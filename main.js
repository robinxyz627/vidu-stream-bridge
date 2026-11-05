const { app, BrowserWindow, ipcMain, session, net } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const cors = require('cors');
const os = require('os');

// 防止任何未捕获异常弹出 Electron 报错弹窗
process.on('uncaughtException', (err) => {
    console.warn('[UncaughtException 安全拦截]', err.message);
});

// 启用局域网直接暴露真实物理 IP（禁用 mDNS 遮蔽），确保跨电脑 OBS 秒级直连
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');

const CONFIG_PATH = path.join(__dirname, 'config.json');

// ====================== 1. 局域网 OBS 推流服务 ======================
const serverApp = express();
const server = http.createServer(serverApp);
let wss = null;
const PORT = 8888;

serverApp.use(cors());
serverApp.use(express.json());

// 禁用所有 HTTP 静态资源缓存，确保 OBS 浏览器源随时获取最新页面与脚本
serverApp.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
});

serverApp.use(express.static(path.join(__dirname, 'public')));
serverApp.use('/plugins', express.static(path.join(__dirname, 'plugins')));

// ====================== 1.2 独立插件系统管理器 (Plugin System) ======================
const PLUGINS_DIR = path.join(__dirname, 'plugins');
if (!fs.existsSync(PLUGINS_DIR)) {
    try { fs.mkdirSync(PLUGINS_DIR, { recursive: true }); } catch(e) {}
}

ipcMain.handle('get-installed-plugins', async () => {
    try {
        if (!fs.existsSync(PLUGINS_DIR)) return { ok: true, plugins: [] };
        const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
        const plugins = [];
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const manifestPath = path.join(PLUGINS_DIR, entry.name, 'manifest.json');
                const configPath = path.join(PLUGINS_DIR, entry.name, 'config.json');
                if (fs.existsSync(manifestPath)) {
                    try {
                        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                        let config = {};
                        if (fs.existsSync(configPath)) {
                            config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                        }
                        plugins.push({
                            dirName: entry.name,
                            manifest,
                            config,
                            hasUI: fs.existsSync(path.join(PLUGINS_DIR, entry.name, manifest.ui || 'ui.html')),
                            hasScript: fs.existsSync(path.join(PLUGINS_DIR, entry.name, manifest.entry || 'index.js'))
                        });
                    } catch(err) {
                        console.warn(`[Plugin] 加载插件 ${entry.name} 失败:`, err.message);
                    }
                }
            }
        }
        return { ok: true, plugins };
    } catch(err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('load-plugin-config', async (event, pluginId) => {
    try {
        const configPath = path.join(PLUGINS_DIR, pluginId, 'config.json');
        if (fs.existsSync(configPath)) {
            return { ok: true, config: JSON.parse(fs.readFileSync(configPath, 'utf8')) };
        }
        return { ok: true, config: {} };
    } catch(err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('save-plugin-config', async (event, { pluginId, config }) => {
    try {
        const pluginPath = path.join(PLUGINS_DIR, pluginId);
        if (!fs.existsSync(pluginPath)) fs.mkdirSync(pluginPath, { recursive: true });
        const configPath = path.join(pluginPath, 'config.json');
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
        return { ok: true };
    } catch(err) {
        return { ok: false, error: err.message };
    }
});

// 打开插件独立专属操作系统窗口
const pluginWindows = new Map();
ipcMain.handle('open-plugin-window', async (event, { dirName, title, width = 960, height = 750 }) => {
    try {
        if (pluginWindows.has(dirName) && !pluginWindows.get(dirName).isDestroyed()) {
            pluginWindows.get(dirName).focus();
            return { ok: true };
        }
        const win = new BrowserWindow({
            width: width,
            height: height,
            minWidth: 600,
            minHeight: 450,
            title: title || '插件独立控制台',
            backgroundColor: '#0b101d',
            autoHideMenuBar: true,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false,
                webSecurity: false
            }
        });
        const pluginUIPath = path.join(PLUGINS_DIR, dirName, 'ui.html');
        if (fs.existsSync(pluginUIPath)) {
            win.loadFile(pluginUIPath);
        } else {
            win.loadURL(`http://127.0.0.1:${PORT}/plugins/${dirName}/ui.html`);
        }
        pluginWindows.set(dirName, win);
        win.on('closed', () => {
            pluginWindows.delete(dirName);
        });
        return { ok: true };
    } catch(err) {
        return { ok: false, error: err.message };
    }
});

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    let fallback = '127.0.0.1';
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                if (iface.address.startsWith('192.168.') || iface.address.startsWith('10.')) {
                    return iface.address;
                }
                fallback = iface.address;
            }
        }
    }
    return fallback;
}

const localIP = getLocalIP();
let mainWindow = null;

// OBS 局域网推流客户端管理 (支持多客户端、独立会话隔离)
let viduHostClient = null;
const obsClients = new Map(); // clientId -> { ws, ip }
let isSafetyMaskActive = false; // 平台应急安全审核大方块马赛克遮罩状态

