# @laikaton/bwm-protocol

BWM Protocol v1 — Shell（@laikaton/dsh-bwm-friend）与 Runtime（@laikaton/bwm-runtime）之间的边界契约。

## 原则

**协议公开、决策私有**——本包只描述消息格式与状态值域（Apache 2.0）；状态机转换/阈值/权重等决策层属于 Runtime 私有核心，不在本包。

## 内容

```
schema/
├── events.json       # Event Schema（agent.* / presence:*）
├── state.json        # State Schema（presence / mode / emotion 值域）
├── capability.json   # Capability Schema（shell / runtime 能力协商）
├── handshake.json    # Handshake Schema（hello / welcome，full|lite）
└── index.js          # 常量 + validators（镜像 schema）
```

## 快速使用

```js
import { PRESENCE, validPresence, validMode } from '@laikaton/bwm-protocol';
validPresence('thinking'); // 'thinking'
validPresence('bogus');    // 'idle'（fallback）
```

## 版本

- v1.0.0（2026-08-24 冻结）
- 变更规则：Additive-only；`version` 字段全程携带（当前 "1.0"）
- 完整文档见仓库 `docs/BWM-PROTOCOL-v1.md`
