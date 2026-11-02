const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const os = require('os');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = 8888;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 获取局域网 IP (优先选择 192.168 或 10.x 局域网网段)
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

// 保存已连接的客户端
let viduHostClient = null;       // 运行在 Vidu 网页/宿主端的注入客户端
const obsClients = new Set();    // 另一台电脑上的 OBS 浏览器源
const controllerClients = new Set(); // 本地控制面板

// WebSocket 信令与指令通道
wss.on('connection', (ws, req) => {
    const url = req.url;
    console.log(`[WS] 收到新连接: ${url}`);

    if (url.includes('role=vidu-host')) {
        viduHostClient = ws;
        console.log('[WS] Vidu 网页/宿主客户端已连接！(已准备接收视频流与注入指令)');
        broadcastStatus();

        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                // 处理 WebRTC 信令转发到 OBS
                if (data.type === 'signal-offer' || data.type === 'signal-ice') {
                    for (const obs of obsClients) {
                        if (obs.readyState === WebSocket.OPEN) {
                            obs.send(JSON.stringify(data));
                        }
                    }
                } else if (data.type === 'status-update') {
                    for (const ctrl of controllerClients) {
                        if (ctrl.readyState === WebSocket.OPEN) {
                            ctrl.send(JSON.stringify(data));
                        }
                    }
                }
            } catch (err) {
                console.error('[WS] 解析消息失败:', err);
            }
        });

        ws.on('close', () => {
            console.log('[WS] Vidu 宿主客户端断开连接');
            viduHostClient = null;
            broadcastStatus();
        });
    } else if (url.includes('role=obs')) {
        obsClients.add(ws);
        console.log(`[WS] OBS 浏览器源连接成功！当前 OBS 客户端数: ${obsClients.size}`);
        
        // 通知宿主端重新发起与新 OBS 的 WebRTC 握手
        if (viduHostClient && viduHostClient.readyState === WebSocket.OPEN) {
            viduHostClient.send(JSON.stringify({ type: 'obs-ready' }));
        }

        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                if (data.type === 'signal-answer' || data.type === 'signal-ice') {
                    if (viduHostClient && viduHostClient.readyState === WebSocket.OPEN) {
                        viduHostClient.send(JSON.stringify(data));
                    }
                }
            } catch (err) {
                console.error('[WS] 转发 OBS 信令失败:', err);
            }
        });

        ws.on('close', () => {
            obsClients.delete(ws);
            console.log(`[WS] OBS 浏览器源断开连接。剩余 OBS 数: ${obsClients.size}`);
        });
    } else {
        // 控制面板连接
        controllerClients.add(ws);
        broadcastStatus();

        ws.on('close', () => {
            controllerClients.delete(ws);
        });
    }
});

function broadcastStatus() {
    const isOnline = !!viduHostClient && viduHostClient.readyState === WebSocket.OPEN;
    const msg = JSON.stringify({
        type: 'bridge-status',
        viduOnline: isOnline,
        obsCount: obsClients.size,
        localIP: localIP,
        obsUrl: `http://${localIP}:${PORT}/obs.html`
    });
    for (const ctrl of controllerClients) {
        if (ctrl.readyState === WebSocket.OPEN) {
            ctrl.send(msg);
        }
    }
}

// ================= HTTP API 接口（开放给本地控制面板 & 后续抖音弹幕助手） =================

// 1. 弹幕与文本对话接口（直接口播/回复）
app.post('/api/chat', (req, res) => {
    const { text, username } = req.body;
    if (!text) {
        return res.status(400).json({ code: -1, msg: '缺少 text 参数' });
    }

    if (!viduHostClient || viduHostClient.readyState !== WebSocket.OPEN) {
        return res.status(503).json({ code: -2, msg: 'Vidu 数字人未连接或未在线' });
    }

    const payload = {
        type: 'inject-chat',
        text: text,
        username: username || '观众'
    };

    viduHostClient.send(JSON.stringify(payload));
    console.log(`[API] 收到弹幕/文本交互: ${username || '观众'}: ${text}`);
    res.json({ code: 0, msg: '已发送至数字人' });
});

// 2. 动作干预指令接口（让数字人做动作，如比剪刀手、挥手、戴墨镜）
app.post('/api/action', (req, res) => {
    const { action } = req.body;
    if (!action) {
        return res.status(400).json({ code: -1, msg: '缺少 action 参数' });
    }

    if (!viduHostClient || viduHostClient.readyState !== WebSocket.OPEN) {
        return res.status(503).json({ code: -2, msg: 'Vidu 数字人未连接或未在线' });
    }

    const payload = {
        type: 'inject-action',
        action: action
    };

    viduHostClient.send(JSON.stringify(payload));
    console.log(`[API] 收到动作指令: ${action}`);
    res.json({ code: 0, msg: `已发送动作: ${action}` });
});

// 3. 服务状态检查
app.get('/api/status', (req, res) => {
    res.json({
        viduOnline: !!viduHostClient && viduHostClient.readyState === WebSocket.OPEN,
        obsClients: obsClients.size,
        localIP: localIP,
        obsUrl: `http://${localIP}:${PORT}/obs.html`,
        controllerUrl: `http://${localIP}:${PORT}/controller.html`
    });
});

process.on('uncaughtException', (err) => {
    console.warn('[UncaughtException 被安全捕获]', err.message);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.log(`[Bridge Server] 端口 ${PORT} 已有服务在运行。`);
    } else {
        console.error('[Bridge Server] 服务启动异常:', err);
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('\n======================================================');
    console.log('🚀 Vidu S2 数字人局域网纯净推流与弹幕交互中继服务已启动！');
    console.log('------------------------------------------------------');
    console.log(`👉 本地控制面板:    http://127.0.0.1:${PORT}/controller.html`);
    console.log(`👉 跨电脑 OBS 采集地址: http://${localIP}:${PORT}/obs.html`);
    console.log(`👉 弹幕/指令 API:     http://${localIP}:${PORT}/api/chat`);
    console.log('======================================================\n');
});
