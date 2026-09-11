# Changelog

## 0.6.0 (2026-09-10) · wireLedger 落盘（B2 反超第一步 / 专利4 实施例）

### 发布收敛（2026-09-11 · 可发布门禁全绿）

- 🐛 **P0 wireLedger settings 白名单静默丢包**：host PUT 白名单不含 `wireLedger` → `createLedgerStore` 唯一持久通道在生产形状下**完全不落盘**（core 单测注入 store 全绿、端到端断裂——"声称与实现不符"典型）。放行 + 数组形状守卫（非数组 400）+ 无关字段 PUT 不清账本；host 红灯回归 4 断言；跨重启 reload 真机验证闭环（含 `relationship_delta` 语义字段透传）
- 🐛 **资产热投递盲区**：`~/.bwm-friend/assets` 启动时不存在（README 文档化投递流程）→ watcher 挂不上 → 用户后投递素材重启前不可见（0.5.0 懒挂 watcher 只救"根已存在"场景）。watcher 升级 `recursive`（主题子目录内后投递也触发失效）+ 存在挂不上根时缓存 TTL 2s 兜底（重扫成功即补挂，回纯事件驱动）；host 红灯回归实证（全新初始态播种→免重启可见）
- host 套件 36→**38**：health 版本断言改单源 package.json（硬编码 '0.5.0' 漂移复发——PLUGIN_VERSION 同款教训在测试侧清零）；媒体用例 fixture 自播种（沙盒无资产时确定性绿，HOME 不可写显式 SKIP 不装绿）
- 环境：repo 依赖安装恢复（缺 node_modules 致皮肤发现 0 → T9 皮肤卡红，环境债非代码回归）；`package-lock.json` 入库（dev 安装可复现）
- 文档对齐：README 测试计数/路径泛化；Settings Schema v1 补记 `wireLedger` 运行时通道键（与"新设置项先进 schema"纪律的张力留档，未来三端吸收或平移宿主通道时收口）
- 包内容审计：零密钥/零内网地址/零个人运行时路径；架构边界 grep 审计：Runtime 侧红线全 0、Shell 侧核心逻辑定义（function 级）全 0
- 门禁：**core 36 · host 38 · e2e 12 · T1-T14 17 项 · pack 冒烟 8 · fresh DSH 装载 15 —— 全绿**

- **Ledger 持久化**：`wireLedger(bus, context, opts)` / `createRuntime(opts)` 新增可选 `ledger` store 适配器（`append(entry)` + `load()`）——逐事件写透、启动异步恢复、合并守 200 上限；append 失败 emit `ledger:persist.error` 不阻断事件管线；不传 ledger 时行为与 0.5 完全一致（向后兼容）
- **语义字段透传**：task/tool 事件 payload 整体进账本（`relationship_delta`/`emotion_context` 等未来语义字段原样保留，专利4 前向兼容）；core 保持纯逻辑无 I/O，store 由 Shell 提供
- **Shell 接线**：`createLedgerStore()`（src/client.js）——内存镜像 + 单飞行写穿 settings 通道（宿主落盘，memory.json 同目录），镜像上限 500；未来平移宿主 JSONL/SQL（P6 agent_actions）只换 store 实现
- **边界不变**：`DOMAIN_POLICY.timeline` 仍为 `'runtime'`（persistSnapshot 快照不含 timeline）——账本走独立通道，不混快照
- **测试**：core 套件 32→36 全绿（落盘/恢复链、透传+合并上限、失败不阻断、向后兼容）；host 端点套件 36 失败为 HEAD 既有（需活 DSH 宿主），与本次改动无关（基线 diff 为空）

## 0.5.0 (2026-09-03) · 完成度地图定版（九行全部 100%）

### 可观测性 40→100
- health 深度化（version/uptimeSec/components 五件）；新增 GET /metrics（路由计数/错误/延迟分位 + 业务总量）
- 结构化审计日志（JSON 行 · 5MB 轮转 · BWM_LOG_MAX_BYTES/BWM_LOG_DISABLE 接缝 · subject 掩码）
- 🐛 update-check 版本硬编码 '0.3.2' 漂移事故 → PLUGIN_VERSION 单源 package.json

