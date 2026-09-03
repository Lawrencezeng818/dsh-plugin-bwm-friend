# BWM Friend × DSH 插件 · 产品与功能设计说明书 v1.0

> 文档版本：v1.0（2026-09-03，基于插件 v0.4.0 实测功能撰写——每个功能点均为已交付、已回归验证的事实，非规划稿）
> 读者：产品决策者 / 市场运营 / 接手开发 / 生态开发者
> 配套文档：[README](../README.md) · [Settings Schema v1](./BWM-SETTINGS-SCHEMA-v1.md) · [SDK Contract v0.1](./BWM-SDK-CONTRACT-v0.1.md) · [架构边界](./BWM-ARCHITECTURE-BOUNDARY.md) · [交接文档](./HANDOVER-2026-09-03-v0.4.0-release.md)

---

## 一、产品定位

### 一句话

**BWM Friend 是给 AI Agent（DSH）装上"身体和脸"的入口层插件**——用真人质感数字人视频做外壳，把一个命令行气质的 Agent 工作台，变成一个"有形象、有声音、有记忆、会主动开口"的沉浸式工作伴侣；同时 100% 保留原生 Agent 的全部能力，一行功能不删。

### 定位判断

它**不是**一个聊天皮套，也**不是**一个数字人 demo。它的定位是一个三层结构中的**入口层（Identity Layer）**：

```
┌─ 入口层：BWM Friend（外壳/人格/语音/记忆/主动行为）← 本插件
├─ 能力层：DSH Harness（Agent 引擎/工具调用/模型管理，100% 原生不动）
└─ 契约层：BWM Protocol / SDK / Runtime-core（三端统一协议，开放给生态）
```

三个判断支撑这个定位：

1. **"皮壳"是刚需，不是装饰。** Agent 时代的用户界面正在从"输入框"走向"对象"。用户对 Agent 的信任感、使用时长、情感粘性，很大程度取决于它有没有一个稳定的"存在形象"。DSH 本体解决了"能干"，BWM Friend 解决"愿意一直用"。
2. **原生保持是护城河，不是妥协。** 市面上的数字人产品几乎都是"自建聊天框 + 自建模型调用"，Agent 能力被截断成单轮聊天。BWM Friend 反向而行：iframe 内嵌原生 DSH，header/对话流/composer/模型菜单/用量圆环全部原生，插件只做外壳与增益——**Agent 能力上限 = DSH 本体上限，永不掉队**。
3. **协议先行是生态野心。** 插件只是入口，背后是冻结的 BWM Protocol v1 + SDK v0.1 + Runtime-core：桌面 App / DSH 插件 / 手机端三端共享同一套人格、记忆、设置与存在感语义。这是"产品"背后的"平台"雏形。

---

## 二、解决什么问题：用户痛点逐条拆解

| # | 痛点（用户视角） | BWM Friend 的解法 | 状态 |
|---|---|---|---|
| P1 | Agent 工具再强，也是个"没有脸的命令行"，用久了冰冷、无情感连接 | 真人质感数字人视频形象（ idle 呼吸感 / 说话口型驱动），5 套人格主题可切换 | ✅ 已交付 |
| P2 | 每次都要主动开口，AI 永远"被动应答"，没有"陪伴感" | **主动行为**：空闲检测 + 阈值触发，数字人主动开场搭话（proactive 引擎 + 幂等去重） | ✅ 已交付 |
| P3 | 聊天机器人**没有记忆**，每天从零认识你 | 规则启发式事实抽取（FACT_PATTERNS）→ memory.json 持久化，对话中自然引用你的背景信息 | ✅ 已交付（v0.4 标注：未来上移 Memory Runtime） |
| P4 | 打字累；语音产品"能听不会说"或"能说不会听" | 按住说话（MiMo ASR）→ 回复**自动朗读**（MiMo TTS），语音打断可取消请求 | ✅ 已交付（无 key 显式降级） |
| P5 | 想换个人设/声音，得翻配置文件、重启服务 | 主题模板一键切换，**模板⇒音色⇒人格三联动**（选"电竞男孩"自动换 Milo 音色与对应人格，零迁移兼容旧配置） | ✅ v0.4 交付 |
| P6 | 第三方"套壳"产品把 Agent 能力阉割成单轮聊天 | iframe 嵌原生 DSH：工具调用、多会话工作区、模型切换、推理等级、用量统计**全部原生可用** | ✅ 核心设计 |
| P7 | 数字人产品是"消费级玩具"，进不了工作流 | **work 模式**：数字人在旁，中央是完整 Agent 工作台；任务执行时数字人呈现 executing 状态 | ✅ 已交付 |
| P8 | 自部署数字人项目安装即劝退（依赖地狱） | 三步装：`npm i` → profile 引用 → 打开页面；UI 壳与协议随包发布，干净机器可装可跑（有自动化冒烟证明） | ✅ v0.4 交付 |
| P9 | 本地 web 服务裸奔（CSRF/路径穿越/DNS rebinding 都是真风险） | v0.4 安全收敛：同源校验重排封堵表单伪造、Origin 白名单、XSS 转义、凭据掩码、路径 resolve 校验、并发守卫、任务超时 | ✅ v0.4 交付 |

