// ==UserScript==
// @name         Vidu S2 纯净 OBS 转发与弹幕交互桥接插件
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  抹除 Vidu 丑陋 UI，提取高清纯净 WebRTC 音视频并转发至局域网 OBS，支持弹幕注入与动作干预
// @author       Antigravity
// @match        https://www.vidu.cn/vidu-stream/*
// @match        https://vidu.cn/vidu-stream/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const BRIDGE_WS_URL = 'ws://127.0.0.1:8888/?role=vidu-host';
    let ws = null;
    let localStream = null;
    let peerConnections = [];

    console.log('%c[Vidu Bridge] 纯净桥接扩展已加载！正在寻找媒体流与建立局域网转发...', 'color: #00d2ff; font-weight: bold;');

    // 1. 彻底抹除所有丑陋的网页前端 UI，只保留中央纯净视频
    function injectPureModeStyles() {
        const style = document.createElement('style');
        style.id = 'vidu-pure-mode-style';
        style.innerHTML = `
            /* 隐藏底部水印 "AI生成数字人 | Vidu S" 与右下角说明 */
            div[class*="watermark"],
            div[class*="footer"],
            div[class*="copyright"],
            span:contains("AI生成数字人"),
            /* 隐藏所有控制栏（麦克风、摄像头、挂断按钮等） */
            div[class*="controls"],
            div[class*="action-bar"],
            div[class*="bottom-bar"],
            /* 隐藏顶部计时器 00:01 和分享按钮 */
            div[class*="timer"],
            button[class*="share"],
            /* 隐藏角色头顶多余的遮罩层 */
            div[class*="mask-layer"] {
                opacity: 0 !important;
                pointer-events: none !important;
            }

            /* 让视频元素全屏居中、自适应任意比例（9:16 或 16:9）无畸变 */
            video {
                width: 100vw !important;
                height: 100vh !important;
                max-width: 100vw !important;
                max-height: 100vh !important;
                object-fit: contain !important;
                position: fixed !important;
                top: 0 !important;
                left: 0 !important;
                z-index: 999999 !important;
                background-color: #000 !important;
            }
        `;
        document.head.appendChild(style);

        // 定时轮询，精准清理绝对定位覆盖的 DOM 文字
        setInterval(() => {
            const allElements = document.querySelectorAll('div, span, p');
            for (const el of allElements) {
                if (el.children.length === 0 && (el.innerText.includes('AI生成数字人') || el.innerText.includes('Vidu S'))) {
                    el.style.display = 'none';
                }
            }
        }, 1000);
    }

    // 2. 捕获数字人的原生音视频 MediaStream
    function hookMediaStream() {
        // 定时轮询检查 video 元素
        const timer = setInterval(() => {
            const video = document.querySelector('video');
            if (video && video.srcObject && video.srcObject.getTracks().length > 0) {
                localStream = video.srcObject;
                console.log('%c[Vidu Bridge] 成功捕获数字人音视频流！', 'color: #00e676; font-weight: bold;', localStream);
                clearInterval(timer);
                initWebSocketBridge();
            }
        }, 800);
    }

    // 3. 连接本地 Node.js 局域网转发中继服务
    function initWebSocketBridge() {
        try {
            ws = new WebSocket(BRIDGE_WS_URL);
        } catch (e) {
            console.warn('[Vidu Bridge] 无法连接到本地中继服务 8888，请确认已启动 node server.js');
            return;
        }

        ws.onopen = () => {
            console.log('%c[Vidu Bridge] 已连通本地中继服务！准备好推流给 OBS。', 'color: #00e676; font-weight: bold;');
        };

        ws.onmessage = async (event) => {
            const data = JSON.parse(event.data);

            if (data.type === 'obs-ready') {
                console.log('[Vidu Bridge] 收到 OBS 准备就绪信号，正在创建 WebRTC 推流 Offer...');
                await startWebRTCToOBS();
            } else if (data.type === 'signal-answer') {
                if (window.currentPC) {
                    await window.currentPC.setRemoteDescription(new RTCSessionDescription(data.answer));
                    console.log('[Vidu Bridge] 成功与 OBS 建立 WebRTC 通道！OBS 现在已有纯净画面与声音。');
                }
            } else if (data.type === 'signal-ice') {
                if (window.currentPC && data.candidate) {
                    try {
                        await window.currentPC.addIceCandidate(new RTCIceCandidate(data.candidate));
                    } catch (e) {}
                }
            } else if (data.type === 'inject-chat') {
                // 收到外部弹幕/文本交互指令
                injectTextInput(data.text);
            } else if (data.type === 'inject-action') {
                // 收到动作干预指令
                injectActionCommand(data.action);
            }
        };

        ws.onclose = () => {
            console.log('[Vidu Bridge] 与本地中继连接断开，5秒后尝试重连...');
            setTimeout(initWebSocketBridge, 5000);
        };
    }

    // 4. 将原生捕获的 MediaStream 转化为 WebRTC 直连发给 OBS
    async function startWebRTCToOBS() {
        if (!localStream) {
            const video = document.querySelector('video');
            if (video) localStream = video.srcObject;
        }

        if (!localStream) {
            console.warn('[Vidu Bridge] 尚未获取到数字人视频流，等待流就绪...');
            return;
        }

        const pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });
        window.currentPC = pc;

        localStream.getTracks().forEach(track => {
            pc.addTrack(track, localStream);
        });

        pc.onicecandidate = (event) => {
            if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'signal-ice',
                    candidate: event.candidate
                }));
            }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        ws.send(JSON.stringify({
            type: 'signal-offer',
            offer: offer
        }));
    }

    // 5. 自动寻找页面底部的输入框，注入弹幕或文本指令并发送
    function injectTextInput(text) {
        console.log('[Vidu Bridge] 正在注入文本/弹幕:', text);

        // 寻找文本输入框或者可编辑区域
        let inputEl = document.querySelector('input[type="text"], textarea, [contenteditable="true"]');
        if (!inputEl) {
            // 如果输入框被折叠在某个“手柄/道具/键盘”按钮里，尝试先触发打开
            const toggleButtons = document.querySelectorAll('button, svg');
            for (const b of toggleButtons) {
                if (b.getAttribute('aria-label')?.includes('输入') || b.className?.includes('input') || b.className?.includes('tool')) {
                    b.click();
                    break;
                }
            }
            inputEl = document.querySelector('input[type="text"], textarea, [contenteditable="true"]');
        }

        if (inputEl) {
            if (inputEl.tagName === 'INPUT' || inputEl.tagName === 'TEXTAREA') {
                inputEl.value = text;
                inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                inputEl.dispatchEvent(new Event('change', { bubbles: true }));
            } else {
                inputEl.innerText = text;
                inputEl.dispatchEvent(new Event('input', { bubbles: true }));
            }

            // 模拟按下 Enter 回车发送
            setTimeout(() => {
                const enterEvent = new KeyboardEvent('keydown', {
                    key: 'Enter',
                    code: 'Enter',
                    keyCode: 13,
                    which: 13,
                    bubbles: true
                });
                inputEl.dispatchEvent(enterEvent);
                console.log('%c[Vidu Bridge] 弹幕/指令已成功注入发送！', 'color: #00e676;');
            }, 100);
        } else {
            console.warn('[Vidu Bridge] 未能在页面上找到输入框，请确保已打开指令/输入弹窗');
        }
    }

    // 6. 动作指令注入（如比剪刀手、眨眼等）
    function injectActionCommand(action) {
        console.log('[Vidu Bridge] 正在注入动作指令:', action);
        injectTextInput(action);
    }

    // 启动执行
    injectPureModeStyles();
    hookMediaStream();

})();
