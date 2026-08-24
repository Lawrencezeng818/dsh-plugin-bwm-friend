# BWM SDK Contract v0.1（冻结）

> 状态：**v0.1 冻结（2026-08-24）**——变更 Additive-only（新增 minor，改删 major）
> 包：`@laikaton/bwm-sdk`（Apache-2.0，协议开放）
> 关系：Runtime（闭源核心）→ BWM Protocol → SDK → Plugin / Agent / Shell

## 1. 定位

第三方开发者接入 BWM Agent Runtime 的唯一入口。**不直接碰内部 JSON/状态机**——SDK 封装
`@laikaton/bwm-runtime-core` 的协议面（hello/context/event），提供三个域的友好 API。

未来 Runtime 服务化后，SDK 内部经 BWM Protocol 网络层替换（remote runtime service），
**SDK 接口不变**。

## 2. 创建

```js
import { createBwmRuntime } from '@laikaton/bwm-sdk';

const runtime = createBwmRuntime({
  // core: 注入 runtime-core 实例（默认内部创建）
  // hostBase: host 同源前缀（agent.send 聊天端点）
  // transport: 自定义传输（多端/服务端注入；默认同源 fetch POST JSON）
});
```

## 3. Agent API（请求生命周期）

| API | 签名 | 说明 |
|-----|------|------|
| `agent.send` | `send(message, { history?, requestId? }) → Promise<{ok, reply, requestId}>` | 发送消息；内部维护 `requestState`（idle→thinking→replying→idle） |
| `agent.cancel` | `cancel() → requestState` | 取消进行中请求（语音打断/用户停止；未来接 DSH Stop） |
| `agent.status` | `status() → {state, requestId, startedAt}` | 当前请求状态（`idle/thinking/replying`） |

**requestState 状态机**（Runtime 决策，重复 start 拒绝）：

```
idle → start(requestId) → thinking → reply → replying → end → idle
                          └── cancel → idle(cancelled:true)
```

## 4. Persona API（人格）

| API | 签名 | 说明 |
|-----|------|------|
| `persona.get` | `get() → {identity, personality}` | 当前人格（Mira 预设） |
| `persona.switch` | `switch(id) → persona` | 切换人格预设（v0.1：MIRA 唯一预设；未来多预设/Evolution Runtime 扩展） |

## 5. Presence API（存在感）

| API | 签名 | 说明 |
|-----|------|------|
| `presence.state` | `state() → 'idle'\|'thinking'\|...` | 当前 presence 状态（9 值域） |
| `presence.observe` | `observe(cb(state, payload)) → unsubscribe` | 订阅状态变化（注册即回放当前状态） |

## 6. 底层透传（进阶/调试）

```js
runtime.events.on(channel, fn, opts)   // 协议事件订阅
runtime.events.emit(channel, payload)  // 协议事件发布
runtime.context.get(domain)            // 上下文只读
```

## 7. 版本与兼容

- v0.1 冻结：Agent（send/cancel/status）、Persona（get/switch）、Presence（state/observe）
- Additive-only：新 API = minor；改/删 = major（v1.0 前允许 breaking，需冻结评审）
- 边界：SDK 不含任何状态机实现/UI 逻辑——纯封装协议面

## 8. 未来（v0.2+ 候选）

- `runtime.memory.get/set`（Memory Runtime 开放）
- `runtime.ledger.query`（行为记录查询）
- `runtime.capabilities.require(name, version)`（能力需求声明）
- dsh-adapter 拆分（`@laikaton/bwm-adapter-dsh`：MutationObserver 等宿主观察逻辑从 Shell 迁出）