---

## 三、产品亮点（对外可宣称的差异化）

1. **原生 Agent 100% 保留**——不是套壳聊天，是"给工作台换壳"。iframe 内嵌 + `?bwm=embedded` 参数化激活，根路径零侵入，结构选择器 + 版本登记对抗上游改版。
2. **真人视频数字人，非 Live2D 卡通**——HeyGem 管线的真人形象资产（idle/talk 双态），皮肤包 `@laikaton/bwm-skin-*` 即插即换形象。
3. **模板⇒音色⇒人格三联动**——一次点击完成形象、声线、人格的成套切换，这是市面上数字人项目普遍要手动拼的三件事。
4. **主动陪伴行为**——不等你开口；空闲主动开场，且带 requestId 幂等去重（快速连点/多端不重复触发）。
5. **持久记忆**——对话中抽取事实、跨会话引用，"它记得你是谁"。
6. **双模式一插件**——work（工作台+数字人在侧）/ companion（全屏沉浸陪伴）同一个入口切换，工作与陪伴不换 App。
7. **企业级安全基线**（同类开源项目普遍缺失）：Sec-Fetch-Site/Origin 双重同源校验、BWM_TRUSTED_HOSTS 白名单、媒体 token 不可逆、登录凭据掩码且 token 不下发、26 断言安全回归。
8. **发布工程纪律**——协议+UI壳随包、干净机冒烟自动化、T1-T14 真浏览器状态同步回归；"装得上、跑得起来"是被测试证明的承诺。

---

## 四、功能全景

### 4.1 模式矩阵

| 入口 | 形态 | 面向 |
|---|---|---|
| `/`（无参数） | 原生 DSH，插件完全 no-op | 不想被打扰的用户 |
| `/?bwm=embedded` | 原生页面 + 嵌入式外壳（centerCol 视图、抽屉、数字人透出） | 轻量体验 |
| `/bwm-friend/work/` | 数字人在侧 + iframe 原生工作台（620–1080px 响应式）+ 顶栏任务信息条 | 日常工作 |
| `/bwm-friend/companion/` | 全屏沉浸数字人 + 幕布 + composer + 语音双向 | 陪伴/演示 |

### 4.2 子系统清单（v0.4.0 实测）

