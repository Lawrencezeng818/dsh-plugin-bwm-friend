# dsh-plugin-bwm-friend

BWM Friend × DSH「数字人沉浸式工作台」插件——**AI Agent Identity Layer 的 DSH 入口**。
数字人视频 + 半透明幕布 + 青色边框作为"外壳"，原生 DSH 业务流 100% 原生（不重画/不清洗/不 paraphrase）。

## 核心原则

**UI 与业务分离**：正常访问 DSH harness 根 `/` 完全不动；只有 `?bwm=embedded` 才激活嵌入式模式。

## 安装（Publish Preparation：fresh DSH 三步装）

```bash
# 1. 安装插件包（发布后；当前从 Gitee 或本地 pack 安装）
npm i dsh-plugin-bwm-friend
# 或本地：npm i /path/to/dsh-plugin-bwm-friend-0.3.2.tgz

# 2. profile cordis.yml 引用 bundle patch
#   bundles: 加入 dsh-plugin-bwm-friend 的 cordis.patch.yml（`dsh --profile <name> …` 自动加载 dsh.bundle.patch）

# 3. 配置（可选，均有默认值）
#   环境变量（2026-09-03 发布评审补全契约；均可选，无则用内置默认）：
#     XIAOMI_MIMO_API_KEY  — 语音 ASR/TTS（MiMo；无则语音功能显式降级）
#     DEEPSEEK_API_KEY     — 陪伴聊天（Mira）——读宿主 ~/.dsh/.credentials.yaml，无需 env
#     BWM_ASSET_ROOTS      — 数字人视频资产目录（逗号分隔多个；默认扫描
#                            ~/.bwm-friend/assets 与 BWM_STATIC 同级 heygem-data/input）
#     BWM_STATIC           — BWM 前端壳目录（默认用包内 static-ui/，一般无需设置）
#     BWM_UI_PORT          — BWM 服务探测端口（默认 7860）
#     DSH_WORK_DIR         — Agent 任务工作目录（默认用户主目录）
#     BWM_AUTH_BASE        — 登录/云同步代理基址（广州 Hub；缺省=dev 本地验证模式）
#     BWM_UPDATE_URL       — 更新检查清单地址（缺省=内置默认）
#     BWM_TRUSTED_HOSTS    — Host 白名单（逗号分隔 host:port；设后非白名单 Host 一律 403，
#                            彻底关闭 DNS rebinding 残余风险；默认不启用）
#     BWM_TASK_TIMEOUT_MS  — Agent 任务超时上限（默认 600000）
#     BWM_TASK_MIN_MS      — 任务最短耗时接缝（测试用；并发 429 确定性验证）
#     BWM_AGENT_MOCK       — =1 跳过 dsh agent 模块真实导入（挂起/超时路径测试接缝）
#     BWM_MIMO_BASE_URL    — 语音 ASR/TTS 端点覆写（默认小米 MiMo；测试注入 Mock）
#     BWM_CHAT_BASE_URL    — 陪伴聊天端点覆写（默认 DeepSeek；测试注入 Mock）
#     BWM_LOG_DISABLE      — =1 关闭审计日志（默认开；JSON 行 · ~/.dsh-bwm-friend/logs/host.log）
#     BWM_LOG_MAX_BYTES    — 审计日志轮转阈值（默认 5MB → .1）
#
#   数字人视频素材投递点：把 idle-*/heygem-*.mp4 放进 ~/.bwm-friend/assets（可带主题子目录），
#   或安装皮肤包 @laikaton/bwm-skin-*（依赖已声明，npm i 自动就位）。
```

验证：启动 DSH web → `http://localhost:3200/bwm-friend/work/`（work 页）与 `/bwm-friend/companion/`（陪伴页）。

## 架构（方案② + Runtime 化）

```
DSH Harness → BWM Shell Renderer（subscribe / command dispatch）→ @laikaton/bwm-runtime-core
```

| 文件/包 | 作用 |
|---------|------|
| `lib/index.js` | host 半（work/companion 页面伺服、`/bwm-friend/*` 路由、MiMo 语音代理、记忆） |
| `lib/client.js` | client 构建产物（构建自 `src/client.js`，勿手改） |
| `src/client.js` | 浏览器客户端源码（`applyEmbeddedHarness`、EMBEDDED_CSS、presence 事件驱动） |
| `invariant.js` | DSH 规范 invariant companion（`./invariant`） |
| `cordis.patch.yml` | 插件定义（host + invariant 注入） |
| `packages/bwm-protocol/` | BWM Protocol schema（Apache-2.0，冻结 v1.0.0） |
| `packages/bwm-sdk/` | 开发者 SDK（`@laikaton/bwm-sdk`，Agent/Persona/Presence API，v0.1） |
| `packages/bwm-runtime-core/` | 闭源核心（Event/Context/Capability/Ledger/Presence/Request/Identity + DOMAIN_POLICY） |

## 模式

- DSH 根 `/`（无参数）→ client `apply()` 完全 no-op，原生界面不动
- `/?bwm=embedded` → `applyEmbeddedHarness`：centerCol 会话视图 + 侧栏右上抽屉 + 数字人透出
- `/bwm-friend/work/` → work 页（iframe 内嵌原生 DSH，响应式 clamp(620px, 48vw, 1080px)，任务信息条上移顶栏）
- `/bwm-friend/companion/` → 陪伴页（沉浸式视频 + 幕布 + composer + 语音按住说话/回复自动朗读）

## 开发

```bash
# 构建 client（改 src/client.js 后）
node scripts/build-client.mjs

# 沙盒
cd /Users/zengtian/projects/dsh-sandbox && ./start.sh 3200

# 测试（host 端点回归需活沙盒；语音冒烟需 XIAOMI_MIMO_API_KEY）
npm test                  # core 32 + host 26 + e2e
node tests/release-pack-smoke.mjs # 干净机发布冒烟（pack→隔离安装→三端点）
bash tests/status-sync-verify.sh  # 设置状态同步 T1-T14（headless Chrome 真渲染）
node tests/p2-voice-smoke.cjs    # 语音链路
node tests/s3-presence-smoke.cjs # presence 事件驱动
```

## 硬性原则

- 原生 DSH 渲染（header/对话流/composer/模型菜单/推理等级/用量圆环/滚动）100% 原生
- 只改外观，不破坏原生功能；生成类名不稳定 → `[class*=...]` 结构选择器 + `EMBEDDED_SELECTORS` 版本登记
- **Runtime State ≠ Persistent State**：`DOMAIN_POLICY` 裁决落盘（presence/timeline/tasks 不落盘）
- 安全：CSRF 同源校验（Sec-Fetch-Site/Origin）、路径穿越 resolve 校验、postMessage origin 校验

## Known Limitations and Deferred Work

- 语音：按住说话（companion）依赖浏览器麦克风权限；ASR/TTS 走 MiMo（需 `XIAOMI_MIMO_API_KEY`）
- 记忆：规则启发式事实抽取（`FACT_PATTERNS`），未来上移 Memory Runtime（Context Governance）
- 多宿主：当前适配 DSH web；Claude Desktop/Cursor 等宿主经 capability negotiation 降级运行（未实测）
- 发布：`license: UNLICENSED`（私有）；开源策略 = 壳（Shell/Protocol/SDK）开放 + Runtime 核心闭源
- 悬浮按钮拖动未实现（pointerup 重置坐标，静态定位）

## 变更

见 [CHANGELOG.md](./CHANGELOG.md)。
