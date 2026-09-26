# Changelog

## 0.7.2 (2026-09-26) · 发布硬化批次（全面代码审查 + 功能性审查收口，可发布门禁）

> 三路并行只读深审（static-ui 陪伴页 / host 端点 / 闭源核心包）产出 8×P1 + 21×P2 + 38×P3，本批次修复全部 P1 与 P2 及可安全收口的 P3；行号级证据见审查报告。0.7.1 未单独定版，factgate companion 与本批次一并随 0.7.2 发布。

### 安全 / 稳定性（host `lib/index.js`）
- 🐛 **P1 ReDoS**：`/companion/chat` 是唯一无并发守卫的重端点，1MB 载荷直达 `我是.*的` 无界回溯正则可拖死与 DSH 同进程的事件循环——三层修复：消息入口截断 2000 字符 + 记忆抽取正则全部加界（`.{0,24}` 量级）+ chat 并发守卫 ≤4（429）
- 🐛 **请求体 UTF-8 chunk 断裂**：readJsonBody 改 Buffer 收集后一次性 toString——原逐 chunk 字符串拼接把跨 chunk 的多字节汉字静默打成 U+FFFD 入库，且按 UTF-16 计数使 CJK 实际字节上限放大 ~3 倍；PUT /settings 消重改走同一通道（strictJson 400）
- companionChat 上游 fetch 补 `AbortSignal.timeout(60s)`（全文件最后一处无超时 fetch）；启动预扫描 TDZ 静默死亡修复（preload 调用点移至 `watchedRoots` 声明后，失败落审计不再 `.catch(()=>{})` 吞掉）
- serveMedia `bytes=-0` 按 RFC 7233 返回 416（原 206 全量）；promise 链补最终兜底（404 分支再抛曾是 unhandledRejection）；mp4Resolution 读失败也关 fd（泄漏）；memoryQueue 防毒护栏；PROACTIVE_CONTEXT 原型链查找改 `Object.hasOwn`；/status avatar null 守卫；runRealAgentTask 成功路径补 dispose；early-429 排空请求流防 keep-alive 断裂；settings 校验器缺席降级显式化（audit + health `components.settings.validator` 观测点）
- 登录限速评审后**维持原契约**（按尝试计数）：改按失败计数会使限速在 dev 模式（任意凭据皆成功）永不可触发、也无法测试；60s 窗口自愈，正常用户连续 6 次登录的误杀属已裁决可接受取舍

### 交互体验（`static-ui/` 陪伴页，历史对话反复提及的类别逐项收口）
- 🐛 **额度徽章整会话不更新**：`quota.updated` 分支引用未定义变量 `msg` → ReferenceError 被 catch 吞（`msg`→`event`）
- 🐛 **生成中断线输入框永久禁用**：busy 只在 WS 事件里解除——close 时复位 + 10 分钟客户端 watchdog 兜底
- 🐛 **模板卡成倍重复**：loadTemplates 只追加不清空 + 默认卡重复绑定——入口 `replaceChildren()` 重建
- 🐛 **删除自定义模板无确认**：删除前走 confirmDialog，删除中禁用按钮
- 其余：更新版本号 innerHTML 转义（XSS）；发送防抖（响应创建前回车重复扣次）；头像上传失败回滚（对齐待机视频）；说话视频补 2GB 上限；服务离线 15s 循环 toast 改静默 pill；persona 加载失败禁存（防空文本覆盖服务端人格）；模板加载失败 toast+重试卡；声音克隆按钮防并发；上传区隐藏后 placeholder 死按钮修复；长回复 overflow-y:auto（移动端可读）；iOS 输入 16px 防聚焦放大；`:root` 补 `--accent`；模板卡禁用态；确认弹窗 Esc + `\n` 换行生效；向导弹窗恢复滚动；读操作 9 处补 ok 检查（fetchJsonOk 统一封装，401 语义不变）