| 子系统 | 关键能力 | 入口/端点 |
|---|---|---|
| 资产清单 inventory | 多根扫描（用户投递目录 + BWM_STATIC 同级 + 皮肤包）、idle/talk 分类、主题分组、皮肤优先 | `GET /bwm-friend/inventory` |
| 媒体流 | HTTP Range、token 不可逆映射、失效回收、路径白名单 | `GET /bwm-friend/media/:token` |
| 设置同步 | schema v1 校验、原子写、串行化、version 管辖、模板⇒音色/人格联动 | `GET/PUT /bwm-friend/settings` |
| 陪伴聊天 | Mira 人格 + personaOverride（每主题人格）、记忆抽取/合并、proactive 主动开场 | `POST /bwm-friend/chat` |
| 语音 | MiMo ASR（≤25MB、并发守卫 429）、TTS 自动朗读、打断取消 | `POST /bwm-friend/transcribe` 等 |
| 工作任务 | 原生 Agent 全量 + 任务执行驱动数字人状态、10min 超时上限 | `POST /bwm-friend/work/task` |
| 引擎设置弹窗 | 模型目录实时同步 DSH 原生（懒加载、不重复 RPC） | 页面内 |
| 账号 | Hub 登录代理、状态查询（掩码回显）、token 不下发 | `/bwm-friend/auth/*` |
| 探测与降级 | BWM 服务探测、无 key 显式降级、皮肤包缺失降级 | `GET /bwm-friend/health` |
| 更新检查 | 更新清单地址可配（BWM_UPDATE_URL） | 启动时 |

---

## 五、功能设计说明（按子系统展开）

### 5.1 外壳与原生保持（核心架构决策）

- **零侵入原则**：DSH 根路径渲染完全不动；嵌入式模式由 URL 参数激活，客户端 `applyEmbeddedHarness` 基于结构选择器（`[class*=…]` + `EMBEDDED_SELECTORS` 版本登记）适配上游 DOM 演进。
- **work 页**：原生 DSH 装 iframe，任务信息条上移顶栏；composer/滚动/用量圆环皆为原生组件，插件只做布局与外观。
- **设计代价（诚实声明）**：上游改版可能破坏选择器——已用版本登记机制把风险变为可管理的补丁动作。

### 5.2 数字人资产管线

- **发现**：`LOCAL_ASSET_ROOTS`（`~/.bwm-friend/assets` 投递点 + BWM_STATIC 同级 `heygem-data/input` 惯例）+ `BWM_ASSET_ROOTS` env 覆盖 + `node_modules/@laikaton/bwm-skin-*/assets` 皮肤自动发现（皮肤标记 source=skin，选取优先）。
- **主题模型**：目录即主题（甜心女孩/电竞男孩/可爱孙女HD/迷人少妇/霸道女总裁）；根级散文件归 `(root)`；`custom_uploads` 在 UI 卡片中过滤。
- **安全性**：media token 为随机 UUID 不可逆（不泄漏本地路径）；token↔路径稳定复用 + 失效双向回收（重建清单不换发新 token、旧 token 不永久有效）；仅清单内路径可被访问，resolve 校验防穿越。
- **热更新**：fs.watch 监听资产根 → 变更即失效重建，watcher 随插件 dispose 回收（不泄漏）。

### 5.3 设置状态同步（v0.4 重做）

- **契约**：Settings Schema v1（冻结，additive-only），`validateSettings` 强校验 + `normalizeSettings` 补默认。
- **写入路径**：PUT → 互斥队列串行化 → 未知顶层 key 丢弃 → version 服务端管辖 → 顶层类型守卫（非对象 400）→ 合并 → 校验 → 原子落盘（tmp+rename）。并发多 key 写入零丢失（26 断言回归覆盖）。
- **三联动**：`__bwmSwitchTheme` 前端一次 PUT 同时落 theme + voice + personas[theme]，服务端 personaOverride 解析顺序 `personas[theme]` → 旧版 `avatar.persona` 字符串（零迁移）。

### 5.4 陪伴智能

- **人格**：单一来源 protocol 层 IDENTITY/PERSONALITY 预设（随包副本，行为确定性）；每主题可覆写人格文案。
- **记忆**：FACT_PATTERNS 规则抽取 → mergeMemory 合并落盘；诚实定位为"启发式 v1"，架构上为 Memory Runtime 上移预留。
- **主动行为**：空闲时长 + 触发阈值 → 数字人主动开场；requestId 60s 幂等去重防多端重复。
- **语音链路**：按住说话 → MiMo ASR → 文本入 Chat → 回复 TTS 自动朗读；`agent.cancel` 支持语音打断（requestState 状态机：idle→thinking→replying→idle）。

### 5.5 工作模式

