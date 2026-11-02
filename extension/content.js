console.log('%c[Vidu Extension] 纯净净化脚本已被 Chrome 成功加载！', 'color: #00ff00; font-size: 16px;');

// 核心：强力 DOM 扫描与精准隐藏
function purgeUglyElements() {
    // 1. 隐藏带 "AI生成数字人" 的文字及其遮罩容器
    const textNodes = document.querySelectorAll('div, span, p');
    textNodes.forEach(el => {
        const text = el.innerText ? el.innerText.trim() : '';
        if (text.includes('AI生成数字人') || text.includes('Vidu S')) {
            // 将该文字元素及其父容器彻底隐藏
            el.style.setProperty('display', 'none', 'important');
            if (el.parentElement) el.parentElement.style.setProperty('display', 'none', 'important');
        }
        // 隐藏计时器 (如 00:06)
        if (/^\d{2}:\d{2}$/.test(text)) {
            el.style.setProperty('display', 'none', 'important');
        }
    });

    // 2. 隐藏右上角的分享按钮图标
    const shareBtns = document.querySelectorAll('button, svg, div');
    shareBtns.forEach(el => {
        if (el.tagName === 'BUTTON' && el.querySelector('svg') && el.getBoundingClientRect().top < 100 && el.getBoundingClientRect().right > (window.innerWidth - 100)) {
            el.style.setProperty('display', 'none', 'important');
        }
    });

    // 3. 隐藏底部那 5 个圆圈控制按钮（麦克风、摄像头、转换、输入、挂断）
    // 它们的特征：全是圆形按钮 (border-radius: 50%) 且集中在屏幕底部 150px 以内
    const buttons = document.querySelectorAll('button');
    buttons.forEach(btn => {
        const rect = btn.getBoundingClientRect();
        // 位于底部区域且包含 svg 图标
        if (rect.top > (window.innerHeight - 180) && btn.querySelector('svg')) {
            // 平时完全隐藏！
            btn.style.setProperty('opacity', '0', 'important');
            btn.style.setProperty('pointer-events', 'none', 'important');
        }
    });

    // 4. 让数字人视频元素全屏顶格展示，不留杂边
    const video = document.querySelector('video');
    if (video) {
        video.style.setProperty('width', '100vw', 'important');
        video.style.setProperty('height', '100vh', 'important');
        video.style.setProperty('object-fit', 'contain', 'important');
        video.style.setProperty('background', '#000', 'important');
    }
}

// 持续每 200 毫秒高频扫描，确保 React 动态渲染出来的 DOM 一出现就被立刻抹杀
setInterval(purgeUglyElements, 200);

// 提供鼠标悬浮在底部边缘时呼出控制栏的交互
window.addEventListener('mousemove', (e) => {
    const isAtBottom = e.clientY > (window.innerHeight - 80);
    const buttons = document.querySelectorAll('button');
    buttons.forEach(btn => {
        const rect = btn.getBoundingClientRect();
        if (rect.top > (window.innerHeight - 180) && btn.querySelector('svg')) {
            if (isAtBottom) {
                btn.style.setProperty('opacity', '1', 'important');
                btn.style.setProperty('pointer-events', 'auto', 'important');
            } else {
                btn.style.setProperty('opacity', '0', 'important');
                btn.style.setProperty('pointer-events', 'none', 'important');
            }
        }
    });
});
