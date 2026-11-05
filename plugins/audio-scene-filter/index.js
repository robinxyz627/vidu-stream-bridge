// plugins/audio-scene-filter/index.js
// 场景音色/空间混响滤镜插件后台执行引擎

module.exports = function createAudioSceneFilterPlugin(bridge) {
    let config = {
        enabled: true,
        monitor_local: false,
        active_preset: "bathroom",
        bindings: [],
        presets: {}
    };

    let currentAvatarId = null;

    // 应用当前预设或根据角色自动绑定
    function applyActivePreset(presetKey, reason = '') {
        if (!config.enabled) {
            bridge.setAudioParams({
                enabled: false,
                wet: 0.0,
                dry: 1.0,
                monitor_local: false
            });
            return;
        }

        const key = presetKey || config.active_preset || 'bathroom';
        const preset = (config.presets && config.presets[key]) || {
            name: '默认空间',
            roomSize: 0.8,
            dampening: 0.3,
            wet: 0.5,
            dry: 0.8,
            lowCut: 80,
            highCut: 8000
        };

        config.active_preset = key;

        bridge.setAudioParams({
            enabled: true,
            roomSize: preset.roomSize,
            dampening: preset.dampening,
            wet: preset.wet,
            dry: preset.dry,
            lowCut: preset.lowCut,
            highCut: preset.highCut,
            monitor_local: !!config.monitor_local
        });

        if (reason) {
            bridge.log(`🎙️ [场景音效插件] ${reason} -> 已挂载空间音效:【${preset.name}】(湿度: ${(preset.wet * 100).toFixed(0)}%, 空间: ${(preset.roomSize * 100).toFixed(0)}%)`);
        }
    }

    // 根据角色 ID 查找绑定的预设
    function onAvatarChanged({ id, name }) {
        if (!id) return;
        currentAvatarId = id;

        if (!config.enabled) return;

        // 在 bindings 中查找匹配项
        const matched = (config.bindings || []).find(b => b.avatarId === id || (name && b.avatarName === name));
        if (matched && matched.presetKey && config.presets && config.presets[matched.presetKey]) {
            applyActivePreset(matched.presetKey, `角色切换 [${name || id}] 触发预设`);
        } else {
            // 未专门绑定的角色，保持当前预设或直通
            console.log(`[AudioFilter] 角色 [${name || id}] 未配置专用音色绑定，保持当前预设: ${config.active_preset}`);
        }
    }

    // 初始化载入配置
    async function init() {
        try {
            const saved = await bridge.loadConfig('audio-scene-filter');
            if (saved && Object.keys(saved).length > 0) {
                config = Object.assign({}, config, saved);
            }
            bridge.log(`🎙️ [场景音效插件] 已就绪！当前激活预设:【${config.active_preset}】，已绑定规则数: ${(config.bindings || []).length}`);

            // 监听配置保存热重载
            bridge.onConfigUpdated('audio-scene-filter', (newCfg) => {
                config = Object.assign({}, config, newCfg);
                applyActivePreset(config.active_preset, '配置已更新');
            });

            // 监听角色切换事件（换装、下拉切换、初始开播）
            if (typeof bridge.onAvatarChange === 'function') {
                bridge.onAvatarChange((avatar) => {
                    onAvatarChanged(avatar);
                });
            }

            // 初始应用一次
            applyActivePreset(config.active_preset);
        } catch(e) {
            console.error('[AudioFilter] 初始化失败:', e);
        }
    }

    init();

    return {
        getConfig: () => config,
        applyPreset: (key) => applyActivePreset(key, '手动选择预设'),
        setMonitor: (val) => {
            config.monitor_local = !!val;
            applyActivePreset(config.active_preset);
        }
    };
};
