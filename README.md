# dsh-plugin-bwm-friend

BWM Friend × DSH「数字人沉浸式工作台」插件。

## 核心原则

**UI 与业务分离**：原生 DSH 业务流 100% 原生，不含任何重画/清洗/paraphrase；BWM 只做「皮肤/外壳」（数字人视频 + 半透明幕布 + 青色边框）。正常访问 DSH harness 根 `/` 完全不动。

## 架构（方案②）

- `src/client.js` — 浏览器客户端源码（嵌入式模式 `applyEmbeddedHarness`、EMBEDDED_CSS、PRESENCE_CSS）。改后运行 `node scripts/build-client.mjs` 重建 `lib/client.js`。
- `lib/client.js` — client 构建产物（`window.__ModuleLoader__.load(...)` 包裹），勿手改。
- `lib/index.js` — host 半（work/companion 页面伺服、`WORK_CHAT_JS` 挂 iframe、`/bwm-friend/work/task` 等）。
- `scripts/build-client.mjs` — client 构建脚本。
- `cordis.patch.yml` — 插件定义。

## 模式

- DSH harness 根 `/`（无参数）→ 插件 client `apply()` 完全 no-op，原生界面不动。
- `/?bwm=embedded` → `applyEmbeddedHarness`：iframe 内只显示 centerCol 会话视图，侧栏 → 右上抽屉，详情列隐藏，数字人视频 + 半透明幕布透出。
- `/bwm-friend/work/` → work 页（iframe 内嵌原生 DSH 会话视图 + 右上「陪伴 / ☰ 工作区」）。
- `/bwm-friend/companion/` → 陪伴页（沉浸式视频 + 左侧幕布 + composer）。

## 硬性原则

- 原生 DSH 渲染（header/对话流/composer/模型菜单/推理等级/用量圆环/滚动）100% 原生，不重画、不清洗、不 paraphrase。
- 只改外观（透明/边框/位置），不破坏原生功能（点击、弹菜单、弹用量框、滚动、推理等级显示、模型名）。
- 生成类名不稳定：用 `[class*=...]` 结构选择器或 JS 结构特征定位；JS 定位不能拦截点击/叠覆盖层。
- 正常访问 `/` 原生 DSH 完全不动（只有 `?bwm=embedded` 才激活嵌入式模式）。