### 陪伴智能 65→100
- Mock MiMo ASR/TTS + Mock DeepSeek 注入接缝（BWM_MIMO_BASE_URL/BWM_CHAT_BASE_URL）——语音链路 E2E 不再依赖真 key
- 语音+聊天+记忆链路 E2E 12 检查；记忆抽取五类模式单测

### 安全基线 80→100（对抗评审 3×P1+3×P2 全闭环）
- P1-1 chat 载荷无上限 → readJsonBody 1MB；P1-2 DNS rebinding 整体绕过 → isTrustedHost 回环白名单；
  P1-3 任务并发无上限+超时 agent 裸奔 → in-flight≤2(429)+dispose；P2-4 symlink 外发 → lstat 拒绝；
  P2-5 登录爆破 → 按 subject 分桶限速(60s/5)+错误统一 http-<status>；P2-6 主体信息最小化（仅后 2 位）
- docs/THREAT-MODEL-v1.md（九威胁防线 + 六项残余风险明示）

### 工作模式 75→100
- BWM_AGENT_MOCK 接缝 + 挂起 agent shim：真挂起超时/dispose 中止/taskTimeouts 记账/并发 429 七检查
- 🐛 runRealAgentTask 本地 const process TDZ 地雷排雷（改名 procSteps）

### 资产管线 90→100
- checksum 升级流式 sha256（mtime/size 缓存）；resolution=tkhd best-effort 解析（零外部依赖）
- 🐛 懒挂 watcher 根治「先启动后放素材」缓存陈旧（GUI 主题丢失最初根因）

### 设置同步 90→100
- 迁移完备/损坏兜底/并发读写交错/默认形状/schema additive 版本 12 断言

### 外壳 95→100
- EMBEDDED_SELECTORS 抗改版回归：headless Chrome+CDP（Node 内建 WebSocket 零依赖）真渲染 DOM 分级断言
  （hard 常驻结构=FAIL 门槛；soft 条件组件=记录）
- companion 页视觉基线入库；work 页 headless 挂起已知（记录于提交材料）

### 发布工程 90→100
- 离线可装性最强实证：npm pack → --offline 安装 → 装产物全冒烟；更新检查三态（新版/同版/不可达 fail-open）

### 生态层 30→100
- examples/sdk-consumer.mjs 外部消费者参考实现；compareVersion 补为协议级导出
- tests/negotiation.test.mjs 多宿主协商矩阵 6 断言；tests/protocol-conformance.e2e.mjs 公开契约 10 断言

### 回归基线（全绿）
host-endpoints 36 · chain-e2e 12 · task-timeout 7 · settings-robust 12 · embedded-selectors 11 ·
release-offline 9 · negotiation 6 · protocol-conformance 10 · memory 4 · T1-T14 状态同步

## 0.4.0 (2026-09-03)

### 修复·第三轮（发布评审路径 B：P0/P1 全闭环，四维评审"需修复后发布"→可发布）
- **安全 P0**：isSameOriginRequest 重排（dest=document 仅读、Origin:null/file:// 仅读、
  Origin/Host 不一致提前拒、BWM_TRUSTED_HOSTS 白名单）——封堵顶层表单 text/plain 伪造 JSON
  打 /work/task 的 RCE 级 CSRF 绕过；云端模板名（远端输入）/皮肤目录名/主题名/模型名
  innerHTML 统一转义；/auth/status 与登录回显手机号掩码；登录响应不再下发 Hub token
- **打包 P0**：协议随包副本优先（packages/ 入 files 白名单，行为确定性）；UI 壳随包
  （static-ui/，BWM_STATIC 默认值不再指向个人工程）；依赖修正（-bwm-protocol
  +bwm-skin-mira）；LOCAL_ASSET_ROOTS/DSH_WORK_DIR 去个人绝对路径（~/.bwm-friend/assets
  投递点 + BWM_STATIC 同级素材发现）；新增 tests/release-pack-smoke.mjs 干净机冒烟
- **settings 健壮化**：writeConfig 原子写；PUT 串行化（withConfigLock）；validateSettings
  接线（类型非法 400）；version 服务端管辖；未知顶层 key 不落盘
