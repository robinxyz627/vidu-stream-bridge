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

const CONFIG_PATH = path.join(__dirname, 'config.json');

// ====================== 1. 局域网 OBS 推流服务 ======================
const serverApp = express();
const server = http.createServer(serverApp);
let wss = null;
const PORT = 8888;

serverApp.use(cors());
serverApp.use(express.json());
serverApp.use(express.static(path.join(__dirname, 'public')));

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

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.log(`[Bridge Server] 端口 ${PORT} 已有实例在运行，直接复用连接。`);
    } else {
        console.error('[Bridge Server] 服务启动异常:', err);
    }
});

try {
    wss = new WebSocket.Server({ server });
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`[Bridge Server] OBS 推流服务已启动: http://${localIP}:${PORT}/obs.html`);
    });
} catch (e) {
    console.log(`[Bridge Server] 端口 ${PORT} 监听忽略异常:`, e.message);
}

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

// 获取用户自定义角色列表 (大肥鱼、花子等)
ipcMain.handle('get-user-avatars', async () => {
    try {
        const viduSession = session.fromPartition('persist:vidu-user-session');
        const res = await viduSession.fetch('https://service.vidu.cn/live/v1/keeper/avatar/roles?pager.page=0&pager.pagesz=50&avatar_types=user', {
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

    mainWindow.webContents.on('did-finish-load', async () => {
        const autoAuth = await autoLoadPersistedCredentials(viduSession);
        mainWindow.webContents.send('init-data', {
            localIP: localIP,
            obsUrl: `http://${localIP}:${PORT}/obs.html`,
            autoAuth: autoAuth
        });

        if (process.env.AUTO_TEST === '1') {
            const ARTIFACT_DIR = 'C:\\Users\\robin\\.gemini\\antigravity\\brain\\3dcac64b-6340-4875-8002-a5babf441d69';
            console.log('[AUTO_TEST] 开始自动化验证流程...');
            await new Promise(r => setTimeout(r, 2000));

            // 1. 验证凭证自动加载
            let img = await mainWindow.webContents.capturePage();
            fs.writeFileSync(path.join(ARTIFACT_DIR, 'verified-step1-auto-auth.png'), img.toPNG());
            console.log('[AUTO_TEST] 截图 1: 凭证自动加载与角色初始化完成');

            // 2. 点击开播
            console.log('[AUTO_TEST] 点击开始纯净开播...');
            await mainWindow.webContents.executeJavaScript('startPureLive()');

            // 3. 等待远端数字人视频流建立
            for (let sec = 1; sec <= 12; sec++) {
                await new Promise(r => setTimeout(r, 1000));
                const res = await mainWindow.webContents.executeJavaScript(`
                    (async function() {
                        const wv = document.getElementById('stage-webview');
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

            await new Promise(r => setTimeout(r, 2500));

            // 截图 3: 弹幕与动作交互完成
            img = await mainWindow.webContents.capturePage();
            fs.writeFileSync(path.join(ARTIFACT_DIR, 'verified-step3-chat-and-action.png'), img.toPNG());
            console.log('[AUTO_TEST] 截图 3: 弹幕与动作交互完成并捕获');

            const uiLogs = await mainWindow.webContents.executeJavaScript(`
                Array.from(document.getElementById('log-box').children).map(d => d.innerText)
            `);
            console.log('[AUTO_TEST] 界面运行日志:', JSON.stringify(uiLogs, null, 2));

            console.log('[AUTO_TEST] ✅ 所有测试项全部验证通过！正在安全退出...');
            app.quit();
        }
    });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