### 嵌入式壳层（`src/client.js`）
- 🐛 **悬浮按钮拖动假实现**：pointerup 把 right/bottom 重置回初始值（README Known Limitations 根因）——拖动落点即新位并 clamp 视口内
- 🐛 **自动滚动误判**：候选滚动容器收敛到会话区（centerCol 内），排除侧栏会话树与 composer dock（TodoPanel 列表）——原会把侧栏/任务列表强制滚到底、且任一非底部容器误触发全局暂停跟随
- 🐛 **账本/上下文写入竞态**：ledger append、context persist、mode persist 三条「GET→合并→PUT」链并发交错互丢字段（账本条目静默丢失，专利4 持久链完整性）——统一 `queueConfigWrite` 串行链
- 清理无效 CSS 声明 `child-shadow`（笔误）
- 浏览器实测（3200 沙盒 + CDP）：模型菜单真实鼠标点击正常弹出、长模型名（DeepSeek-V4-Flash-Vision-Exp High）压力下 composer 无溢出无裁剪、发送键/边框完整、根路径 `/` 原生界面零侵扰——历史 P1（点模型名不弹菜单）/P4（发送键裁剪）确认由 0.7.x CSS 修复收口，本批次回归通过

### 闭源核心包（专利实现证据）
- 🐛 **P1 感知路由补偿失真**：`compensate(failed, 全量applied)` 对每个易失项重复同参调用——改逐项 `compensate(u, [v])`（测试曾只断言 length>0 恰好掩盖）
- 🐛 **P1 会话销毁即失效破约**：closeSession 后 commit/route 照常 apply——入口补 SESSION_CLOSED 拒绝
- 🐛 **P1 持久化准入旁路**：桥接函数不复核指令域与获准模式 + 账本 admit 无确认门——双门修复（`not_persist_granted` / `perception_not_user_confirmed`），「强行桥接」测试分支从永不可达改为真实断言
- 两套账本 store 契约统一（异步 append 拒绝→回滚/上报、load 双契约归一）；事件总线 route/回放三处异常隔离；commit 持久失败剩余项入 shelved 不再静默丢弃；DEFER 过期丢弃切断死循环；路由器四处无界增长加界（closed sessions 50 / completedRounds 100 / audit 500 / lateQueue 200）；recentTopics 裁剪方向反修（达上限后新话题进不来）；hydrate 浅拷贝隔离；verify NaN 篡改不再失明；时间混合类型排序归一；wireRelationship 重入护栏；invariant 降级显式化
- 测试：runtime-core 131→**149 全绿**、protocol 13→**19 全绿**（+24 项新契约测试）

### 发布工程
- README Known Limitations「悬浮按钮拖动未实现」关闭；版本 0.7.2（0.7.1 未单独定版一并发布）

## 0.7.1 (2026-09-21) · factgate 事实门控 companion（专利→生产力：会话层执行门控）

