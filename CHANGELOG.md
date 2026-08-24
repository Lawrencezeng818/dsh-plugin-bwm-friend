# Changelog

## 0.3.0 (2026-08-24)

### 架构（Runtime 化）
- P1.1 Event Kernel 迁入 `@laikaton/bwm-runtime-core`（createEventBus + EVENT_VERSIONS + createRuntime 协议面）
- P1.2 Context Runtime（8 域 + ownership 治理 + CONTEXT_VERSIONS + shellSet 校验）
- P1.3 Capability Layer（negotiate 能力协商：requires/capabilities 分离、full/lite 降级）
- P1.4 Runtime Contract（Shell 物理隔离：grep 红线全 0；Context/Ledger/Presence 状态机全部迁出；协议值域冻结）
- Runtime v1.1 稳定化：DOMAIN_POLICY（Runtime State ≠ Persistent State）+ persistSnapshot 防抖 + requestState 状态机 + presence MutationObserver 事件驱动 + memory 串行化 + inventory 生命周期缓存 + iframe loading + Audio 复用
- P3 SDK v0.1：`@laikaton/bwm-sdk`（Agent.send/cancel/status、Persona.get/switch、Presence.state/observe）

### 功能
- P2-Voice：MiMo ASR/TTS 代理（/bwm-friend/transcribe + /tts）+ 按住说话 → 自动发送 + 回复自动朗读 + 8 音色
- P2-Memory/Persona：Identity Runtime 雏形（IDENTITY_PRESET 单一来源）+ Mira 记忆（FACT_PATTERNS 抽取/跨消息注入/问句噪音过滤）
- 对话宽度对齐陪伴模式：iframe 742px（dialogue-panel 全宽）

### 安全（代码审查）
- CSRF 防护（Sec-Fetch-Site/Origin 同源校验，跨源 403）——防 RCE 级跨源 agent 触发
- 静态资源 DoS（createReadStream error 崩进程）→ stat 预检 + stream error 监听
- 路径穿越（serveCompanion resolve 校验）
- media token 随机 UUID（防路径泄漏）
- Range RFC 7233（suffix-range 正确 + start>end 416）
- memory 原子写（temp+rename）+ 串行化
- postMessage 发送 targetOrigin 收紧同源

### 测试
- runtime-core 32/32、host-endpoints 15/15、E2E 12/12、P2-VOICE、S3-PRESENCE

## 0.2.0 (2026-08-24)

### 修复
- P1 模型菜单/workspace 菜单/用量圆环面板被裁剪：EMBEDDED_CSS `[class*=root]{overflow-y:auto}` 误伤组件 root（PNUCKq_root/_8Ce2OW_root），滚动只保留 centerCol/scrollBody/viewArea
- 模型/命令/Workspace Write 按钮不可见（全透明背景+浅字对比度不足）→ 深色半透明底+青色边框
- 发送键 disabled 态 opacity 0.4 几乎消失 → 保持 0.65
- 发送键渐变被 `[class*=trailing] button` 覆盖 → `.p7GS4W_trailing .p7GS4W_primary` 提权
- hero 高度被 `[class*=root]{height:100%}` 压到 81px → card 底部按钮行被裁 37px → hero auto
- heroGlow 装饰 svg 撑出 88px 垂直滚动 → 隐藏
- ContextMeter root 被 `[class*=root]{width:100%}` 撑到 341px 压塌模型按钮容器 → span width auto + data-slot min-width
- 侧栏窄屏 collapsed（iframe 620 < SIDEBAR_AUTO_COLLAPSE 1024）会话树不渲染 → 自动触发原生 toggle
- 抽屉遮挡 composer → 选会话自动收起
- P0 安全：postMessage 3 处监听 origin 校验 + 2 处发送 targetOrigin 收紧同源

### 功能
- 任务信息条上移融合顶栏：DSH 会话 header 垂直两行(76px) → 横向单行紧凑条(44px)
- ☰ 工作区弹窗：屏幕最右透明毛玻璃（right:0 + backdrop-blur），内嵌 iframe `/?bwm=embedded&pop=1` 仅侧栏会话树；点会话 → postMessage 三跳切换主 iframe + 自动关闭
- 对话宽度：620 → 600px（用户指定）

## 0.3.1 (2026-08-24)
### 功能
- 皮肤资产包机制：插件自动发现 node_modules/@laikaton/bwm-skin-*/assets（换皮肤=换资产包）
- @laikaton/bwm-skin-mira@1.0.0（电竞男友主题 idle+talk，~3.7M）已发布 npm
- ASSET_ROOTS 优先级：env BWM_ASSET_ROOTS → 本地开发路径 → 皮肤包自动发现

## 0.3.2 (2026-08-24)
### 修复
- 默认主题改为甜心女孩（DEFAULT_CONFIG avatar.theme '电竞男友' → '甜心女孩'）
- companion-init.js pick 逻辑修复：按 config theme 选待机视频（原来写死 idle[0] 不看主题）
- 皮肤包 bwm-skin-mira 1.1.0：电竞男友 → 甜心女孩资产（idle+talk）