- 任务经原生 Agent 引擎执行（cwd 可配 DSH_WORK_DIR）；任务驱动数字人 presence（thinking/executing/success/error）。
- v0.4 加固：whenIdle 超时上限（默认 10min，env 可调）防任务无限挂起；工作区列表 = 真实 DSH 会话枚举。

### 5.6 安全模型（v0.4 基线）

同源校验（Sec-Fetch-Site 分级 + Origin/Host 一致性 + dest=document 仅读 + Origin:null/file:// 仅读 + BWM_TRUSTED_HOSTS 可选白名单）→ 防 CSRF/DNS rebinding；远端输入（云模板名/皮肤目录名/主题名/模型名）一律 HTML 转义；凭据手机号掩码、Hub token 不下发；25MB 级转写接口并发守卫；所有长任务有超时。

### 5.7 扩展体系（平台面）

- **BWM Protocol v1**（Apache-2.0，冻结）：schema/events/presence/modes/emotions/capabilities 三端统一。
- **BWM SDK v0.1**（Apache-2.0，冻结）：`createBwmRuntime` → Agent/Persona/Presence 三域 API；Runtime 服务化后 SDK 接口不变。
- **Runtime-core**（闭源）：Event/Context/Capability/Ledger/Presence/Identity + DOMAIN_POLICY（Runtime State ≠ Persistent State 裁决）。
- **皮肤包**：npm 包即皮肤（assets 目录约定），依赖声明自动就位。
- **开源策略**：壳开放 + 核心闭源（UNLICENSED）。

### 5.8 配置契约（10 个 env，全部可选）

见 README"安装"节：XIAOMI_MIMO_API_KEY / DEEPSEEK_API_KEY / BWM_ASSET_ROOTS / BWM_STATIC / BWM_UI_PORT / DSH_WORK_DIR / BWM_AUTH_BASE / BWM_UPDATE_URL / BWM_TRUSTED_HOSTS / BWM_TASK_TIMEOUT_MS。素材投递：`~/.bwm-friend/assets`（可主题子目录）。

### 5.9 质量资产

core 32 + host 26 断言 + e2e；干净机发布冒烟 8 检查；T1-T14 真浏览器状态同步回归；presence/语音/proactive 三条链路冒烟。

---

## 六、对标分析

对标对象分四类（同类可比的都找了代表作）：

### 6.1 对比表

