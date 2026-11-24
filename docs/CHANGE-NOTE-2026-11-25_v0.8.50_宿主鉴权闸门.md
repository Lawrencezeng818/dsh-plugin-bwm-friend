# 变更说明 · v0.8.50 接入宿主鉴权闸门

- 版本：`0.8.50`（npm `dsh-plugin-bwm-friend@0.8.50`，tag `v0.8.50`）
- 日期：2026-11-25
- 改动面：`lib/index.js`（新增 `createHostGate` + 路由前置闸门 + health 自报）、`tests/host-gate.test.mjs`（新增）、`package.json`（版本）、`CHANGELOG.md`
- 未改动：`cordis.patch.yml`、前端静态页、SDK 契约、配置 schema

## 一、一句话

`/bwm-friend/*` 此前只跑自建同源防线、不认宿主的登录态；本版把宿主的访问闸门接上，**三种宿主形态各自优雅降级**，且有意避开参考实现里会让全站 403 的那条路径。

## 二、起因：不是自评，是市场条目被追加了注记

2026-11-24 PR #18465 合并进 DSH 插件市场目录时，维护者（`fkysly`）在我的描述后**手写追加**一句，en/zh 各一份：

> Its HTTP routes have no DSH access check, so a web page open in your browser could call them.

核实结论：**成立**。当时的实现是 `webServer.register` 注册 prefix 路由，唯一防线是 `isSameOriginRequest`（Origin/Host 一比一、`sec-fetch-site: cross-site` 一票拒、`BWM_TRUSTED_HOSTS` 钉住 DNS rebinding）。这套防线认真但不等于宿主鉴权——它不认 DSH 的登录态，任何人只要能构造同源请求就能调用。

两点补充事实，用于判断处置尺度：

| 事实 | 数据 | 含义 |
|---|---|---|
| 该注记不是扫描器生成 | `data/capabilities.json` 里**没有**本条目记录；注记为人工写入 | 删它需要人工复查，不是等重扫自动消失 |
| 非针对本项目 | `data/plugins` 里 480 个条目带同一句 | 是 `webServer.register` 这批插件的系统性问题 |

## 三、改了什么

### 3.1 双路闸门（`createHostGate`，`lib/index.js:2498`）

每请求解析一次，不冻结挂载时的判断（宿主可能晚于插件挂载才 `provide('connection')`）：

| 优先级 | 条件 | 行为 |
|---|---|---|
| ① | `connection.requestRejection` 存在（DSH ≤0.2.2） | 调用它；返回 `401/403` 即拒，返回 `undefined` 即准入。**不需要 inject 作用域** |
| ② | 仅 `connection.admit` 存在（≥0.2.3） | 必须在 `ctx.inject(['connection','connection.authentication'])` 的**子作用域**内调用；`{ rejection }` 即拒，`{ peer }` 即准入，`undefined` 按 403 |
| ③ | 两者皆无（更老宿主 / 桌面壳） | 闸门为 `none`，交回原自建防线，**零行为变化** |
| ④ | `BWM_HOST_GATE=off` | 显式关闭，同上 |

闸门位于 **prefix 级**（`lib/index.js:2608`），顺序是「先宿主闸门 → 再自建同源防线」，因此 `/bwm-friend/*` 全路径（含静态页、health、写端点）统一受控，没有漏点。

### 3.2 失败姿态 fail-closed

闸门自身抛异常时：记 `host_gate.error` → 单请求应答 **403**。既不 fail-open（把宿主 bug 变成漏洞），也不 fail-storm（不把异常扩散成全局拦截）。

### 3.3 可观测，防「代码写了没生效」

- `GET /bwm-friend/health` 新增 `components.hostGate.mode`：`requestRejection` / `admit` / `none` / `off` / `unresolved`
- 审计事件：`host_gate.refused`（含 route、kind、status）、`host_gate.error`

这一项是刻意加的：本项目历史上出现过「代码写了、开关没生效」的静默失败，所以把实际生效形态做成可读字段，而不是靠读代码推断。

### 3.4 被拒时用户看到什么