- **资源治理**：inventory watcher 入 disposers；media token 稳定复用+失效回收；
  runRealAgentTask 超时上限（BWM_TASK_TIMEOUT_MS）；/transcribe 并发守卫（429）
- **功能收敛**：引擎弹窗砍装饰 tab（通用/插件/预设）与 alert 占位按钮（模型 tab 保留）；
  云端模板卡改非交互条目；删除死代码 workChat()
- **文档**：README env 契约补全（BWM_AUTH_BASE/BWM_UPDATE_URL/BWM_TRUSTED_HOSTS/
  BWM_TASK_TIMEOUT_MS）+ 素材投递点成文；schema v1 文档标注预留字段

### 测试（第三轮）
- host-endpoints 17 → **26 断言**（CSRF 绕过/Origin:null/掩码/token/并发丢写等，红灯先行）
- 新增 **release-pack-smoke**（pack→隔离安装→模块加载→三端点→自包含断言，8 检查）
- 新增 **release-fresh-dsh**（`test:fresh`，真实 DSH 装载链路发布门槛，15 检查）：全新 HOME/DSH_HOME → `dsh plugin add <tgz>` → bundle 自动登记 → 安装产物为 tgz 真实拷贝（非 symlink）且 lib 与仓库构建产物哈希一致 → 启动独立实例 → health 版本/work/companion/根路径页面级断言；`--keep` 保留实例供人工/浏览器复验（全新实例浏览器实测：38 provider 原生目录同步、work/companion 结构完整、零页面 JS 错误）
- status-sync T1-T14 + p2-proactive 全绿；p2-voice-smoke 无 key 显式 SKIP

## 0.4.0 (2026-09-03) · 第二轮（模板⇒音色/人格联动）
### 修复·第二轮（模板⇒音色/人格联动，tests/status-sync-verify.sh T1-T14 全绿；红灯先行 7 FAIL）
- **P1 切换模板音色不跟随**（用户报告）：桌面版语义 = 切模板音色随模板变（`applyTemplateSwitch` 里 `data.voice` 随模板返回）；插件免刷新切换只 PUT `avatar.theme`，音色死在原地。新增 `__bwmThemeVoice` 预设表（甜心女孩→茉莉、电竞男孩→Milo、可爱孙女HD→冰糖、迷人少妇→Chloe、霸道女总裁→Mia；未知主题保持当前音色，不盲改克隆音）+ 共享入口 `__bwmSwitchTheme`：一次 PUT 原子持久化 theme+voice，随后同步高亮/热切视频/音色下拉与状态
- **P2 人格不随模板重载**：桌面版人格按模板存储（reload 后 loadPersona 取新模板人格）；插件砍成全局单值但标签仍写"当前模板"，切模板后输入框内容不随动。新增 `avatar.personas`（按主题映射），读取规则 `personas[theme]` 优先、缺失回退 legacy `avatar.persona`（升级零迁移）；`wirePersona` 按 theme 读、保存写整张 personas map（客户端读改写，规避服务端浅合并整表覆盖）；`companionChat` 人格注入同规则按当前主题取
- **模板切换入口收敛**：`fillTemplates` 与 `fillCustomTemplates` 两处点击各自 PUT 只存 theme（漏音色/人格联动）→ 收敛到唯一共享入口 `__bwmSwitchTheme`（修根不修枝）

### 测试
- `status-sync-verify.sh`/`verify-shim.mjs` 扩至 **T1-T14**（新增：启动人格按主题读取、切模板音色跟随预设、原子持久化 theme+voice、人格按主题回退/恢复、personas 保存写回）；修复前 7 FAIL → 修复后 ALL PASS
- `p2-voice-smoke.cjs` 无 `XIAOMI_MIMO_API_KEY` 时显式 SKIP 并说明（TTS 后端必返 missing-key，此前让人误判为链路回归）
- host 端点回归 17/17（沙盒 3200 按 `dsh-sandbox/start.sh` 文档重启后）

## 0.4.0 (2026-09-03) · 第一轮（设置状态同步批修）

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