| 维度 | **BWM Friend** | 商用陪伴（Replika / Character.AI / 星野类） | 开源数字人（[Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber) / HeyGem / 桌宠类如 [AI-Desktop-Pet](https://github.com/ruguo0119/AI-Desktop-Pet)、[Live2DPet](https://github.com/x380kkm/Live2DPet)） | DSH 生态工具插件 |
|---|---|---|---|---|
| 本质 | **Agent 工作台的身份入口层** | 情感陪伴订阅服务 | 数字人技术 demo/桌宠 | 单点工具增强 |
| Agent 能力 | **完整原生**（工具/多会话/模型管理） | 无（自有封闭模型，能力截断） | 单轮聊天 + 简单工具（LLM 自接） | 不涉及 |
| 形象 | 真人视频数字人 | 文字/头像为主 | Live2D/3D 卡通为主 | 无 |
| 语音 | ASR+TTS 双向、打断 | 有（云端） | 有（本地 VITS/VOICEVOX 等） | 无 |
| 记忆 | 持久化事实记忆 | 强（云端，但数据在他方） | 部分有（如桌宠长期记忆） | 无 |
| 主动行为 | 有（幂等防重） | 有（推送） | 少数有 | 无 |
| 部署 | npm 三步、本地数据 | 无需部署（数据上云） | **部署门槛高**（Python/Node/模型依赖地狱） | npm |
| 数据主权 | **全本地**（记忆/配置/素材） | 全在云端 | 全本地 | 本地 |
| 安全工程 | CSRF/XSS/白名单/掩码/并发守卫 | 不可见（黑盒） | 普遍裸奔（本地信任假设） | 参差不齐 |
| 生态契约 | Protocol+SDK 冻结，三端同构 | 封闭 API | 各自为战 | DSH 插件 API |

### 6.2 逐类点评

**vs 商用陪伴（Replika/C.AI/星野）**：它们赢在情感打磨、内容运营和零部署；输在**封闭与截断**——用户拿不到 Agent 能力，数据出本地。BWM Friend 走的是"你的 Agent + 你的数据 + 它来当脸"的相反路线，两者用户群重叠但需求正交：**陪伴消费 vs 陪伴生产力**。

**vs 开源数字人（Open-LLM-VTuber 等）**：这是最直接的比较组。它们的强项：Live2D 表现力、全离线、社区活跃。它们的共同短板：**没有 Agent 深度**（聊天即全部）、部署复杂度劝退、安全基本裸奔、无协议生态。BWM Friend 的差异三板斧：①站在一个真 Agent 引擎（DSH）肩上而非自聊天框；②npm 三步装的工程纪律（有自动化冒烟背书）；③真人视频质感替代卡通皮套。代价：形象表现力弱于 Live2D 的表情系统、离线能力弱（依赖 MiMo/DeepSeek 云端）。

**vs HeyGem 本体**：HeyGem 解决"造出会说话的数字人视频"，是资产生产管线；BWM Friend 是它的**消费端与Agent化封装**（素材管线直接兼容 heygem-* 命名），二者是上下游而非竞品。

**vs DSH 生态内其他插件**：工具类插件增强"能力"，BWM Friend 增强"存在感与入口"，占据的是生态里尚未被占据的**身份层**位置，不与工具插件竞争，反而放大它们的留存价值。

---

## 七、我的意见与判断（诚实版）

### 成立的判断

1. **定位成立**："Agent 的身份层"是真空白。市面要么有脸没脑（数字人），要么有脑没脸（Agent 工作台）。BWM Friend 是少数把两者**以原生保持方式**焊在一起的产品，且协议先行使它有机会从插件长成三端平台。
2. **工程即卖点**：目标用户是自部署/注重数据主权的 Agent 深度用户，这群人被开源数字人的部署门槛伤过。三步装 + 干净机冒烟 + 安全基线，恰好打在这个人群的信任开关上。
3. **三联动这类"细节即体验"**是传播点：模板⇒音色⇒人格一键成套，演示视频里最有记忆点。

### 风险与短板（市场文案不得回避）

1. **表现力代差**：真人视频无法做实时情绪表情（Live2D 可），情绪表达靠状态机（thinking/executing/success）而非面部微表情。演示场景够用，情感深度场景弱于 VTuber 系。
2. **云端依赖**：ASR/TTS/聊天都挂云端 API，断网/欠费退化为文字壳。离线路线（本地 LLM+本地 TTS）是明确的下一程，但今天没有。
3. **记忆 heuristic**：规则抽取是 v1 权宜，复杂事实会漏。对外口径应为"有记忆"，不应宣称"长期记忆智能体"。
4. **单宿主**：当前只适配 DSH web；"多宿主降级运行"写在架构里但未实测——生态故事讲出去之前要补。

### 取胜策略（建议）

- **短打**：市场页主推"给 DSH 装上身体"+ 三联动演示 GIF + 三步装；把 26 断言安全回归和干净机冒烟写进信任区块（技术买家吃这个）。
- **中打**：皮肤包市场（@laikaton/bwm-skin-* 已经是可发现约定）——形象即内容，让非技术用户也为"换人"付费/传播。
- **长打**：Protocol/SDK 不动，把 Runtime 推向服务化，做"一个数字人身份，三端（桌面/DSH/手机）在场"——那是这个架构真正值钱的形态。

**一句话总结**：这是一个"工程完成度反常地高"的入口层插件——它现在最大的风险不是做不出来，而是**被当成皮套误卖**。按"Agent 身份层"定位打，按"皮套"卖必死。

---

*本说明书基于 v0.4.0 实测功能与代码事实撰写；功能宣称与 schema 预留字段红线见 [Settings Schema v1 §预留字段](./BWM-SETTINGS-SCHEMA-v1.md)。*
