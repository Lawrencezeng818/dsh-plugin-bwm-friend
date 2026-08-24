# BWM Protocol v1（冻结）

> **状态**：v1.0.0 冻结（2026-08-24）。任何变更必须 bump 版本，Additive-only。
> **定位**：@laikaton/bwm-shell（UI 壳）与 @laikaton/bwm-runtime（闭源核心）之间的边界契约。
> **公开原则**：**协议公开、决策私有**——本文件描述消息格式与状态值域（公开，Apache 2.0）；状态机转换逻辑/阈值/情绪权重等决策层**不在此文档**（私有）。

---

## 1. 总则

- 传输：Shell 与 Runtime 间经事件总线（同进程）或 postMessage（跨 frame）传递
- 事件：`{ type: string, version: string, ...payload }`（Additive-only，载荷演进 bump version）
- 状态：单值枚举，非法值按对应 fallback（presence→idle，mode→work）
- 所有消息必须携带 `version`（当前 "1.0"）

## 2. Event Schema（事件——公开）

### 2.1 Agent 活动事件（Runtime → Shell）

| type | version | payload | 语义 |
|------|---------|---------|------|
| `agent.thinking.start` | 1.0 | `{ session }` | Agent 开始推理 |
| `agent.thinking.end` | 1.0 | `{ session }` | 推理结束 |
| `agent.tool.call` | 1.0 | `{ session, tool, args? }` | 工具调用开始 |
| `agent.tool.result` | 1.0 | `{ session, tool, ok }` | 工具调用结束 |
| `agent.task.success` | 1.0 | `{ session, durationMs? }` | 任务成功 |
| `agent.task.failed` | 1.0 | `{ session, error? }` | 任务失败 |
| `memory.updated` | 1.0 | `{ session, scope }` | 记忆更新（scope: agent\|relationship\|preference） |
| `emotion.changed` | 1.0 | `{ session, emotion }` | 情绪变化（emotion 值域见 3.3） |
| `presence:state` | 1.0 | `{ state }` | Presence 状态变更 |
| `presence:mode` | 1.0 | `{ mode }` | 视图模式变更 |

### 2.2 DSH 宿主事件（Runtime 消费，来自 Agent Loop）

| type | 来源 | payload 要点 |
|------|------|-------------|
| `turn/start` / `turn/end` | DSH agent loop | `{ session }` |
| `user/message` | DSH | `{ session, content[] }` |
| `assistant/message` | DSH | `{ session, content[] }` |
| `tool/call` / `tool/result` | DSH | `{ session, tool, ... }` |
| `step/start` / `step/end` | DSH | `{ session, step }` |

## 3. State Schema（状态——公开）

### 3.1 Presence（存在状态）

```
idle | attention | thinking | executing | speaking | success | error | offline | transition
```

### 3.2 Mode（视图模式）

```
work | companion | meeting
```

### 3.3 Emotion（情绪——v1 值域冻结，权重决策私有）

```
neutral | warm | curious | focused | concerned | playful | proud | empathetic | tired
```

## 4. Capability Schema（能力协商——公开）

### 4.1 Shell 能力（Shell → Runtime 声明）

| capability | 说明 |
|-----------|------|
| `video-layer` | 数字人视频层渲染 |
| `composer-skin` | 输入框皮肤（BWM 风格） |
| `sidebar-drawer` | 侧栏抽屉/工作区弹窗 |
| `pop-session` | 会话选择弹窗（屏幕最右） |
| `header-strip` | 任务信息条（header 紧凑化） |

### 4.2 Runtime 能力（Runtime → Shell 声明）

| capability | 说明 |
|-----------|------|
| `presence-provide` | 提供 presence 状态流 |
| `context-govern` | 共享上下文治理（8 域） |
| `ledger-record` | 行为生命周期记录 |
| `identity-hold` | 人格身份持有 |
| `evolution-run` | 演进算法 |

## 5. Handshake（握手——格式公开，策略私有）

```
Shell ── hello ────────────────────────► Runtime
      { protocol: "bwm", version: "1.0",
        shellVersion: "0.3.0", dshVersion: "x.y.z",
        capabilities: ["video-layer","composer-skin",...] }

Runtime ── welcome ────────────────────► Shell
      { protocol: "bwm", version: "1.0",
        runtimeVersion: "0.1.0",
        mode: "full" | "lite",          // runtime 可用=full，否则 lite
        presence: ["idle","thinking",...],
        capabilities: ["presence-provide","context-govern",...] }
```

- **full mode**：Runtime 提供事件/状态流，Shell 订阅渲染
- **lite mode**：Runtime 不可用（未安装/未授权），Shell 独立运行（降级体验，UI 完整）
- 握手失败/超时：Shell 进入 lite mode；Runtime 上线后重握手自动升级 full

## 6. Frame Messaging（跨 frame 通道——当前 postMessage 统一命名）

### 6.1 Shell → Host（壳内子 frame 通知父页）

| type | payload | 语义 |
|------|---------|------|
| `bwm-presence` | `{ state }` | 数字人视频状态变化（presence 联动） |
| `bwm-pop-select` | `{ title }` | 弹窗选了会话 |
| `bwm-embedded` | `{ openSidebar }` | 嵌入式抽屉开关 |

### 6.2 Host → Shell

| type | payload | 语义 |
|------|---------|------|
| `bwm-embedded` | `{ openSidebar }` | 打开/关闭侧栏抽屉 |
| `bwm-switch-session` | `{ title }` | 切换到指定会话 |
| `bwm-switch-mode` | `{ mode }` | 切换视图模式 |

> 安全：所有 postMessage 必须校验 `e.origin === location.origin`；发送 targetOrigin 用 `location.origin` 非 `'*'`。

## 7. 版本与演进

- 当前冻结：**v1.0.0**
- 变更规则：Additive-only——新增事件/状态/能力 = bump minor；修改/删除 = bump major + 迁移文档
- 兼容：Shell 与 Runtime 各自声明协议版本，握手时取 `min(shellVersion, runtimeVersion)` 协商

## 8. 公开边界审计（v1 冻结时检查）

| 项 | 公开 | 私有 |
|----|------|------|
| 事件名/载荷 | ✅ | — |
| 状态值域 | ✅ | — |
| 能力清单 | ✅ | — |
| 握手格式 | ✅ | — |
| 状态机转换逻辑（thinking→deep_thinking 阈值） | — | 🔒 |
| 情绪权重/关系等级计算 | — | 🔒 |
| Presence 仲裁算法 | — | 🔒 |
| Evolution 算法 | — | 🔒 |

> 冻结签名：BWM Protocol v1.0.0 · 2026-08-24 · 曾添 / BOSS-OS