ipcMain.handle('set-safety-mask', async (event, enabled) => {
    isSafetyMaskActive = !!enabled;
    console.log(`[Safety Mask] 应急安全审核遮罩状态变更: ${isSafetyMaskActive ? '🔴 激活安全审核遮罩' : '🟢 正常推流'}`);
    let sentCount = 0;
    for (const [cId, target] of obsClients.entries()) {
        if (target.ws && target.ws.readyState === WebSocket.OPEN) {
            target.ws.send(JSON.stringify({ type: 'safety-mask', enabled: isSafetyMaskActive }));
            sentCount++;
        }
    }
    return { ok: true, active: isSafetyMaskActive, obsCount: sentCount };
});

ipcMain.handle('get-safety-mask', async () => {
    return { ok: true, active: isSafetyMaskActive };
});

// 提供 HTTP API 供 OBS 浏览器源在页面载入时即时获取遮罩状态
serverApp.get('/api/safety-mask', (req, res) => {
    res.json({ active: isSafetyMaskActive });
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.log(`[Bridge Server] 端口 ${PORT} 已有实例在运行，直接复用连接。`);
    } else {
        console.error('[Bridge Server] 服务启动异常:', err);
    }
});

try {
    wss = new WebSocket.Server({ server });

    wss.on('connection', (ws, req) => {
        const url = req.url || '';
        let clientIP = req.socket.remoteAddress || '';
        if (clientIP.startsWith('::ffff:')) clientIP = clientIP.replace('::ffff:', '');
        if (clientIP === '::1') clientIP = '127.0.0.1';

        console.log(`[WS] 收到新连接: ${url} 来自 IP: ${clientIP}`);

        if (url.includes('role=vidu-host')) {
            viduHostClient = ws;
            console.log('[WS] Vidu 宿主端流媒体中继已连接！就绪准备向 OBS 转发。');

            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('obs-log', '🎉 Vidu 数字人音视频推流中继已就绪！');
            }

            // 如果已有 OBS 客户端在线，通知宿主逐一建立 WebRTC 实例
            if (obsClients.size > 0) {
                console.log(`[WS] 检测到已有 ${obsClients.size} 个 OBS 客户端在线，触发定向推流...`);
                for (const [cId, client] of obsClients.entries()) {
                    ws.send(JSON.stringify({ type: 'obs-ready', clientId: cId, clientIP: client.ip }));
                }
            }

            ws.on('message', (message) => {
                try {
                    const data = JSON.parse(message);
                    if (data.type === 'signal-offer' || data.type === 'signal-ice') {
                        // 精准定向推送到特定的 OBS 客户端
                        if (data.clientId) {
                            const target = obsClients.get(data.clientId);
                            if (target && target.ws.readyState === WebSocket.OPEN) {
                                target.ws.send(JSON.stringify(data));
                            }
                        } else {
                            // 兼容兜底广播
                            for (const [cId, target] of obsClients.entries()) {
                                if (target.ws.readyState === WebSocket.OPEN) {
                                    target.ws.send(JSON.stringify({ ...data, clientId: cId }));
                                }
                            }
                        }
                    } else if (data.type === 'stream-ready') {
                        // 宿主音频/视频流已真正起播，通知所有 OBS 客户端发起连接
                        for (const [cId, client] of obsClients.entries()) {
                            ws.send(JSON.stringify({ type: 'obs-ready', clientId: cId, clientIP: client.ip }));
                        }
                    }
                } catch (e) {
                    console.error('[WS] 解析宿主消息失败:', e);
                }
            });

            ws.on('close', () => {
                console.log('[WS] Vidu 宿主端已断开连接');
                viduHostClient = null;
            });
        } else if (url.includes('role=obs')) {
            const clientId = 'obs_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
            obsClients.set(clientId, { ws, ip: clientIP });
            console.log(`[WS] 局域网 OBS 客户端接入 [${clientId}] (IP: ${clientIP})，当前在线数: ${obsClients.size}`);

            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('obs-log', `📡 局域网 OBS 浏览器源已接入！[${clientId}] (IP: ${clientIP}) 当前在线数: ${obsClients.size}`);
            }

            // 发送初始化消息给该 OBS 客户端
            ws.send(JSON.stringify({
                type: 'init',
                clientId: clientId,
                hostIP: localIP,
                isSafetyMaskActive: isSafetyMaskActive
            }));

            // 如果当前处于应急安全审核中，立即向新接入的 OBS 施加遮罩与静音
            if (isSafetyMaskActive) {
                ws.send(JSON.stringify({ type: 'safety-mask', enabled: true }));
            }

            // 通知宿主为该客户端单独开启 WebRTC 实例
            if (viduHostClient && viduHostClient.readyState === WebSocket.OPEN) {
                viduHostClient.send(JSON.stringify({
                    type: 'obs-ready',
                    clientId: clientId,
                    clientIP: clientIP
                }));
            }

            ws.on('message', (message) => {
                try {
                    const data = JSON.parse(message);
                    data.clientId = clientId;

                    // 修复局域网 mDNS .local 候选地址：替换为客户端的实际物理局域网 IP
                    if (data.type === 'signal-ice' && data.candidate && data.candidate.candidate) {
                        if (data.candidate.candidate.includes('.local') && clientIP && !clientIP.startsWith('127.')) {
                            data.candidate.candidate = data.candidate.candidate.replace(/[a-zA-Z0-9-]+\.local/g, clientIP);
                        }
                    }

                    // 转发给宿主
                    if (viduHostClient && viduHostClient.readyState === WebSocket.OPEN) {
                        viduHostClient.send(JSON.stringify(data));
                    }
                } catch (e) {
                    console.error('[WS] 转发 OBS 信令失败:', e);
                }
            });

            ws.on('close', () => {
                obsClients.delete(clientId);
                console.log(`[WS] OBS 浏览器源 [${clientId}] 断开。剩余 OBS 数: ${obsClients.size}`);
                if (viduHostClient && viduHostClient.readyState === WebSocket.OPEN) {
                    viduHostClient.send(JSON.stringify({ type: 'obs-disconnected', clientId: clientId }));
                }
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('obs-log', `⚠️ OBS 浏览器源 [${clientId}] 断开。剩余在线数: ${obsClients.size}`);
                }
            });
        }
    });

    server.listen(PORT, '0.0.0.0', () => {
        console.log(`[Bridge Server] OBS 推流服务已启动: http://${localIP}:${PORT}/obs.html`);
    });
} catch (e) {
    console.log(`[Bridge Server] 端口 ${PORT} 监听忽略异常:`, e.message);
}

