# BWM Friend 威胁模型 v1.0（2026-09-03）

> 依据：对抗性安全评审（子代理评审报告，36 断言回归背书）+ v0.4.x 防线实现
> 适用：dsh-plugin-bwm-friend host（`/bwm-friend/*` 路由）与注入客户端
> 定位：本地同进程插件——攻击面 = 本机其他进程、浏览器同源/跨源页面、远端内容（云端模板/模型目录/Hub 响应）

## 一、信任边界

```
浏览器页面（同源 127.0.0.1 / 跨源 evil.com / rebind 域名）
        │ HTTP
DSH Harness（宿主，同进程）◄── 本插件 host（/bwm-friend/*）
        │                          │ 出站 fetch
本机文件系统（资产/配置/日志）      远端：MiMo ASR/TTS · DeepSeek · 广州 Hub
```

- 操作员 env（BWM_*）＝可信输入
- 用户本人（同源浏览器）＝可信写主体；跨源页面＝不可信
- 远端响应内容＝不可信（模板名/模型名/Hub message 一律不直接入 DOM 或回显）

## 二、威胁与防线（含评审闭环）

| # | 威胁 | 防线 | 验证 |
|---|---|---|---|
| T1 | 跨源 CSRF 伪造写（表单 text/plain 伪造 JSON 打 /work/task → RCE 级） | Sec-Fetch-Site 分级 + Origin/Host 等值 + dest=document 仅读 + Origin:null/file:// 仅读 | 26→36 断言含 403 套件 |
| T2 | **DNS rebinding/别名域**（rebind 后浏览器视为同源，Origin==Host 同时为攻击域——评审 P1-2：原等值锚可被整体绕过） | `isTrustedHost`：浏览器路径（same-origin/none/same-site）的 Host 必须为回环（localhost/127.0.0.1/[::1]）或在 BWM_TRUSTED_HOSTS 显式扩展 | `__securityTestHooks` 子进程单测 |
| T3 | 载荷内存 DoS（无界 body 累加——评审 P1-1：companion/chat 是唯一漏网端点） | 全写端点 readJsonBody 有界（chat 1MB / settings 1MB / transcribe 25MB+并发≤2） | 2MB 载荷 → 413 且服务存活 |
| T4 | 任务滥用（并发拉起多 agent；超时后 agent 无人监管继续执行——评审 P1-3） | /work/task in-flight ≤2（429）；超时/异常路径 dispose 尽力中止（防御式可选链）；BWM_TASK_TIMEOUT_MS 上限 | 并发第 3 个 429（seam 确定性测试） |
| T5 | XSS（远端输入：云端模板名/模型名/主题目录名/聊天回显） | 全部 innerHTML 插值经 `__bwmEsc`/`escLocal`/`esc`；动态回显走 textContent；postMessage 校验 origin | 评审逐 sink 审计零命中 + 静态断言钉死转义链 |
| T6 | 任意文件读（路径穿越 / media token 注入 / **symlink 夹带**——评审 P2-4） | URL 规范化+resolve startsWith；token 正则排除 `./%` + 服务端白名单；**lstat 拒绝 symlink 条目**（根级投递软链属设计内，仍可） | 穿越全形态 404/403 套件 |
| T7 | 凭据面（爆破中继/Hub message 透传/主体信息泄漏——评审 P2-5/P2-6） | 登录限速（按 subject 分桶，60s 窗 5 次 → 429）；生产错误统一 `http-<status>`；maskSubject 最小化（仅后 2 位）；token 不下发、日志仅掩码 | 限速 429 + 日志无原始手机号断言 |
| T8 | 原型污染 | JSON.parse/spread 均产生自有属性（CreateDataProperty），白名单键迭代不含 `__proto__`（评审 node 实测排除） | 评审实证 |
| T9 | 攻击无痕 | 结构化审计日志（req/config/auth/chat/transcribe/task 全事件，403 也有痕；掩码入账；5MB 轮转） | 日志断言（批次1） |

## 三、残余风险（明示不装瞎）

1. **无 Origin 客户端（curl/SDK）放行**：不在 CSRF 威胁模型内（本机进程本可直连）；换来的是 SDK/脚本可用性。
2. **LAN 访问默认 403**：浏览器路径 Host 必须回环；局域网访问需设 `BWM_TRUSTED_HOSTS=<host:port>`（安全默认的取舍）。
3. **dev 登录模式**（BWM_AUTH_BASE 未设）：任意凭据即登录——仅限本地开发语义，生产必须配置 AUTH_BASE；限速按尝试计数兜底。
4. **metrics/health 未鉴权**：仅运行态指纹（rss/路由计数/组件布尔），本机低权进程可读；信息量评估为低。
5. **BWM_TRUSTED_HOSTS 含端口精确匹配**：写 `127.0.0.1:3080` 走 `localhost:3080` 仍 403（回环集已含 localhost，仅 LAN 域受影响）——文档已示。
6. **审计请求行不含 origin/host/UA**：rebinding 形态攻击的事后取证需结合宿主层日志（T2 已在插件层预防）。

## 四、评审留痕

- 评审者：对抗性子代理（独立上下文，只读仓库）；报告含 3×P1、3×P2、5 个覆盖缺口
- 闭环：全部 P1/P2 已修复（本文件 T1-T9 所引），覆盖缺口 5 项已入 `tests/host-endpoints.test.cjs` §8 与 `tests/companion-chain.e2e.mjs`
- 下次评审：定版 v0.5.0 前重跑对抗评审（提示词：`docs/REVIEW-PROMPT-v0.4.0.md`）
