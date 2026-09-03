# v0.4.0 综合评审提示词（交给外部 AI 用）

> 用法：整段复制下方提示词发给评审 AI。有仓库访问权的给只读权限；无仓库访问权的提示词自含事实附录，仍可评审但结论效力降级（材料缺失会体现为报告里的"未验证"项）。
> 配套材料：`docs/BWM-FRIEND-PRODUCT-SPEC-v1.0.md`（产品说明书，bb7ff4d）、仓库 `dsh-plugin-bwm-friend` @ 7f67c53+。

---

## ⬇️ 评审提示词正文（复制以下全部）

你是一位严苛的独立评审人，同时对一个 AI Agent 生态插件做**技术评审**与**产品评审**。你的雇主是潜在的发布决策者，你的报告直接决定是否发布。你的声誉来自挑出真问题，不来自客套。

## 评审对象

`dsh-plugin-bwm-friend` v0.4.0：给 DSH Agent（AI Agent 工作台）装上"数字人外壳"的入口层插件。作者的核心声称是"Agent 身份层"：真人视频数字人外壳 + 100% 保留原生 Agent 能力 + 冻结的三端协议（BWM Protocol/SDK）。你的任务之一就是**攻击这些声称**。

## 材料与优先级

若有仓库访问权（`dsh-plugin-bwm-friend` @ v0.4.0），按此顺序读：
1. `docs/BWM-FRIEND-PRODUCT-SPEC-v1.0.md` — 产品说明书（定位/痛点/亮点/对标/作者自评）
2. `README.md` — 安装/架构/env 契约/Known Limitations
3. `lib/index.js` — host 全部逻辑（~2200 行，单文件）；`src/client.js` — 浏览器端
4. `docs/BWM-SETTINGS-SCHEMA-v1.md`（注意文末"预留字段"红线表）、`docs/BWM-SDK-CONTRACT-v0.1.md`、`docs/BWM-ARCHITECTURE-BOUNDARY.md`
5. `CHANGELOG.md`（v0.4.0 三轮合拢）、`tests/`（host-endpoints 26 断言 / release-pack-smoke / status-sync-verify T1-T14）、`package.json`
若无仓库访问权：基于附录 A/B 评审，但**每个无法核实的点必须标注"未验证"**，不得当作已确认。

## 评审纪律（违反即报告无效）

1. **一切文档陈述默认为"作者声称"**。亮点表、痛点表、对标表都是作者写的——你要做的是用代码与测试证明或推翻，而不是复述。
2. **证据强制**：每个结论附 `文件:行号`（或测试名/命令）。写不出证据的结论降级为"印象"。
3. **禁止善意补全**：发现"文档说有 X 但代码里找不到 X"时，结论就是"声称与实现不符"，不许替作者圆。
4. **对照红线**：`docs/BWM-SETTINGS-SCHEMA-v1.md` 文末预留字段表（voice.volume/avatar.idle/avatar.driver/power.*/llm.*/ui.type/account 无消费点）——产品说明书与 README 的任何功能宣称若越线，直接判违规。
5. 你的价值 = 找到作者自己没写的缺陷。附录 B 是作者自认的薄弱区，**从这里开始但不限于这里**。

## 技术评审维度（每项 0-5 分 + 证据）

- T1 安全基线真实性：验证同源校验实现（Sec-Fetch-Site 分级/Origin-Host 一致性/dest=document 仅读/Origin:null 仅读/BWM_TRUSTED_HOSTS）、XSS 转义覆盖面（云端模板名等远端输入）、凭据掩码与 token 不下发、媒体 token 不可逆与路径白名单。找绕过。
- T2 发布工程：`npm pack` 产物自包含（packages/+static-ui 是否入 files、默认路径是否零个人依赖、协议随包副本优先的 import 顺序）；release-pack-smoke 的 8 项检查是否真的能拦截"本机能跑异机挂"。
- T3 代码质量与可维护性：lib/index.js 单文件 ~2200 行（含模板字符串内嵌 JS）的架构代价；注入 JS 的测试可达性；错误处理一致性；死代码残留。
- T4 测试资产有效性：26 host 断言/T1-T14/pack 冒烟是否测在点子上；哪些关键路径仍无测试（语音链路？proactive？更新检查？）。
- T5 settings 写入健壮性：原子写/串行化/校验接线/version 管辖的实现正确性与并发边角。
- T6 资源治理：watcher 泄漏修复、media token 回收、任务超时、/transcribe 并发守卫——是否还有同类未治理点（定时器？事件监听？缓存？）。
- T7 架构分层：Protocol/SDK/Runtime-core 三层边界是否名副其实；"壳开放+核心闭源"策略在仓库里是否自洽。