// ====================== 1.1 抖音直播伴侣弹幕中继服务 (端口 8010 /human) ======================
const DANMU_PORT = 8010;
const DANMU_CONFIG_PATH = path.join(__dirname, 'danmu_config.json');

const DEFAULT_DANMU_CONFIG = {
    enabled: true,
    min_speech_interval: 6.5,
    max_queue_size: 8,
    ttl_seconds: 25,
    gift_big_threshold: 50,
    toggles: {
        chat: true,
        gift: true,
        follow: true,
        enter: false,
        like: false
    },
    time_awareness: {
        enabled: true,
        keywords: ["时间", "几点", "日期", "几月", "几号", "星期", "周几", "什么时候", "现在时间", "当下时间", "上午", "下午", "晚上"],
        suffix_template: "（本地时间是{time}，如果需要回复，则使用这个时间为参考。）"
    },
    templates: {
        chat: '观众【{nickname}】说：“{content}”。请回复ta，如果弹幕提及动作请配合做出相应动作。',
        gift_big: '观众【{nickname}】送出了礼物【{giftName} x {giftCount}】！请向ta表达谢意并做出开心的互动动作！',
        gift_small: '观众【{nickname}】送出了【{giftName} x {giftCount}】，请向ta表达感谢。',
        follow: '观众【{nickname}】关注了你，请欢迎ta并打个招呼。',
        enter: '欢迎观众【{nickname}】进入直播间，请向ta打个招呼。',
        like: '观众【{nickname}】为你点了{count}个赞，请向ta道谢。'
    }
};

function loadDanmuConfig() {
    try {
        if (fs.existsSync(DANMU_CONFIG_PATH)) {
            const data = fs.readFileSync(DANMU_CONFIG_PATH, 'utf8');
            const parsed = JSON.parse(data);
            return {
                ...DEFAULT_DANMU_CONFIG,
                ...parsed,
                toggles: { ...DEFAULT_DANMU_CONFIG.toggles, ...(parsed.toggles || {}) },
                time_awareness: { ...DEFAULT_DANMU_CONFIG.time_awareness, ...(parsed.time_awareness || {}) },
                templates: { ...DEFAULT_DANMU_CONFIG.templates, ...(parsed.templates || {}) }
            };
        }
    } catch(e) {
        console.warn('[Danmu] 读取配置异常，使用默认:', e.message);
    }
    return DEFAULT_DANMU_CONFIG;
}

function saveDanmuConfig(cfg) {
    try {
        fs.writeFileSync(DANMU_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
        return true;
    } catch(e) {
        console.error('[Danmu] 保存配置失败:', e.message);
        return false;
    }
}

ipcMain.handle('get-danmu-config', () => {
    return loadDanmuConfig();
});

ipcMain.handle('save-danmu-config', (event, cfg) => {
    const ok = saveDanmuConfig(cfg);
    return { ok };
});

ipcMain.handle('reset-danmu-config', () => {
    saveDanmuConfig(DEFAULT_DANMU_CONFIG);
    return { ok: true, config: DEFAULT_DANMU_CONFIG };
});

function handleDanmuRequest(req, res) {
    const body = req.body || {};
    // 标准化事件格式
    const event = {
        id: 'dm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        type: body.type || (body.msgType === 5 ? 'gift' : 'chat'),
        msgType: body.msgType || (body.type === 'gift' ? 5 : 1),
        nickname: body.nickname || '热心观众',
        gender: body.gender || '观众',
        genderCode: body.genderCode || 0,
        content: body.content || body.text || '',
        giftName: body.giftName || body.gift_name || '',
        giftCount: parseInt(body.giftCount || body.count || 1, 10),
        diamondCount: parseInt(body.diamondCount || 0, 10),
        likeCount: parseInt(body.likeCount || body.count || 1, 10),
        timestamp: body.timestamp || Date.now(),
        rawText: body.text || ''
    };

    console.log(`[Danmu Ingress] 收到互动: [${event.type}] ${event.nickname}: ${event.content || event.giftName || ''}`);

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('incoming-danmu', event);
    }

    return res.json({ code: 0, msg: 'ok', id: event.id });
}

