# Changelog

## 0.8.39 (2026-11-11) · 修「设置弹窗打开后有一部分被透明化」：清底函数限定主干 #root 子树

> 创世者报告：0.8.38 后设置弹窗能正常弹出了，但**弹窗有一部分区域被透明化**
> （能透出后面的聊天/视频层）。裁决：原生弹窗「原有是怎么样就怎么样」，绝不清底。

### 根因（JS 运行时清底函数，不是 CSS）

`ADAPTER_DSH_0823.transparentizeSurfaces()`（干活模式的「发现式清底」）：遍历 `body *`，
凡**不透明背景 + 可视面积 ≥35% 视口**的元素一律 `background: transparent !important`
（设计意图：清掉主干 frame/pane/root 多层白底，让视频层透出来）。

触发链闭环：
1. 设置弹窗 = DSH Modal，`createPortal(..., document.body)` 挂 **body 直下**；
2. 弹窗打开 = DOM 变化 → `MutationObserver`（apply 幂等校正）→ `setWorkLayout()`
   → `transparentizeSurfaces()`；
3. 弹窗整体 ≥35% 视口且不透明白底 → 命中判据被清透明；内部小卡片 <35% 保留
   → 表现为「弹窗有一部分被透明化」。

### 修复

`transparentizeSurfaces()` 增加守卫：**只清主干应用（`#root` 子树）**，
`el.closest('#root')` 为空一律跳过（DSH 主干挂 `#root`，asar 实证
`getElementById('root')`；原生弹层 portal 在 body 直下、#root 之外）。
原职责（清主干白底面板）不受影响；抽屉 `.bwm-sb` 在 #root 内，行为不变。

### 教训

「发现式」运行时清底（按几何/样式特征找目标）的判据必须带**作用域边界**——
body 全域扫描会把 portal 弹层当成目标。门户（portal 挂载点）就是天然边界：
主干 = #root，弹层 = body 直挂。

## 0.8.38 (2026-11-11) · 修「个人→设置弹窗不出现」：层级向发布版对齐 + 弹层表面色成对补齐

> 创世者报告：点工作区弹左侧抽屉，点左下角「个人」（插件市场/模型设置入口），
> 白色设置弹窗不出现。裁决：**向发布版 0.8.0 的做法对齐**。

### 根因（两条链，均由桌面壳偏离发布版造成）

- **层级链**：本皮肤曾把 z 拔到 2147482000+（发布版全套 ≤81）。从宿主 asar 全量
  实测 DSH 真实层级带：内容 ≤101 · overlayLayer=20(pointer-events:none) ·
  onboarding 900 · dialog 1000–1003 · 菜单 1100 · chatPick 1200+。
  我们的全屏 `#bwm-sidebar-scrim`(2147482050, 抽屉开时 inset:0 显示) 把 900+ 带
  的原生弹窗全部压住，且其 click=「关抽屉」——弹窗开了也被盖、点击被吃。
- **配色链**：0.8.36 给作用域重声明了全部 `label-*` 文字变量（改浅）却漏了
  `bg-layer-1/2/3`（弹层表面，宿主 142+ 处消费，浅色主题=白）→ 作用域内的弹层
  白底白字。发布版 0.8.0 对 `--dsw-*` 重声明数量为 **0**，刷色全靠逐组件点名。

### 修复（对齐发布版原则）

- **层级回小数字**：topbar 2000→**120**、抽屉 2100→**130**、scrim 2050→**110**、
  ☰ 3000→**140**。取 110–199 空闲带（asar 扫描无占用）：内容之上、一切弹层之下；
  「点击外部关抽屉」保留，原生弹窗不再被吞。发布版相对关系保持：scrim<topbar<抽屉。
- **弹层表面色成对补齐**：调色板补 `bg-layer-1/2/3 = bluish-875/850/800`（DSH 官方
  深色主题原值，asar 实测），与 label-* 浅色值恢复 DSH 深色主题原始映射。
- 遗留说明：portal 到 body 的 DSH 原生弹窗在浅色主题下是白底黑字（功能正常），
  深色化留待后续单独裁决。

## 0.8.37 (2026-11-11) · 撤回 0.8.36 的错误归因，回滚到发布版行为；重定「视频定格」真凶候选

> 创世者质询：「有现成的代码，你比对一下之前已经发布的版本……为什么要乱改原有已经好的代码？」
> 逐项比对 `/tmp/pkg080/package/lib/client.js`（发布版 0.8.0）后确认：0.8.36 的两条结论
> **都不成立**，属于「拿无效测量当实测」+「换掉没坏的代码」。已整体回滚。

### 撤回一：filter+transform 叠加冻结视频 —— 证据无效，已回滚

- 0.8.36 声称「三帧像素完全一致（冻结）；单独任一属性都不冻结」，据此删掉了
  thinking 的 `transform: scale(1.02)`（发布版 lib/client.js:764 本来就有）。
- **复核发现测量无效**：留存的截图证据里，实验组（m1v/m2v/m3v）与**对照组**
  （k1v/k2v/k3v）各自内部 MD5 都完全一致——对照组没变化说明测的根本不是
  「改动是否冻结画面」；且拍摄时 DSH 窗口被前台应用（WPS/WorkBuddy 弹窗）遮挡。
  agent 侧也无法可靠把 DSH 切到前台（System Events -10004，`open -a` 激活无效）。
- **逻辑上也不成立**：发布版 0.8.0 用同一份规则跑了很久，若叠加真是病因，发布版早该复发。
- **处置**：`PRESENCE_CSS` 恢复与发布版 762-768 逐字一致（transition 含 transform、
  thinking 恢复 `transform: scale(1.02)`）。

### 撤回二：电源管理重写（converge+看门狗）—— 改的是没坏的代码，已回滚

- 复核 host.log 的 `video.power` 序列：8 次启动（09:38–09:49）**全部**
  `loadeddata → playing` 收尾，`paused:false`、`readyState:4`，零条
  pause / hidden / play-rejected 记录 → 媒体元素从未被暂停，也不存在
  「play 被拒后无人重试」的实际发生场景。
- **处置**：`bindPowerManagement` 恢复发布版 1075-1104 原实现；`bindOcclusionPause`
  按发布版 941-951 原样恢复（发布版里同样只有定义、没有调用点，属既有形态，不再动）；
  删除 `video.power` 诊断上报与 3s 看门狗（诊断使命已完成，证据留在
  `~/.dsh-bwm-friend/logs/host.log`）。

### 重定真凶候选：0.8.36 新加的输入座位层 `backdrop-filter`

- 时间线：三 bug 修复给 `[class*=composerSeat]` 加了 `rgba(8,13,22,.93)` +
  `backdrop-filter: blur(18px)`（大面积、直接压在视频可见区上方）→ 随后用户报
  「执行任务聊天时视频定格」。
- 旁证：视频在播（paused:false）但画面不动 = 合成层快照不更新，与「backdrop-filter
  缓存背景快照」的失效模式吻合；发布版对视频上方的遮挡只有**实色渐变 + 左侧一条
  blur 幕布**（`#bwm-scrim` z5），从不大面积给视频挂 backdrop-filter。
- **处置**：座位层改为高不透明度**实色** `rgba(9,14,23,.97)`（视频层底色系），
  删除 backdrop-filter——观感近似磨砂，但不产生背景快照合成层。
- **新红线（写进 CSS 注释）**：视频可见区上方的遮挡层**禁止 backdrop-filter**，
  需要磨砂感用实色近似。

### 本版本净变化（相对 v0.8.35 基线，除三 bug 修复外全部回到发布版行为）

- 三 bug 修复保留：标题上移 `mainPanel padding-top`、滚动隔离 `overflow-y:hidden`、
  抽屉深色调色板 + macOS 白洗等价覆盖（这三条发布版没有对应物，属桌面壳新增）。
- 输入座位层：不透明底保留、**去 backdrop-filter**（0.8.36 引入的合成层风险清除）。
- 视频 CSS 与电源管理：与发布版 0.8.0 逐字一致。

## 0.8.36 (2026-11-11) · 修「agent 一思考，右侧视频就定格」【⚠️ 本条两条结论已被 0.8.37 撤回，勿引用】

> 用户报告：干活模式下执行任务聊天时，右侧 Mira 画面停止播放、定格，且不会自行恢复。
> 排查分两条线，最终确认是**两个独立缺陷**，都已修。

### 缺陷一（真凶）：`filter` + `transform` 在 `<video>` 上叠加 → 画面冻结

- **现象定位**：先排除「播放被暂停」——但宿主日志 `desktop.diag` 里确实出现过
  `paused:true`（`readyState=4`、`src` 正常），说明还有独立的暂停缺陷（见缺陷二）。
  真正对应用户描述的是**画面定格但仍在播**：连续截图三帧，像素完全一致。
- **二分过程**（每轮都截图比对同一裁切区的 MD5）：
  | 施加在 video 上 | 两帧是否变化 | 结论 |
  |---|---|---|
  | `filter: blur(2px) saturate(.9) brightness(1.06)` | 变 | 单独不冻结 |
  | `transform: scale(1.02)` | 变 | 单独不冻结 |
  | **两者同时** | **完全一致** | **冻结** |
  | 真实 `.bwm-thinking` 规则（本就同时含两者） | **完全一致** | **冻结** |