- **新增 `factgate.js` companion**（bundle patch 行 `bwm-friend-factgate`，真实上下文加载）：把事件内核"门控获准帧"（runtime-core index.js:87）装到 harness 会话层——`fact_probe`（权威源探测）/ `fact_assert`（断言核验门控：ADMITTED 发票据、BLOCKED 拦截+理由）/ `fact_ledger`（审计账本：单调序号、上限500滚动、每域 retained 票据）/ **全局写保护守卫**（`tools.guard` 普通上下文注册=全局生效、单调不可翻案：权威源文件对 write/edit 只读）
- **事实域 v1 内置 4 域**：patent-status（SSOT）/ package-compliance（递交包 SHA256SUMS）/ env-config（DSH_HOME AGENTS.md）/ e-receipt（SSOT 第7行受理状态）；settings 化配置列 v2
- **架构勘误记录**：动态会话插件沙箱门面剥掉 `tools.guard`（cordis-host-runner/guard.ts 只暴露 register/schemas/get，防绕过单调守卫）——写保护**只能部署级挂载**；会话内原型（fgate-2/pkg-5）按"显式失灵不静默"特性检测降级验证了同款限制
- **fs/tools 可选服务纪律**：ctx.get + 特性检测，缺席显式降级报告，绝不静默放行（invariant 同款教训）；工具逐具 try/catch 注册，单具被拒不拖垮其余
- 经验判例：`/Users/zengtian/projects/memory/workflow/20260921-DSH-动态插件开发四暗礁与契约先行节奏.md`（defineTool 工位/参数根开放/输出 schema 显式/运行期特性检测）
- **factgate settings 化（0.7.1 增补）**：域注册表支持配置覆盖——主插件 settings PUT 白名单/类型守卫/深合并放行 `factgate` 键，bwm-protocol schema 增补 `factgate.domains` 校验（{label, source} 非空字符串，非法逐键拒绝）；companion 启动时读 `~/.dsh-bwm-friend/config.json` 覆盖内置 4 域，缺项/失败回退默认（不阻断加载）
- **发布链全绿（2026-09-22）**：core 131/131 · artifact PASS · host 38/38（沙盒 3200）· e2e ✓ · pack ALL PASS · fresh ALL PASS；settings 通道端到端实测 PUT→落盘→GET 三连过
- **SG 8089 门户链路退役（创世者裁决）**：DNS 实测直指广州，SG 不在服务路径；容器摘除、路由标记 retired、备份 `SG:/opt/boss-portal-retired-backup-20260922.tar.gz`；架构 SSOT（BOSS_THREE_NODE_TOPOLOGY.md）与脚本头同步更新

## 0.7.0 (2026-09-11) · Perception Router（专利5 实现证据 / 跨域路由与一致性编排）

- **新增 `createPerceptionRouter()`**（`packages/bwm-runtime-core/src/perception-router.js`，纯逻辑无 I/O）：感知事件的**跨状态域路由与一致性编排**——专利5 交底书 v0.3 §四 六步骨架的可运行实现
  - **感知会话**：`openSession()` 绑定允许采集的感知类别、调度策略、允许流向的域、新鲜度窗口与销毁条件；`closeSession()` 销毁（易失域随之失效）
  - **结构化感知事件**：`ingest()` 产出带事件标识/来源类型/生成时间/有效期/关系范围的事件（来源白名单与前台隐私门控在此拒绝）
  - **域更新决策向量**：`decide()` 输出每域 `deny | volatile | persist | defer`；**持久性默认值不对称**——易失运行状态域默认易失，持久历史状态域默认拒绝（持久化需同时满足显著性阈值+会话允许+关系范围匹配+显式分享或用户确认）
  - **域更新指令**：`route()` 产出**同一 eventId 串联**的候选指令，绑定主体、关系范围与策略版本（可追溯、可撤销）
  - **跨域一致性控制**：`commit()` 处理顺序（易失先于持久）、**策略版本冲突整体拒绝**、**部分失败补偿**（持久域失败→补偿已执行易失更新+标记待重试）、**迟到事件隔离**（轮次已完成的事件延迟至下一轮，绝不回写已完成轮）
  - **域名下沉纪律**：目标状态域以「类」（易失/持久）表达，具体域名走配置——新增 `emotion/memory/task` 域无需改动路由器（专利5 权项演化空间的代码对应）
- **边界**：不生成存在状态（专利2 的权）、不计算关系增量与写账本（专利4 的权）——只产出候选指令，交事件内核与账本端执行（交底书 §二 裁决表）
- **测试**：core 套件 36→**48 全绿**（新增 12 项跨域一致性契约测试：会话销毁/隐私拒绝路径/置信度与显著性门控/持久化准入/迟到事件隔离/过期事件/部分失败补偿/版本冲突/同事件标识串联/域扩展性/审计视图）——即专利5 §八 要求的**核心创造性证据**（一致性编排，而非采样 Benchmark）

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
