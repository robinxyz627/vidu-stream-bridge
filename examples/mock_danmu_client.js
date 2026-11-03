#!/usr/bin/env node
/**
 * Vidu S2 数字人弹幕中继 - Node.js 模拟客户端 (Mock Danmu Client)
 * 依赖：仅使用 Node.js 原生 http 模块，无需 npm 依赖。
 * 运行方式：
 *   node mock_danmu_client.js --demo
 *   node mock_danmu_client.js --chat "你好呀"
 */

const http = require('http');

const HOST = process.env.DANMU_HOST || '127.0.0.1';
const PORT = parseInt(process.env.DANMU_PORT || '8010', 10);

function sendDanmu(event) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(event);
        const req = http.request({
            hostname: HOST,
            port: PORT,
            path: '/human',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': Buffer.byteLength(payload)
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                console.log(`[OK ${res.statusCode}] 事件 [${event.type}]: ${data}`);
                resolve(data);
            });
        });

        req.on('error', (err) => {
            console.error(`[ERROR] 连接失败 (http://${HOST}:${PORT}/human): ${err.message}`);
            reject(err);
        });

        req.write(payload);
        req.end();
    });
}

async function runDemo() {
    console.log(`=== 开始全事件 Demo 演示 -> http://${HOST}:${PORT}/human ===\n`);
    const events = [
        { type: 'chat', nickname: '小明', gender: '男', content: '主播好，今天穿得真可爱！' },
        { type: 'chat', nickname: '水军', gender: '男', content: '666' },
        { type: 'gift', nickname: '榜一大哥', gender: '男', giftName: '嘉年华', giftCount: 1, diamondCount: 3000 },
        { type: 'follow', nickname: '甜心小喵', gender: '女' },
        { type: 'chat', nickname: '时间询问者', gender: '女', content: '现在几点钟啦？' }
    ];

    for (let i = 0; i < events.length; i++) {
        console.log(`[${i + 1}/${events.length}] 投递事件:`, JSON.stringify(events[i]));
        try {
            await sendDanmu(events[i]);
        } catch (e) {}
        await new Promise(r => setTimeout(r, 1200));
    }
    console.log('\n=== Demo 演示完成 ===');
}

if (process.argv.includes('--demo')) {
    runDemo();
} else {
    // 默认发送一条测试聊天
    const content = process.argv[2] || '主播你好呀，很高兴认识你！';
    sendDanmu({ type: 'chat', nickname: '测试观众', gender: '女', content });
}
