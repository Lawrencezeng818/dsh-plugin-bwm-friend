# Presence v1 Canonical Dictionary(在场感状态唯一真理源)

> **状态**:v1.1-draft(2026-09-09 终审:**D1/D2 已批准,D3 延后,D4/D5 待拍**;拍板后冻结为 v1.0.0)
> **authority(本词典第一行声明,先于任何状态定义)**:

```yaml
authority:
  canonical_source: 本文件(Presence v1 Dictionary)
  protocol_role: derived   # schema/state.json 的 presence 枚举由本词典派生并校验
  sdk_role: derived        # bwm-sdk 的 Presence 域类型由本词典生成
  ui_role: derived         # Shell/皮肤 recipe 注册以本词典状态名为键
  patent_role: derived     # 专利2(Presence State Generation)实施例的唯一术语引用源
versioning: additive-only(新增状态=minor;修改/删除/改优先级/改层结构=major)
```

> **v1.1 结构升级(终审定案)**:单层状态表升级为**三层模型**——`semantic_state`(在场语义,Presence 本体)/ `activity_state`(当前活动,运行细节)/ `presentation_recipe`(如何表现,输出层)。三层分离终结"thinking 是不是 Presence"之争:**thinking 是 activity;Presence 是 semantic layer**。本词典由此同时是术语治理的试金石:它裁决的不是命名美感,是"谁有权定义状态"的架构治理问题。

---

## 0. 三层模型总览

```
Presence
├── semantic_state        # 在场语义层(Presence 本体,粗粒度,对外可见)
│     available / engaged / transitioning / unavailable
├── activity_state        # 活动层(运行细节,细粒度,仲裁产生)
│     idle / attention / listening / thinking / executing / working / speaking / success / error
└── presentation_recipe   # 表现层(按 semantic×activity 组合选择,按载体注册)
      avatar_* / voice_* / ui_* / robot_*(预留)
```

## 1. semantic_state(在场语义层)

| canonical | 唯一语义 | 进入 | 退出 | 来源 |
|---|---|---|---|---|
| `available` | 在场、可交互,无进行中交互 | 初始/会话结束/瞬态回落 | 输入到达→engaged;心跳丢失→unavailable;迁移通过门控→transitioning | 本词典(自 Protocol `idle` 语义升维) |
| `engaged` | 交互进行中(对话/任务/表达任一活跃) | 任意 activity 激活 | 全部 activity 归于 idle→available | 本词典 |
| `transitioning` | 模式迁移事务持有(独占写,外部生产者禁写) | 迁移请求通过门控 | 迁移提交→available/engaged;回滚→快照语义态 | 专利3 迁移语义(自 Protocol `transition` 升维) |
| `unavailable` | 运行时不可达 | 心跳丢失/服务探测失败 | 服务恢复重握手(full mode)→available | 本词典(自 Protocol `offline` 升维) |

**语义层红线**:executing/working 期间拒绝迁移请求(不进入 transitioning,控件置灰);transitioning 期间外部状态生产者禁止写入。

## 2. activity_state(活动层)

| canonical | 唯一语义 | 类别 | 进入条件(事件) | 退出 |
|---|---|---|---|---|
| `idle` | 无活动基准态 | 稳态 | 初始/回落 | 任何唤起 |
| `attention` | 被唤起:输入到达/被点名,尚未推进 | 瞬态倾向 | `user/message`(非语音)/界面唤起 | 推进至 listening/thinking,或回落 |
| `listening` | 语音聆听:ASR 采集活跃 | 稳态 | 按住说话按下 | 松开→thinking;取消→idle |
| `thinking` | 推理中,无工具调用 | 稳态 | `agent.thinking.start` | `agent.thinking.end`/`agent.tool.call` |
| `executing` | 工具/步骤执行中(步骤级) | 稳态 | `agent.tool.call` | `agent.tool.result` |
| `working` | 生成/长任务活跃(任务级) | 稳态 | `/work/task` accepted | `agent.task.success/failed` |
| `speaking` | 表达中:TTS 输出活跃 | 稳态 | TTS 播放开始 | 完成/被打断(agent.cancel) |
| `success` | 任务成功结果态 | **瞬态** | `agent.task.success` | 1400ms 自动回落(实测值,专利2) |
| `error` | 任务失败结果态 | **瞬态** | `agent.task.failed` | 2000ms 自动回落(实测值,专利2) |

