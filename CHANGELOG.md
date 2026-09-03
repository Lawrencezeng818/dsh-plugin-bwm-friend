# Changelog

## Unreleased（2026-09-03）

### 修复·第二轮（模板⇒音色/人格联动，tests/status-sync-verify.sh T1-T14 全绿；红灯先行 7 FAIL）
- **P1 切换模板音色不跟随**（用户报告）：桌面版语义 = 切模板音色随模板变（`applyTemplateSwitch` 里 `data.voice` 随模板返回）；插件免刷新切换只 PUT `avatar.theme`，音色死在原地。新增 `__bwmThemeVoice` 预设表（甜心女孩→茉莉、电竞男孩→Milo、可爱孙女HD→冰糖、迷人少妇→Chloe、霸道女总裁→Mia；未知主题保持当前音色，不盲改克隆音）+ 共享入口 `__bwmSwitchTheme`：一次 PUT 原子持久化 theme+voice，随后同步高亮/热切视频/音色下拉与状态
- **P2 人格不随模板重载**：桌面版人格按模板存储（reload 后 loadPersona 取新模板人格）；插件砍成全局单值但标签仍写"当前模板"，切模板后输入框内容不随动。新增 `avatar.personas`（按主题映射），读取规则 `personas[theme]` 优先、缺失回退 legacy `avatar.persona`（升级零迁移）；`wirePersona` 按 theme 读、保存写整张 personas map（客户端读改写，规避服务端浅合并整表覆盖）；`companionChat` 人格注入同规则按当前主题取
- **模板切换入口收敛**：`fillTemplates` 与 `fillCustomTemplates` 两处点击各自 PUT 只存 theme（漏音色/人格联动）→ 收敛到唯一共享入口 `__bwmSwitchTheme`（修根不修枝）

### 测试
- `status-sync-verify.sh`/`verify-shim.mjs` 扩至 **T1-T14**（新增：启动人格按主题读取、切模板音色跟随预设、原子持久化 theme+voice、人格按主题回退/恢复、personas 保存写回）；修复前 7 FAIL → 修复后 ALL PASS
- `p2-voice-smoke.cjs` 无 `XIAOMI_MIMO_API_KEY` 时显式 SKIP 并说明（TTS 后端必返 missing-key，此前让人误判为链路回归）
- host 端点回归 17/17（沙盒 3200 按 `dsh-sandbox/start.sh` 文档重启后）

## Unreleased（2026-09-03 第一轮）

### 修复（全部 tests/status-sync-verify.sh 实测回归通过：修复前快照 6 FAIL → 修复后 9 PASS）
- **P1 设置面板模板初始高亮缺失**：`fillTemplates` 初始高亮读 `localStorage['bwm-config']`——全代码库无任何写入点，高亮永远为空（用户实测：当前是"电竞男孩"的视频，打开设置无对应高亮）。改为与服务端 `/bwm-friend/settings` 单一真相源对齐
- **P1 音色回显不齐 + 从不持久化**：`fillVoices` 硬编码回显"冰糖"、`voiceSelect` 无 change 监听（选了不保存，刷新即回显错值）。改为回显服务端 `voice.voice`（自定义/克隆音色追加为选项）+ 选择即 PUT 保存
- **P1 主题状态多路不一致**：点击模板卡只同步 `#templateGrid` 高亮，皮肤卡无高亮联动、"当前模板"标签不热更新 → 同屏三处状态互相矛盾。收敛为共享 `__bwmApplyTheme`（预设区 + 皮肤卡 + 标签一次同步）与 `__bwmHotSwapIdle`（选片规则与加载期一致：皮肤优先→精确匹配→根目录兜底）
- **"默认"卡值错位**：点击"默认"卡把字面量 `默认` 存进 config，而 inventory 主题名为 `(root)`，加载期选片必失配回退 `idle[0]`（视频与保存主题脱钩）。卡值改存 `(root)`、UI 显示"默认"
- **主题枚举混入非模板资产**：`custom_uploads`（用户上传杂物）此前会成为可点击模板卡（无 idle → 点击后视频回退根目录，状态再度脱钩）。枚举过滤为 `idle`/`talk` 资产
- 清理居中模态内无消费的 settings 死 fetch

### 测试
- 新增 `tests/status-sync-verify.sh` + `tests/verify-shim.mjs`：任意版本 lib 挂独立 shim 服务（HOME 隔离不碰真实配置），headless Chrome 真实渲染 work 页做 T1-T9 DOM 断言；修复前快照复现 6 FAIL，修复后 ALL PASS；host 端点回归 17/17

## 0.3.2 (2026-09-02)

### 修复（全部 ego-browser 实测回归通过）
- **P1 会话列表无法切换（回归修复）**：`wireSidebarA11y` 在 pop 弹窗模式跳过 inert/aria-hidden——`inert` 会在 hit-testing 阶段吞掉真实鼠标点击（程序化 `.click()` 不受影响，合成事件绕过，自动化回归因此漏检）
- **P1 TodoPanel 尺寸与原生不一致**：EMBEDDED_CSS 全局 `[class*=root]` `height:100%` 误命中 composer dock 内组件 root，收起态 36px 被撑到 170px、展开 358px → 豁免 `[class*=composerStack] *`；全局滚动条隐藏规则吞掉 `.list` 滚动条 → dock 内恢复 thin/8px。实测收起 38px / 展开 226px / 滚动条可见
- **弹层「新会话」跨窗口同步**：pop 端捕获拦截 + 转发 `bwm-pop-new-session`，父页转发主 iframe 原生新建+切换（此前弹层内创建后主窗口不跟随，与原生行为不一致）
- **ask/choice 选项卡片防截断**：卡片内容需 ~802px > 旧固定宽 742px，选项/提交键被裁 → 对话区改响应式 `clamp(620px, 48vw, 1080px)` + 卡片双挂载位（composerSeat/scrollBody）max-width 约束 + 按钮换行
- **历史会话裸 DSML 控制标记清洗**：显示层 MutationObserver 增量折叠为「历史工具调用·已折叠」占位（原文存 title），不动会话数据
- **工作区遮罩交互**：首次打开 toast 关闭提示 + Esc 关闭 + cursor/title
- **读屏降噪**：主 iframe 抽屉收起时 `aria-hidden`+`inert`（仅主 iframe；pop 模式豁免）
- 登记 `EMBEDDED_SELECTORS.askCard = eT_Osq_`（ask 卡片 hashed 前缀）

### 变更
- 对话区宽度 742px 固定 → `clamp(620px, 48vw, 1080px)` 响应式（大屏对话区占比过低 + 卡片截断）

### 测试
- e2e 模型菜单断言修正：回归点是「点击后弹出」（菜单可见且内容非空）；菜单内部结构随 DSH 版本/模型目录而异，不再硬断言推理等级行
- e2e 弹窗断言对齐 0.3.1 设计：点会话后弹窗保持打开（连续切换），旧断言「点会话后关闭」过时（被旧沙盒进程掩盖）
- host 新增 2 项 DoS 用例（请求体上限 413 + 进程存活），15 → 17
- 服务端发布加固：`readJsonBody` 请求体上限 1MB（transcribe 音频放宽 25MB）+ settings PUT/work/task 内联读取同步收口 + 超限前排空请求流（防 keep-alive 连接 ECONNRESET）

## 0.3.1 (2026-08-26)

- 工作区面板会话列表交互重构 + loading 失败态兜底（轮询会话树渲染成功即移除 loading；10s 超时显示失败态+重试，杜绝无限 loading）
- 嵌入式自动滚动修复（遍历所有候选滚动容器）

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
