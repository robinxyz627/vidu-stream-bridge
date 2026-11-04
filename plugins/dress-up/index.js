/**
 * 智能送礼/指令无缝换装插件 (Dress-Up Plugin Backend)
 */
module.exports = function createDressUpPlugin(bridge) {
    let lastSwitchTime = 0;
    let config = {
        enabled: true,
        cooldown: 40,
        transition_speech: "收到【{nickname}】的心意，我先去换套新衣服，马上回来哦~",
        rules: []
    };

    // 初始化时加载配置
    async function init() {
        try {
            const saved = await bridge.loadConfig('dress-up');
            if (saved && typeof saved === 'object') {
                config = { ...config, ...saved };
            }
            bridge.log(`👗 [换装插件] 已启动就绪，当前规则数: ${(config.rules || []).length}，冷却防抖: ${config.cooldown}s`);
        } catch(e) {
            console.warn('[DressUpPlugin] 加载配置失败:', e);
        }
    }

    // 监听实时配置更新
    if (bridge.onConfigUpdated) {
        bridge.onConfigUpdated('dress-up', (newCfg) => {
            config = { ...config, ...newCfg };
            bridge.log(`👗 [换装插件] 收到实时配置热更新！当前规则数: ${(config.rules || []).length}`);
        });
    }

    // 核心事件拦截与换装调度
    bridge.onDanmu(async (event) => {
        if (!config.enabled) return;
        const now = Date.now();
        const cooldownMs = (config.cooldown || 40) * 1000;

        // 遍历换装规则
        const rules = config.rules || [];
        for (const rule of rules) {
            let matched = false;

            if (rule.type === 'gift_name' && event.type === 'gift') {
                const giftName = event.giftName || '';
                if (giftName && giftName.includes(rule.trigger)) matched = true;
            } else if (rule.type === 'gift_diamonds' && event.type === 'gift') {
                const threshold = parseInt(rule.trigger, 10);
                if (event.diamondCount >= threshold) matched = true;
            } else if (rule.type === 'chat_command' && event.type === 'chat') {
                const content = event.content || '';
                if (content && content.includes(rule.trigger)) matched = true;
            }

            if (matched) {
                // 检查冷却
                if (now - lastSwitchTime < cooldownMs) {
                    const waitSec = Math.ceil((cooldownMs - (now - lastSwitchTime)) / 1000);
                    bridge.log(`👗 [换装插件] 命中换装规则 [${rule.trigger} -> ${rule.targetAvatarName || rule.targetAvatarId}]，但处于冷却期，还需等待 ${waitSec}s`);
                    return;
                }

                // 检查当前角色是否已经是目标角色
                const currentAvatar = bridge.getCurrentAvatar();
                if (currentAvatar && currentAvatar.id === rule.targetAvatarId) {
                    bridge.log(`👗 [换装插件] 目标角色已经是 [${rule.targetAvatarName || rule.targetAvatarId}]，无需重复切换`);
                    return;
                }

                lastSwitchTime = now;
                bridge.log(`🎉 👗 [换装插件] 成功触发无缝换装！由观众【${event.nickname}】触发 -> 变身为【${rule.targetAvatarName || rule.targetAvatarId}】`);

                // 1. 注入过渡台词
                const speechTpl = rule.speech || config.transition_speech || "收到心意啦，我先去换套衣服，马上回来哦~";
                const speech = speechTpl
                    .replace(/\{nickname\}/g, event.nickname || '热心观众')
                    .replace(/\{giftName\}/g, event.giftName || '礼物')
                    .replace(/\{target\}/g, rule.targetAvatarName || '新角色');

                bridge.sendChat(speech);

                // 2. 触发底层的 A/B 双舞台无缝热换装！
                bridge.switchAvatar(rule.targetAvatarId, rule.targetAvatarName);
                break;
            }
        }
    });

    init();

    return {
        reloadConfig: init
    };
};
