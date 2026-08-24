# BWM Architecture Boundary（架构边界冻结）

> **状态**：v1.0 冻结（2026-08-24，P0 评审后新增）。本文件是 Shell/Core 物理隔离的**宪法**——
> 团队扩展、新增模块、重构时以此为唯一边界依据，防止架构腐化。
> **关联**：docs/BWM-PROTOCOL-v1.md（契约格式）、08_Projects 方案 v3.1（实施路线）。

## 1. 分层总览

```
┌─────────────────────────────────────────────────┐
│ dsh-bwm-shell（开源，MIT）                        │
│   UI 皮肤 / DSH Adapter / 视图桥 / 主题 / 布局     │
│   只订阅协议状态，不产生核心决策                    │
└──────────────────┬──────────────────────────────┘
                   │ BWM Protocol（Apache 2.0）
                   ▼
┌─────────────────────────────────────────────────┐
│ bwm-runtime-core（闭源，商业许可）                 │
│   Identity / Context / Presence / Ledger /        │
│   Evolution / Affective State 决策层              │
└─────────────────────────────────────────────────┘
```

## 2. 禁止事项（红线，禁止违反）

### Shell（dsh-bwm-shell / client 侧）禁止拥有

| ❌ 禁止 | 原因 | 审计方式 |
|--------|------|---------|
| Event Kernel（事件总线核心） | 核心入口，必须归 Runtime | `grep createEventBus shell/` 必须 0 |
| Context Store（8 域上下文存储） | 记忆/人格数据 = 商业核心 | `grep createAgentContext shell/` 必须 0 |
| Presence Decision（状态仲裁） | 状态机逻辑私有 | `grep PRESENCE_STATES shell/` 必须 0 |
| Emotion Calculation（情绪权重） | Affective 决策私有 | `grep wireEmotion/emotion.` shell/ 必须 0 |
| Ledger Persistence（行为记录持久化） | 生命周期数据 = 专利核心 | `grep wireLedger shell/` 必须 0 |
| 任何"我是谁"人格常量 | Identity = 商业核心 | `grep PERSONA shell/` 必须 0 |

### Runtime（bwm-runtime-core）禁止拥有

| ❌ 禁止 | 原因 | 审计方式 |
|--------|------|---------|
| React Component | UI 属 Shell | `grep jsx/tsx runtime/` 必须 0 |
| CSS / 样式文件 | 皮肤属 Shell | `grep .css runtime/` 必须 0 |
| DOM selector / querySelector | 渲染属 Shell | `grep querySelector runtime/` 必须 0 |
| DSH UI dependency | 宿主绑定属 Shell | `grep dsh-client- runtime/` 必须 0 |
| DSH 具体页面逻辑 | 多宿主接入前提 | `grep /bwm-friend runtime/` 必须 0 |

## 3. 唯一通信方式

Shell ↔ Runtime 只允许通过 **BWM Protocol**（见 docs/BWM-PROTOCOL-v1.md）：
- 事件：`agent.*` / `presence:*` / `memory.*` / `emotion.*`
- 状态：presence/mode/emotion 值域
- 能力协商：hello → welcome（full|lite）
- **禁止**：Shell 直接 require Runtime 内部模块；Runtime 直接操作 Shell DOM

## 4. 演进规则

- 本文件变更 = 架构变更，需创世者批准（🔴 治理文件）
- 边界放宽（Shell 允许某核心组件）必须带商业理由 + 专利评估
- 每次 PR 审计：新增文件归属是否正确层；grep 红线 0 命中

## 5. 当前现状标注（2026-08-24，P0 冻结时刻）

> ⚠️ **当前代码尚未物理隔离**——Event Kernel/Context/Presence/Ledger/Persona 仍在
> `src/client.js`（历史单包形态）。本文件是**目标宪法**，P1 拆包以它为准绳逐步收敛。
> P1 完成定义 = 本文件 §2 红线全部满足（见方案 v3.1 §十一验收标准）。

> 冻结签名：BWM Architecture Boundary v1.0 · 2026-08-24 · 曾添 / BOSS-OS