## 产品评审维度（每项 0-5 分 + 证据）

- P1 定位成立性："Agent 身份层" vs "皮套"——产品说明书的第一章论证能否站住？反例：一个 iframe 外壳配视频背景，凭什么是身份层？
- P2 痛点表诚实度：9 条痛点对应功能是否都已交付（对照 schema 预留字段红线，重点查 llm.*、voice.volume、memory 相关宣称）。
- P3 亮点差异化：8 条亮点里哪几条真实差异、哪几条同行也有（对照它给的对标表：商用陪伴/Open-LLM-VTuber/HeyGem/DSH 插件）。
- P4 对标分析质量：四类对标是否选对了对手、结论是否公允、有没有为抬高自己贬低对手的不实陈述。
- P5 市场就绪度：安装三步是否真三步；文档是否足以让陌生用户自助；市场提交包（截图/提交说明）与产品实际是否一致。
- P6 自评可信度：产品说明书第七章"我的意见与判断"（风险/短板自认）是否诚实、有没有漏掉更大的风险。

## 输出格式（严格遵守）

1. **评分总表**：T1-T7、P1-P6 每项分数 + 一句话结论。
2. **发现清单**：按 P0（发布前必须修）/P1（应修）/P2（可延后）分级；每条含证据位置、影响、建议修法。
3. **声称核实表**：挑 5-8 条最响亮的作者声称，逐条给"证实/证伪/未验证"。
4. **发布建议**：三选一——可发布 / 修复后发布（列最小修复集）/ 不可发布（列理由）。
5. **你作为产品人的补充意见**：若这是你的产品，下一步三件事。

## 附录 A：作者声称的事实速览（未经你核实）

- 双模式：`/bwm-friend/work/`（数字人在侧 + iframe 原生工作台）、`/bwm-friend/companion/`（沉浸陪伴）；`?bwm=embedded` 参数激活嵌入壳，根路径 no-op。
- 资产管线：多根扫描（`~/.bwm-friend/assets` 投递点 + 皮肤包自动发现）、idle/talk 分类、主题即目录、media token 不可逆+失效回收、fs.watch 热更新。
- 设置同步：schema v1 冻结、PUT 串行化、原子写、validateSettings 接线、version 管辖、未知 key 丢弃；模板⇒音色⇒人格三联动（personas[theme] 优先，兼容旧 avatar.persona）。
- 陪伴智能：Mira 人格（protocol 随包副本）、规则启发式事实记忆（作者自认 heuristic v1）、空闲主动开场（60s 幂等去重）、MiMo ASR/TTS 双向+打断取消。
- 安全 v0.4：同源校验重排（封堵 dest=document 表单 POST 伪造 JSON 打 /work/task）、远端输入 XSS 转义、手机号掩码、Hub token 不下发、/transcribe 并发守卫 429、任务 10min 超时。
- 发布：npm 三步装、协议+UI 壳随包、`@laikaton/bwm-skin-mira` 皮肤依赖、10 个可选 env、26 host 断言+T1-T14 真浏览器回归+8 项 pack 冒烟。
- 生态：BWM Protocol v1 与 SDK v0.1 已冻结（Apache-2.0）、Runtime-core 闭源、license UNLICENSED、目标市场 dsh-market.com。

## 附录 B：作者自认薄弱区（重点核查起点，不限于）

1. lib/index.js 单文件 ~2200 行、注入 JS 以模板字符串内嵌——可维护性与测试性代价。
2. 真人视频形象无实时表情系统，情绪表达靠状态机（thinking/executing/success），弱于 Live2D。
3. ASR/TTS/聊天全挂云端 API，无离线路线。
4. 记忆是 FACT_PATTERNS 规则抽取，复杂事实会漏。
5. 多宿主（Claude Desktop/Cursor）"降级运行"只写在架构里，未实测。
6. work 页市场截图摄于收敛建模前（提交说明已注明）；悬浮按钮拖动未实现。
7. Registry 上 @laikaton/bwm-protocol 与随包副本存在漂移可能（现以随包副本优先规避，但 SDK 消费者混装场景未验证）。

（提示词正文结束）

---

## ⬆️ 使用备注

- **强模式**（推荐）：给评审 AI 仓库只读权限，提示词照发。评审深度取决于它能读多少代码。
- **弱模式**：无仓库访问时，把 PRODUCT-SPEC/README/CHANGELOG 全文随提示词粘贴过去；报告效力受限但可用于产品面初筛。
- **收报告后**：把"声称核实表"与作者自评并排对照——两边都标"证实"的才是真站得住的；"未验证"堆积多的维度就是你下一轮要补证据的地方。
