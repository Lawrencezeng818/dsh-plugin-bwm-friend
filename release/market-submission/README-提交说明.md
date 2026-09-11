# BWM Friend — DSH 插件市场收录提交说明

> 提交目标：dsh-market.com（DSH 社区插件市场，@linxin666 维护 community.json 收录制）
>
> 版本：**v0.6.0**（2026-09-10 定版 + 2026-09-11 发布收敛）——在 0.5.0「完成度地图九行全部 100%」基础上新增**行为经历账本（wireLedger）持久化**：Agent 任务/工具事件逐条落盘、重启恢复、语义字段前向兼容，为「共同经历改变后续行为」打底（发布门槛全绿：core 36 · host 38 · e2e 12 · 状态同步 T1-T14 · 干净机安装 8 检查 · 全新 DSH 装载 15 检查）。
> 安全：对抗评审 3×P1+3×P2 全修复，威胁模型 `docs/THREAT-MODEL-v1.md`（九防线+六残余风险）。
>
> **历史**：v0.5.0（2026-09-03）完成度九行 100%；v0.4.0（2026-09-03）发布评审四维 P0 全闭环：安全加固（CSRF 绕过封堵/XSS 转义/凭据掩码）、打包自包含、settings 写入健壮化、资源治理与任务超时、装饰功能收敛。
>
> 截图说明：companion-page.png 为 v0.5.0 基线（1600x1000）；v0.6.0 无 UI 变更（账本为服务端/底层能力），截图沿用有效；work-page.png 因 headless 截图已知挂起（视频组件虚拟时间饥饿），沿用 v0.4.0 市场提交版基线（默认视图无差异）。
> npm 版本说明：registry 已有 0.3.0/0.3.1（2026-08-24 发布），本版 0.6.0 为升级发布。

## 一、提交内容清单

| 文件 | 说明 |
|------|------|
| `plugin-entry.json` | community.json 收录条目（含中英文描述） |
| `screenshots/work-page.png` | work 页截图（数字人沉浸式工作台） |
| `screenshots/companion-page.png` | companion 页截图（陪伴模式） |

## 二、收录条目（plugin-entry.json）

```json
{
  "id": "dsh-plugin-bwm-friend",
  "name": "BWM Friend 数字人工作台",
  "nameEn": "BWM Friend",
  "author": "laikaton",
  "description": "数字人沉浸式工作台：原生 DSH 业务流 + 数字人视频 + 半透明幕布 + 青色边框。语音输入/回复朗读、跨会话记忆、人格切换（Mira 陪伴/Mentor 导师）、数字人主动行为、多会话工作区弹窗。UI 与业务分离——原生 DSH 100% 不动。",
  "descriptionEn": "Digital human immersive workspace: native DSH flow + avatar video + frosted scrim + teal border. Voice input/read-aloud replies, cross-session memory, persona switching (Mira companion / Mentor advisor), proactive digital-human behaviors, multi-session workspace popup. UI separated from business — native DSH untouched.",
  "repo": "https://gitee.com/zeng-tian818/dsh-plugin-bwm-friend",
  "npm": "dsh-plugin-bwm-friend",
  "category": "ui"
}
```

## 三、产品简介（用于市场展示）

### 一句话定位
**BWM Friend = AI Agent Identity Layer 的 DSH 入口**——不是普通数字人插件，而是让 AI Agent 持续表现"我是同一个 Agent"（Presence/Context/Ledger/Identity）的沉浸式工作台。

### 核心特性
1. **原生不打扰**：UI 与业务分离——原生 DSH 业务流 100% 原生（不重画/不清洗/不 paraphrase），正常访问 `/` 完全不动
2. **数字人沉浸**：数字人视频 + 半透明幕布 + 青色边框（BWM 品牌色系），左侧对话右侧数字人
3. **语音全链路**：按住说话 → ASR → 发送 → AI 回复自动朗读（MiMo TTS，8 音色可换）
4. **跨会话记忆**：Mira 记得你的偏好/名字/说过的事（跨消息生效）
5. **人格切换**：Mira（温暖陪伴）↔ Mentor（理性导师）双人格，一键切换
6. **主动行为**：数字人会主动问候/关心（结合记忆），不是被动应答
7. **多会话工作区**：☰ 弹窗屏幕最右毛玻璃，会话树一键切换
8. **工程化**：CSRF 防护/路径校验/事件驱动 presence（0s 响应）/ 皮肤资产包机制

### 技术底座
- DeepSeek Harness 插件（bundle 标准：`dsh.bundle.patch` + `./invariant`）
- 架构：DSH → Shell（UI）→ BWM Protocol（公开 Apache-2.0）→ Runtime（闭源核心）
- 行为经历账本（v0.6.0）：任务/工具事件逐条持久化 + 重启恢复，语义字段前向兼容（工程能力，UI 暂不暴露）
- npm：`dsh-plugin-bwm-friend`（代码）+ `@laikaton/bwm-skin-mira`（皮肤资产包）

### 安装
```bash
npm i dsh-plugin-bwm-friend @laikaton/bwm-skin-mira
# profile 引用 bundle patch 后重启 DSH
# 访问 /bwm-friend/work/（工作台）与 /bwm-friend/companion/（陪伴）
```

## 四、截图说明

### work-page.png — 数字人沉浸式工作台（work 模式）
- 右侧：高品质数字人视频（电竞男友主题皮肤，白色职业装，亲切微笑）
- 左侧：原生 DSH 会话视图（模型选择 DeepSeek-V4-Flash-Vision-Exp High / Workspace Write / 输入框 / 青色发送键）
- 顶部：任务信息条（标准模式 / Session log / 对话·轨迹 tabs）+ 品牌横幅
- 深色沉浸配色 + 青绿色（Teal）高亮 = BWM 品牌色系

### companion-page.png — 陪伴模式（companion）
- 右侧：数字人居家场景（沙发/抱枕，温暖微笑，单手托下巴）
- 左侧：半透明磨砂玻璃面板（幕布效果，虚实共生）
- 聊天界面：最近对话 / 输入框 / 麦克风（按住说话）/ 发送
- 顶部：「✨ 主动」按钮 = Mira 主动行为

## 五、提交方式（给维护者）

1. **找到 community.json 仓库**：@linxin666/dsh-client-ui-community-plugins（npm 包内的 community.json 是数据源）
2. **提交 PR**：把 `plugin-entry.json` 内容追加进 community.json（保持数组格式）
3. 或**联系作者**（linxin666）附上本包内容

### 提交字段说明
- `id`：唯一标识（= npm 包名）
- `name/nameEn`：市场显示名（中英文）
- `author`：作者/组织（laikaton）
- `description/descriptionEn`：市场简介（中英文）
- `repo`：源码仓库（Gitee）
- `npm`：npm 包名（安装入口）
- `category`：分类（ui / agent / tool 等）

## 六、注意事项

- npm 搜索索引对新包有延迟（registry API 可查但 search API 需时间收录）——不影响 `npm i` 安装
- 插件 license 当前 UNLICENSED（私有部署阶段）；后续开源拆分（壳 MIT）后建议更新描述
- 皮肤资产包独立分发（`@laikaton/bwm-skin-mira`）——市场可同时展示皮肤包