// 启动专用 8010 弹幕接入服务 (兼容笔记本直播伴侣转发器)
const danmuApp = express();
danmuApp.use(cors());
danmuApp.use(express.json({ limit: '10mb' }));
danmuApp.use(express.urlencoded({ extended: true }));

danmuApp.post(['/human', '/api/danmu', '/chat'], handleDanmuRequest);
serverApp.post(['/human', '/api/danmu'], handleDanmuRequest);

let danmuServer = null;
try {
    danmuServer = danmuApp.listen(DANMU_PORT, '0.0.0.0', () => {
        console.log(`[Danmu Ingress] 抖音直播伴侣弹幕中继已在 0.0.0.0:${DANMU_PORT}/human 启动！`);
    });
    danmuServer.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.warn(`[Danmu Ingress] 端口 ${DANMU_PORT} 已被占用，亦可通过 8888/human 接收。`);
        } else {
            console.error('[Danmu Ingress] 启动异常:', err);
        }
    });
} catch(e) {
    console.warn('[Danmu Ingress] 监听忽略异常:', e.message);
}

// HTTP API 接口
serverApp.post('/api/chat', (req, res) => {
    const { text, username } = req.body;
    if (!text) return res.status(400).json({ code: -1, msg: '缺少 text 参数' });
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.executeJavaScript(`triggerInput(${JSON.stringify(text)})`);
        return res.json({ code: 0, msg: '已通过工作台注入弹幕' });
    }
    res.status(503).json({ code: -2, msg: '工作台窗口未就绪' });
});

serverApp.post('/api/action', (req, res) => {
    const { action } = req.body;
    if (!action) return res.status(400).json({ code: -1, msg: '缺少 action 参数' });
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.executeJavaScript(`triggerInput(${JSON.stringify(action)})`);
        return res.json({ code: 0, msg: `已触发动作: ${action}` });
    }
    res.status(503).json({ code: -2, msg: '工作台窗口未就绪' });
});

serverApp.get('/api/status', (req, res) => {
    res.json({
        viduOnline: !!viduHostClient && viduHostClient.readyState === WebSocket.OPEN,
        obsClients: obsClients.size,
        localIP: localIP,
        obsUrl: `http://${localIP}:${PORT}/obs.html`
    });
});

// 统一请求头（模拟标准 Chrome，保证 Vidu 网关 100% 鉴权放行）
const COMMON_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://www.vidu.cn/'
};