**语义边界**:attention vs listening=唤起 vs 语音通道物理活跃;working vs executing=任务级 vs 步骤级。

**活动层仲裁(融合裁决,两来源冲突已标注)**:
`working > executing > speaking > thinking > listening > attention > success ≈ error(瞬态) > idle`
(working 任务级优先于 executing 步骤级;semantic 层的 unavailable/transitioning 不参与活动仲裁——它们在语义层独占。2026-09-09 勘误:三层化重写时 working 曾从仲裁序丢失,由 presence-dictionary 测试首跑暴露并修复——机器权威的第一个战果。)
单写者 `wirePresence()`;事件幂等可重放(上限 500 条);恢复时回放重建。

> **定义(2026-09-09 终审 D2 批准,写入正文)**:Arbitration Priority ≠ State Semantic Priority。`working > thinking` 不意味着 working 在语义上"比 thinking 更重要",而是:**两者同时存在时,Runtime 对外只允许某一个 Presence 状态占据当前主导表现**。仲裁顺序不是业务优先级,不得据此设计业务逻辑。
>
> **机器化后的边界强化(终审第四轮)**:Arbitration Priority 是**冲突解决机制**,不是在定义哪个状态"更高级"——`working > executing` 是事件/活动并存时的裁决顺序,不是说 working 在 Presence 语义上比 executing"更存在"。此区分防止三层模型退化回单层状态枚举。

## 3. presentation_recipe(表现层)

配方按 (semantic, activity) 组合选择、按载体注册——**状态与载体解耦是专利2 的技术边界,不得反向绑定**;状态切换只换配方引用,不重建运行时实例:

```
(semantic, activity) → recipes(多载体并行)
  ├── avatar_* : 视频配方类(.bwm-thinking 等)/ idle↔talk 双态
  ├── voice_*  : TTS 行为(speaking 态输出路由)
  ├── ui_*     : 状态条/任务信息条/header 指示
  └── robot_*  : 预留(Body Adapter 未来载体)
```

## 4. 与单层协议的映射(兼容层)

| legacy 单层(Protocol v1) | (semantic, activity) |
|---|---|
| `idle` | (available, idle) |
| `attention` | (engaged, attention) |
| `listening`* | (engaged, listening) |
| `thinking` | (engaged, thinking) |
| `executing` | (engaged, executing) |
| `working`* | (engaged, working) |
| `speaking` | (engaged, speaking) |
| `success` / `error` | (engaged, success/error) |
| `offline` | (unavailable, —) |
| `transition` | (transitioning, —) |

\* `working`/`listening` 为词典新增(专利2 体系),协议下次 minor bump 吸收;吸收前 consumer 遇未知值按现有 fallback 回退 idle。`presence:state` 事件载荷 additive 扩展:`{state(legacy), semantic, activity}`。

## 5. 版本与兼容

- 层结构变更(本 v1.1 三层化)= 词典 pre-freeze 修订;冻结后改层结构=major。
- 修改/删除任一状态、调整仲裁序 = major + 全消费方审计(state.json / SDK / Shell recipes / 专利2 实施例 / 测试断言)。

## 6. 术语映射(跨文档对齐)

| 词典 | Protocol v1 文档 | 专利2 草案 | 专利技术语言(终审双层体系) |
|---|---|---|---|
| 三层模型(本词典) | 9 值单层子集 | 9 值单层子集(working/listening 体系) | **Presence State Generation(存在状态生成)**——三层结构即权利要求骨架:语义生成 / 活动仲裁 / 表现配方选择 |

对外产品语言继续用"在场感(Presence)";权利要求语言用"存在状态生成"(见《专利战略定稿》§6.3 双层语言表)。