```json
{"error":"需要先登录 DSH：请重新打开 dsh web 启动时打印的网址。/ DSH login required: reopen the URL dsh web printed at startup."}
```

401 / 503 / 其他分别给不同文案，不是裸的 `{"error":"forbidden"}`。

## 四、为什么偏离参考实现（这是本变更最要紧的一处判断）

`dsh-market` 的 `src/http.ts` 是同类问题最可靠的参考实现，但**照抄会出事**。三处必须知道：

| 常见修法 | 实际后果 | 证据 |
|---|---|---|
| 只加 `engines.dsh >= 0.2.3` | **挡掉全部现有稳定用户** | npm `@deepseek-ai/dsh` 的 `latest` = `0.2.2-rc.5`；`0.2.3` 只有 `alpha` |
| 只调 `requestRejection` | 在新宿主上**静默失效**（空操作） | dsh-market 源码注释：「DSH 0.2.3 removed `requestRejection` for `admit(request)` … Without this the gate quietly became a no-op on those hosts」 |
| 补调 `admit` 但作用域冷时回退根 ctx | **全站 403**，含已登录用户 | dsh-market #1299：抛 `cannot get property "connection.authentication" without inject` → catch 转 403 |

本实现的取舍：**作用域不可用时不碰 `admit`，直接降级 ③**。宁可少一层宿主校验（仍保留自建防线），也不制造一次全站不可用。`requestRejection` 不需要作用域，照用。

## 五、验证证据（真实宿主，非模拟）

环境：`@deepseek-ai/dsh@0.2.2-rc.5`，本插件以 `link:` 挂进 `web` profile，`--port 3299`。

| 请求 | 0.8.49（改前） | 0.8.50（改后） |
|---|---|---|
| `GET /bwm-friend/settings` 无会话 | **200**，返回配置内容 | **401** |
| `GET /bwm-friend/settings` 带会话 cookie | 200 | **200** |
| `GET /bwm-friend/status` 无会话 | 200 | **401** |
| `GET /bwm-friend/health` 带会话 | 无该字段 | 200，`hostGate.mode = "requestRejection"` |

单元测试：`tests/host-gate.test.mjs` 新增 **16 例**，覆盖三态宿主、`admit` 返回 `undefined` 按 403、闸门抛错 fail-closed、`dispose` 回收作用域，以及**#1299 回归**（作用域冷时不得回退根 ctx）。既有套件：core 78/78、artifact PASS、theme diff=0、pack smoke PASS。

`tests/p0-auth.test.mjs` 有 1 例失败（2 pass / 1 fail），已用 `git stash` 对照确认**改动前同样失败**，与本变更无关（该例走网络，耗时 551ms）。

## 六、影响面与兼容

- **DSH ≤0.2.2 用户**：行为变化即本变更目的（无会话不再可调）；带会话无感
- **DSH ≥0.2.3 用户**：走 `admit` 路径；若宿主不提供注入作用域，降级为自建防线（不 403）
- **桌面壳 / 自建部署**：无 `connection` 服务 → `none`，行为与 0.8.49 完全一致
- **回退**：设 `BWM_HOST_GATE=off` 即恢复旧行为，无需回滚版本

## 七、边界：本变更没做什么

- 没改 `cordis.patch.yml`（保持纯 insert，热挂载约束不变）
- 没动分类（仍 `ui`。判断依据：页面级外壳 `/bwm-friend/`，非全局换肤；若按 `theme` 收，会进主题 Tab 拿一键切换入口，属商业定位问题，须创世者定）
- 没补 `icon:` / `screenshots.json`（美观项，不影响鉴权与收录）
- 市场条目里的那句注记，需另开 PR 删除 → 见 `docs/` 外部的 PR #18604

## 八、关联产物

| 产物 | 位置 |
|---|---|
| npm 包 | `dsh-plugin-bwm-friend@0.8.50`（latest） |
| GitHub | tag `v0.8.50`，commit `93d8a95` |
| 市场目录删除注记 PR | awesome-dsh-plugin **#18604** |
| 市场目录收录 PR（已完成） | awesome-dsh-plugin **#18465**（merged 2026-11-24T15:01Z） |