- **结论**：Chromium(macOS) 在 `filter` 与 `transform` 共存时，会把视频从「直接合成」
  踢到「读回滤镜再变换」路径，视频帧不再提交——画面停在最后一帧，而 `paused` 仍是
  `false`，排查时极易误判成播放被暂停。
- **修复**：`.bwm-thinking video` 去掉 `transform: scale(1.02)`，只保留 `filter`；
  `.bwm-layer video` 的 transition 一并去掉 transform 项。
- **红线（已写进 CSS 注释）**：本文件所有视频态**只允许改 `filter`**，任何「放大/位移」
  类效果必须加在覆盖层，不许碰 video 的 `transform`。

### 缺陷二：`play()` 失败后无任何重试路径 → 暂停后不自愈

- **旧实现**：暂停与恢复各写各的，靠 `video.dataset.wasPlaying` 中间量传递「该不该恢复」；
  `play()` 被拒时 `.catch(() => {})` 静默吞掉，之后没有任何重试。
  启动瞬间（窗口不可见/尚未缓冲）被拒一次，视频就永久停在首帧。
- **重写为「目标态收敛 + 看门狗」**：
  - `shouldPlay()` 单一判据算目标态（可见 + 未被电池策略降级）；
  - `converge()` 幂等地把当前态推向目标态，可被任意事件反复调用；
  - 触发点：`visibilitychange` / `focus` / `pageshow` / 非预期 `pause` / `loadeddata` /
    **3s 看门狗**（兜住 Chromium 后台节流、GPU 上下文丢失、宿主重排等静默中断）；
  - 电池逻辑只更新 `onBattery` 标记，暂停与否一律交给 `converge`。
- 同时删除死代码 `bindOcclusionPause()`（从未被 init 调用，且与电源管理职责重叠——
  两处各自 pause/play 正是「定格不自愈」的来源之一）。
- 新增诊断事件 `video.power`（仅桌面壳）：记录 `reason / acted / paused / hidden / readyState`，
  去重后上报，下次同类问题可直接看日志判定是「被暂停」还是「画面冻结」。

### 验证

- 修复后 video 上只剩 `filter`，无线 `transform`；干净产物重启无 crash、画面正常刷新。
- 排查期间曾有 3 次 `Desktop renderer exited: killed`，全部发生在实验脚本往 video 上叠加
  `filter`+`transform` 时，干净产物下未复现——与该组合走危险合成路径的判断一致。

## 0.8.35 (2026-11-10) · B 批：会话区 / 输入区逐项对齐发布版

> 承接 0.8.30–0.8.34（A 批骨架）。来源仍是 `dsh-plugin-bwm-friend-0.8.0/lib/client.js`
> 的 `EMBEDDED_CSS`（1377-1488），但那份表按 0.8.x 的 hashed 类名写（`.p7GS4W_*` /
> `.PNUCKq_*` / `.eLe3jW_*`），0.2.2 哈希前缀全变（实测当前 InputBar = `JZLxKW_*`），
> 故**按语义选择器（`[class*=xxx]`）重写**，逐条注释标明对应行号。

### 已搬（B 批，9 组）

| # | 发布版行为 | 落地 |
|---|---|---|
| ① | 会话头 76px 两行 → **44px 单行**（titleRow + tabs 同行） | 保留网格、把 `.tabs` 从「跨列第二行」搬到「第 3 列第 1 行」，行高锁 44px；`headerBlank`（hero 空态）不套用 |
| ② | 会话区隐藏滚动条、composer 内列表恢复细滚动条 | 作用域限定 `[class*=mainPanel]`（整页 `[class*=list]` 会裁掉模型菜单） |
| ③ | `composerSeat` 贴底 + `padding: 14px 4px 6px 0` | 同值 |
| ④ | 输入文字 `#e8efec`、placeholder `rgba(223,231,228,.55)` | 同值（不钉就走宿主变量，偏冷偏亮） |
| ⑤ | 模型名白 + **effort 值青 `#7bf2d2`/600** | 同值（0.2.2 的 `Default` 原本是灰的，实测已补回青色） |
| ⑥ | `trailing` 不换行、ContextMeter 圆环不被撑满 | `[class*=trailing]` 与 `[data-slot="conversation.input.model"]` 同值 |
| ⑦ | `heroGlow` 隐藏 | 同值（0.2.2 无此类名 = 无害死规则，留作升级对账） |
| ⑧ | ask/附件卡防横向截断 | `section[class*=card]` 两处挂载位都约束 max-width |
| ⑨ | 窗口 <560px 压缩 composer clearance | 同值 |

### 十、0.2.2 新增的「局部深色」组件（发布版没有，属增量修复）

`ui-deliverables`（交付文件卡 / 变更文件）、`ui-plan`（计划卡）把深色**写死在
`:global(body[data-ds-dark-theme])`** 里，不走 `--dsw-*` 调色板。本仓只做 CSS 作用域、
不切宿主主题属性 ⇒ 它们退回浅色：实测交付卡底色 `rgb(250,250,250)` **纯白**，
在深色幕布上是一块白板（用户视角最刺眼的一处不一致）。
→ 在对话面板内重声明 `--deliverable-fill/-hover`、`--changes-fill/-hover`、
`--plan-card-fill/-hover`（宿主深色块同值 neutral-850/800）+ 图标托底 `5% 白`。

### 踩坑记录（三个，都实测）

1. **不能把 header 改成 flex**：0.2.2 的 `.titleRow` 带 `container-type: inline-size`（内联轴尺寸包含），
   一旦成为 flex 项，固有宽度=0 → 标题整行消失、tabs 挤到最左（0.8.35 首次构建实测）。
   **保留 grid、改 tabs 的 grid-column** 才对。
2. **tabs 被折进 ⋯ ≠ CSS 放不下**：DSH 用**行宽估算**决定露几个 tab
   （`ConversationSession.tsx:127` → `floor((row.clientWidth-48)/120)`，每 tab 记 120px）。
   `width:max-content` 把行宽压到 ~60px → 只露 1 个。必须 `min-width: 288px`（2 槽 = 2×120+48）。
3. **照搬 `viewArea{flex:1 1 auto; min-height:0}` 会把输入框弄丢**：0.2.2 的滚动容器是
   `.scrollBody`，viewArea 必须保持原生 `flex:1 0 auto; min-height:auto` 才能把高度撑出来。
   实测（临时 DOM 探针）：viewArea 被压到 466px 后 `composerSeat.offsetTop` 从 4463 掉到 466，
   输入卡整体跑到 y=-3378（屏幕外），界面上只剩消息、输入框消失；`position:sticky` 也失效。
   **探针 A/B 法**（`skin.disabled=true` 再量一次）5 分钟定位，比逐条猜快得多。

### 验证

- 探针实测：`SEAT y=628 / offTop=4623`（贴底、sticky 生效），交付文件卡 `--deliverable-fill` 已走 dark。
- `npm run test:pack` 15 项全 PASS。

## 0.8.30–0.8.34 (2026-11-10) · A 批骨架对齐（发布版 topbar + 去掉注入态多余控件）

> 裁决出处：`boss-lectron-ceo` 对话 2026-11-10
> **「1:1 对标发布版"= 删掉语音球；A 批（骨架对齐）」**

### 一、先行事实（决定了这批的性质）

发布版的干活页**不是向 DSH 根页面注入**，而是 Host 生成的独立页 `/bwm-friend/work/`：
`topbar(78px)` + `dialogue-panel`（左，内嵌原生 DSH iframe）+ `presence-panel`（右舞台）。
`lib/client.js:1814` `if (!isBwmPage) return () => {}` —— 根路径操作是**彻底空操作**。
桌面壳 `dsh-app://` 下无法内嵌 DSH（子 iframe 拿不到 `__DSH_BOOT__`），只能把同一套骨架叠在根页面上。

### 二、已搬（A 批）