## 7. 决策点(2026-09-09 终审拍板记录)

| # | 决策 | 状态 | 裁决内容 |
|---|---|---|---|
| D1 | `working`/`listening` 并入协议的时点 | **APPROVED** | 下一次 minor bump 吸收。原则:**词典先行,协议渐进吸收**——词典 v1 即规范源,当前协议保持兼容,不为词典统一制造 breaking change |
| D2 | 活动层仲裁融合裁决(§2) | **APPROVED** | 生效,并正式定名 Arbitration Priority(≠State Semantic Priority,定义已写入 §2) |
| D3 | `attention` 是否加瞬态回落 | **DEFERRED** | 第一版不加:attention 与 listening/working/thinking 边界已清楚(唤起/物理监听/执行/推理),提前加自动回落会把语义状态绑成 UI/Runtime 时序行为;有真实场景证需要 transient semantics 再加 |
| D4 | semantic 层四值批准(尤其 `transitioning` 升维) | PENDING | 待创世者拍板 |
| D5 | legacy 单层 `state` 字段保留策略 | PENDING | 待创世者拍板 |

## 8. 机器权威(从"文档权威"升级为"机器权威")

- **机器形态**:本词典的机器可读派生物为 `schema/presence-dictionary.json`(semantic/activity 枚举、legacy 映射、仲裁序、红线约束)。
- **CI 纪律**:任何 Protocol / SDK / UI 状态枚举**不得脱离本词典单独增加、删除或重命名**——`attention vs working/listening` 这类分叉不靠人工评审发现,在测试阶段直接暴露。
- **派生链条与落地状态(2026-09-09)**:
  - ✅ Dictionary → `schema/presence-dictionary.json`(机器形态)
  - ✅ `schema/index.js` 的 `PRESENCE` 常量**已从词典派生**(原手写镜像已消除——那是词典之外最后一个旁路定义点);新增导出 `SEMANTIC_STATES` / `ACTIVITY_STATES` / `ARBITRATION_PRIORITY` / `toLayered()` 供消费方采用
  - ✅ `state.json` 子集校验 + 三方一致校验(index.js ≡ state.json ≡ 词典)+ toLayered 行为测试(`test/presence-dictionary.test.mjs`,9 项全绿;settings 4 项、SDK 14 项回归通过,消费方零感知)
  - ⬜ SDK enum 显式采用(当前 SDK 消费 legacy 单层,无自有枚举——无旁路,接线可后置)
  - ⬜ UI/Shell recipe 注册键校验(Runtime 侧接线时补)
- **首跑战果(工程案例,永久保留)**:三层化重写时 `working` 从仲裁序丢失,四轮人工评审未发现,机器校验首跑即暴露并修复(勘误记于 §2)。案例价值:证明机器不是在替人工重复检查,而是**在发现人工评审实际漏掉的规范分叉**——"唯一真理源"从这一刻开始产生组织价值。

## 9. 冻结纪律(终审第四轮定案:bug correction 与 semantic change 彻底分离)

从 2026-09-09 起,**不因实现 bug 重开 Presence 语义设计**。判定规则:

| 发现的问题类型 | 修复路径 |
|---|---|
| 实现/派生物违反 Dictionary | 修实现 / 修派生物(JSON、镜像、测试) |
| 违反 schema 约束 | 修 schema / 修测试 |
| Dictionary 本身语义错误 | **只有走 D1-D5 变更程序才能改**(变更=走决策点流程,留下裁决记录) |

否则"机器发现问题"会退化为人工重新讨论规范,机器权威被架空。

---

> 冻结签名(待补):Presence v1 Dictionary v1.0.0 · 2026-09-__ · 曾添 / BOSS-OS(D4/D5 拍板后冻结)
> 派生关系回写:批准后本词典登记进 `BWM-PROTOCOL-v1.md` 与专利2 草案 frontmatter(实施例状态术语唯一引用源);state.json 由本词典 §4 映射生成校验。
