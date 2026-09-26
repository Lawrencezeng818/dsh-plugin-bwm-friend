# 0.7.2 发布硬化批次 · 全面审查与修复记录（2026-09-26）

> 三路并行只读深审 → 分级修复 → 全门禁闭环。审查对象：static-ui 陪伴页 / host 端点 / 闭源核心包 + 嵌入式壳层（src/client.js）。全部 P1/P2 与可安全收口的 P3 已修复；残余项分级处置见文末。

## 一、审查发现总览

| 审查面 | P1 | P2 | P3 | 报告要点 |
|---|---|---|---|---|
| static-ui（app.js 2997 行/index.html/styles.css） | 4 | 10 | 15 | quota.updated 引用未定义变量（ReferenceError 被吞，额度徽章整会话不更新）；WS 断线 busy 永不复位（输入框永久禁用）；loadTemplates 只追加不清空（模板卡成倍重复）；删除无确认；读操作 9 处缺 ok 检查；更新版本号 innerHTML 未转义 |
| host（lib/index.js 2435 行） | 1 | 3 | 9 | ReDoS（chat 无并发守卫 + 无界回溯正则，与 DSH 同进程可拖死事件循环）；请求体逐 chunk 拼接（UTF-8 多字节断裂 + 限额按字符计）；chat fetch 无超时；启动预扫描 TDZ 静默死亡。历史六防线（CSRF/1MB/并发≤2/lstat/限速/审计轮转）核查全部在位无回归 |
| 核心包（runtime-core/protocol/sdk/invariant/factgate） | 3 | 8 | 14 | 感知路由补偿回调失真（同参重复调用）；commit/route 不查会话关闭（销毁即失效破约）；桥接不复核域与获准模式（持久化准入旁路）；两套账本 store 契约矛盾；总线三处无异常隔离；四处无界增长；recentTopics 裁剪方向反 |
| 嵌入式壳层（src/client.js，我 + 历史会话） | — | 3 | 2 | 悬浮按钮拖动假实现（pointerup 重置坐标）；自动滚动候选容器未收敛（侧栏/TodoPanel 被抢滚动+暂停误判）；账本/上下文 GET-PUT 竞态丢字段；无效 CSS 声明 child-shadow |

历史会话 P1–P5 交接文档（/Users/zengtian/projects/dsh-bwm-friend-需求文档.md）复核结论（3200 沙盒 CDP 实测）：
- P1 点模型名不弹菜单 → **已收口**（真实鼠标点击弹出 250×50 菜单，el.click 与 Input.dispatchMouseEvent 双路径验证）
- P2 用量圆环位置 / P4 发送键裁剪 → **已收口**（长模型名 "DeepSeek-V4-Flash-Vision-Exp High" 压力下 trailing 无溢出、发送键/边框完整，圆环回归原生位置——JS transform 已撤、CSS 修复生效）
- P3 模型名截断/推理等级 → 原生行为保留（原生 max-width 截断，菜单内完整显示）
- P5 侧栏抽屉/详情条/多会话切换 → 已实现（e2e 冒烟 12/12：320px 抽屉、贴最右、连续切换不关闭）

## 二、修复清单（按域）

### host（lib/index.js）
1. ReDoS 三层修复：chat 入口截断 2000 字符 + memory.js 正则全部加界 + chat 并发守卫 ≤4（429，early-return 排空流）
2. readJsonBody Buffer 收集 + 字节限额 + strictJson 选项；PUT /settings 消重走同通道
3. companionChat fetch 补 AbortSignal.timeout(60s)
4. 启动预扫描 TDZ 修复（调用点移至 watchedRoots 声明后，失败落审计 inventory.preload_failed）
5. serveMedia：bytes=-0 → 416；promise 链最终兜底（unhandledRejection 防崩）；mp4Resolution fd try/finally
6. memoryQueue 防毒护栏；PROACTIVE_CONTEXT Object.hasOwn；/status avatar null 守卫；runRealAgentTask 成功路径 dispose；early-429 排空
7. settings 校验器缺席降级显式化（console.error + audit + health components.settings.validator）
8. 登录限速**维持原契约**（按尝试计数）——评审后裁决：改按失败计数会使限速在 dev 模式不可触发不可测试；60s 自愈窗口的误杀属已裁决取舍（红线：不放松安全契约）

### static-ui 陪伴页（26 项）
P1×4（quota.updated msg→event；WS close 复位 busy + 10min watchdog；loadTemplates replaceChildren；删除确认）+ P2×10（XSS 转义/发送防抖/头像回滚/上传上限/静默轮询/persona 禁存/模板失败提示/克隆防并发/死按钮/长回复滚动）+ P3×12（16px 防聚焦放大/--accent/禁用态/Esc 关闭/pre-line/弹窗滚动/fetchJsonOk 九处封装等）。

### 嵌入式壳层（src/client.js）
1. queueConfigWrite 串行链：ledger append / context persist / mode persist 全部过链（丢字段竞态根因）
2. wireAutoScroll 候选收敛：仅 centerCol 内、排除 sidebarCol 与 composerStack；暂停判定同步收敛
3. 悬浮按钮拖动落点即新位 + 视口 clamp（README Known Limitation 关闭）
4. child-shadow 无效声明清理

### 核心包（17 项，详见提交与测试）
补偿逐项化 / SESSION_CLOSED / 桥接双门（not_persist_granted + perception_not_user_confirmed）/ 异步 append 回滚与上报 / restore 双契约归一 / 总线三处隔离 / shelved 搁置清单 / DEFER 过期丢弃 / 四处加界 / recentTopics 方向修正 / hydrate 浅拷贝 / verify NaN 篡改 / 时间类型归一 / 重入护栏 / invariant 显式降级。

## 三、验证证据（全绿）

| 门禁 | 结果 |
|---|---|
| bwm-runtime-core | 149 pass / 0 fail（131→149） |
| bwm-protocol | 19 pass / 0 fail（13→19） |
| build-artifact parity | PASS（产物可加载 + 内联逐字节一致） |
| host-endpoints（3200 沙盒） | 38/38 |
| e2e-smoke（playwright 真渲染） | 12/12（含模型菜单点击弹出） |
| release-pack-smoke | 8 PASS |
| release-fresh-dsh | 15 PASS（0.7.2 全新安装） |
| embedded-selectors（headless CDP） | ALL PASS（hard 结构零漂移） |
| settings-robust e2e | ALL PASS |
| status-sync T1-T14 | ALL PASS |
| CDP 实测（本批次） | 长模型名压力无溢出/菜单双路径弹出/根路径零侵扰 |

## 四、残余项分级处置

- **维持原状（已裁决）**：登录限速按尝试计数（dev 可测性 > 罕见误杀）；P3 模型名原生截断；serveMedia TOCTOU（需本机写权限，威胁模型内可接受）
- **降级为观测点**：settings 校验器缺席 → audit + health 显式暴露
- **留档待产品确认**：busy 断线即时解锁可能与重连后进行中响应交错；refreshStatus 瞬时失败闪红；移动端 16px 布局需真机过一眼（static-ui 三处）
- **后续批次**：core completedRounds 按会话隔离需扩展 API 签名；hydrate 深拷贝；异步 append 回滚窗口（同步 store 不受影响）