| # | 发布版 | 落地 |
|---|---|---|
| 1 | `topbar` 78px：`fixed/z15/grid 1fr auto/padding 0 34px/border-bottom rgba(255,255,255,.055)/linear-gradient(180deg,rgba(8,13,22,.94),rgba(8,13,22,.45))/blur(16px)`；左 brand-mark 54×54（radius13 + 青辉 `0 0 18px rgba(123,242,210,.35)`）+ `Bwm Friend`(600/13px/字距.22em) + `be water my friend`(8px/#87928f/.16em)；右 配额徽标 + 设置圆钮 + `陪伴`胶囊 + `☰ 工作区`胶囊 | `#bwm-topbar`（`ensureTopbar()`），数值逐项对 `static-ui/styles.css:86-144/187-215/2092-2103` 与 `lib/index.js:1475-1481(mkBtn)` |
| 2 | 对话面板 `padding: clamp(118px,14vh,154px) 0 42px`（给 topbar 让位） | `ADAPTER_DSH_022.setWorkLayout()` 在对话列上等价设置（`box-sizing:border-box` 保证总高仍 100vh） |
| 3 | work 态左右内边距归零 | 同上（`padding` 左右 0） |
| 17 | 模式切换 = topbar 的 `陪伴`胶囊（固定文案） | 桌面壳不再建右下角悬浮胶囊，`ensureToggleButton()` 直接返回 topbar 那枚（`data-bwm-static-pill` 关掉文案跟随与拖拽） |
| 18 | `☰ 工作区` 在 topbar 动作区 | 桌面壳不再建左上角悬浮 `#bwm-sidebar-toggle`（原与 78px topbar 同坐标互压），复用 topbar 胶囊 |
| 11 | 发布版干活页**没有**语音球 | 桌面壳不执行 `ensureBwmComposer()`（web 形态保持原样），同时消掉「两个发送键 + 语音球挤在 placeholder 前」 |

### 三、过程中核出的两个真实缺陷（已修）

1. **交通灯压住品牌图标**：窗口是 `hiddenInset`，红黄绿浮在内容上约 70px，发布版 `padding:0 34px` 是浏览器页的值。
   → 顶栏改 `padding: 0 34px 0 92px`；陪伴页（静态壳）由 `desktop-shim.js` 仅在 `location.protocol==='dsh-app:'` 时注入
   `.topbar{padding-left:92px}`，**web 形态一个字节不改**。
2. **工作区抽屉透底不可读**：`transparentizeSurfaces()` 已把侧栏底色清成透明，滑出后直接透出聊天正文。
   → `.bwm-sb` 补发布版 `#bwm-workspace-pop` 的玻璃底（`rgba(10,16,26,.55)` + `blur(18px) saturate(.9)` + 青边 + 阴影），
   层级抬到 topbar 之上（发布版弹窗 z80 > topbar z15 同关系）。

### 四、踩坑记录（下次别再犯）

- **模板字符串里写不了反引号**：CSS 注释里写 `` `#bwm-workspace-pop` `` 直接截断模板 → 打包后语法错误 →
  DSH 启动报 “@dsh-plugin-bwm-friend: import failed”。**凡是往 CSS 模板里写注释，一律不用反引号**；
  打包链必须 `node --check lib/client.js` 后才 `npm pack`（这次就是漏了这一步）。
- `npm run test:pack` **15 项全 PASS**（tarball 边界 / 协议随包 / 静态壳随包 / 三端点 200 / 注入 JS 完整伺服）。

## 0.8.29 (2026-11-10) · 配色核对 + 桌面适配与可发布代码隔离

> 裁决出处：`boss-lectron-ceo` 对话 2026-11-10
> **「请你核对清楚，你哪有跟那个发布插件的是同样的颜色呢？你现在改的不是插件的代码吗？我未来要发布插件的哦。」**

### 一、核对结论（代码级，非目测）

把发布产物 `dsh-plugin-bwm-friend-0.8.0.tgz` 的全部颜色字面量抽出来与当前 `lib/client.js` 做集合比对：

- 发布版色值 **43 个**，当前产物缺失 **0 个**。
- 关键值逐个在位：`#e8efec`(白字) / `#7bf2d2`+`#52fefe`(青渐变) /
  `rgba(8,13,22,.9)`(幕布) / `rgba(123,242,210,.55)`(青边) / `rgba(123,242,210,.15)`(顶栏底边)。

### 二、核出的 3 个真实偏差（已修）

| 偏差 | 现象 | 根因 | 修法 |
|---|---|---|---|
| 输入卡不透明 | 内部 `#151517` 实心灰，发布版透幕布 | 两条覆盖变量写在 202 条调色板**之前**，被同名变量覆盖（同规则内后者胜） | 移到调色板之后 |
| 仍是实心块 | 卡片透明了但透出外层 hero 的 `--dsw-alias-bg-base` | composer 容器未清底 | 照发布版 `EMBEDDED_CSS` 清 `composerSeat/composerStack` 容器底 |
| 青边看不见 | 只有约 0.5px 的 elevation `box-shadow` 描边 | DSH 原生画法，非发布版的实心 border | 卡片改 `border: 1px solid rgba(123,242,210,.55)` + `box-shadow: none` |

### 三、可发布性隔离（回应「我未来要发布插件」）

之前把「桌面 App 宿主适配」直接塞进了 `PRESENCE_CSS`，会随包发到浏览器。现已拆开：

| 常量 | 内容 | 何时加载 |
|---|---|---|
| `PRESENCE_CSS` | 发布版原设计样式（**0** 个宿主变量、**0** 个 `100vw` 桌面适配） | 全部形态 |
| `DESKTOP_WORK_SKIN_CSS` | 宿主环境适配 + 干活模式配色（205 处 `--dsw-*`、205 行调色板） | **仅 `isDesktopShell()`**，`injectDesktopWorkSkin()` 幂等注入 |
| `EMBEDDED_CSS` | iframe 内嵌原生 DSH 会话视图的皮肤（发布版原有） | web 嵌入页 |

验证：`npm run test:pack` **15 项全 PASS**（含 tarball 内容边界、协议随包、端点 200、注入 JS 完整伺服）。

### 四、仍存在的观感差异（不是色值差异）

输入卡内部实测 `#201c1c`（我的）vs `#11151d`（发布版）。原因是幕布 `rgba(8,13,22,.9)` 半透明，
底下透出的是**不同的视频画面**——发布版那张背后是暗处，当前窗口背后是暖色人物。色值同源，混色结果随背景变。

### 五、未做（等指令）

发布版干活页顶部的 Bwm Friend 品牌栏（logo + 名称 + 陪伴/—/⧉/工作区）尚未搬到桌面壳；
当前顶部是 DSH 原生会话工具条（已深色化 + 青底边）。属布局控件差异。

## 0.8.24 (2026-11-10) · 配色 1:1 复刻发布版，不再借用 DSH 官方主题

> 裁决出处：`boss-lectron-ceo` 对话 2026-11-10
> **「你为何要用官方的主题颜色呢？我要你 1:1 复刻这个已经发布过的插件版本的配色，就是深色配白色，还有一些渐变。」**

### 上一版错在哪

0.8.20–0.8.23 为了把「深色幕布 + 浅色文字」做出来，去切换 DSH 的全局深色主题
（`body[data-ds-dark-theme]` + `color-scheme:dark`）。方向错了：那是**给宿主换肤**，
不是复刻插件配色；而且 DSH 的 `ThemeService` 会按持久偏好抢回浅色，只能靠
`MutationObserver` 持续抢，越抢越乱（实测「陪伴 ⇄ 干活」往返后左侧变白）。

### 本版做法：纯 CSS 作用域，零 JS

发布版的真实配色 = **DSH 深色调色板** + **插件自有色值**。两者都限定在干活模式的
聊天面板内重声明，开关只有 `body[data-bwm-mode='work']`：

| 配色来源 | 落地方式 |
|---|---|
| DSH 深色调色板（202 条 `--dsw-static-*` / `--dsw-alias-*`） | 复制自 `design-platform.css` 的 `body[data-ds-dark-theme]` 两块，作用域改为 `body[data-bwm-mode='work'] [class*=mainPanel]` |
| 白字 `#e8efec` | 面板 `color` |
| 青色细边 `rgba(123,242,210,·)` | 输入卡片 `border` / 顶栏 `border-bottom` |
| 青色渐变 `linear-gradient(135deg,#7bf2d2,#52fefe)` | 发送键 `background` |
| 深色幕布 `rgba(8,13,22,.9→.12)` + `blur(16px)` + mask 渐隐 | 原设计值，**未改一个字节** |

因为不碰宿主主题属性，所以：不会被 ThemeService 抢、陪伴模式（全屏 iframe）与侧栏不受影响、
退出干活模式配色自动消失无需还原、`cordis.patch.yml` 的 `ui-theme` 已恢复 `light`。

**删除**：`setHostDarkTheme()`、`darkKeeper`、`adaptScrimToTheme()`、`#bwm-scrim.bwm-scrim-light`
（浅色幕布变体是我为绕过浅色 UI 自创的，发布版没有）。

**验证**：DSH 全局浅色（`preference: light`）下，干活模式实测为深色底 + 白字 + 青边 + 青渐变发送键，
与发布版 `dsh-sandbox/work-bot.png` / `work-crop.png` 逐项一致；任务 ⇄ 陪伴往返后保持深色。

## 0.8.23 (2026-11-10) · 干活模式与发布版 1:1（Work Mode Parity with Published Build）

> 裁决出处：`boss-lectron-ceo` 对话 2026-11-10
> **「我要求你参照原先发布过的插件的整个布局控件，所有的东西跟它一致，听明白吗？」**

### 真正的差异不在插件，在 DSH 主题

对照发布产物 `dsh-plugin-bwm-friend-0.8.0.tgz` 逐项核对，布局控件本来就已一致
（`.bwm-layer` 全屏 cover、`#bwm-scrim` 左 `clamp(620px,58vw,940px)` 深色幕布 + `blur(16px)` + mask、
聊天根 fixed 左 0 同宽全高 z-index 6、`transparentizeSurfaces()` ≥35% 视口清底、
`.bwm-sb` ☰ 抽屉、同一按钮切模式）。

唯一不一致的是**明暗**：发布版是在**深色 DSH** 上出的图（`dsh-sandbox/work-chat-visible.png` 为证），
而 desktop profile 的 `ui-theme` 持久偏好是 `light`，早前版本被迫用「浅色幕布」绕，
导致整体成了浅色工作台。

### 修正

- **干活模式用 DSH 官方深色主题**：`data-ds-dark-theme` + `color-scheme:dark`
  （即 `packages/client/ui-theme/src/boot-theme.ts` 用的同一对开关，配色来自
  `design-platform.css` 的 `body[data-ds-dark-theme]` 变量块，不另造色板）。
  于是幕布回到原设计的 `rgba(8,13,22,.9)`，正文是主题给的浅色 `rgb(249,250,251)`。
- **深色只在启动时设一次**：DSH 的 `ThemeService` 会按持久偏好重写 body 属性，
  实测「陪伴 ⇄ 干活」往返时属性会被抢回浅色（左侧变白）。改为启动时设定 + `MutationObserver`
  幂等保持，不再随模式切换反复抢占。
- `adaptScrimToTheme()` 保留为兜底：深色 UI 下不激活，只有 UI 真被改回浅色时才换浅色雾面。

### 保留

- 右侧预览列让位（`.bwm-rb`，0.8.19 裁决）。
- 桌面环境适配：`.bwm-layer` 显式 `100vw/100vh`、按钮 z-index 提到 `2147483000`
  （DSH 的 `overlayLayer` 会吞点击）、`desktop-shim.js` 的 `postMessage('*')`。

### 实测

干活模式左侧为深色磨砂、正文浅色清晰、右侧数字人铺满无残留；陪伴模式为完整原设计页面；
cliclick 往返「干活 → 陪伴 → 干活」后仍保持深色，不再变白。

## 0.8.19 (2026-11-10) · 干活模式回归原设计（Work Layout Reverted to Original）

> 裁决出处：`boss-lectron-ceo` 对话 2026-11-10「要做，我就照原设计搬那套注入」→
> **「请你不要自己在这里摸索，不是有参考的那个插件的代码吗？你为什么自己改呢？」**

### 教训：桌面适配只许换选择器，不许改布局语义

0.8.7–0.8.15 在桌面壳里自创了三处原设计没有的东西，已全部回退：

| 自创 | 原设计（`ADAPTER_DSH_0823`，一字不动） |
|---|---|
| `transparentizeSurfaces()` 覆写为「跳过对话面板、保留原生底色」 | 清掉**所有**占屏 ≥35% 的面板底色，玻璃底交给幕布 |
| 新增 `pinWorkLayout()` + 「不强制清底」 | `setWorkLayout()` = 透明化 + 钉 `clamp(620px,58vw,940px)` + `background:transparent` |
| 把 `#bwm-scrim` 塞进 `#bwm-layer` 内部 | 幕布独立挂 body、z-index 5；chatRoot z-index 6 在其上，本就不会虚化聊天 |

`ADAPTER_DSH_022` 现在只覆盖 `selectors / locatorStrategies / getChatRoot / getSidebar`——
四个全是 DSH 0.2.2 换 DOM 后的必然差异；布局、透明化、还原一律 `call` 原实现。

### 修正

- **挂载点回到 `document.body`**：0.8.7 判定「桌面壳 body/#root 有 filter 造包含块」并改挂 `<html>`，
  0.2.2 实测 `body` 的 `filter` 为 `none`——错误归因，已撤回。层物理尺寸实测
  `layer [0,0,1280,820]` / `scrim [0,0,742,820]` / `chatRoot [0,0,742,820]`，全部正确。
- **幕布明暗跟随主题**（`adaptScrimToTheme()`）：原设计幕布写死深色 `rgba(8,13,22,.9)`，
  因为 2026-08 的 DSH 是深色 UI；0.2.2 **只有一套浅色主题**（源码无任何深色变量），
  深色幕布 + 深色正文 = 对比度≈0。遂按正文色相对亮度切换 `.bwm-scrim-light`，
  **只换色值**，位置/宽度/渐变角度/遮罩渐隐/`backdrop-filter` 与深色版逐项一致。
  将来 DSH 若提供深色 UI，自动回到 1:1 原始观感。

### 新增（0.2.2 出现的新元素，原设计无对应）

- **右侧预览列让位**：0.2.2 新增 `rightbarCol`（576×820）正好压在「左聊天 + 右舞台」的舞台位上，
  其 chrome 浮在数字人身上。干活模式给它挂 `.bwm-rb`（`translateX(101%)`，与左侧 `.bwm-sb`
  同款位移机制、方向相反），切回陪伴 / 退出干活时移除 class 复位。

### 保留的桌面环境适配（均不改设计语义）

`.bwm-layer` 显式 `100vw/100vh`；`#bwm-toggle` 与 `#bwm-sidebar-toggle` 抬到
`z-index 2147483000`（DSH 自带 `overlayLayer` 会吞掉点击）；`desktop-shim.js` 的 `postMessage('*')`。

### 实测

cliclick 点击切换按钮往返 **干活 → 陪伴 → 干活** 成功，按钮命中正常；右侧预览列滑走后无残留。

## 0.8.6 (2026-11-10) · 桌面壳入口（Desktop Shell Entry）

> 裁决出处：`boss-lectron-ceo` 对话 2026-11-10「按 A 开工」→「默认进干活模式」→
> **「陪伴模式不是在最右侧搞个视频，它是完整的，整个界面都进行了调整，被你改得乱七八糟的」**
> （第三条推翻了前两条的「右侧停靠栏」做法；0.8.1–0.8.5 为本地试错版本，未发布，改动已全部回退）

### 原则：桌面壳只补入口，不改页面

陪伴模式一律加载**完整的 `/bwm-friend/companion/`**——顶栏（品牌/配额/设置）+ 左对话面板
（当前回复/最近对话/输入框/语音球/发送）+ 右数字人舞台 + 设置抽屉，整幅界面原样。
静态页、样式、原有注入脚本**零改动、零覆盖样式注入**。

### 新增

- **悬浮切换按钮**（仅 `location.protocol === 'dsh-app:'` 时挂载，样式照抄原 `ensureToggleButton`）：
  文字随模式切换「陪伴」⇄「干活」（原 `MODE_LABELS`），点一次进覆盖层、再点退出——
  即原设计 `wireToggle` 的同一按钮切模式行为。
- **覆盖层**：全屏 iframe 加载 `/bwm-friend/companion/`，懒加载（首次点击才请求）。
- **`desktop-shim.js`**（host 半新增，仅 iframe 内生效）：把页内 Esc 与顶栏「干活」按钮的意图
  用 `postMessage('*')` 回传父窗口；web 直连本页时 `window.parent === window` 立即退出，零影响。

### 实测修正（三轮，均已真机验证）

1. **覆盖层只铺左上角一小块** → DSH 的 body/#root 上有 `filter`/`backdrop-filter`，会给
   `position: fixed` 后代造包含块。改挂 `document.documentElement` 并显式 `100vw/100vh`。
2. **页内 `postMessage` 收不到** → 自定义协议下 `location.origin` 退化为 opaque（`"null"`），
   `targetOrigin` 不匹配导致消息被丢弃；改由 shim 发 `'*'`，父侧按 `data.type` 判定。
3. **覆盖层打开后入口按钮被隐藏** → 等于没有退路。改回原设计的「同一按钮切模式」。

### 不变（硬约束）

- **web 浏览器形态零变化**：协议不是 `dsh-app:` 时该分支根本进不来；`/bwm-friend/*` 页面零改动。
- DSH 根路径原生界面不重绘、不读写任何 hashed 类名。

### 验证（真机 macOS DeepSeek Harness 0.2.2-rc.1）

- `test:core` 78/78 PASS · `test:artifact` PASS
- 启动 = 原生干活界面 + 右下角「陪伴」；点击 → 完整 Bwm Friend 整屏（数字人视频在播）；
  Esc 或点「干活」→ 回原生，按钮回到「陪伴」。
- 未覆盖：语音（`XIAOMI_MIMO_API_KEY` 未注入 App 进程 → `voice.configured=false` 显式降级）。

## 0.8.0 (2026-11-01) · P1-lite：受控认知内核离包（R2 结构整改）

> 裁决出处：`boss-lectron-ceo/decisions/决策记录_2026-10-31_BWM付费形态与身份资产共享裁决.md`
> 取证与复核：`docs/` 2026-11-01 P0 取证报告 §八 · R79 独立复核（深度档）
> 性质：**breaking（内部语义）**——公开包导出面与 `createRuntime()` 返回值同时收窄。npm 侧 0.7.x 从未发布，故无外部用户受影响。

### 变更（安全 / 合规）
- 🔒 **受控认知内核迁出公开包**：关系账本（六步机制链）、感知路由器、感知-账本桥接三者，自 `@laikaton/bwm-runtime-core` 迁往新私有包 `@laikaton/bwm-cognitive-core`（`private: true` + `UNLICENSED`，永不发布、永不内联）
- 🔒 **构建内联清单减两条**（`scripts/inline-modules.mjs`）：产物 `lib/client.js` 由 **157.8KB → 91.5KB（-42%）**，产物内受控实现标记 **全部 0 命中**
- 🔒 **`createRuntime()` 收窄**：移除 `relationshipLedger` 返回值与 `opts.relationshipLedger` 入参；包导出面移除 `createRelationshipLedger` / `RULE_TABLES` / `LEDGER_ERRORS` / `bridgePerceptionToLedger` / `createPerceptionRouter` / `DOMAIN_CLASS` / `UPDATE_MODES` / `PERCEPTION_ERRORS` 共 8 项 + 桥接 1 项
- ✅ **业务影响为零**：取证确认 client / host / sdk 对上述符号**全部零消费**，真实影响仅为包接口面收窄

### 门禁（R79 六条件落地）
- ➕ 新增受控核验专用视图（`--scope=<受控标识>`，取值见 `scripts/audit-release.mjs` 头注）：只验「受控实现是否离包」（F7/F8 + 受控字样 + 标识形态 + a/b 边界），与全量门禁**并存不替代**；解冻 F1–F6 须另起独立裁决（条件 1/5）
- ➕ `scripts/freeze-declaration.json` + 强制校验：`--expect-blocked` 必须附 `until` / `basis` / `ref`，缺失、非法、过期一律拒绝放行（条件 6）
- 🔄 `tests/build-artifact-parity.mjs` 断言**反转**：受控实现由「必须存在」改为「必须不存在」，与 audit F7/F8 构成双保险（条件 4）

### 验证留痕
- `test:core` **78/78 PASS** · `test:artifact` **PASS** · `test:pack` **ALL PASS** · 私有包独立 `node --test` **71/71 PASS**
- `npm pack` tarball 31 文件，`cognitive` / `perception-router` / `relationship-ledger` / `runtime-core` **0 命中**
- 全量审计：`[a]×0 [b]×0 [P]×0`、`F7/F8 消失`；残留 `[F1–F6]×6` 与 `[c]×33` 属公开 runtime 面，**待知识产权线复核归属**，不视为已解冻

### 已知敞开（不粉饰）
- 受控词口径未统一：本文件含受控字样，故 `docs/` 分类判据已将其列入「⛔ 出包」，不随 tarball 分发
- F1–F6（EventBus retained 快照 / generation 代次）仍在公开产物内，其是否属受控实施例**待知识产权线仓裁定**；冻结期放行凭 `freeze-declaration.json`，有效至 2027-01-31

## 0.7.5 (2026-10-0X) · 未定版（本地开发版本，未发布）

> 该版本号在本地推进多轮私有化改造，未经发布；功能变更并入 0.8.0 一并说明。

## 0.7.4 (2026-09-26) · 移除「引擎设置」（用户裁决：不需要这个东西）

- 🗑 **整体移除引擎设置四件套**（用户实测反馈：点「设置」出现来历不明的「引擎设置」）：①设置面板「⚙ 引擎设置」快捷入口与引擎区块；②居中模态（MODAL_CSS/buildModal/openEngineModal + bwm-open-settings 监听）；③**work/companion iframe 内对原生 DSH「设置」按钮的劫持注入**（含 1.5s 永久轮询的 tryWire——违背「原生 100% 原生」架构原则的皮肤层越界，正是用户点设置看到引擎设置的直接原因）；④工作区弹窗内的 wirePopSettings 同类劫持
- 行为回归原生：iframe 内「设置」按钮恢复 DSH 原生设置弹层（模型切换本就有 composer 原生模型按钮，无功能损失）；设置面板保留主题模板等 BWM 自有功能
- 共 -17.9KB 死代码；test:fresh 需重打包验证（0.7.4 定版门禁见提交）

## 0.7.3 (2026-09-26) · 工作区首次切换静默失败修复（用户实测回归）

- 🐛 **首次切会话不生效、第二次才成功**（用户实测）：主 iframe 收到切换消息后原实现**单次查找**目标、文件夹展开后只等固定 400ms 单次重查即静默放弃——真实工作区会话量大、React 渲染慢时首轮必失败（第二次因首轮已把文件夹点开才成功）。改为**轮询重试**：每轮先找目标（可见即点），找不到则继续展开 folders 链中未展开层，300ms × 16 ≈ 5s 上限；「新会话」按钮同类单次查找一并加固（8×300ms）。CDP 实测三场景（根级会话/已展开文件夹/折叠文件夹内不可见目标）首次切换全部生效
- 附带：端到端验证缺口教训——e2e 此前只断言「点会话后弹窗保持打开」，未断言「主窗口会话真实切换」，本轮已补 selected/header 双探针验证

## 0.7.2 (2026-09-26) · 发布硬化批次（全面代码审查 + 功能性审查收口，可发布门禁）

> 三路并行只读深审（static-ui 陪伴页 / host 端点 / 闭源核心包）产出 8×P1 + 21×P2 + 38×P3，本批次修复全部 P1 与 P2 及可安全收口的 P3；行号级证据见审查报告。0.7.1 未单独定版，factgate companion 与本批次一并随 0.7.2 发布。

### 安全 / 稳定性（host `lib/index.js`）
- 🐛 **P1 ReDoS**：`/companion/chat` 是唯一无并发守卫的重端点，1MB 载荷直达 `我是.*的` 无界回溯正则可拖死与 DSH 同进程的事件循环——三层修复：消息入口截断 2000 字符 + 记忆抽取正则全部加界（`.{0,24}` 量级）+ chat 并发守卫 ≤4（429）
- 🐛 **请求体 UTF-8 chunk 断裂**：readJsonBody 改 Buffer 收集后一次性 toString——原逐 chunk 字符串拼接把跨 chunk 的多字节汉字静默打成 U+FFFD 入库，且按 UTF-16 计数使 CJK 实际字节上限放大 ~3 倍；PUT /settings 消重改走同一通道（strictJson 400）
- companionChat 上游 fetch 补 `AbortSignal.timeout(60s)`（全文件最后一处无超时 fetch）；启动预扫描 TDZ 静默死亡修复（preload 调用点移至 `watchedRoots` 声明后，失败落审计不再 `.catch(()=>{})` 吞掉）
- serveMedia `bytes=-0` 按 RFC 7233 返回 416（原 206 全量）；promise 链补最终兜底（404 分支再抛曾是 unhandledRejection）；mp4Resolution 读失败也关 fd（泄漏）；memoryQueue 防毒护栏；PROACTIVE_CONTEXT 原型链查找改 `Object.hasOwn`；/status avatar null 守卫；runRealAgentTask 成功路径补 dispose；early-429 排空请求流防 keep-alive 断裂；settings 校验器缺席降级显式化（audit + health `components.settings.validator` 观测点）
- 登录限速评审后**维持原契约**（按尝试计数）：改按失败计数会使限速在 dev 模式（任意凭据皆成功）永不可触发、也无法测试；60s 窗口自愈，正常用户连续 6 次登录的误杀属已裁决可接受取舍

### 交互体验（`static-ui/` 陪伴页，历史对话反复提及的类别逐项收口）
- 🐛 **额度徽章整会话不更新**：`quota.updated` 分支引用未定义变量 `msg` → ReferenceError 被 catch 吞（`msg`→`event`）
- 🐛 **生成中断线输入框永久禁用**：busy 只在 WS 事件里解除——close 时复位 + 10 分钟客户端 watchdog 兜底
- 🐛 **模板卡成倍重复**：loadTemplates 只追加不清空 + 默认卡重复绑定——入口 `replaceChildren()` 重建
- 🐛 **删除自定义模板无确认**：删除前走 confirmDialog，删除中禁用按钮
- 其余：更新版本号 innerHTML 转义（XSS）；发送防抖（响应创建前回车重复扣次）；头像上传失败回滚（对齐待机视频）；说话视频补 2GB 上限；服务离线 15s 循环 toast 改静默 pill；persona 加载失败禁存（防空文本覆盖服务端人格）；模板加载失败 toast+重试卡；声音克隆按钮防并发；上传区隐藏后 placeholder 死按钮修复；长回复 overflow-y:auto（移动端可读）；iOS 输入 16px 防聚焦放大；`:root` 补 `--accent`；模板卡禁用态；确认弹窗 Esc + `\n` 换行生效；向导弹窗恢复滚动；读操作 9 处补 ok 检查（fetchJsonOk 统一封装，401 语义不变）

### 嵌入式壳层（`src/client.js`）
- 🐛 **悬浮按钮拖动假实现**：pointerup 把 right/bottom 重置回初始值（README Known Limitations 根因）——拖动落点即新位并 clamp 视口内
- 🐛 **自动滚动误判**：候选滚动容器收敛到会话区（centerCol 内），排除侧栏会话树与 composer dock（TodoPanel 列表）——原会把侧栏/任务列表强制滚到底、且任一非底部容器误触发全局暂停跟随
- 🐛 **账本/上下文写入竞态**：ledger append、context persist、mode persist 三条「GET→合并→PUT」链并发交错互丢字段（账本条目静默丢失，关系账本持久链完整性）——统一 `queueConfigWrite` 串行链
- 清理无效 CSS 声明 `child-shadow`（笔误）
- 浏览器实测（3200 沙盒 + CDP）：模型菜单真实鼠标点击正常弹出、长模型名（DeepSeek-V4-Flash-Vision-Exp High）压力下 composer 无溢出无裁剪、发送键/边框完整、根路径 `/` 原生界面零侵扰——历史 P1（点模型名不弹菜单）/P4（发送键裁剪）确认由 0.7.x CSS 修复收口，本批次回归通过

### 闭源核心包（实现证据）
- 🐛 **P1 感知路由补偿失真**：`compensate(failed, 全量applied)` 对每个易失项重复同参调用——改逐项 `compensate(u, [v])`（测试曾只断言 length>0 恰好掩盖）
- 🐛 **P1 会话销毁即失效破约**：closeSession 后 commit/route 照常 apply——入口补 SESSION_CLOSED 拒绝
- 🐛 **P1 持久化准入旁路**：桥接函数不复核指令域与获准模式 + 账本 admit 无确认门——双门修复（`not_persist_granted` / `perception_not_user_confirmed`），「强行桥接」测试分支从永不可达改为真实断言
- 两套账本 store 契约统一（异步 append 拒绝→回滚/上报、load 双契约归一）；事件总线 route/回放三处异常隔离；commit 持久失败剩余项入 shelved 不再静默丢弃；DEFER 过期丢弃切断死循环；路由器四处无界增长加界（closed sessions 50 / completedRounds 100 / audit 500 / lateQueue 200）；recentTopics 裁剪方向反修（达上限后新话题进不来）；hydrate 浅拷贝隔离；verify NaN 篡改不再失明；时间混合类型排序归一；wireRelationship 重入护栏；invariant 降级显式化
- 测试：runtime-core 131→**149 全绿**、protocol 13→**19 全绿**（+24 项新契约测试）

### 发布工程
- README Known Limitations「悬浮按钮拖动未实现」关闭；版本 0.7.2（0.7.1 未单独定版一并发布）

## 0.7.1 (2026-09-21) · factgate 事实门控 companion（知产→生产力：会话层执行门控）

- **新增 `factgate.js` companion**（bundle patch 行 `bwm-friend-factgate`，真实上下文加载）：把事件内核"门控获准帧"（runtime-core index.js:87）装到 harness 会话层——`fact_probe`（权威源探测）/ `fact_assert`（断言核验门控：ADMITTED 发票据、BLOCKED 拦截+理由）/ `fact_ledger`（审计账本：单调序号、上限500滚动、每域 retained 票据）/ **全局写保护守卫**（`tools.guard` 普通上下文注册=全局生效、单调不可翻案：权威源文件对 write/edit 只读）
- **事实域 v1 内置 4 域**：知产状态域（SSOT）/ package-compliance（递交包 SHA256SUMS）/ env-config（DSH_HOME AGENTS.md）/ e-receipt（SSOT 第7行受理状态）；settings 化配置列 v2
- **架构勘误记录**：动态会话插件沙箱门面剥掉 `tools.guard`（cordis-host-runner/guard.ts 只暴露 register/schemas/get，防绕过单调守卫）——写保护**只能部署级挂载**；会话内原型（fgate-2/pkg-5）按"显式失灵不静默"特性检测降级验证了同款限制
- **fs/tools 可选服务纪律**：ctx.get + 特性检测，缺席显式降级报告，绝不静默放行（invariant 同款教训）；工具逐具 try/catch 注册，单具被拒不拖垮其余
- 经验判例：`/Users/zengtian/projects/memory/workflow/20260921-DSH-动态插件开发四暗礁与契约先行节奏.md`（defineTool 工位/参数根开放/输出 schema 显式/运行期特性检测）
- **factgate settings 化（0.7.1 增补）**：域注册表支持配置覆盖——主插件 settings PUT 白名单/类型守卫/深合并放行 `factgate` 键，bwm-protocol schema 增补 `factgate.domains` 校验（{label, source} 非空字符串，非法逐键拒绝）；companion 启动时读 `~/.dsh-bwm-friend/config.json` 覆盖内置 4 域，缺项/失败回退默认（不阻断加载）
- **发布链全绿（2026-09-22）**：core 131/131 · artifact PASS · host 38/38（沙盒 3200）· e2e ✓ · pack ALL PASS · fresh ALL PASS；settings 通道端到端实测 PUT→落盘→GET 三连过
- **SG 8089 门户链路退役（创世者裁决）**：DNS 实测直指广州，SG 不在服务路径；容器摘除、路由标记 retired、备份 `SG:/opt/boss-portal-retired-backup-20260922.tar.gz`；架构 SSOT（BOSS_THREE_NODE_TOPOLOGY.md）与脚本头同步更新

## 0.7.0 (2026-09-11) · Perception Router（闭源实现证据 / 跨域路由与一致性编排）

- **新增 `createPerceptionRouter()`**（`packages/bwm-runtime-core/src/perception-router.js`，纯逻辑无 I/O）：感知事件的**跨状态域路由与一致性编排**——内部技术方案 v0.3 §四 六步骨架的可运行实现
  - **感知会话**：`openSession()` 绑定允许采集的感知类别、调度策略、允许流向的域、新鲜度窗口与销毁条件；`closeSession()` 销毁（易失域随之失效）
  - **结构化感知事件**：`ingest()` 产出带事件标识/来源类型/生成时间/有效期/关系范围的事件（来源白名单与前台隐私门控在此拒绝）
  - **域更新决策向量**：`decide()` 输出每域 `deny | volatile | persist | defer`；**持久性默认值不对称**——易失运行状态域默认易失，持久历史状态域默认拒绝（持久化需同时满足显著性阈值+会话允许+关系范围匹配+显式分享或用户确认）
  - **域更新指令**：`route()` 产出**同一 eventId 串联**的候选指令，绑定主体、关系范围与策略版本（可追溯、可撤销）
  - **跨域一致性控制**：`commit()` 处理顺序（易失先于持久）、**策略版本冲突整体拒绝**、**部分失败补偿**（持久域失败→补偿已执行易失更新+标记待重试）、**迟到事件隔离**（轮次已完成的事件延迟至下一轮，绝不回写已完成轮）
  - **域名下沉纪律**：目标状态域以「类」（易失/持久）表达，具体域名走配置——新增 `emotion/memory/task` 域无需改动路由器（权项演化空间的代码对应）
- **边界**：不生成存在状态（存在状态生成机制之权）、不计算关系增量与写账本（关系账本机制之权）——只产出候选指令，交事件内核与账本端执行（技术方案 §二 裁决表）
- **测试**：core 套件 36→**48 全绿**（新增 12 项跨域一致性契约测试：会话销毁/隐私拒绝路径/置信度与显著性门控/持久化准入/迟到事件隔离/过期事件/部分失败补偿/版本冲突/同事件标识串联/域扩展性/审计视图）——即技术方案 §八 要求的**核心创造性证据**（一致性编排，而非采样 Benchmark）

## 0.6.0 (2026-09-10) · wireLedger 落盘（B2 反超第一步 / 关系账本实施例）

### 发布收敛（2026-09-11 · 可发布门禁全绿）

- 🐛 **P0 wireLedger settings 白名单静默丢包**：host PUT 白名单不含 `wireLedger` → `createLedgerStore` 唯一持久通道在生产形状下**完全不落盘**（core 单测注入 store 全绿、端到端断裂——"声称与实现不符"典型）。放行 + 数组形状守卫（非数组 400）+ 无关字段 PUT 不清账本；host 红灯回归 4 断言；跨重启 reload 真机验证闭环（含 `relationship_delta` 语义字段透传）
- 🐛 **资产热投递盲区**：`~/.bwm-friend/assets` 启动时不存在（README 文档化投递流程）→ watcher 挂不上 → 用户后投递素材重启前不可见（0.5.0 懒挂 watcher 只救"根已存在"场景）。watcher 升级 `recursive`（主题子目录内后投递也触发失效）+ 存在挂不上根时缓存 TTL 2s 兜底（重扫成功即补挂，回纯事件驱动）；host 红灯回归实证（全新初始态播种→免重启可见）
- host 套件 36→**38**：health 版本断言改单源 package.json（硬编码 '0.5.0' 漂移复发——PLUGIN_VERSION 同款教训在测试侧清零）；媒体用例 fixture 自播种（沙盒无资产时确定性绿，HOME 不可写显式 SKIP 不装绿）
- 环境：repo 依赖安装恢复（缺 node_modules 致皮肤发现 0 → T9 皮肤卡红，环境债非代码回归）；`package-lock.json` 入库（dev 安装可复现）
- 文档对齐：README 测试计数/路径泛化；Settings Schema v1 补记 `wireLedger` 运行时通道键（与"新设置项先进 schema"纪律的张力留档，未来三端吸收或平移宿主通道时收口）
- 包内容审计：零密钥/零内网地址/零个人运行时路径；架构边界 grep 审计：Runtime 侧红线全 0、Shell 侧核心逻辑定义（function 级）全 0
- 门禁：**core 36 · host 38 · e2e 12 · T1-T14 17 项 · pack 冒烟 8 · fresh DSH 装载 15 —— 全绿**

- **Ledger 持久化**：`wireLedger(bus, context, opts)` / `createRuntime(opts)` 新增可选 `ledger` store 适配器（`append(entry)` + `load()`）——逐事件写透、启动异步恢复、合并守 200 上限；append 失败 emit `ledger:persist.error` 不阻断事件管线；不传 ledger 时行为与 0.5 完全一致（向后兼容）
- **语义字段透传**：task/tool 事件 payload 整体进账本（`relationship_delta`/`emotion_context` 等未来语义字段原样保留，关系账本前向兼容）；core 保持纯逻辑无 I/O，store 由 Shell 提供
- **Shell 接线**：`createLedgerStore()`（src/client.js）——内存镜像 + 单飞行写穿 settings 通道（宿主落盘，memory.json 同目录），镜像上限 500；未来平移宿主 JSONL/SQL（P6 agent_actions）只换 store 实现
- **边界不变**：`DOMAIN_POLICY.timeline` 仍为 `'runtime'`（persistSnapshot 快照不含 timeline）——账本走独立通道，不混快照
- **测试**：core 套件 32→36 全绿（落盘/恢复链、透传+合并上限、失败不阻断、向后兼容）；host 端点套件 36 失败为 HEAD 既有（需活 DSH 宿主），与本次改动无关（基线 diff 为空）

## 0.5.0 (2026-09-03) · 完成度地图定版（九行全部 100%）

### 可观测性 40→100
- health 深度化（version/uptimeSec/components 五件）；新增 GET /metrics（路由计数/错误/延迟分位 + 业务总量）
- 结构化审计日志（JSON 行 · 5MB 轮转 · BWM_LOG_MAX_BYTES/BWM_LOG_DISABLE 接缝 · subject 掩码）
- 🐛 update-check 版本硬编码 '0.3.2' 漂移事故 → PLUGIN_VERSION 单源 package.json

### 陪伴智能 65→100
- Mock MiMo ASR/TTS + Mock DeepSeek 注入接缝（BWM_MIMO_BASE_URL/BWM_CHAT_BASE_URL）——语音链路 E2E 不再依赖真 key
- 语音+聊天+记忆链路 E2E 12 检查；记忆抽取五类模式单测

### 安全基线 80→100（对抗评审 3×P1+3×P2 全闭环）
- P1-1 chat 载荷无上限 → readJsonBody 1MB；P1-2 DNS rebinding 整体绕过 → isTrustedHost 回环白名单；
  P1-3 任务并发无上限+超时 agent 裸奔 → in-flight≤2(429)+dispose；P2-4 symlink 外发 → lstat 拒绝；
  P2-5 登录爆破 → 按 subject 分桶限速(60s/5)+错误统一 http-<status>；P2-6 主体信息最小化（仅后 2 位）
- docs/THREAT-MODEL-v1.md（九威胁防线 + 六项残余风险明示）

### 工作模式 75→100
- BWM_AGENT_MOCK 接缝 + 挂起 agent shim：真挂起超时/dispose 中止/taskTimeouts 记账/并发 429 七检查
- 🐛 runRealAgentTask 本地 const process TDZ 地雷排雷（改名 procSteps）

### 资产管线 90→100
- checksum 升级流式 sha256（mtime/size 缓存）；resolution=tkhd best-effort 解析（零外部依赖）
- 🐛 懒挂 watcher 根治「先启动后放素材」缓存陈旧（GUI 主题丢失最初根因）

### 设置同步 90→100
- 迁移完备/损坏兜底/并发读写交错/默认形状/schema additive 版本 12 断言

### 外壳 95→100
- EMBEDDED_SELECTORS 抗改版回归：headless Chrome+CDP（Node 内建 WebSocket 零依赖）真渲染 DOM 分级断言
  （hard 常驻结构=FAIL 门槛；soft 条件组件=记录）
- companion 页视觉基线入库；work 页 headless 挂起已知（记录于提交材料）

### 发布工程 90→100
- 离线可装性最强实证：npm pack → --offline 安装 → 装产物全冒烟；更新检查三态（新版/同版/不可达 fail-open）

### 生态层 30→100
- examples/sdk-consumer.mjs 外部消费者参考实现；compareVersion 补为协议级导出
- tests/negotiation.test.mjs 多宿主协商矩阵 6 断言；tests/protocol-conformance.e2e.mjs 公开契约 10 断言

### 回归基线（全绿）
host-endpoints 36 · chain-e2e 12 · task-timeout 7 · settings-robust 12 · embedded-selectors 11 ·
release-offline 9 · negotiation 6 · protocol-conformance 10 · memory 4 · T1-T14 状态同步

## 0.4.0 (2026-09-03)

### 修复·第三轮（发布评审路径 B：P0/P1 全闭环，四维评审"需修复后发布"→可发布）
- **安全 P0**：isSameOriginRequest 重排（dest=document 仅读、Origin:null/file:// 仅读、
  Origin/Host 不一致提前拒、BWM_TRUSTED_HOSTS 白名单）——封堵顶层表单 text/plain 伪造 JSON
  打 /work/task 的 RCE 级 CSRF 绕过；云端模板名（远端输入）/皮肤目录名/主题名/模型名
  innerHTML 统一转义；/auth/status 与登录回显手机号掩码；登录响应不再下发 Hub token
- **打包 P0**：协议随包副本优先（packages/ 入 files 白名单，行为确定性）；UI 壳随包
  （static-ui/，BWM_STATIC 默认值不再指向个人工程）；依赖修正（-bwm-protocol
  +bwm-skin-mira）；LOCAL_ASSET_ROOTS/DSH_WORK_DIR 去个人绝对路径（~/.bwm-friend/assets
  投递点 + BWM_STATIC 同级素材发现）；新增 tests/release-pack-smoke.mjs 干净机冒烟
- **settings 健壮化**：writeConfig 原子写；PUT 串行化（withConfigLock）；validateSettings
  接线（类型非法 400）；version 服务端管辖；未知顶层 key 不落盘
- **资源治理**：inventory watcher 入 disposers；media token 稳定复用+失效回收；
  runRealAgentTask 超时上限（BWM_TASK_TIMEOUT_MS）；/transcribe 并发守卫（429）
- **功能收敛**：引擎弹窗砍装饰 tab（通用/插件/预设）与 alert 占位按钮（模型 tab 保留）；
  云端模板卡改非交互条目；删除死代码 workChat()
- **文档**：README env 契约补全（BWM_AUTH_BASE/BWM_UPDATE_URL/BWM_TRUSTED_HOSTS/
  BWM_TASK_TIMEOUT_MS）+ 素材投递点成文；schema v1 文档标注预留字段

### 测试（第三轮）
- host-endpoints 17 → **26 断言**（CSRF 绕过/Origin:null/掩码/token/并发丢写等，红灯先行）
- 新增 **release-pack-smoke**（pack→隔离安装→模块加载→三端点→自包含断言，8 检查）
- 新增 **release-fresh-dsh**（`test:fresh`，真实 DSH 装载链路发布门槛，15 检查）：全新 HOME/DSH_HOME → `dsh plugin add <tgz>` → bundle 自动登记 → 安装产物为 tgz 真实拷贝（非 symlink）且 lib 与仓库构建产物哈希一致 → 启动独立实例 → health 版本/work/companion/根路径页面级断言；`--keep` 保留实例供人工/浏览器复验（全新实例浏览器实测：38 provider 原生目录同步、work/companion 结构完整、零页面 JS 错误）
- status-sync T1-T14 + p2-proactive 全绿；p2-voice-smoke 无 key 显式 SKIP

## 0.4.0 (2026-09-03) · 第二轮（模板⇒音色/人格联动）
### 修复·第二轮（模板⇒音色/人格联动，tests/status-sync-verify.sh T1-T14 全绿；红灯先行 7 FAIL）
- **P1 切换模板音色不跟随**（用户报告）：桌面版语义 = 切模板音色随模板变（`applyTemplateSwitch` 里 `data.voice` 随模板返回）；插件免刷新切换只 PUT `avatar.theme`，音色死在原地。新增 `__bwmThemeVoice` 预设表（甜心女孩→茉莉、电竞男孩→Milo、可爱孙女HD→冰糖、迷人少妇→Chloe、霸道女总裁→Mia；未知主题保持当前音色，不盲改克隆音）+ 共享入口 `__bwmSwitchTheme`：一次 PUT 原子持久化 theme+voice，随后同步高亮/热切视频/音色下拉与状态
- **P2 人格不随模板重载**：桌面版人格按模板存储（reload 后 loadPersona 取新模板人格）；插件砍成全局单值但标签仍写"当前模板"，切模板后输入框内容不随动。新增 `avatar.personas`（按主题映射），读取规则 `personas[theme]` 优先、缺失回退 legacy `avatar.persona`（升级零迁移）；`wirePersona` 按 theme 读、保存写整张 personas map（客户端读改写，规避服务端浅合并整表覆盖）；`companionChat` 人格注入同规则按当前主题取
- **模板切换入口收敛**：`fillTemplates` 与 `fillCustomTemplates` 两处点击各自 PUT 只存 theme（漏音色/人格联动）→ 收敛到唯一共享入口 `__bwmSwitchTheme`（修根不修枝）

### 测试
- `status-sync-verify.sh`/`verify-shim.mjs` 扩至 **T1-T14**（新增：启动人格按主题读取、切模板音色跟随预设、原子持久化 theme+voice、人格按主题回退/恢复、personas 保存写回）；修复前 7 FAIL → 修复后 ALL PASS
- `p2-voice-smoke.cjs` 无 `XIAOMI_MIMO_API_KEY` 时显式 SKIP 并说明（TTS 后端必返 missing-key，此前让人误判为链路回归）
- host 端点回归 17/17（沙盒 3200 按 `dsh-sandbox/start.sh` 文档重启后）

## 0.4.0 (2026-09-03) · 第一轮（设置状态同步批修）

### 修复（全部 tests/status-sync-verify.sh 实测回归通过：修复前快照 6 FAIL → 修复后 9 PASS）
- **P1 设置面板模板初始高亮缺失**：`fillTemplates` 初始高亮读 `localStorage['bwm-config']`——全代码库无任何写入点，高亮永远为空（用户实测：当前是"电竞男孩"的视频，打开设置无对应高亮）。改为与服务端 `/bwm-friend/settings` 单一真相源对齐
- **P1 音色回显不齐 + 从不持久化**：`fillVoices` 硬编码回显"冰糖"、`voiceSelect` 无 change 监听（选了不保存，刷新即回显错值）。改为回显服务端 `voice.voice`（自定义/克隆音色追加为选项）+ 选择即 PUT 保存
- **P1 主题状态多路不一致**：点击模板卡只同步 `#templateGrid` 高亮，皮肤卡无高亮联动、"当前模板"标签不热更新 → 同屏三处状态互相矛盾。收敛为共享 `__bwmApplyTheme`（预设区 + 皮肤卡 + 标签一次同步）与 `__bwmHotSwapIdle`（选片规则与加载期一致：皮肤优先→精确匹配→根目录兜底）
- **"默认"卡值错位**：点击"默认"卡把字面量 `默认` 存进 config，而 inventory 主题名为 `(root)`，加载期选片必失配回退 `idle[0]`（视频与保存主题脱钩）。卡值改存 `(root)`、UI 显示"默认"
- **主题枚举混入非模板资产**：`custom_uploads`（用户上传杂物）此前会成为可点击模板卡（无 idle → 点击后视频回退根目录，状态再度脱钩）。枚举过滤为 `idle`/`talk` 资产
- 清理居中模态内无消费的 settings 死 fetch

### 测试
- 新增 `tests/status-sync-verify.sh` + `tests/verify-shim.mjs`：任意版本 lib 挂独立 shim 服务（HOME 隔离不碰真实配置），headless Chrome 真实渲染 work 页做 T1-T9 DOM 断言；修复前快照复现 6 FAIL，修复后 ALL PASS；host 端点回归 17/17

## 0.3.2 (2026-09-02)

### 修复（全部 ego-browser 实测回归通过）
- **P1 会话列表无法切换（回归修复）**：`wireSidebarA11y` 在 pop 弹窗模式跳过 inert/aria-hidden——`inert` 会在 hit-testing 阶段吞掉真实鼠标点击（程序化 `.click()` 不受影响，合成事件绕过，自动化回归因此漏检）
- **P1 TodoPanel 尺寸与原生不一致**：EMBEDDED_CSS 全局 `[class*=root]` `height:100%` 误命中 composer dock 内组件 root，收起态 36px 被撑到 170px、展开 358px → 豁免 `[class*=composerStack] *`；全局滚动条隐藏规则吞掉 `.list` 滚动条 → dock 内恢复 thin/8px。实测收起 38px / 展开 226px / 滚动条可见
- **弹层「新会话」跨窗口同步**：pop 端捕获拦截 + 转发 `bwm-pop-new-session`，父页转发主 iframe 原生新建+切换（此前弹层内创建后主窗口不跟随，与原生行为不一致）
- **ask/choice 选项卡片防截断**：卡片内容需 ~802px > 旧固定宽 742px，选项/提交键被裁 → 对话区改响应式 `clamp(620px, 48vw, 1080px)` + 卡片双挂载位（composerSeat/scrollBody）max-width 约束 + 按钮换行
- **历史会话裸 DSML 控制标记清洗**：显示层 MutationObserver 增量折叠为「历史工具调用·已折叠」占位（原文存 title），不动会话数据
- **工作区遮罩交互**：首次打开 toast 关闭提示 + Esc 关闭 + cursor/title
- **读屏降噪**：主 iframe 抽屉收起时 `aria-hidden`+`inert`（仅主 iframe；pop 模式豁免）
- 登记 `EMBEDDED_SELECTORS.askCard = eT_Osq_`（ask 卡片 hashed 前缀）

### 变更
- 对话区宽度 742px 固定 → `clamp(620px, 48vw, 1080px)` 响应式（大屏对话区占比过低 + 卡片截断）

### 测试
- e2e 模型菜单断言修正：回归点是「点击后弹出」（菜单可见且内容非空）；菜单内部结构随 DSH 版本/模型目录而异，不再硬断言推理等级行
- e2e 弹窗断言对齐 0.3.1 设计：点会话后弹窗保持打开（连续切换），旧断言「点会话后关闭」过时（被旧沙盒进程掩盖）
- host 新增 2 项 DoS 用例（请求体上限 413 + 进程存活），15 → 17
- 服务端发布加固：`readJsonBody` 请求体上限 1MB（transcribe 音频放宽 25MB）+ settings PUT/work/task 内联读取同步收口 + 超限前排空请求流（防 keep-alive 连接 ECONNRESET）

## 0.3.1 (2026-08-26)

- 工作区面板会话列表交互重构 + loading 失败态兜底（轮询会话树渲染成功即移除 loading；10s 超时显示失败态+重试，杜绝无限 loading）
- 嵌入式自动滚动修复（遍历所有候选滚动容器）

## 0.3.0 (2026-08-24)

### 架构（Runtime 化）
- P1.1 Event Kernel 迁入 `@laikaton/bwm-runtime-core`（createEventBus + EVENT_VERSIONS + createRuntime 协议面）
- P1.2 Context Runtime（8 域 + ownership 治理 + CONTEXT_VERSIONS + shellSet 校验）
- P1.3 Capability Layer（negotiate 能力协商：requires/capabilities 分离、full/lite 降级）
- P1.4 Runtime Contract（Shell 物理隔离：grep 红线全 0；Context/Ledger/Presence 状态机全部迁出；协议值域冻结）
- Runtime v1.1 稳定化：DOMAIN_POLICY（Runtime State ≠ Persistent State）+ persistSnapshot 防抖 + requestState 状态机 + presence MutationObserver 事件驱动 + memory 串行化 + inventory 生命周期缓存 + iframe loading + Audio 复用
- P3 SDK v0.1：`@laikaton/bwm-sdk`（Agent.send/cancel/status、Persona.get/switch、Presence.state/observe）

### 功能
- P2-Voice：MiMo ASR/TTS 代理（/bwm-friend/transcribe + /tts）+ 按住说话 → 自动发送 + 回复自动朗读 + 8 音色
- P2-Memory/Persona：Identity Runtime 雏形（IDENTITY_PRESET 单一来源）+ Mira 记忆（FACT_PATTERNS 抽取/跨消息注入/问句噪音过滤）
- 对话宽度对齐陪伴模式：iframe 742px（dialogue-panel 全宽）

### 安全（代码审查）
- CSRF 防护（Sec-Fetch-Site/Origin 同源校验，跨源 403）——防 RCE 级跨源 agent 触发
- 静态资源 DoS（createReadStream error 崩进程）→ stat 预检 + stream error 监听
- 路径穿越（serveCompanion resolve 校验）
- media token 随机 UUID（防路径泄漏）
- Range RFC 7233（suffix-range 正确 + start>end 416）
- memory 原子写（temp+rename）+ 串行化
- postMessage 发送 targetOrigin 收紧同源

### 测试
- runtime-core 32/32、host-endpoints 15/15、E2E 12/12、P2-VOICE、S3-PRESENCE

## 0.2.0 (2026-08-24)

### 修复
- P1 模型菜单/workspace 菜单/用量圆环面板被裁剪：EMBEDDED_CSS `[class*=root]{overflow-y:auto}` 误伤组件 root（PNUCKq_root/_8Ce2OW_root），滚动只保留 centerCol/scrollBody/viewArea
- 模型/命令/Workspace Write 按钮不可见（全透明背景+浅字对比度不足）→ 深色半透明底+青色边框
- 发送键 disabled 态 opacity 0.4 几乎消失 → 保持 0.65
- 发送键渐变被 `[class*=trailing] button` 覆盖 → `.p7GS4W_trailing .p7GS4W_primary` 提权
- hero 高度被 `[class*=root]{height:100%}` 压到 81px → card 底部按钮行被裁 37px → hero auto
- heroGlow 装饰 svg 撑出 88px 垂直滚动 → 隐藏
- ContextMeter root 被 `[class*=root]{width:100%}` 撑到 341px 压塌模型按钮容器 → span width auto + data-slot min-width
- 侧栏窄屏 collapsed（iframe 620 < SIDEBAR_AUTO_COLLAPSE 1024）会话树不渲染 → 自动触发原生 toggle
- 抽屉遮挡 composer → 选会话自动收起
- P0 安全：postMessage 3 处监听 origin 校验 + 2 处发送 targetOrigin 收紧同源

### 功能
- 任务信息条上移融合顶栏：DSH 会话 header 垂直两行(76px) → 横向单行紧凑条(44px)
- ☰ 工作区弹窗：屏幕最右透明毛玻璃（right:0 + backdrop-blur），内嵌 iframe `/?bwm=embedded&pop=1` 仅侧栏会话树；点会话 → postMessage 三跳切换主 iframe + 自动关闭
- 对话宽度：620 → 600px（用户指定）

## 0.3.1 (2026-08-24)
### 功能
- 皮肤资产包机制：插件自动发现 node_modules/@laikaton/bwm-skin-*/assets（换皮肤=换资产包）
- @laikaton/bwm-skin-mira@1.0.0（电竞男友主题 idle+talk，~3.7M）已发布 npm
- ASSET_ROOTS 优先级：env BWM_ASSET_ROOTS → 本地开发路径 → 皮肤包自动发现

## 0.3.2 (2026-08-24)
### 修复
- 默认主题改为甜心女孩（DEFAULT_CONFIG avatar.theme '电竞男友' → '甜心女孩'）
- companion-init.js pick 逻辑修复：按 config theme 选待机视频（原来写死 idle[0] 不看主题）
- 皮肤包 bwm-skin-mira 1.1.0：电竞男友 → 甜心女孩资产（idle+talk）