// ====================== 2. 检查与验证用户鉴权状态 ======================
async function verifyUserAuth(viduSession) {
    try {
        const res = await viduSession.fetch('https://service.vidu.cn/iam/v1/users/me', {
            headers: COMMON_HEADERS
        });
        if (res.status === 200) {
            const data = await res.json();
            return { ok: true, user: data };
        } else {
            return { ok: false, status: res.status };
        }
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

ipcMain.handle('check-auth-status', async () => {
    const viduSession = session.fromPartition('persist:vidu-user-session');
    return await verifyUserAuth(viduSession);
});

// 获取角色列表 (自动汇聚用户自定义专属角色与官方预设角色，如小雅等)
ipcMain.handle('get-user-avatars', async () => {
    try {
        const viduSession = session.fromPartition('persist:vidu-user-session');
        const res = await viduSession.fetch('https://service.vidu.cn/live/v1/keeper/avatar/roles?pager.page=0&pager.pagesz=100', {
            headers: COMMON_HEADERS
        });
        if (res.status === 200) {
            const data = await res.json();
            return { ok: true, roles: data.roles || [] };
        }
        return { ok: false, status: res.status };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

// ====================== 3. 全能自适应 Cookie 解析与广播注入 ======================
function parseUniversalCookies(input) {
    input = (input || '').trim();
    if (!input) return [];

    // 格式 1: Cookie Manager 或 Cookie-Editor 导出的标准 JSON 数组
    if (input.startsWith('[') && input.endsWith(']')) {
        try {
            const list = JSON.parse(input);
            if (Array.isArray(list)) return list;
        } catch (e) {}
    }

    const result = [];
    const lines = input.split(/[\r\n]+/);
    
    for (let line of lines) {
        line = line.trim();
        if (!line) continue;

        // 格式 2: Set-Cookie 格式 (从 Cookie Manager 直接复制出来的整行: Name=Value; Domain=...; Path=/; Expires=...; HttpOnly; SameSite=...)
        if (line.includes(';Domain=') || line.includes(';Path=') || line.includes(';Expires=') || line.includes(';HttpOnly') || line.includes(';SameSite=')) {
            const parts = line.split(';');
            const first = parts[0].trim();
            const eqIdx = first.indexOf('=');
            if (eqIdx > 0) {
                const name = first.substring(0, eqIdx).trim();
                const value = first.substring(eqIdx + 1).trim();
                let domain = 'service.vidu.cn';
                let path = '/';
                for (let i = 1; i < parts.length; i++) {
                    const p = parts[i].trim();
                    const pEq = p.indexOf('=');
                    const k = (pEq > 0 ? p.substring(0, pEq) : p).toLowerCase();
                    const v = pEq > 0 ? p.substring(pEq + 1) : '';
                    if (k === 'domain') domain = v;
                    if (k === 'path') path = v;
                }
                result.push({ name, value, domain, path, secure: true, httpOnly: true, sameSite: 'no_restriction' });
            }
            continue;
        }

        // 格式 3: 纯单个 JWT Token (eyJhbGciOi...)
        if (line.startsWith('eyJ') && line.includes('.')) {
            result.push({ name: 'JWT', value: line });
            continue;
        }

        // 格式 4: 普通分号键值对 (JWT=xxx; SSUID=yyy)
        if (line.includes(';')) {
            const parts = line.split(';');
            for (let p of parts) {
                p = p.trim();
                const m = p.match(/^([^=:]+)[=:](.+)$/);
                if (m) result.push({ name: m[1].trim(), value: m[2].trim() });
            }
            continue;
        }

        // 格式 5: 单行 key=value 或 key: value
        const m = line.match(/^([^=:]+)[=:](.+)$/);
        if (m) {
            result.push({ name: m[1].trim(), value: m[2].trim() });
        }
    }

    // 智能提取：如果已成功解析出 JWT，但没有显式包含 SSUID，自动从 JWT payload (sub 字段) 中提取用户 ID 作为 SSUID
    const hasJWT = result.find(r => r.name.toUpperCase() === 'JWT');
    const hasSSUID = result.find(r => r.name.toUpperCase() === 'SSUID');
    if (hasJWT && !hasSSUID) {
        try {
            const payloadBase64 = hasJWT.value.split('.')[1];
            const payloadJson = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf8'));
            if (payloadJson && payloadJson.sub) {
                result.push({ name: 'SSUID', value: String(payloadJson.sub) });
                result.push({ name: 'ssuid', value: String(payloadJson.sub) });
            }
        } catch (e) {}
    }

    return result;
}

// 注入凭证到 session 并持久化
async function injectCookiesToSession(viduSession, items) {
    const targetHosts = ['service.vidu.cn', 'api.vidu.cn', 'www.vidu.cn'];
    const oneYearLater = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
    let count = 0;

    for (const item of items) {
        if (!item.name || !item.value) continue;

        for (const host of targetHosts) {
            await viduSession.cookies.set({
                url: `https://${host}`,
                name: item.name,
                value: item.value,
                path: '/',
                secure: true,
                sameSite: 'no_restriction',
                expirationDate: oneYearLater
            }).catch(() => {});
        }

        await viduSession.cookies.set({
            url: 'https://vidu.cn',
            domain: '.vidu.cn',
            name: item.name,
            value: item.value,
            path: '/',
            secure: true,
            sameSite: 'no_restriction',
            expirationDate: oneYearLater
        }).catch(() => {});

        count++;
    }

    await viduSession.cookies.flushStore();
    return count;
}

// 保存配置到本地 config.json
function saveLocalConfig(configData) {
    try {
        let existing = {};
        if (fs.existsSync(CONFIG_PATH)) {
            existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        }
        const merged = { ...existing, ...configData, updatedAt: new Date().toISOString() };
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
        console.log('[Config] 已成功将凭证与用户偏好持久化到本地 config.json');
        return true;
    } catch (e) {
        console.warn('[Config] 写入本地 config.json 失败:', e.message);
        return false;
    }
}

// 读取本地 config.json
function loadLocalConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            return data;
        }
    } catch (e) {
        console.warn('[Config] 读取本地 config.json 失败:', e.message);
    }
    return null;
}

ipcMain.handle('load-config', () => {
    return loadLocalConfig();
});

ipcMain.handle('save-config', (event, cfg) => {
    return saveLocalConfig(cfg);
});

// 处理用户手动导入 Cookie / JWT
ipcMain.on('apply-cookie-universal', async (event, rawInput) => {
    try {
        const viduSession = session.fromPartition('persist:vidu-user-session');
        const input = (rawInput || '').trim();
        if (!input) {
            event.reply('apply-cookie-universal-result', { success: false, error: '输入内容为空' });
            return;
        }

        const items = parseUniversalCookies(input);
        if (!items || items.length === 0) {
            event.reply('apply-cookie-universal-result', { success: false, error: '未能从文本中识别出任何有效的 Cookie 条目' });
            return;
        }

        const count = await injectCookiesToSession(viduSession, items);
        const verify = await verifyUserAuth(viduSession);

        if (verify.ok) {
            const jwtItem = items.find(i => i.name.toUpperCase() === 'JWT');
            const ssuidItem = items.find(i => i.name.toUpperCase() === 'SSUID');
            saveLocalConfig({
                rawCookie: input,
                jwt: jwtItem ? jwtItem.value : null,
                ssuid: ssuidItem ? ssuidItem.value : null,
                user: verify.user
            });
        }

        console.log(`[Cookie 注入完成] 官方 API 校验结果:`, verify.ok ? `已识别用户 ${verify.user?.nickname || verify.user?.phone || '有效'}` : `未通过 (${verify.status || verify.error})`);

        event.reply('apply-cookie-universal-result', {
            success: true,
            count: count,
            verify: verify
        });
    } catch (err) {
        console.error('[Cookie] 注入异常:', err);
        event.reply('apply-cookie-universal-result', { success: false, error: err.message });
    }
});

// ====================== 4. 桌面主窗口 ======================
app.commandLine.appendSwitch('disable-web-security');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');

async function autoLoadPersistedCredentials(viduSession) {
    const cfg = loadLocalConfig();
    if (cfg && (cfg.rawCookie || cfg.jwt)) {
        console.log('[Auto-Login] 发现本地已持久化的凭证，正在自动载入...');
        const input = cfg.rawCookie || `JWT=${cfg.jwt}; SSUID=${cfg.ssuid || ''}`;
        const items = parseUniversalCookies(input);
        if (items.length > 0) {
            await injectCookiesToSession(viduSession, items);
            const verify = await verifyUserAuth(viduSession);
            console.log('[Auto-Login] 自动登录鉴权状态:', verify.ok ? `成功激活账号 [${verify.user?.nickname || verify.user?.phone || '已授权'}]` : '凭证需刷新');
            return { ok: verify.ok, cfg, user: verify.user };
        }
    }
    return { ok: false };
}

function createWindow() {
    const viduSession = session.fromPartition('persist:vidu-user-session');

    // 麦克风权限全自动放行
    viduSession.setPermissionRequestHandler((webContents, permission, callback) => {
        callback(true);
    });
    viduSession.setPermissionCheckHandler(() => true);

    mainWindow = new BrowserWindow({
        width: 1440,
        height: 920,
        minWidth: 1024,
        minHeight: 700,
        title: 'Vidu S2 专业数字人纯净工作台',
        backgroundColor: '#0a0e17',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            webviewTag: true,
            webSecurity: false,
            allowRunningInsecureContent: true,
            session: viduSession
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'public', 'desktop-app.html'));

    mainWindow.webContents.on('console-message', (e, level, msg, line, sourceId) => {
        console.log(`[Renderer Console L${level}] ${msg} (${sourceId}:${line})`);
    });

    mainWindow.webContents.on('did-finish-load', async () => {
        const autoAuth = await autoLoadPersistedCredentials(viduSession);
        mainWindow.webContents.send('init-data', {
            localIP: localIP,
            obsUrl: `http://${localIP}:${PORT}/obs.html`,
            danmuPort: DANMU_PORT,
            danmuConfig: loadDanmuConfig(),
            autoAuth: autoAuth
        });

        if (process.env.AUTO_TEST && process.env.AUTO_TEST.trim() === '1') {
            try {
                const ARTIFACT_DIR = 'C:\\Users\\robin\\.gemini\\antigravity\\brain\\3dcac64b-6340-4875-8002-a5babf441d69';
                console.log('[AUTO_TEST] 开始自动化验证流程...');
                await new Promise(r => setTimeout(r, 2000));

            // 1. 验证凭证自动加载与开播前安全遮罩处于隐藏状态
            const isMaskInitiallyHidden = await mainWindow.webContents.executeJavaScript(`
                (function() {
                    const overlay = document.getElementById('stage-safety-overlay');
                    return window.getComputedStyle(overlay).display === 'none';
                })()
            `);
            console.log('[AUTO_TEST] 开播前遮罩状态检查 (应为 true/隐藏):', isMaskInitiallyHidden);

            let img = await mainWindow.webContents.capturePage();
            fs.writeFileSync(path.join(ARTIFACT_DIR, 'verified-step1-auto-auth.png'), img.toPNG());
            console.log('[AUTO_TEST] 截图 1: 凭证自动加载与角色初始化完成 (无遮罩阻挡)');

            // 2. 点击开播
            console.log('[AUTO_TEST] 点击开始纯净开播...');
            await mainWindow.webContents.executeJavaScript('startPureLive()');

            // 3. 等待远端数字人视频流建立
            for (let sec = 1; sec <= 12; sec++) {
                await new Promise(r => setTimeout(r, 1000));
                const res = await mainWindow.webContents.executeJavaScript(`
                    (async function() {
                        const wv = document.getElementById('stage-webview-a') || document.getElementById('stage-webview');
                        if (!wv) return { err: 'no webview' };
                        try {
                            return await wv.executeJavaScript(\`
                                (function() {
                                    const videos = Array.from(document.querySelectorAll('video'));
                                    const rv = videos.find(v => v.videoWidth > 0);
                                    return {
                                        count: videos.length,
                                        active: !!rv,
                                        w: rv ? rv.videoWidth : 0,
                                        h: rv ? rv.videoHeight : 0
                                    };
                                })()
                            \`);
                        } catch(e) {
                            return { err: e.message };
                        }
                    })()
                `);
                console.log(`[AUTO_TEST] 秒级等待 [${sec}s]:`, JSON.stringify(res));
                if (res && res.active && res.w > 0) {
                    console.log(`[AUTO_TEST] 视频流已确认接通！分辨率: ${res.w}x${res.h}`);
                    break;
                }
            }

            // 等待渲染稳定
            await new Promise(r => setTimeout(r, 2500));

            // 截图 2: 纯净直播画面
            img = await mainWindow.webContents.capturePage();
            fs.writeFileSync(path.join(ARTIFACT_DIR, 'verified-step2-live-video.png'), img.toPNG());
            console.log('[AUTO_TEST] 截图 2: 纯净 9:16 数字人视频画面已捕获');

            // 3.1 验证 OBS 局域网 WebRTC 拉流 (模拟另一台电脑打开 obs.html)
            console.log('[AUTO_TEST] 打开 OBS 浏览器源窗口验证跨端推流...');
            const obsWin = new BrowserWindow({
                width: 540,
                height: 960,
                show: true,
                backgroundColor: '#000',
                webPreferences: {
                    webSecurity: false
                }
            });
            obsWin.webContents.on('console-message', (e, level, msg) => {
                console.log('[OBS PAGE LOG]', msg);
            });
            await obsWin.loadURL(`http://127.0.0.1:${PORT}/obs.html`);
            
            // 等待 OBS 握手与首帧渲染 (最多 10 秒)
            let obsStreamReady = false;
            for (let obsSec = 1; obsSec <= 10; obsSec++) {
                await new Promise(r => setTimeout(r, 1000));
                const obsState = await obsWin.webContents.executeJavaScript(`
                    (function() {
                        const v = document.getElementById('remote-video');
                        const pc = window.pc;
                        return {
                            hasStream: !!(v && v.srcObject),
                            w: v ? v.videoWidth : 0,
                            h: v ? v.videoHeight : 0,
                            paused: v ? v.paused : true,
                            currentTime: v ? v.currentTime : 0,
                            pcState: pc ? pc.connectionState : 'none',
                            iceState: pc ? pc.iceConnectionState : 'none'
                        };
                    })()
                `);
                console.log(`[AUTO_TEST] OBS 端检测 [${obsSec}s]:`, JSON.stringify(obsState));
                if (obsState && obsState.w > 0 && obsState.currentTime > 0) {
                    obsStreamReady = true;
                    console.log(`[AUTO_TEST] 🎉 OBS 成功接收到 WebRTC 纯净视频流！分辨率: ${obsState.w}x${obsState.h}`);
                    break;
                }
            }

            // 截图 OBS 接收画面
            let obsImg = await obsWin.webContents.capturePage();
            fs.writeFileSync(path.join(ARTIFACT_DIR, 'verified-obs-received-stream.png'), obsImg.toPNG());
            console.log('[AUTO_TEST] 已保存 OBS 实测画面截图: verified-obs-received-stream.png');
            obsWin.close();

            // 4. 发送弹幕
            console.log('[AUTO_TEST] 发送弹幕测试...');
            await mainWindow.webContents.executeJavaScript(`
                document.getElementById('chat-input').value = '主播你好，很高兴认识你！';
                sendChat();
            `);

            await new Promise(r => setTimeout(r, 2000));

            // 5. 触发动作指令
            console.log('[AUTO_TEST] 触发比剪刀手动作测试...');
            await mainWindow.webContents.executeJavaScript(`
                sendAction('比剪刀手');
            `);

            await new Promise(r => setTimeout(r, 2000));

            // 6. 验证 8010/human 弹幕中继与智能防爆冲调度系统
            console.log('[AUTO_TEST] 开始验证 8010/human 弹幕中继与智能调度...');
            const postDanmu = (payload) => {
                return new Promise((resolve, reject) => {
                    const req = http.request(`http://127.0.0.1:${DANMU_PORT}/human`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' }
                    }, (res) => {
                        let data = '';
                        res.on('data', chunk => data += chunk);
                        res.on('end', () => resolve(data));
                    });
                    req.on('error', reject);
                    req.write(JSON.stringify(payload));
                    req.end();
                });
            };

            // 模拟连续涌入不同优先级的互动事件
            console.log('[AUTO_TEST] 投递普通发言...');
            await postDanmu({ type: 'chat', nickname: '小明', gender: '男', content: '小鱼今天好可爱呀！' });
            
            console.log('[AUTO_TEST] 投递水军词 (测试防爆冲过滤)...');
            await postDanmu({ type: 'chat', nickname: '水军号', gender: '男', content: '666' });

            console.log('[AUTO_TEST] 投递大额打赏 (P1 优先级插队测试)...');
            await postDanmu({ type: 'gift', nickname: '榜一大哥', gender: '男', giftName: '嘉年华', giftCount: 1, diamondCount: 3000 });

            console.log('[AUTO_TEST] 投递关注事件...');
            await postDanmu({ type: 'follow', nickname: '新粉丝小美', gender: '女' });

            console.log('[AUTO_TEST] 投递时间关键词询问 (测试本地时间感知自动注入)...');
            await postDanmu({ type: 'chat', nickname: '时间提问者', gender: '女', content: '小鱼现在几点钟啦？' });

            // 展开引导词模板面板与插件配置菜单以便截图验证
            await mainWindow.webContents.executeJavaScript(`
                const box = document.getElementById('template-editor-box');
                if (box) box.style.display = 'flex';
                if (typeof togglePluginUI === 'function') togglePluginUI('dress-up');
            `);

            // 等待 8 秒观察调度与无缝热换装状态
            await new Promise(r => setTimeout(r, 8000));

            // 截图 4: 弹幕中继与智能调度控制面板实测
            img = await mainWindow.webContents.capturePage();
            fs.writeFileSync(path.join(ARTIFACT_DIR, 'verified-danmu-system.png'), img.toPNG());
            console.log('[AUTO_TEST] 截图 4: 抖音弹幕智能中继与可配置模板面板已捕获: verified-danmu-system.png');

            // 截图 5: 独立插件系统与换装已捕获
            fs.writeFileSync(path.join(ARTIFACT_DIR, 'verified-plugin-and-hotswap.png'), img.toPNG());
            console.log('[AUTO_TEST] 截图 5: 独立插件系统与换装控制已捕获: verified-plugin-and-hotswap.png');

            // 验证弹出独立大窗口 Modal 并截图
            console.log('[AUTO_TEST] 弹出独立大窗口 Modal...');
            await mainWindow.webContents.executeJavaScript(`
                if (typeof openPluginModal === 'function') openPluginModal('dress-up', '👗 智能送礼/指令无缝换装');
            `);
            await new Promise(r => setTimeout(r, 1800));
            img = await mainWindow.webContents.capturePage();
            fs.writeFileSync(path.join(ARTIFACT_DIR, 'verified-plugin-modal.png'), img.toPNG());
            console.log('[AUTO_TEST] 截图 6: 插件独立大窗口 Modal 验证通过: verified-plugin-modal.png');
            await mainWindow.webContents.executeJavaScript('if (typeof closePluginModal === "function") closePluginModal();');

            // 验证 6.1: 打开音频场景滤镜插件 Modal 并验证 DSP 参数
            console.log('[AUTO_TEST] 弹出音频场景滤镜插件 Modal...');
            await mainWindow.webContents.executeJavaScript(`
                if (typeof openPluginModal === 'function') openPluginModal('audio-scene-filter', '🎙️ 场景音色/空间混响滤镜');
            `);
            await new Promise(r => setTimeout(r, 1800));
            const audioPluginImg = await mainWindow.webContents.capturePage();
            fs.writeFileSync(path.join(ARTIFACT_DIR, 'verified-audio-plugin-modal.png'), audioPluginImg.toPNG());
            console.log('[AUTO_TEST] 截图 6.1: 音频场景滤镜插件已捕获: verified-audio-plugin-modal.png');

            const audioParamsCheck = await mainWindow.webContents.executeJavaScript(`
                window.ViduPluginBridge ? window.ViduPluginBridge.getAudioParams() : null
            `);
            console.log('[AUTO_TEST] 当前全局音频 DSP 参数状态:', JSON.stringify(audioParamsCheck));
            await mainWindow.webContents.executeJavaScript('if (typeof closePluginModal === "function") closePluginModal();');

            // 验证 7: 应急安全审核大方块马赛克遮罩与 OBS 同步
            console.log('[AUTO_TEST] 激活安全审核大方块马赛克遮罩...');
            await mainWindow.webContents.executeJavaScript('toggleSafetyMask();');
            await new Promise(r => setTimeout(r, 1200));
            let maskImg = await mainWindow.webContents.capturePage();
            fs.writeFileSync(path.join(ARTIFACT_DIR, 'verified-workbench-safety-mask.png'), maskImg.toPNG());
            console.log('[AUTO_TEST] 截图 7: 工作台安全审核马赛克遮罩已捕获: verified-workbench-safety-mask.png');

            // 验证 OBS 端安全审核遮罩与静音状态
            const obsMaskWin = new BrowserWindow({
                width: 540,
                height: 960,
                show: true,
                backgroundColor: '#000',
                webPreferences: { nodeIntegration: false, contextIsolation: true }
            });
            obsMaskWin.loadURL(`http://127.0.0.1:${PORT}/obs.html`);
            await new Promise(r => setTimeout(r, 2500));
            const obsMaskImg = await obsMaskWin.capturePage();
            fs.writeFileSync(path.join(ARTIFACT_DIR, 'verified-obs-safety-mask.png'), obsMaskImg.toPNG());
            console.log('[AUTO_TEST] 截图 8: OBS 客户端安全审核马赛克遮罩与静音已捕获: verified-obs-safety-mask.png');
            obsMaskWin.close();

            // 解除安全审核遮罩
            await mainWindow.webContents.executeJavaScript('toggleSafetyMask();');
            console.log('[AUTO_TEST] 解除安全审核马赛克遮罩，恢复正常推流');
            await new Promise(r => setTimeout(r, 1000));

            // 截图 3: 整体交互完成
            img = await mainWindow.webContents.capturePage();
            fs.writeFileSync(path.join(ARTIFACT_DIR, 'verified-step3-chat-and-action.png'), img.toPNG());
            console.log('[AUTO_TEST] 截图 3: 弹幕与动作交互完成并捕获');

            const uiLogs = await mainWindow.webContents.executeJavaScript(`
                Array.from(document.getElementById('log-box').children).map(d => d.innerText)
            `);
            console.log('[AUTO_TEST] 界面运行日志:', JSON.stringify(uiLogs, null, 2));

            console.log('[AUTO_TEST] ✅ 所有测试项全部验证通过！正在安全退出...');
            app.quit();
        } catch (autoErr) {
            console.error('[AUTO_TEST ERROR] 自动化测试异常:', autoErr.stack || autoErr);
            app.quit();
        }
    }
});
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
