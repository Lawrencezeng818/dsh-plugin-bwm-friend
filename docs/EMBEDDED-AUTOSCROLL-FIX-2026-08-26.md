# Embedded Mode Auto-Scroll Fix — 2026-08-26

> Postmortem + fix record. Work page (`/bwm-friend/work/`，iframe 内嵌原生 DSH，`/?bwm=embedded`) 在输入/回复后对话窗口不自动下滚。

## 现象

- 原生 DSH（非嵌入式）自动滚动正常；嵌入式 work 页不滚。
- 用户发送消息后，整个工作过程中对话区不跟随滚动。

## 根因（源码 + 实测双重确认）

1. **原生布局**：原生 DSH 中 `scrollBody`（`[data-conversation-scroll]`）是唯一滚动容器；消息列表 `.scroll` 是 `overflow: visible` 普通流（见 `ui-conversation/src/client/chat/ChatView.module.css` 的 `:global([data-conversation-scroll]) .scroll { overflow: visible }`）。原生自动滚动 `toBottom(el)` = `el.scrollTop = el.scrollHeight`，作用在 `scrollerOf(local)` = `closest('[data-conversation-scroll]')` 上（`ChatView.tsx`），所以原生有效。
2. **插件 EMBEDDED_CSS 破坏几何**（`src/client.js`）：`!important` 把 `[class*=scroll]`/`[class*=list]` 全设 `overflow-y: auto`，`[class*=root]` 设 `height:100%` → 长会话时**实际承接滚动的是消息列表 `waGfua_list`，`scrollBody` 不再溢出**。
3. **旧自动滚动代码只滚 scrollBody**（`scrollTop = scrollHeight`）——对无溢出元素是 no-op → 永远不滚；原生逻辑同样滚 scrollBody，也被 CSS 废掉。两者一起失效 = 用户看到的 bug。

实测证据（headless Chrome + CDP，短会话）：
- `scrollBody`：sh 456 == ch 456（无溢出）→ 旧代码操作它必是 no-op。
- `waGfua_list`：sh 286 > ch 282（唯一真实溢出容器）。

## 修复（`src/client.js` 的 `wireAutoScroll` 重写）

机制：
- **滚动目标**：每次实时查询所有候选滚动容器（`scrollBody`/`viewArea`/`centerCol > root`/`scroll`/`list`），逐个 `scrollTop = scrollHeight`（幂等，无溢出者 no-op）——无论 DSH 布局/几何怎么变，真正溢出的那个容器必被滚到底。
- **观察器**：挂在 `document.body`（subtree+childList+characterData），会话切换/React 重建不失效（旧实现捕获 scrollBody 一次性引用，且 `__bwmAutoScrollWired` 常驻阻止重连）。
- **时序**：mutation 后双 `requestAnimationFrame` 再滚，等流式/图片异步布局稳定。
- **暂停逻辑**：`document` 上 capture 阶段监听 scroll（scroll 事件不冒泡但走捕获），任一容器离开底部 60px 即暂停跟随，回到底部恢复——与原生"pin 到底部才跟随"一致。

构建：`npm run build`（`scripts/build-client.mjs`，src → lib 包成 `__ModuleLoader__.load` envelope）。
生效：3200/3080 均从磁盘伺服 `lib/client.js`，**刷新页面即生效，无需重启服务**（已 curl 验证两边伺服新标记）。

验证（修复后注入 3000px 撑高块）：
- 注入前：`waGfua_list` sh 286 / ch 282 / st 0。
- 注入后：`waGfua_list` sh 286 / ch 16 / **st 270** = 恰好滚到底（sh − st − ch = 0）。
- `wired: true` 新逻辑生效；scrollBody 依旧无溢出（证明旧代码确实无效）。

## 调试方法备忘（headless Chrome + CDP）

在 DSH 文件沙箱下跑 headless Chrome 的可用配方（本 bug 排查沉淀）：
- 必须加 `--no-sandbox --disable-dev-shm-usage`，否则 Chrome 沙箱初始化失败直接崩。
- **用 `Target.createTarget({url})` 或先 `location.href=` 再 evaluate 导航**；`Page.navigate` 在此环境易超时。
- `Runtime.evaluate` 用同步表达式 + `returnByValue`；`awaitPromise: true` 会挂死。
- 页面渲染慢：轮询 evaluate 等 `[class*=scrollBody]` 出现（最多 ~50s）再测。
- 残留 Chrome 占端口会导致诡异超时：先 `pkill -f "remote-debugging-port=93"`。
- 临时 profile 目录 rmSync 偶发 ENOTEMPTY（Chrome 未完全退出），属无害噪音。

## 关联

- 修改文件：`src/client.js`（源码 SSOT）、`lib/client.js`（构建产物）。
- 环境拓扑见 `docs/DSH双环境拓扑与使用规范.md`。
- 相关原生代码：`deepseek-harness/packages/client/ui-conversation/src/client/chat/ChatView.tsx`（toBottom/scrollerOf）、`.../skeleton/ConversationRoot.module.css`。
