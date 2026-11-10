/**
 * dsh-plugin-bwm-friend — browser half（Phase 0：Event Bus + Shared Agent Context + Presence 视觉联动）
 * 职责：
 *   1. Agent Event Bus（§3.5）：统一事件源，PresenceEngine/Memory/Ledger/Transition 全部订阅
 *   2. Shared Agent Context（§4.2）：8 域第一公民模型（Identity/Personality/Memory/Conversation/
 *      Tasks/Preferences/Timeline/Presence），JSON 可序列化，随配置持久化
 *   3. Presence 视觉联动：agent.* 事件 → presence 状态 → 视频层视觉配方（thinking/executing/success/error）
 *   4. 既有 M1：视频背景（主题 idle 视频）+ 主题切换 + 遮挡暂停 + 设置页
 * 编辑本文件后运行 `npm run build`。
 * 注意：必须以 `return module.exports;` 结尾（build-client.mjs 信封要求）。
 */
const React = require('react');
// P1.1：Event Kernel 已迁入 @laikaton/bwm-runtime-core（闭源核心，独立包）
// Shell 经 createRuntime() 协议面消费；require 由 build-client.mjs 内联注入解析
const { createRuntime } = require('@laikaton/bwm-runtime-core');

const SETTINGS_URL = '/bwm-friend/settings';
const INVENTORY_URL = '/bwm-friend/inventory';

const inject = ['slots'];

/* ── 0.5 EMBEDDED 选择器版本登记（P1：DSH 升级防碎）────────────── */
// EMBEDDED_CSS / applyEmbeddedHarness 依赖 DSH 的 hashed CSS Modules 类名（随机前缀，
// DSH 升级即变）。本表登记当前适配版本用到的全部关键选择器与结构锚点——
// DSH 升级时：先跑沙盒验证哪些选择器失效 → 更新本表对应项 + EMBEDDED_CSS 引用 →
// 在 ADAPTER_REGISTRY 新增一条 adapter（match 新版本）。
// 稳定锚点（不随版本变）：[data-slot="conversation.input.model"]、[role=treeitem]、
// [class*=sidebarCol]/[class*=centerCol]/[class*=detailsCol]（语义后缀稳定）。
const EMBEDDED_SELECTORS = {
  version: 'dsh-2026-08-23', // 与 ADAPTER_REGISTRY[0].version 对应
  composer: 'p7GS4W_',       // 输入卡片（card/root/input/primary/trailing/tools/row/add/modes）
  modelSelect: 'PNUCKq_',    // 模型选择器（trigger/triggerLabel/triggerEffort/cell/option/menu/root）
  accessMode: 'eLe3jW_',     // 访问模式（Workspace Write）
  contextMeter: '_8Ce2OW_',  // 用量圆环（root/trigger/panel/track/fill）
  conversation: 'f9lKaG_',   // 会话（scrollBody/composerSeat/composerStack/heroGlow/header/titleRow/tabs）
  shell: '_5Rp60q_',         // 框架（frame/sidebarCol/centerCol/detailsCol）
  sidebarInner: 'RnFLRG_',   // 侧栏内部（root/logoRow/newSession/regionArea/toggle）
  askCard: 'eT_Osq_',        // ask/choice 选项卡片（card/frame/headerActions；2026-09-02 防截断用）
  sidebarSearch: 'waGfua_',  // 侧栏搜索/动作
  settingsRail: 'Ep6gBG_',   // 设置轨道按钮
  stable: ['[data-slot="conversation.input.model"]', '[role=treeitem]', '[class*=sidebarCol]', '[class*=centerCol]', '[class*=detailsCol]'],
};

/* ── 1.5 Capability Layer（P1.3：Shell 侧声明——信息性提供 + 需求性 requires）──
 * capabilities：Shell 自身 UI 能力（信息性，供 Runtime 了解宿主，不参与协商裁决）
 * requires：Shell 需要 Runtime 提供的核心能力（决定 full/lite 模式与降级 UI）
 * 与 docs/BWM-PROTOCOL-v1.md §4.1/§4.2 对齐；协商算法在 runtime-core（negotiate，闭源核心）
 */
const SHELL_CAPABILITIES = [
  { name: 'video-layer', version: '1.0', level: 'full', constraints: { layout: 'right-panel' } },
  { name: 'composer-skin', version: '1.0', level: 'full', constraints: { style: 'bwm-mint' } },
  { name: 'sidebar-drawer', version: '1.0', level: 'full', constraints: { width: 320 } },
  { name: 'pop-session', version: '1.0', level: 'full', constraints: { position: 'screen-right' } },
  { name: 'header-strip', version: '1.0', level: 'full', constraints: { height: 44 } },
];
const SHELL_REQUIRES = [
  { name: 'presence-provide', version: '1.0' }, // presence 联动（数字人状态）
  { name: 'context-govern', version: '1.0' },   // 8 域共享上下文
  { name: 'ledger-record', version: '1.0' },    // 行为生命周期记录
];

/* ── 1. Event Kernel（已迁入 @laikaton/bwm-runtime-core，P1.1）──────────────
 * createEventBus / EVENT_VERSIONS 定义已移除——Shell 不再拥有核心；
 * 经 require('@laikaton/bwm-runtime-core') 的 createRuntime() 协议面消费。
 * 边界审计：grep "function createEventBus" src/client.js = 0 ✅
 */

/* ── 2. Shared Agent Context（已迁入 @laikaton/bwm-runtime-core，P1.4）────────────
 * createAgentContext / CONTEXT_VERSIONS / CONTEXT_MIGRATIONS 定义已移除——Context 归 Runtime；
 * Shell 经 runtime.context（只读 runtime 域 / shellSet 写 shared 域）+ runtime.hydrateContext 消费。
 * 边界审计：grep "function createAgentContext" src/client.js = 0 ✅
 */

/* ── 3. Presence 视觉联动 ───────────────────────────────────────────── */
// 状态 → 视觉配方（CSS 变体类，视频层不重建播放器）
const PRESENCE_CLASS = {
  idle: '',
  attention: 'bwm-attention',
  thinking: 'bwm-thinking',
  executing: 'bwm-executing',
  speaking: 'bwm-speaking',
  success: 'bwm-success',
  error: 'bwm-error',
  offline: 'bwm-offline',
};

const PRESENCE_CSS = `
.bwm-layer video { transition: filter .6s ease, transform .6s ease; }
.bwm-layer.bwm-attention video { filter: brightness(1.12) saturate(1.05); }
.bwm-layer.bwm-thinking video { filter: blur(2px) saturate(.9) brightness(1.06); transform: scale(1.02); }
.bwm-layer.bwm-executing video { filter: saturate(1.15) brightness(1.03); }
.bwm-layer.bwm-speaking video { filter: saturate(1.1) brightness(1.05); }
.bwm-layer.bwm-error video { filter: grayscale(.85) brightness(.9); }
.bwm-layer.bwm-offline video { filter: grayscale(1) brightness(.7); }
.bwm-layer { position: fixed; left: 0; top: 0; width: 100%; height: 100%; overflow: hidden; pointer-events: none; transition: width .6s cubic-bezier(.22,1,.36,1), left .6s cubic-bezier(.22,1,.36,1), right .6s cubic-bezier(.22,1,.36,1); }
body[data-bwm-mode='work'] .bwm-layer { width: 100%; left: 0; right: 0; background: radial-gradient(900px 600px at 62% 40%, rgba(123,242,210,.06), transparent 60%), #111522; }
#bwm-toggle { transition: transform .15s ease, opacity .2s ease; }
#bwm-toggle.bwm-toggling { opacity: .5; }
@keyframes bwm-success-glow { 0% { box-shadow: inset 0 0 0 rgba(122,242,210,0); } 30% { box-shadow: inset 0 0 120px rgba(122,242,210,.35); } 100% { box-shadow: inset 0 0 0 rgba(122,242,210,0); } }
.bwm-layer.bwm-success { animation: bwm-success-glow 1.2s ease-out; }
#bwm-rotate { position: fixed; inset: 0; z-index: 999; display: none; align-items: center; justify-content: center; flex-direction: column; gap: 16px; background: #090e18; color: #e8efec; font-family: -apple-system, BlinkMacSystemFont, sans-serif; text-align: center; }
#bwm-rotate .rot-icon { font-size: 48px; animation: bwm-rot-spin 1.6s ease-in-out infinite; }
@keyframes bwm-rot-spin { 0%,100% { transform: rotate(0); } 50% { transform: rotate(90deg); } }
#bwm-rotate button { padding: 10px 22px; border-radius: 999px; border: 1px solid rgba(122,242,210,.5); background: rgba(8,13,22,.8); color: #e8efec; font-size: 15px; cursor: pointer; }
.bwm-sb { position: fixed !important; left: 0 !important; top: 0 !important; height: 100vh !important; z-index: 45 !important; transform: translateX(-100%); transition: transform .3s ease; box-shadow: 8px 0 24px rgba(0,0,0,.25); }
.bwm-sb.bwm-sb-open { transform: translateX(0); }
/* DSH 0.2.2 新增的右侧预览列：干活模式下让位给舞台（与左侧 .bwm-sb 同款位移机制，方向相反）。
   原设计没有这一列——它出现在「左聊天 + 右舞台」之后，压住了右半屏。 */
.bwm-rb { transform: translateX(101%) !important; transition: transform .3s ease; }
#bwm-sidebar-toggle { position: fixed; left: 14px; top: 14px; z-index: 60; width: 36px; height: 36px; border-radius: 10px; border: 1px solid rgba(122,242,210,.35); background: rgba(8,13,22,.72); color: #e8efec; font-size: 16px; cursor: pointer; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(6px); }
#bwm-sidebar-scrim { position: fixed; inset: 0; z-index: 44; display: none; background: rgba(8,13,22,.3); }
#bwm-sidebar-scrim.on { display: block; }
/* 侧边栏收起(固定定位)后，主内容列必须填满：hashed 类名用属性子串选择器 + !important（DSH 重渲染冲不掉） */
body[data-bwm-mode='work'] .bwm-sb ~ [class*=centerCol] { flex: 1 1 100% !important; width: 100% !important; }
body[data-bwm-mode='work'] .bwm-sb ~ [class*=centerCol] > [class*=root] { width: 100% !important; }
#bwm-voice-orb { width: 42px; height: 42px; border-radius: 50%; border: 1px solid rgba(123,242,210,.45); background: rgba(8,13,22,.72); color: #7bf2d2; display: flex; align-items: center; justify-content: center; cursor: pointer; flex: none; transition: transform .15s ease, box-shadow .2s ease; box-shadow: 0 0 14px rgba(123,242,210,.18); }
#bwm-voice-orb:active { transform: scale(.92); box-shadow: 0 0 22px rgba(123,242,210,.45); }
#bwm-send-btn { width: 42px; height: 42px; border-radius: 50%; border: none; background: linear-gradient(135deg, #7bf2d2, #52fefe); color: #080d16; display: flex; align-items: center; justify-content: center; cursor: pointer; flex: none; }
#bwm-composer-hint { margin: 6px 2px 0; font-size: 11px; color: rgba(189,198,195,.65); letter-spacing: .03em; }
#bwm-scrim { position: fixed; left: 0; top: 0; width: clamp(620px, 58vw, 940px); height: 100vh; z-index: 5; display: none; pointer-events: none; }
body[data-bwm-mode='work'] #bwm-scrim { display: block; }
#bwm-scrim { -webkit-backdrop-filter: blur(16px) saturate(0.88); backdrop-filter: blur(16px) saturate(0.88);
  background: linear-gradient(90deg, rgba(8,13,22,.9) 0%, rgba(8,13,22,.78) 50%, rgba(8,13,22,.42) 73%, rgba(8,13,22,.12) 88%, transparent 100%), radial-gradient(circle at 42% 42%, rgba(45,101,88,.16), transparent 48%);
  -webkit-mask-image: linear-gradient(90deg, #000 0%, #000 58%, rgba(0,0,0,.72) 76%, transparent 100%); mask-image: linear-gradient(90deg, #000 0%, #000 58%, rgba(0,0,0,.72) 76%, transparent 100%); }
`;

/* ═══════════════════════════════════════════════════════════════════════════
   ⚠️ 桌面壳专属样式 —— **Web 形态永不加载**（只在 isDesktopShell() 时注入）
   ───────────────────────────────────────────────────────────────────────────
   为什么隔离：插件未来要发布到浏览器（web profile）。这段是为了让「桌面 App 里
   的原生 DSH 界面」看起来像发布版插件干活页的观感，它依赖 DSH 的 --dsw-* 变量名，
   属于宿主适配，不是插件自身功能。放进 PRESENCE_CSS 会跟着发布包带去浏览器，
   在别的宿主上成为死代码/脏样式。故独立成 DESKTOP_WORK_SKIN_CSS。
   ───────────────────────────────────────────────────────────────────────────
   配色与发布产物 dsh-plugin-bwm-friend-0.8.0.tgz 的 EMBEDDED_CSS 同源：
     · 白字 #e8efec / 青边 rgba(123,242,210,·) / 青渐变 linear-gradient(135deg,#7bf2d2,#52fefe)
     · 深色幕布 rgba(8,13,22,.9) 由 PRESENCE_CSS 的 #bwm-scrim 提供（未改）
     · DSH 深色调色板逐条复制 design-platform.css 的 body[data-ds-dark-theme] 两块
   ═══════════════════════════════════════════════════════════════════════════ */
const DESKTOP_WORK_SKIN_CSS = `
/* ── 一、宿主环境适配（不改设计语义）───────────────────────────────────────
   桌面壳 dsh-app:// 下：显式用视口单位，避免祖先参与层叠/包含块变化时百分比失真
   （实测层物理尺寸 [0,0,1280,820] 正确）；DSH 自带 overlayLayer 会吞掉按钮点击，
   故把 ☰ 抬到顶层（层序不变，仅脱离被遮挡）。 */
.bwm-layer { width: 100vw; height: 100vh; }
#bwm-scrim { height: 100vh; }
body[data-bwm-mode] #bwm-sidebar-toggle { z-index: 2147483000; }

/* ── 二、干活模式配色（与发布版 0.8.0 同源）───────────────────────────── */
/* ══ 干活模式配色：1:1 复刻已发布插件（深色 + 白字 + 青渐变）══════════════════
   发布版那套界面是在**深色 DSH** 上呈现的，所以它的真实观感 =
   「DSH 深色调色板」+「插件自有色值（#e8efec 白字 / rgba(123,242,210,·) 青边 /
   linear-gradient(135deg,#7bf2d2,#52fefe) 发送键渐变）」。

   做法：把 DSH 深色调色板**限定在聊天面板作用域内**重声明（变量名、值逐项同源，
   见 packages/client/ui-theme/src/styles/design-platform.css 里
   body[data-ds-dark-theme] 的两个块），因此：
     · 不需要切换 DSH 全局主题（ThemeService 会按持久偏好抢回浅色）；
     · 陪伴模式（全屏 iframe）与侧栏不被波及；
     · 退出干活模式时配色自动消失，无需还原。
   开关只靠 body[data-bwm-mode='work']，与发布版 web 形态的判定方式一致。 */
body[data-bwm-mode='work'] [class*=mainPanel],
body[data-bwm-mode='work'] [class*=centerCol] {
  color-scheme: dark;
  color: #e8efec;
  --dsw-static-amber-100: rgb(254, 245, 231);
  --dsw-static-amber-400: rgb(247, 173, 49);
  --dsw-static-amber-500: rgb(245, 158, 11);
  --dsw-static-amber-600: rgb(221, 134, 41);
  --dsw-static-amber-900: rgb(39, 36, 31);
  --dsw-static-blue-100: rgb(219, 234, 254);
  --dsw-static-blue-300: rgb(147, 197, 253);
  --dsw-static-blue-400: rgb(96, 165, 250);
  --dsw-static-blue-450: rgb(77, 147, 248);
  --dsw-static-blue-500: rgb(59, 130, 246);
  --dsw-static-blue-50: rgb(239, 246, 255);
  --dsw-static-blue-50p: rgb(234, 243, 255);
  --dsw-static-blue-600: rgb(37, 99, 235);
  --dsw-static-blue-75: rgb(229, 240, 255);
  --dsw-static-blue-800: rgb(30, 64, 175);
  --dsw-static-blue-900: rgb(14, 48, 116);
  --dsw-static-blue-950: rgb(23, 37, 84);
  --dsw-static-deepseek-100: rgb(228, 237, 253);
  --dsw-static-deepseek-200: rgb(211, 226, 255);
  --dsw-static-deepseek-300: rgb(183, 200, 254);
  /* Brightened from the platform rgb(103, 158, 254) at the designer's request: legibility on the dark toast surface. */
  --dsw-static-deepseek-400: rgb(122, 170, 255);
  --dsw-static-deepseek-450: rgb(86, 134, 254);
  --dsw-static-deepseek-500: rgb(65, 118, 230);
  --dsw-static-deepseek-50: rgb(237, 243, 254);
  --dsw-static-deepseek-600: rgb(72, 104, 178);
  --dsw-static-deepseek-700-delete: rgb(47, 76, 143);
  --dsw-static-deepseek-800: rgb(52, 65, 91);
  --dsw-static-deepseek-900: rgb(40, 49, 66);
  --dsw-static-green-100: rgb(230, 250, 237);
  --dsw-static-green-400: rgb(78, 209, 126);
  --dsw-static-green-500: rgb(34, 197, 94);
  --dsw-static-green-500-a08: rgb(34 197 94 / 8%);
  --dsw-static-green-500-a12: rgb(34 197 94 / 12%);
  --dsw-static-green-900: rgb(35, 60, 44);
  --dsw-static-neutral-00: rgb(255, 255, 255);
  --dsw-static-neutral-1000: rgb(0, 0, 0);
  --dsw-static-neutral-100: rgb(245, 245, 245);
  --dsw-static-neutral-150: rgb(237, 237, 237);
  --dsw-static-neutral-200: rgb(229, 229, 229);
  --dsw-static-neutral-250: rgb(220, 220, 220);
  --dsw-static-neutral-300: rgb(212, 212, 212);
  --dsw-static-neutral-400: rgb(162, 164, 166);
  --dsw-static-neutral-500: rgb(127, 130, 135);
  --dsw-static-neutral-50: rgb(250, 250, 250);
  --dsw-static-neutral-550: rgb(101, 103, 107);
  --dsw-static-neutral-600: rgb(84, 85, 87);
  --dsw-static-neutral-700: rgb(60, 60, 61);
  --dsw-static-neutral-800: rgb(41, 41, 41);
  --dsw-static-neutral-850: rgb(33, 33, 35);
  --dsw-static-neutral-900: rgb(15, 15, 15);
  --dsw-static-neutral-bluish-00: rgb(255, 255, 255);
  --dsw-static-neutral-bluish-1000: rgb(15, 17, 21);
  --dsw-static-neutral-bluish-100: rgb(235, 238, 242);
  --dsw-static-neutral-bluish-150: rgb(233, 236, 242);
  --dsw-static-neutral-bluish-200: rgb(225, 229, 238);
  --dsw-static-neutral-bluish-300: rgb(207, 211, 214);
  --dsw-static-neutral-bluish-310: rgb(202, 210, 219);
  --dsw-static-neutral-bluish-400: rgb(173, 178, 184);
  --dsw-static-neutral-bluish-500: rgb(151, 157, 166);
  --dsw-static-neutral-bluish-50: rgb(249, 250, 251);
  --dsw-static-neutral-bluish-55: rgb(245, 247, 250);
  --dsw-static-neutral-bluish-600: rgb(129, 133, 140);
  --dsw-static-neutral-bluish-60: rgb(249, 250, 251);
  --dsw-static-neutral-bluish-700: rgb(97, 102, 107);
  --dsw-static-neutral-bluish-750: rgb(67, 69, 74);
  --dsw-static-neutral-bluish-75: rgb(241, 243, 245);
  --dsw-static-neutral-bluish-800: rgb(53, 54, 56);
  --dsw-static-neutral-bluish-850: rgb(44, 44, 46);
  --dsw-static-neutral-bluish-875: rgb(35, 35, 36);
  --dsw-static-neutral-bluish-900: rgb(27, 27, 28);
  --dsw-static-neutral-bluish-90: rgb(237, 240, 244);
  --dsw-static-neutral-bluish-950: rgb(21, 21, 23);
  --dsw-static-red-100: rgb(254, 226, 226);
  --dsw-static-red-400: rgb(242, 90, 90);
  --dsw-static-red-400-a12: rgb(242 90 90 / 12%);
  --dsw-static-red-500: rgb(239, 68, 68);
  --dsw-static-red-50: rgb(254, 242, 242);
  --dsw-static-red-600: rgb(236, 19, 19);
  --dsw-static-red-600-a08: rgb(236 19 19 / 8%);
  --dsw-static-red-900: rgb(87, 12, 12);
  --dsw-static-violet-400: rgb(167, 139, 250);
  --dsw-static-violet-600: rgb(124, 58, 237);
  --dsw-alias-bg-base: var(--dsw-static-neutral-bluish-950);
  --dsw-alias-bg-document-preview: var(--dsw-static-neutral-bluish-950);
  --dsw-alias-bg-document-selection: color-mix(in srgb, var(--dsw-static-blue-500) 40%, transparent);
  --dsw-alias-label-document-preview: var(--dsw-static-neutral-bluish-300);
  --dsw-alias-bg-layer-1: var(--dsw-static-neutral-bluish-875);
  --dsw-alias-bg-layer-2: var(--dsw-static-neutral-bluish-850);
  --dsw-alias-bg-layer-3: var(--dsw-static-neutral-bluish-800);
  --dsw-alias-bg-mask-1: rgba(0, 0, 0, 0.5);
  --dsw-alias-bg-mask-2: rgba(0, 0, 0, 0.2);
  --dsw-alias-bg-mask-3: rgba(0, 0, 0, 0.48);
  --dsw-alias-bg-mask-photo: rgba(0, 0, 0, 0.88);
  --dsw-alias-bg-mask-drop: rgba(39, 39, 48, 0.7);
  --dsw-alias-bg-module-platform: var(--dsw-static-neutral-bluish-800);
  --dsw-alias-bg-multi-select: var(--dsw-static-neutral-850);
  --dsw-alias-bg-overlay: var(--dsw-static-neutral-bluish-700);
  --dsw-alias-bg-skeleton: rgba(255, 255, 255, 0.08);
  --dsw-alias-border-inverted2: rgba(255, 255, 255, 0.08);
  --dsw-alias-border-inverted: rgba(255, 255, 255, 0.06);
  --dsw-alias-border-l1: rgba(255, 255, 255, 0.06);
  --dsw-alias-border-l2-darkmode-thin: rgba(255, 255, 255, 0.06);
  --dsw-alias-border-l2: rgba(255, 255, 255, 0.12);
  --dsw-alias-border-l3: rgba(255, 255, 255, 0.16);
  --dsw-alias-border-l4: rgba(255, 255, 255, 0.2);
  --dsw-alias-brand-primary-invert: var(--dsw-static-neutral-bluish-50);
  --dsw-alias-brand-primary-new-colorprimary-new-color: var(--dsw-static-deepseek-450);
  --dsw-alias-brand-primary: var(--dsw-static-neutral-bluish-50);
  --dsw-alias-brand-text: var(--dsw-static-neutral-bluish-50);
  --dsw-alias-button-contrast-fill: var(--dsw-static-neutral-bluish-50);
  --dsw-alias-button-elevated-fill: var(--dsw-static-neutral-bluish-750);
  --dsw-alias-button-floating-fill: var(--dsw-static-neutral-bluish-850);
  --dsw-alias-button-floating-hover: var(--dsw-static-neutral-bluish-800);
  --dsw-alias-button-ghost-active-border: var(--dsw-static-neutral-bluish-600);
  --dsw-alias-button-ghost-active-fill: var(--dsw-static-neutral-bluish-750);
  --dsw-alias-button-ghost-active-hover: var(--dsw-static-neutral-bluish-700);
  --dsw-alias-button-info-fill: var(--dsw-static-deepseek-400);
  --dsw-alias-button-info-hover: var(--dsw-static-deepseek-500);
  --dsw-alias-button-primary-dimmed: var(--dsw-static-neutral-bluish-750);
  --dsw-alias-button-primary-fill: var(--dsw-alias-brand-primary);
  --dsw-alias-button-primary-hover: var(--dsw-static-neutral-bluish-100);
  --dsw-alias-button-tool-bar-fill-invisible: rgba(31, 31, 31, 0.36);
  --dsw-alias-button-tool-bar-fill: rgba(84, 85, 87, 0.5);
  --dsw-alias-button-tool-bar-hover: rgba(84, 85, 87, 0.6);
  --dsw-alias-illustration-background: var(--dsw-static-neutral-bluish-850);
  --dsw-alias-illustration-backing: var(--dsw-static-neutral-bluish-750);
  --dsw-alias-illustration-detail: var(--dsw-static-neutral-bluish-600);
  --dsw-alias-illustration-inset: var(--dsw-alias-illustration-backing);
  --dsw-alias-illustration-shadow: var(--dsw-alias-illustration-backing);
  --dsw-alias-illustration-surface: var(--dsw-static-neutral-bluish-700);
  --dsw-alias-interactive-bg-active: rgba(255, 255, 255, 0.14);
  --dsw-alias-interactive-bg-hover-accent: rgba(255, 255, 255, 0.24);
  --dsw-alias-interactive-bg-hover-danger: rgba(242, 90, 90, 0.15);
  --dsw-alias-interactive-bg-hover-solid: var(--dsw-static-neutral-bluish-800);
  --dsw-alias-interactive-bg-hover: rgba(255, 255, 255, 0.08);
  --dsw-alias-label-caption: var(--dsw-static-neutral-bluish-600);
  --dsw-alias-label-deep-diving: color-mix(in srgb, var(--dsw-static-deepseek-450) 55%, var(--dsw-static-neutral-bluish-400));
  --dsw-alias-label-deep-diving-shimmer: color-mix(in srgb, var(--dsw-static-blue-300) 65%, var(--dsw-static-deepseek-400));
  --dsw-alias-label-dimmed: var(--dsw-static-neutral-bluish-750);
  --dsw-alias-label-primary-bluish: var(--dsw-static-neutral-bluish-50);
  --dsw-alias-label-primary-dimmed: var(--dsw-static-neutral-bluish-100);
  --dsw-alias-label-primary-foreground: var(--dsw-static-neutral-bluish-1000);
  --dsw-alias-label-primary-inverted: var(--dsw-static-neutral-bluish-800);
  --dsw-alias-label-primary: var(--dsw-static-neutral-bluish-50);
  --dsw-alias-label-secondary: var(--dsw-static-neutral-bluish-300);
  --dsw-alias-label-shimmer: color-mix(in srgb, var(--dsw-static-neutral-00) 45%, transparent);
  --dsw-alias-label-tertiary: var(--dsw-static-neutral-bluish-400);
  --dsw-alias-menu-icon: var(--dsw-alias-label-primary-dimmed);
  --dsw-alias-link: var(--dsw-static-deepseek-400);
  --dsw-alias-markdown-citation: var(--dsw-static-neutral-bluish-800);
  --dsw-alias-markdown-code-block-banner: var(--dsw-static-neutral-bluish-850);
  --dsw-alias-markdown-code-block: var(--dsw-static-neutral-bluish-900);
  --dsw-alias-markdown-code-segment-selected: var(--dsw-static-neutral-bluish-800);
  --dsw-alias-markdown-code-segment-unselected: var(--dsw-static-neutral-bluish-900);
  --dsw-alias-markdown-inline-code: var(--dsw-static-neutral-800);
  --dsw-alias-markdown-placeholder: var(--dsw-static-neutral-bluish-850);
  --dsw-alias-markdown-tag: var(--dsw-static-neutral-bluish-850);
  --dsw-alias-scrollbar-bg-l1: var(--dsw-static-neutral-700);
  --dsw-alias-scrollbar-bg-l2: var(--dsw-static-neutral-600);
  --dsw-alias-scrollbar-hover-l1: var(--dsw-static-neutral-600);
  --dsw-alias-scrollbar-hover-l2: var(--dsw-static-neutral-550);
  --dsw-alias-state-business-primary: var(--dsw-static-deepseek-400);
  --dsw-alias-state-business-tertiary: var(--dsw-static-deepseek-800);
  --dsw-alias-code-diff-added: var(--dsw-static-green-500-a12);
  --dsw-alias-code-diff-deleted: var(--dsw-static-red-400-a12);
  --dsw-alias-file-diff-added-bg: rgb(31, 49, 36);
  --dsw-alias-file-diff-added-gutter: rgb(19, 32, 22);
  --dsw-alias-file-diff-added-marker: rgb(65, 201, 119);
  --dsw-alias-file-diff-deleted-bg: rgb(60, 31, 27);
  --dsw-alias-file-diff-deleted-gutter: rgb(40, 19, 14);
  --dsw-alias-file-diff-deleted-marker: rgb(250, 66, 62);
  --dsw-alias-state-done-primary: var(--dsw-static-violet-400);
  --dsw-alias-state-error-primary: var(--dsw-static-red-400);
  --dsw-alias-state-error-secondary: var(--dsw-static-red-400);
  --dsw-alias-state-idle-primary: var(--dsw-static-neutral-600);
  --dsw-alias-state-success-primary: var(--dsw-static-green-500);
  --dsw-alias-state-success-secondary: var(--dsw-static-green-400);
  --dsw-alias-state-success-tertiary: var(--dsw-static-green-900);
  --dsw-alias-state-warn-label: var(--dsw-static-amber-600);
  --dsw-alias-state-warn-primary: var(--dsw-static-amber-500);
  --dsw-alias-state-warn-secondary: var(--dsw-static-amber-400);
  --dsw-alias-state-warn-tertiary: var(--dsw-static-amber-900);
  --dsw-alias-switch-thumb: var(--dsw-static-neutral-bluish-400);
  --dsw-alias-toast-bg: var(--dsw-static-neutral-bluish-750);
  --dsw-alias-toast-label: var(--dsw-static-neutral-bluish-00);
  --dsw-alias-turn-trigger-bg: var(--dsw-alias-interactive-bg-hover);
  --dsw-alias-turn-trigger-bg-hover: var(--dsw-alias-interactive-bg-active);
  --dsw-alias-tooltip-bg: var(--dsw-static-neutral-bluish-750);
  --dsw-alias-tooltip-key-bg: color-mix(in srgb, var(--dsw-alias-tooltip-bg), white 18%);
  --dsw-specific-bubble-highlight: var(--dsw-static-neutral-bluish-750);
  --dsw-specific-bubble: var(--dsw-static-neutral-bluish-850);
  --dsw-specific-input-major: var(--dsw-static-neutral-bluish-850);
  --dsw-specific-login-input: var(--dsw-static-neutral-bluish-900);
  --dsw-menu-surface-fill: rgba(48, 49, 54, 0.64);
  --dsw-alias-menu-group-header-fill: rgba(48, 49, 54, 0.94);
  --dsw-specific-menu: var(--dsw-menu-surface-fill);
  --dsw-specific-selector: var(--dsw-static-neutral-bluish-800);
  --dsw-specific-sidebar-fill: var(--dsw-static-neutral-bluish-900);
  --dsw-specific-sidebar-nav-item-active-accent: var(--dsw-static-neutral-bluish-800);
  --dsw-specific-sidebar-nav-item-active: var(--dsw-static-neutral-bluish-750);
  --dsw-specific-tip: var(--dsw-static-neutral-bluish-800);

  /* ⚠️ 覆盖必须写在调色板**之后**：同一规则内同名变量后者胜，写前面会被上面两段调色板覆盖
     （0.8.24 实测踩坑：卡片刻意 transparent 却被 input-major 的深灰盖住，观感不透明）。
     · --dsw-specific-input-major → InputBar 卡片底色，发布版是透出幕布
     · --dsw-alias-border-l2     → 卡片描边（--dsw-elevation-stroke-color 取它），发布版是青色细边 */
  --dsw-specific-input-major: transparent;
  --dsw-alias-border-l2: rgba(123,242,210,.55);
}
/* composer 容器清底：卡片自身已透明，但外层 hero/dock 还压着 --dsw-alias-bg-base 的深灰
   （实测内部 #151517 = neutral-bluish-950），透不出来就成了实心块。
   发布版 EMBEDDED_CSS 同样是「卡片透明 + 外层容器全透明」，这里照搬，只清 composer 容器，
   不碰消息流（消息流保持干净可读）。 */
body[data-bwm-mode='work'] [class*=mainPanel] [class*=composerSeat],
body[data-bwm-mode='work'] [class*=mainPanel] [class*=composerStack],
body[data-bwm-mode='work'] [class*=mainPanel] [class*=composerSeat] > div,
body[data-bwm-mode='work'] [class*=mainPanel] [class*=composerStack] > div {
  background: transparent !important;
  box-shadow: none !important;
}
/* 输入卡片青色细边：发布版是「1px solid rgba(123,242,210,.55)」的实心 border。
   0.2.2 的卡片是 composerStack 内的 *__card（探针实测 JZLxKW_card），自带的是
   elevation 的 box-shadow 描边（约 .5px，叠在深底上几乎看不见）→ 换成实心 border。 */
body[data-bwm-mode='work'] [class*=composerStack] [class*=_card] {
  background: transparent !important;
  border: 1px solid rgba(123,242,210,.55) !important;
  border-radius: 14px !important;
  box-shadow: none !important;
}
/* 发送键：发布版青色渐变（EMBEDDED_CSS 的 .primary）
   ⚠️ border-radius:10px 不是笔误——发布版是**34px 圆角方块**（work-crop.png 放大实测：
   圆角约占边长 30%），不是原生 999px 圆形。0.8.0 EMBEDDED_CSS 第 1438 行同值。 */
body[data-bwm-mode='work'] [class*=trailing] [class*=primary] {
  background: linear-gradient(135deg, #7bf2d2, #52fefe) !important;
  color: #09241d !important;
  border: 0 !important;
  border-radius: 10px !important;
  box-shadow: 0 4px 14px rgba(123,242,210,.35) !important;
  flex: 0 0 auto !important;
  opacity: 1 !important;
}
body[data-bwm-mode='work'] [class*=trailing] [class*=primary]:disabled { opacity: .65 !important; }
/* 会话顶栏：发布版 = 深色半透 + 青色底边（EMBEDDED_CSS 的 centerCol header） */
body[data-bwm-mode='work'] [class*=centerCol] header,
body[data-bwm-mode='work'] [class*=mainPanel] header {
  background: rgba(10,16,26,.5) !important;
}
body[data-bwm-mode='work'] [class*=centerCol] header:not([class*=headerBlank]),
body[data-bwm-mode='work'] [class*=mainPanel] header:not([class*=headerBlank]) {
  border-bottom: 1px solid rgba(123,242,210,.15) !important;
}

/* ══ 二之二、B 批：会话区 / 输入区逐项对齐发布版 0.8.0 ═══════════════════════
   来源：dsh-plugin-bwm-friend-0.8.0/lib/client.js 的 EMBEDDED_CSS（1377-1488）。
   该表按 0.8.x 的 hashed 类名（.p7GS4W_* / .PNUCKq_* / .eLe3jW_*）书写，0.2.2 的
   哈希前缀已全部变化（实测当前 InputBar = JZLxKW_*），所以这里**按语义选择器重写**
   （[class*=xxx] 命中 hashed 类名后缀），并把作用域全部限定在干活模式。
   逐条对应关系写在每段注释里，便于 DSH 升级后对账。 */

/* ① 会话头压成 44px 单行（EMBEDDED_CSS 1399-1406）
   原生 0.2.2 = 76px 两行网格（titleRow 30px + tabs 行；ConversationRoot.module.css:23-31,
   .tabs{grid-column:1/-1} 独占第二行）。发布版是「标题 + 标准模式 + 对话/轨迹」一行排开。
   ⚠️ 不能照 0.8.x 改成 display:flex —— 0.2.2 的 .titleRow 带 container-type:inline-size
   （内联轴尺寸包含），成为 flex 项后固有宽度=0，标题会被挤没（0.8.35 实测：标题消失、
   tabs 挤到最左）。正解是**保留网格**、把 tabs 从「跨列第二行」改到「第 3 列第 1 行」，
   并把行高锁死 44px。
   ⚠️ 用 :has([class*=tabs]) 限定——hero/空白会话（headerBlank）没有 tabs，
   强行 44px 会在空态顶部多出一条 44px 色带（发布版空态没有，work-bot.png 为证）。 */
body[data-bwm-mode='work'] [class*=mainPanel] header:has([class*=tabs]),
body[data-bwm-mode='work'] [class*=centerCol] header:has([class*=tabs]) {
  display: grid !important;
  grid-template-columns: auto minmax(0, 1fr) auto auto !important;
  grid-template-rows: 44px !important;
  align-items: center !important;
  height: 44px !important;
  min-height: 44px !important;
  column-gap: 8px !important;
  padding: 0 10px !important;
  box-sizing: border-box !important;
}
body[data-bwm-mode='work'] [class*=mainPanel] header [class*=titleRow],
body[data-bwm-mode='work'] [class*=centerCol] header [class*=titleRow] {
  grid-column: 2 !important; grid-row: 1 !important;
  align-items: center !important; min-width: 0 !important; min-height: 0 !important; gap: 6px !important;
}
body[data-bwm-mode='work'] [class*=mainPanel] header [class*=titleCluster] { min-width: 0 !important; }
body[data-bwm-mode='work'] [class*=mainPanel] header [class*=crumbs] { font-size: 13px !important; }
body[data-bwm-mode='work'] [class*=mainPanel] header [class*=headerActions] { font-size: 12px !important; }
body[data-bwm-mode='work'] [class*=mainPanel] header [class*=headerUtilities] { margin-left: 4px !important; }
/* tabs 从「跨列第二行」搬到「第 3 列第 1 行」，右对齐、单行不换行。
   ⚠️ min-width 是硬要求：DSH 用**行宽估算**决定露几个 tab
   （ConversationSession.tsx:127 → visibleLimit = floor((row.clientWidth-48)/120)），
   每个 tab 按 120px 记账。width:max-content 把行宽压到 ~60px → 只露 1 个，
   「轨迹」被折进 ⋯（0.8.35 实测）。预留 2 个槽位 = 2×120+48 = 288（多留只会把标题栏挤窄、把「标准模式」chip 顶掉）。 */
body[data-bwm-mode='work'] [class*=mainPanel] header [class*=tabs] {
  grid-column: 3 !important; grid-row: 1 !important;
  width: max-content !important; min-width: 288px !important; max-width: 100% !important;
  height: 100% !important;
  margin-top: 0 !important; margin-left: 0 !important; padding-left: 0 !important;
  align-items: center !important; justify-content: flex-end !important;
  flex-wrap: nowrap !important; gap: 2px !important;
}
/* 最右角落控件（⋯ 菜单）排第 4 列；原生 margin-right:-16px 是为 28px 右内边距留的，
   这里内边距只有 10px，不清零会溢出窗口 */
body[data-bwm-mode='work'] [class*=mainPanel] header [class*=headerCorner] {
  grid-column: 4 !important; grid-row: 1 !important; margin-right: 0 !important;
}
/* :not([class*=tabs]) 排除 tabs 容器本身（属性子串会把容器一起命中） */
body[data-bwm-mode='work'] [class*=mainPanel] header [class*=tab]:not([class*=tabs]) {
  height: 28px !important; line-height: 28px !important; font-size: 12px !important;
}

/* ② 会话区滚动条（EMBEDDED_CSS 1407-1419）
   ⚠️ 只搬「隐藏滚动条」，**不搬**它的 flex 布局（1407/1422 的
   「scrollBody flex:1 1 auto + min-height:0」+「viewArea 同理」）。
   0.8.x 是 iframe 内把整页压平、消息自己滚；0.2.2 的滚动容器是 .scrollBody，
   viewArea 必须保持原生 flex:1 0 auto + min-height:auto 才能把高度撑出来，
   否则座位被拉到内容顶部、sticky 落不到底 —— 实测（0.8.35 探针）：
   viewArea 被压到 466px 后 composerSeat.offsetTop 从 4463 掉到 466，
   输入卡整体跑到 y=-3378（屏幕外），界面上只剩消息、输入框不见了。
   ⚠️ 作用域限定 [class*=mainPanel]：整页 [class*=list] 会命中侧栏/弹层，
   把模型菜单、用量面板裁掉（0.8.0 CHANGELOG 0.2.0 条已记过这个坑）。 */
body[data-bwm-mode='work'] [class*=mainPanel] [class*=scrollBody],
body[data-bwm-mode='work'] [class*=mainPanel] [class*=viewArea],
body[data-bwm-mode='work'] [class*=mainPanel] [class*=scroll],
body[data-bwm-mode='work'] [class*=mainPanel] [class*=list] {
  scrollbar-width: none !important; -ms-overflow-style: none !important;
}
body[data-bwm-mode='work'] [class*=mainPanel] [class*=scrollBody]::-webkit-scrollbar,
body[data-bwm-mode='work'] [class*=mainPanel] [class*=viewArea]::-webkit-scrollbar,
body[data-bwm-mode='work'] [class*=mainPanel] [class*=scroll]::-webkit-scrollbar,
body[data-bwm-mode='work'] [class*=mainPanel] [class*=list]::-webkit-scrollbar {
  display: none !important; width: 0 !important; height: 0 !important;
}
/* composer dock 内的列表恢复细滚动条（TodoPanel .list 原生限高 + 需要能看出可滚） */
body[data-bwm-mode='work'] [class*=composerStack] [class*=list],
body[data-bwm-mode='work'] [class*=composerStack] [class*=scroll] {
  scrollbar-width: thin !important; -ms-overflow-style: auto !important;
}
body[data-bwm-mode='work'] [class*=composerStack] [class*=list]::-webkit-scrollbar,
body[data-bwm-mode='work'] [class*=composerStack] [class*=scroll]::-webkit-scrollbar {
  display: block !important; width: 8px !important; height: 8px !important;
}

/* ③ 输入座位贴底 + 内边距（EMBEDDED_CSS 1420 / 1424） */
body[data-bwm-mode='work'] [class*=composerSeat] {
  margin-top: auto !important;
  flex: none !important;
  max-width: 100% !important;
  min-width: 0 !important;
  padding: 14px 4px 6px 0 !important;
}

/* ④ 输入文字与 placeholder 色（EMBEDDED_CSS 1436-1437）
   发布版把文字钉成 #e8efec、placeholder 钉成 rgba(223,231,228,.55)。
   不钉的话走宿主变量（label-primary = neutral-bluish-50 = rgb(249,250,251)），
   比发布版偏冷偏亮，逐像素对比能看出。 */
body[data-bwm-mode='work'] [class*=composerStack] [class*=input] {
  background: transparent !important; border: 0 !important; color: #e8efec !important;
}
body[data-bwm-mode='work'] [class*=composerStack] [class*=placeholder] {
  color: rgba(223,231,228,.55) !important;
}

/* ⑤ 模型 chip 文字（EMBEDDED_CSS 1450-1451）：模型名白、effort 值青
   work-crop.png 实测：「DeepSeek-V4-F」白 + 「High」青，2026-11-10 当前实机是
   「GLM-5.3-Flash」白 + 「Default」灰 → effort 的青色在 0.2.2 丢了，这里补回。
   ⚠️ 发布版还给 chip 加了深底 + 青边胶囊（1446-1449），但那一版截图里 chip 是
   **无底透明**的（work-crop.png）——说明 .p7GS4W_add / .eLe3jW_trigger 那几条
   在新构建里已成死选择器。以「用户看到的成品」为准，故只补文字色，不加胶囊底。 */
body[data-bwm-mode='work'] [class*=triggerLabel] { color: #e8efec !important; font-weight: 500 !important; }
body[data-bwm-mode='work'] [class*=triggerEffort] { color: #7bf2d2 !important; font-weight: 600 !important; }

/* ⑥ trailing 不塌、ContextMeter 圆环不被挤（EMBEDDED_CSS 1462-1468）
   [class*=root]{width:100%} 类规则会误伤圆环 span，把它撑满整行 → 模型名被压塌。 */
body[data-bwm-mode='work'] [class*=trailing] { flex-wrap: nowrap !important; min-width: 0 !important; }
body[data-bwm-mode='work'] [class*=trailing] > span { width: auto !important; flex: 0 0 auto !important; }
body[data-bwm-mode='work'] [data-slot="conversation.input.model"] { min-width: auto !important; flex: 0 1 auto !important; }

/* ⑦ hero 背光椭圆隐藏（EMBEDDED_CSS 1469-1472）
   纯装饰 svg，原生按 1051/776 比例故意溢出，会把 scrollBody 撑出垂直滚动 → 输入卡被推离底部。 */
body[data-bwm-mode='work'] [class*=heroGlow] { display: none !important; }

/* ⑧ ask/选项/附件卡防横向截断（EMBEDDED_CSS 1479-1487）
   实测（2026-11-10 b2-a.png）：附件消息卡右缘超出卡片被裁。原生卡片挂在
   composerSeat / scrollBody 两处，两处都约束 max-width。 */
body[data-bwm-mode='work'] [class*=composerSeat] section[class*=card],
body[data-bwm-mode='work'] [class*=scrollBody] section[class*=card] {
  max-width: calc(100vw - 40px) !important; min-width: 0 !important; box-sizing: border-box !important;
}
body[data-bwm-mode='work'] [class*=composerSeat] section[class*=card] [class*=headerActions],
body[data-bwm-mode='work'] [class*=scrollBody] section[class*=card] [class*=headerActions] {
  flex-wrap: wrap !important; row-gap: 6px !important; max-width: 100% !important;
}
body[data-bwm-mode='work'] [class*=composerSeat] section[class*=card] button,
body[data-bwm-mode='work'] [class*=scrollBody] section[class*=card] button { white-space: normal !important; }

/* ⑩ 0.2.2 新增组件的「局部深色变量」（发布版没有这批组件，是本仓新增的坑）
   这些组件把深色写死在 :global(body[data-ds-dark-theme]) 里，**不走 --dsw-* 调色板**：
     · ui-deliverables/Deliverables .root  → --deliverable-fill / --deliverable-hover
     · ui-deliverables/ChangedFiles .card  → --changes-fill / --changes-hover
     · ui-plan/PlanPreview .card           → --plan-card-fill / --plan-card-hover
   我们只做 CSS 作用域、不切宿主主题属性 ⇒ 它们一律退回浅色（实测 2026-11-10：
   交付文件卡底色 rgb(250,250,250) 纯白，在深色幕布上是块白板）。
   做法：在对话面板内把这三个变量按宿主深色块同值（neutral-850 / 800）重新声明。
   宿主只在读这些变量的组件上生效，撒在 [class*=_root] 上无副作用（变量没人读=无害），
   这样既不用猜 hashed 前缀，也不会被 DSH 升级改哈希打穿。 */
body[data-bwm-mode='work'] [class*=mainPanel] [class*=_root] {
  --deliverable-fill: var(--dsw-static-neutral-850);
  --deliverable-hover: var(--dsw-static-neutral-800);
  --changes-fill: var(--dsw-static-neutral-850);
  --changes-hover: var(--dsw-static-neutral-800);
  --plan-card-fill: var(--dsw-static-neutral-850);
  --plan-card-hover: var(--dsw-static-neutral-800);
}
/* 卡片左侧图标托底的亮色方片同理（浅色 50% 白 → 深色 5% 白） */
body[data-bwm-mode='work'] [class*=mainPanel] [class*=_fileIcon],
body[data-bwm-mode='work'] [class*=mainPanel] [class*=_cardIcon] {
  background: color-mix(in srgb, var(--dsw-static-neutral-00) 5%, transparent) !important;
}

/* ⑨ 窄屏自适应（EMBEDDED_CSS 1474-1478）：窗口 <560px 时压缩 hero clearance */
@media (max-width: 560px) {
  body[data-bwm-mode='work'] [class*=composerSeat] { padding: 10px 2px 4px 0 !important; }
  body[data-bwm-mode='work'] [class*=mainPanel] header { padding: 0 6px !important; }
}

/* ── 三、顶部品牌栏（1:1 复刻发布版 .topbar / 78px）─────────────────────────
   数值逐项取自发布产物：
     · static-ui/styles.css:86-144  → .topbar / .brand / .brand-mark / .brand b/small
     · static-ui/styles.css:187-215 → .topbar-actions / .icon-button
     · static-ui/styles.css:2092-2103 → .quota-badge
     · lib/index.js:1475-1481 (mkBtn) → 「陪伴」「☰ 工作区」两枚胶囊
   发布版的 topbar 属于 Host 生成的独立页 /bwm-friend/work/；桌面壳无法内嵌 DSH
   （子 iframe 拿不到 __DSH_BOOT__），只能把同一套 topbar 叠在根页面上。 */
#bwm-topbar {
  position: fixed; inset: 0 0 auto; z-index: 2147482000; height: 78px;
  display: grid; grid-template-columns: 1fr auto; align-items: center;
  /* 发布版是 padding: 0 34px（浏览器页，无窗口装饰）。桌面壳窗口用 hiddenInset，
     红黄绿三枚交通灯浮在内容之上、占据左侧约 70px —— 34px 会让 logo 压在交通灯下面
     （实测截图：绿灯盖住品牌图标右上角）。故左侧让出交通灯，右侧仍是发布版的 34px。 */
  padding: 0 34px 0 92px;
  border-bottom: 1px solid rgba(255,255,255,.055);
  background: linear-gradient(180deg, rgba(8,13,22,.94), rgba(8,13,22,.45));
  -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px);
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
  pointer-events: auto;
}
/* 陪伴模式 = 全屏 iframe（发布版完整页面，自带 topbar）→ 这层必须让开，否则双顶栏 */
body[data-bwm-mode='companion'] #bwm-topbar { display: none !important; }
#bwm-topbar .bwm-brand { display: inline-flex; width: max-content; align-items: center; gap: 12px; color: #f2efe6; }
#bwm-topbar .bwm-brand-mark {
  width: 54px; height: 54px; position: relative; display: block; flex: none;
  border-radius: 13px; overflow: hidden; box-shadow: 0 0 18px rgba(123,242,210,.35);
}
#bwm-topbar .bwm-brand-mark img { display: block; width: 100%; height: 100%; object-fit: cover; }
#bwm-topbar .bwm-brand-copy { display: block; min-width: 0; }
#bwm-topbar .bwm-brand-title { display: flex; align-items: baseline; gap: 13px; white-space: nowrap; }
#bwm-topbar .bwm-brand b { display: block; letter-spacing: .22em; font-weight: 600; font-size: 13px; line-height: 1; }
#bwm-topbar .bwm-brand small { display: block; margin-top: 4px; color: #87928f; letter-spacing: .16em; font-size: 8px; }
#bwm-topbar .bwm-actions { grid-column: 2; justify-self: end; display: flex; align-items: center; gap: 10px; }
#bwm-topbar .bwm-quota {
  display: inline-flex; align-items: center; padding: 4px 12px; border-radius: 999px;
  background: rgba(123,242,210,.08); border: 1px solid rgba(123,242,210,.25);
  color: #9fe9d5; font-size: 12px; font-weight: 600; margin-right: 8px; white-space: nowrap;
}
#bwm-topbar .bwm-icon-btn {
  width: 38px; height: 38px; display: grid; place-items: center;
  border: 1px solid rgba(123,242,210,.18); border-radius: 50%;
  background: rgba(255,255,255,.025); color: #e8efec; cursor: pointer; transition: .25s ease;
}
#bwm-topbar .bwm-icon-btn:hover { border-color: rgba(123,242,210,.42); background: rgba(123,242,210,.07); transform: rotate(4deg); }
#bwm-topbar .bwm-icon-btn svg { width: 18px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; }
#bwm-topbar .bwm-pill {
  height: 32px; padding: 0 14px; border-radius: 999px;
  border: 1px solid rgba(123,242,210,.5); background: rgba(8,13,22,.6); color: #7bf2d2;
  font-family: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
  display: flex; align-items: center; letter-spacing: .05em;
}
#bwm-topbar .bwm-pill:hover { background: rgba(123,242,210,.12); }
/* 工作区抽屉：发布版是右侧玻璃弹窗（lib/index.js:1494 #bwm-workspace-pop）
     background rgba(10,16,26,.55) + blur(18px) + 青边 + 阴影，且 z-index 80 压在 topbar(15) 之上。
   桌面壳的「工作区」沿用 DSH 原生侧栏从左侧滑出（那一列本来就在左边），但必须补上同一套玻璃底：
   否则 transparentizeSurfaces() 已把它的底色清成透明 → 抽屉里直接透出聊天正文，完全不可读（实测）。 */
.bwm-sb {
  z-index: 2147482100 !important; /* topbar 之上：发布版弹窗 z80 > topbar z15，同层级关系 */
  background: rgba(10,16,26,.55) !important;
  -webkit-backdrop-filter: blur(18px) saturate(.9); backdrop-filter: blur(18px) saturate(.9);
  border-right: 1px solid rgba(123,242,210,.25);
  box-shadow: 10px 0 30px rgba(0,0,0,.35);
}
#bwm-sidebar-scrim { z-index: 2147482050; } /* topbar 与抽屉之间 */
`;

let desktopSkinDone = false;
/** 注入桌面壳配色皮肤（幂等）。web 形态直接返回，发布产物零影响。 */
function injectDesktopWorkSkin() {
  if (desktopSkinDone || !isDesktopShell()) return;
  desktopSkinDone = true;
  const style = document.createElement('style');
  style.id = 'bwm-desktop-work-skin';
  style.textContent = DESKTOP_WORK_SKIN_CSS;
  document.head.appendChild(style);
}

/** 模式属性写 body——与 web 形态完全一致（原设计 CSS 全部以 body[data-bwm-mode] 为准） */
function setModeAttr(mode) {
  document.body.setAttribute('data-bwm-mode', mode);
}

/* ── 7.7 顶部品牌栏（桌面壳专属；发布版 /bwm-friend/work/ 页头 1:1）───────
   发布版干活页 = topbar(78px) + dialogue-panel(左 58vw，内嵌原生 DSH) + presence-panel(右舞台)。
   桌面壳拿不到 iframe 内的 DSH boot，故把 topbar 直接叠在根页面上，动作区搬发布版
   lib/index.js:1684-1690 的两枚胶囊（陪伴 / ☰ 工作区）+ 配额徽标 + 设置圆钮。 */
function ensureTopbar() {
  if (!isDesktopShell()) return null;
  const existed = document.getElementById('bwm-topbar');
  if (existed) return existed;
  const bar = document.createElement('header');
  bar.id = 'bwm-topbar';
  bar.innerHTML = [
    '<div class="bwm-brand" aria-label="Bwm Friend">',
    '<span class="bwm-brand-mark">',
    '<img src="/bwm-friend/companion/brand-mark-54.png"',
    ' srcset="/bwm-friend/companion/brand-mark-54.png 1x, /bwm-friend/companion/brand-mark-108.png 2x"',
    ' alt="Bwm Friend" width="54" height="54" />',
    '</span>',
    '<span class="bwm-brand-copy"><span class="bwm-brand-title"><b>Bwm Friend</b></span>',
    '<small>be water my friend</small></span>',
    '</div>',
    '<div class="bwm-actions">',
    '<span class="bwm-quota" id="bwm-quota-badge" title="对话次数剩余">—</span>',
    '<button class="bwm-icon-btn" id="bwm-settings-btn" type="button" aria-label="打开设置" title="打开设置">',
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6" /></svg>',
    '</button>',
    '<button class="bwm-pill" id="bwm-switch-companion" type="button" title="切换到陪伴" aria-label="切换到陪伴">陪伴</button>',
    '<button class="bwm-pill" id="bwm-sidebar-drawer-btn" type="button" title="工作区/会话" aria-label="工作区/会话">☰ 工作区</button>',
    '</div>',
  ].join('');
  document.body.appendChild(bar);
  // 设置：发布版这个圆钮打开插件自己的设置抽屉（static-ui 内的抽屉）；桌面壳没有那套抽屉，
  // 改为把 DSH 原生设置入口找出来点一下（侧栏里的设置/齿轮行），找不到就展开工作区让用户点。
  const gear = document.getElementById('bwm-settings-btn');
  gear.addEventListener('click', () => {
    const native = [...document.querySelectorAll('button, [role=button]')].find((el) => {
      const t = (el.getAttribute('aria-label') || '') + (el.title || '') + (el.textContent || '');
      return /设置|settings/i.test(t) && !el.closest('#bwm-topbar');
    });
    if (native) native.click();
    else document.getElementById('bwm-sidebar-drawer-btn')?.click();
  });
  return bar;
}

/** 桌面壳诊断上报（POST /bwm-friend/_diag → host.log）：定位包含块与选择器适配。
 *  只读 DOM、不改任何样式；仅桌面壳调用。 */
function postDesktopDiag(tag) {
  try {
    const snap = (el) => {
      if (!el) return null;
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        el: el.tagName + '.' + String(el.className || '').slice(0, 50),
        pos: s.position, filter: s.filter, backdrop: s.backdropFilter || s.webkitBackdropFilter,
        transform: s.transform, contain: s.contain, disp: s.display, bg: s.backgroundColor,
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      };
    };
    const adapter = (window.__bwm && window.__bwm.adapter) || null;
    const chatRoot = adapter && adapter.getChatRoot ? adapter.getChatRoot() : null;
    const composer = adapter && adapter.locateComposer ? adapter.locateComposer() : null;
    const video = document.getElementById('bwm-avatar-video');
    // DOM 探针：桌面壳 DSH 0.2.2 的 hashed 类名与 2026-08 版不同（composer 命中搜索框、
    // getChatRoot 指到侧栏根）→ 一次性把候选节点打出来，人工比对后修适配器。
    const brief = (el) => {
      const r = el.getBoundingClientRect();
      return el.tagName + '.' + String(el.className || '').slice(0, 44) + ' ' + [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)].join(',');
    };
    const probes = {};
    for (const sel of ['[data-slot="main.conversation"]', '[data-slot="conversation.composer"]', '[class*=centerCol]', 'main', '[class*=detailsCol]', '[class*=sidebarCol]', '[contenteditable=true]', '[class*=composer]']) {
      try { probes[sel] = [...document.querySelectorAll(sel)].slice(0, 4).map(brief); } catch (_) { probes[sel] = ['err']; }
    }
    try {
      const slots = new Set();
      for (const el of document.querySelectorAll('[data-slot]')) slots.add(el.getAttribute('data-slot'));
      probes.dataSlots = [...slots].slice(0, 40);
    } catch (_) { /* noop */ }
    // 行结构探针：centerCol 的父行子节点（找出右侧预览面板的真实盒子与类名）
    try {
      const center = document.querySelector('[class*=centerCol]');
      const row = center && center.parentElement;
      probes.rowChain = [];
      for (let el = center, i = 0; el && i < 3; i++, el = el.parentElement) {
        probes.rowChain.push({
          level: 'up' + i,
          self: brief(el),
          children: [...el.children].slice(0, 8).map((c) => brief(c) + ' bg=' + getComputedStyle(c).backgroundColor),
        });
      }
    } catch (_) { /* noop */ }
    // composer 子树探针（临时）：定位输入卡片真实类名与描边来源，用于青边/透明度的精确命中
    try {
      const stack = document.querySelector('[class*=composerStack]');
      probes.composerTree = [];
      if (stack) {
        const walk = (el, depth) => {
          if (depth > 4) return;
          const cs = getComputedStyle(el);
          probes.composerTree.push({
            d: depth,
            el: brief(el),
            bg: cs.backgroundColor,
            border: cs.borderTopWidth + ' ' + cs.borderTopColor,
            shadow: String(cs.boxShadow || '').slice(0, 70),
          });
          for (const c of [...el.children].slice(0, 6)) walk(c, depth + 1);
        };
        walk(stack, 0);
      }
    } catch (_) { /* noop */ }
    const payload = {
      tag,
      url: location.href,
      protocol: location.protocol,
      viewport: [innerWidth, innerHeight],
      mode: document.body.getAttribute('data-bwm-mode'),
      htmlMode: document.documentElement.getAttribute('data-bwm-mode'),
      theme: {
        darkAttr: document.body.hasAttribute('data-ds-dark-theme'),
        scheme: document.documentElement.style.colorScheme,
        bodyColor: getComputedStyle(document.body).color,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        panelColor: (() => { const p = document.querySelector('[class*=mainPanel]'); return p ? getComputedStyle(p).color : null; })(),
        panelBg: (() => { const p = document.querySelector('[class*=mainPanel]'); return p ? getComputedStyle(p).backgroundColor : null; })(),
        scrimLight: (() => { const sc = document.getElementById('bwm-scrim'); return sc ? getComputedStyle(sc).backgroundImage.slice(0, 70) : null; })(),
        scrimImage: (() => { const sc = document.getElementById('bwm-scrim'); return sc ? getComputedStyle(sc).backgroundImage.slice(0, 90) : null; })(),
      },
      body: snap(document.body),
      appRoot: snap(document.getElementById('root')),
      layer: snap(document.getElementById('bwm-layer')),
      scrim: snap(document.getElementById('bwm-scrim')),
      chatRoot: snap(chatRoot),
      composer: snap(composer),
      sidebar: snap(adapter && adapter.getSidebar ? adapter.getSidebar() : null),
      toggle: snap(document.getElementById('bwm-toggle')),
      video: video ? { src: (video.currentSrc || '').slice(-48), readyState: video.readyState, paused: video.paused, w: video.videoWidth, h: video.videoHeight } : null,
      probes,
      scrimParent: (() => { const s = document.getElementById('bwm-scrim'); return s && s.parentElement ? (s.parentElement.id || s.parentElement.tagName) : null; })(),
      // 叠放顺序探针：elementsFromPoint 按绘制顺序（上→下）返回，用来判定层/幕布与聊天内容的上下关系
      stack: (() => {
        const t = document.getElementById('bwm-toggle');
        const tr = t ? t.getBoundingClientRect() : null;
        const pts = [[300, 300], [900, 300], [300, 700]];
        if (tr) pts.push([Math.round(tr.x + tr.width / 2), Math.round(tr.y + tr.height / 2)]);
        return pts.map(([x, y]) => {
          const list = (document.elementsFromPoint(x, y) || []).slice(0, 10).map((el) => el.id || (el.tagName + '.' + String(el.className || '').slice(0, 22)));
          return x + ',' + y + ' => ' + list.join(' | ');
        });
      })(),
    };
    fetch('/bwm-friend/_diag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {});
  } catch (_) { /* 诊断失败不影响主流程 */ }
}

function ensureLayer() {
  if (document.getElementById('bwm-layer')) return { layer: document.getElementById('bwm-layer'), video: document.getElementById('bwm-avatar-video') };
  const style = document.createElement('style');
  style.textContent = PRESENCE_CSS;
  document.head.appendChild(style);
  injectDesktopWorkSkin(); // 桌面壳专属配色（web 形态为空操作）
  const layer = document.createElement('div');
  layer.id = 'bwm-layer';
  layer.className = 'bwm-layer';
  layer.setAttribute('aria-hidden', 'true');
  layer.style.cssText = 'z-index: 0; background: radial-gradient(1200px 800px at 75% 40%, rgba(91,124,255,0.22), rgba(8,13,22,0.94));';
  const video = document.createElement('video');
  video.id = 'bwm-avatar-video';
  video.muted = true;
  video.loop = true;
  video.autoplay = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.style.cssText = 'position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover;';
  // S7：视频加载失败降级（断网/404 → 品牌渐变占位，不黑屏）
  video.addEventListener('error', () => {
    layer.style.background = 'radial-gradient(1200px 800px at 75% 40%, rgba(91,124,255,.22), rgba(8,13,22,.94))';
    const fallback = document.createElement('div');
    fallback.id = 'bwm-video-fallback';
    fallback.textContent = '✨ Mira 暂时离线，稍后回来';
    fallback.style.cssText = 'position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:rgba(189,198,195,.55); font-size:14px; letter-spacing:.06em;';
    if (!layer.querySelector('#bwm-video-fallback')) layer.appendChild(fallback);
  });
  layer.appendChild(video);
  document.body.insertBefore(layer, document.body.firstChild);
  // bwm 幕布（左 58vw 浮层：虚化+压暗，独立于 DSH 卡片，精确复刻 bwm ::before）
  if (!document.getElementById('bwm-scrim')) {
    const scrim = document.createElement('div');
    scrim.id = 'bwm-scrim';
    document.body.appendChild(scrim);
  }
  setModeAttr('work');
  return { layer, video };
}

// Presence 渲染层（P1.4：状态机已迁入 runtime-core createPresenceMachine，Shell 只订阅渲染）
// 订阅 bus 'presence:state' → 应用视觉 class（PRESENCE_CLASS 配方）；不持有状态决策
function subscribePresenceRender(bus, layer) {
  const applyClass = (state) => {
    if (!layer) return;
    layer.setAttribute('data-bwm-presence', state);
    for (const name of Object.values(PRESENCE_CLASS)) {
      if (name) layer.classList.remove(name); // 空名（idle）跳过，classList.remove('') 会抛
    }
    const cls = PRESENCE_CLASS[state];
    if (cls) layer.classList.add(cls);
  };
  applyClass('idle'); // Fallback before synchronous current-state recovery.
  const off = bus.on('presence:state', (p) => { if (p && p.state) applyClass(p.state); });
  return off;
}

/* ── 4. 既有 M1 功能 ────────────────────────────────────────────────── */
async function loadSettings() {
  try {
    const res = await fetch(SETTINGS_URL);
    return res.ok ? res.json() : {};
  } catch {
    return {};
  }
}

async function saveSettings(cfg) {
  try {
    await fetch(SETTINGS_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    });
  } catch {
    /* host 离线时忽略 */
  }
}

/* Config 读写竞态防护（2026-09-26）：ledger append / context persist / mode persist 都是
 * 「GET→合并→PUT」三步；两条链并发交错时后写覆盖先写、丢对方字段（账本条目或上下文静默丢失）。
 * 所有读改写统一过本串行链（host 侧 withConfigLock 只保 PUT 原子，保不了客户端 GET-PUT 间隙）。 */
let configWriteChain = Promise.resolve();
function queueConfigWrite(makePatch) {
  const run = configWriteChain.then(() => loadSettings().then((cfg) => saveSettings(makePatch(cfg))));
  configWriteChain = run.catch(() => {});
  return run;
}

/* ── Ledger 账本 store（2026-09-10 B2 反超第一步）──
 * wireLedger 的持久化适配器：逐事件 append（内存镜像 + 单飞行写穿 settings 通道），
 * load() 返回持久层全量（core 侧异步恢复、合并守 200 上限）。
 * settings 通道由宿主落盘（memory.json 同目录）；未来平移宿主 JSONL/SQL（P6）只换本函数。
 * 内存镜像上限 500 条（context 内仍守 core 的 200 条读取窗口）。
 */
function createLedgerStore() {
  let mirror = null;
  let prime = loadSettings()
    .then((cfg) => { mirror = Array.isArray(cfg.wireLedger) ? cfg.wireLedger.slice() : []; })
    .catch(() => { mirror = []; });
  return {
    append(entry) {
      if (!mirror) { mirror = []; }
      mirror.push(entry);
      if (mirror.length > 500) mirror = mirror.slice(-500);
      // 2026-09-26：改走全局串行链——原私有 saving 链与 context persist 链并发时
      // GET-PUT 交错互丢字段（后写覆盖先写，账本条目静默丢失）
      queueConfigWrite((cfg) => ({ ...cfg, wireLedger: mirror }))
        .catch(() => { /* 写失败由 core 侧无感知（append 已同步成功入镜像）；宿主恢复时以最近一次成功为准 */ });
    },
    load() {
      return prime.then(() => (mirror ? mirror.slice() : []));
    },
  };
}

async function loadInventory() {
  try {
    const res = await fetch(INVENTORY_URL);
    if (!res.ok) return { items: [] };
    const data = await res.json();
    return Array.isArray(data.items) ? data : { items: [] };
  } catch {
    return { items: [] };
  }
}

function pickIdle(items, theme) {
  const idles = items.filter((i) => i.type === 'idle');
  return idles.find((i) => i.theme === theme) || idles[0] || items.find((i) => i.type === 'talk') || null;
}

async function applyTheme(video, theme) {
  if (!video) return;
  const { items } = await loadInventory();
  const asset = pickIdle(items, theme);
  if (!asset) return;
  if (video.dataset.src !== asset.url) {
    video.dataset.src = asset.url;
    video.src = asset.url;
    video.play().catch(() => {});
  }
}

function bindOcclusionPause(video) {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      video.dataset.wasPlaying = !video.paused;
      video.pause();
    } else if (video.dataset.wasPlaying === 'true') {
      video.play().catch(() => {});
    }
  });
}

/* ── 4.5 Ledger 闭环（已迁入 @laikaton/bwm-runtime-core，P1.4）────────────
 * wireLedger 定义已移除——Ledger 归 Runtime（createRuntime 内部接线：事件 → timeline/tasks）。
 * 边界审计：grep "function wireLedger" src/client.js = 0 ✅
 */

/* ── 5. DSH Adapter Registry（六/七轮评审：版本化适配器）────────────── */
// DSH 前端类名全 hashed（CSS Modules），唯一稳定锚点 = textarea（对话输入框）。
// Registry 按 DSH 版本匹配适配器（类似浏览器驱动）；DSH 升级 = 新增一个 adapter，不改旧的。
const ADAPTER_DSH_0823 = {
    version: 'dsh-2026-08-23',
    match: (ua) => true, // 版本探测占位（未来读 DSH version 头/元数据）
    embeddedSelectors: EMBEDDED_SELECTORS, // P1：嵌入式 CSS 关键选择器版本登记（升级对照表）
    selectors: {
      composer: 'textarea',
      chatCardAncestorDepth: 4, // 2026-08-23 实测：grow→scroll→card→root
    },
    // LocatorStrategy 多策略（v0.9：不固化单个锚点）——策略按序尝试，全部失败 → isSupported=false 降级
    locatorStrategies: [
      () => document.querySelector('textarea'), // 1. textarea（当前命中）
      () => document.querySelector('input[type=text], input[type=search]'), // 2. input type
      () => document.querySelector('[role=textbox]'), // 3. ARIA
      () => document.querySelector('main') || document.querySelector('[class*=conversation]'), // 4. DOM path
    ],
    getChatRoot() {
      const ta = this.locateComposer();
      if (!ta) return null;
      let el = ta;
      for (let i = 0; i < this.selectors.chatCardAncestorDepth && el.parentElement; i++) el = el.parentElement;
      return el && el.parentElement ? el : null;
    },
    getSidebar() {
      // 侧边栏定位：版本化选择器（hashed 类名，2026-08-23 实测 _5Rp60q_sidebarCol）
      return document.querySelector('._5Rp60q_sidebarCol') || document.querySelector('[class*=sidebarCol]');
    },
    // R3：侧边栏收起为 ☰ 抽屉（fixed 滑入/滑出；收起时聊天+舞台占满全宽）
    setSidebarCollapsed(collapsed) {
      const sb = this.getSidebar();
      const center = document.querySelector('._5Rp60q_centerCol') || document.querySelector('[class*=centerCol]');
      if (!sb || !center) return false; // 未就绪 → 调用方重试
      sb.classList.add('bwm-sb');
      sb.classList.toggle('bwm-sb-open', !collapsed);
      // 侧边栏让位后，主内容列必须用 flex 填满（width 压不过 flex-basis；否则空间被 detailsCol 吃掉）
      center.style.flex = '1 1 100%';
      center.style.width = '100%';
      return true;
    },
    // 运行时发现遮挡视口的不透明面板并透明化（类名 hashed 不稳定 → 发现式，不硬编码）
    transparentizeSurfaces() {
      const vw = innerWidth, vh = innerHeight;
      const targets = [];
      for (const el of document.querySelectorAll('body *')) {
        if (el.closest('#bwm-layer') || el.closest('#bwm-toggle')) continue;
        const cs = getComputedStyle(el);
        const bg = cs.backgroundColor;
        if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') continue;
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        const r = el.getBoundingClientRect();
        if (r.width > vw * 0.35 && r.height > vh * 0.35) targets.push(el);
      }
      // 透明化全部 ≥35% 视口的面板（frame/pane/root 多层白底都要清）；
      // 内部卡片（输入栏/气泡/侧边栏）通常 <35% 视口，天然保留 → 聊天可读
      targets.forEach((el) => {
        if (!el.dataset.bwmOriginalBg) el.dataset.bwmOriginalBg = getComputedStyle(el).backgroundColor;
        el.style.setProperty('background-color', 'transparent', 'important');
        el.style.setProperty('background-image', 'none', 'important');
      });
      return targets.length;
    },
    restoreSurfaces() {
      for (const el of document.querySelectorAll('[data-bwm-original-bg]')) {
        el.style.removeProperty('background-color');
        el.style.removeProperty('background-image');
        delete el.dataset.bwmOriginalBg;
      }
    },
    setWorkLayout() {
      this.transparentizeSurfaces();
      const root = this.getChatRoot();
      if (root) {
        root.dataset.bwmWork = '1';
        // 照 bwm 源码处理：dialogue-panel = 绝对定位在左 + width clamp + 全高
        // （不再依赖 centerCol flex 展开——DSH 的 flex 会把空间分给 detailsCol）
        root.style.position = 'fixed';
        root.style.left = '0';
        root.style.top = '0';
        root.style.width = 'clamp(620px, 58vw, 940px)';
        root.style.height = '100vh';
        root.style.zIndex = '6'; // 幕布 z5 之上、☰ z60 之下
        root.style.overflowY = 'auto';
        root.style.setProperty('background', 'transparent', 'important');
      }
    },
    restoreLayout() {
      this.restoreSurfaces();
      const root = this.getChatRoot();
      if (root) {
        delete root.dataset.bwmWork;
        for (const prop of ['background','backdropFilter','webkitBackdropFilter','backgroundImage','webkitMaskImage','maskImage','maxWidth','height','flex','width','position','left','top','zIndex','overflowY']) {
          root.style.removeProperty(prop);
        }
      }
    },
    locateComposer() {
      for (const strategy of this.locatorStrategies) {
        const el = strategy();
        if (el) return el;
      }
      return null;
    },
    isSupported() {
      return !!this.locateComposer();
    },
};

/* DSH 0.2.2（桌面壳实测 2026-11-10）：前端改为**稳定 data-slot 锚点**，
   2026-08 版的 hashed 类名与 textarea 锚点已失效——
   实测 locateComposer() 命中的是侧栏搜索框（Kjh-qa_searchInput）、
   getChatRoot() 走"往上 4 层"返回的是侧栏根（Kjh-qa_root），setWorkLayout 会把侧栏钉到左侧。
   约定：DSH 升级 = 新增 adapter，不改旧条目；旧条目保留给 0.1.x 前端。 */
const ADAPTER_DSH_022 = Object.create(ADAPTER_DSH_0823);
Object.assign(ADAPTER_DSH_022, {
  version: 'dsh-0.2.2',
  match: () => true,
  selectors: { ...ADAPTER_DSH_0823.selectors, composer: '[data-slot="conversation.composer"]', chatRoot: '[data-slot="main.conversation"]' },
  // 只认「对话输入区」内的可编辑元素——绝不再落到 input[type=search]（那是侧栏搜索框）
  locatorStrategies: [
    () => document.querySelector('[data-slot="conversation.composer"] [contenteditable="true"]'),
    () => document.querySelector('[data-slot="conversation.input.dock"] [contenteditable="true"]'),
    () => document.querySelector('[data-slot="main.conversation"] [contenteditable="true"]'),
    () => document.querySelector('[data-slot="conversation.composer"] textarea'),
    () => document.querySelector('textarea'),
  ],
  getChatRoot() {
    // 0.2.2 实测：`[data-slot="main.conversation"]` 是 display:contents 包装层（rect 0,0,0,0），
    // 对它设 position:fixed 无效 → 取有实盒的对话列容器（语义等同原设计的"对话卡片"，
    // 即 composer 所在的整块内容列：header + 消息列表 + 输入区）。
    return document.querySelector('[class*=mainPanel]')
      || document.querySelector('[class*=centerCol]')
      || document.querySelector('[data-slot="conversation.session"]');
  },
  getSidebar() {
    // `[data-slot="sidebar"]` 是 display:contents 包装层（无盒，挂 bwm-sb 无效）→ 直接取有盒的列
    return document.querySelector('[class*=sidebarCol]');
  },
  getRightColumn() {
    // 右侧预览列（0.2.2 新增）：同样用有实盒的列，实测 576×820
    return document.querySelector('[class*=rightbarCol]');
  },
  /** 0.2.2 新增列在干活模式让位给舞台——写法对齐左侧 setSidebarCollapsed（class 开关，幂等） */
  setRightColumnCollapsed(collapsed) {
    const rb = this.getRightColumn();
    if (!rb) return false;
    rb.classList.toggle('bwm-rb', !!collapsed);
    return true;
  },
  // 原设计布局一字不动，只在前后各包一层「右侧预览列让位」+「对话列内边距」
  setWorkLayout() {
    ADAPTER_DSH_0823.setWorkLayout.call(this);
    this.setRightColumnCollapsed(true);
    // 发布版对话面板内边距（lib/index.js:1693）：
    //   padding: clamp(118px, 14vh, 154px) 0 42px
    // 顶部留白是给 78px topbar 让位——发布版是 iframe 从 topbar 之下开始；桌面壳把 DSH 直接叠在
    // 根页面，只能靠对话列的 padding-top 等价实现（否则 DSH 会话头被 topbar 压住 78px）。
    // 左右归零 = 发布版 work 态（陪伴态才有 clamp(44px,6vw,104px)）。box-sizing 保证总高仍 100vh。
    const root = this.getChatRoot();
    if (root) {
      root.style.setProperty('box-sizing', 'border-box');
      root.style.setProperty('padding', 'clamp(118px, 14vh, 154px) 0 42px');
      root.style.setProperty('background', 'transparent', 'important');
    }
  },
  restoreLayout() {
    ADAPTER_DSH_0823.restoreLayout.call(this);
    this.setRightColumnCollapsed(false);
    const root = this.getChatRoot();
    if (root) {
      root.style.removeProperty('padding');
      root.style.removeProperty('box-sizing');
    }
  },
  // ⚠️ 布局/透明化/还原一律继承 ADAPTER_DSH_0823 的原设计实现（不改语义）。
  // 桌面壳与 web 的差异只在「DOM 选择器」，不在「怎么摆」。
});

const ADAPTER_REGISTRY = [ADAPTER_DSH_022, ADAPTER_DSH_0823];

function resolveAdapter() {
  return ADAPTER_REGISTRY.find((a) => a.match(navigator.userAgent)) || ADAPTER_REGISTRY[0];
}

/* ── 6. VideoEngine 电源管理（六轮评审）────────────────────────────── */
// 可见→播 / 隐藏→停 / 电池→按配置暂停 / 低功耗→静态帧降级
function bindPowerManagement(video, getPowerCfg) {
  const applyVisibility = () => {
    if (document.hidden) {
      video.dataset.wasPlaying = !video.paused;
      video.pause();
    } else {
      const cfg = getPowerCfg();
      if (cfg.pauseOnBattery && video.dataset.onBattery === 'true') return; // 电池降级中
      if (video.dataset.wasPlaying === 'true') video.play().catch(() => {});
    }
  };
  document.addEventListener('visibilitychange', applyVisibility);

  // 电池感知（API 可能不可用/被禁 → 静默降级为纯可见性控制）
  if (navigator.getBattery) {
    navigator
      .getBattery()
      .then((battery) => {
        const applyBattery = () => {
          const cfg = getPowerCfg();
          const onBattery = !battery.charging;
          video.dataset.onBattery = String(onBattery);
          if (cfg.pauseOnBattery && onBattery && !document.hidden) {
            video.dataset.wasPlaying = !video.paused;
            video.pause(); // 电池降级：暂停视频（GPU 解码归零）
          } else if (!onBattery && video.dataset.wasPlaying === 'true') {
            video.play().catch(() => {});
          }
        };
        battery.addEventListener('chargingchange', applyBattery);
        battery.addEventListener('levelchange', applyBattery);
        applyBattery();
      })
      .catch(() => {});
  }
}

/* ── 7. Mode / PresenceState 拆分（协议 P2 v3；值域已迁 runtime-core P1.4）──────── */
const { validMode, validPresence } = require('@laikaton/bwm-runtime-core');

/* ── 7.5 强制横屏（通用布局：任何屏幕一律横屏，竖屏显示提示层）────────── */
function wireForceLandscape() {
  if (document.getElementById('bwm-rotate')) return;
  const overlay = document.createElement('div');
  overlay.id = 'bwm-rotate';
  overlay.innerHTML =
    '<div class="rot-icon">&#8630;</div>'
    + '<div style="font-size:18px;font-weight:600">请横屏使用</div>'
    + '<div style="font-size:13px;opacity:.65">本界面为横屏布局，请将设备旋转为横向（或点击进入全屏横屏）</div>'
    + '<button id="bwm-rotate-btn">进入全屏横屏</button>';
  document.body.appendChild(overlay);
  // 进入全屏并锁定横屏（需用户手势；失败则保持提示层）
  overlay.querySelector('#bwm-rotate-btn').addEventListener('click', () => {
    const doc = document;
    const el = doc.documentElement;
    const reqFs = el.requestFullscreen || el.webkitRequestFullscreen;
    Promise.resolve()
      .then(() => reqFs ? reqFs.call(el) : null)
      .then(() => {
        const so = screen.orientation;
        return so && so.lock ? so.lock('landscape').catch(() => {}) : null;
      })
      .catch(() => {});
  });
  // 强制横屏：竖屏(高>宽)即显示提示层，横屏隐藏（不区分设备，符合'没有窄屏视角'）
  const sync = () => {
    overlay.style.display = innerHeight > innerWidth ? 'flex' : 'none';
  };
  addEventListener('resize', sync);
  addEventListener('orientationchange', sync);
  sync();
}

/* ── 7.55 输入框对齐 bwm composer（B4/C2：语音球|输入|发送，auto 1fr auto）── */
function ensureBwmComposer(adapter) {
  const ta = adapter && adapter.locateComposer();
  if (!ta || document.getElementById('bwm-voice-orb')) return !!ta;
  const parent = ta.parentElement;
  if (!parent) return !!ta;
  // 语音球（按住说；语音功能 M3 接入）
  const orb = document.createElement('button');
  orb.id = 'bwm-voice-orb';
  orb.type = 'button';
  orb.setAttribute('aria-label', '按住说话');
  orb.title = '按住说话';
  orb.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"/><path d="M5 11v1a7 7 0 0 0 14 0v-1M12 19v3M8 22h8"/></svg>';
  // 发送（回车同义）
  const send = document.createElement('button');
  send.id = 'bwm-send-btn';
  send.type = 'button';
  send.setAttribute('aria-label', '发送');
  send.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m5 12 14-7-4 14-3-5-7-2Z"/><path d="m12 14 7-9"/></svg>';
  // 提示
  const hint = document.createElement('p');
  hint.id = 'bwm-composer-hint';
  hint.textContent = 'Enter 发送 · Shift + Enter 换行';
  // 布局：语音球 | 输入 | 发送（保留 DSH 表单结构，只改父容器 grid）
  parent.insertBefore(orb, ta);
  parent.insertBefore(send, ta.nextSibling);
  parent.style.display = 'grid';
  parent.style.gridTemplateColumns = 'auto 1fr auto';
  parent.style.alignItems = 'center';
  parent.style.gap = '10px';
  parent.appendChild(hint);
  hint.style.gridColumn = '1 / -1';
  // 发送 = 触发表单提交（回车同义）
  send.addEventListener('click', () => {
    ta.focus();
    const form = ta.closest('form');
    if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
    else ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  return true;
}

/* ── 7.6 侧边栏 ☰ 抽屉（R3：默认收起，展开滑入）─────────────────── */
function wireSidebarDrawer(adapter) {
  let open = false;
  // 桌面壳：发布版没有左上角悬浮 ☰——「工作区」是 topbar 动作区里的一枚胶囊
  // （lib/index.js:1688 `☰ 工作区`）。悬浮 ☰ 又是注入形态的产物，且与 78px topbar 同坐标会互相压，
  // 故桌面壳直接复用 topbar 胶囊，不再新建悬浮按钮。web 形态维持原样。
  const topbarPill = isDesktopShell() ? document.getElementById('bwm-sidebar-drawer-btn') : null;
  let toggleBtn = topbarPill;
  if (!toggleBtn) {
    toggleBtn = document.createElement('button');
    toggleBtn.id = 'bwm-sidebar-toggle';
    toggleBtn.setAttribute('aria-label', '展开/收起侧边栏');
    toggleBtn.textContent = '☰';
    document.body.appendChild(toggleBtn);
  }
  const scrim = document.createElement('div');
  scrim.id = 'bwm-sidebar-scrim';
  document.body.appendChild(scrim);
  const setOpen = (v) => {
    open = v;
    adapter.setSidebarCollapsed(!v);
    scrim.classList.toggle('on', v);
    if (!topbarPill) toggleBtn.textContent = v ? '✕' : '☰'; // topbar 胶囊文案固定
  };
  toggleBtn.addEventListener('click', () => setOpen(!open));
  scrim.addEventListener('click', () => setOpen(false));
  // 默认收起（聊天+舞台占满全宽）；DSH shell 异步渲染，侧边栏出现前重试
  let tries = 0;
  const tryCollapse = () => {
    if (adapter.setSidebarCollapsed(true)) return; // 成功
    if (++tries < 20) setTimeout(tryCollapse, 500); // 最多重试 10s
  };
  tryCollapse();
}

/* ── 8. 悬浮按钮 + ModeMachine（M2）──────────────────────────────── */
const MODE_LABELS = { work: '干活', companion: '陪伴' };
const BTN_BASE_POS = { right: 20, bottom: 20 };

function ensureCompanionFrame() {
  if (document.getElementById('bwm-companion')) return document.getElementById('bwm-companion');
  const frame = document.createElement('iframe');
  frame.id = 'bwm-companion';
  frame.setAttribute('aria-label', 'BWM Friend 陪伴');
  frame.setAttribute('allow', 'microphone; autoplay; clipboard-write');
  frame.style.cssText = [
    'position: fixed; inset: 0; z-index: 20; border: 0; display: none;',
    'background: #090e18; pointer-events: auto;',
    // 桌面壳（body 上有 filter 造包含块）：inset:0 不可靠 → 显式给视口尺寸
    isDesktopShell() ? 'width: 100vw; height: 100vh; margin: 0; padding: 0;' : '',
  ].join('');
  document.body.appendChild(frame);
  return frame;
}

function ensureToggleButton() {
  // 桌面壳：发布版的模式切换是 topbar 动作区的「陪伴」胶囊（lib/index.js:1685），
  // 不是屏幕右下角悬浮胶囊（那是注入形态的产物，发布版干活页里没有）。这里直接复用 topbar 那枚。
  if (isDesktopShell()) {
    const pill = document.getElementById('bwm-switch-companion');
    if (pill) { pill.dataset.bwmStaticPill = '1'; return pill; }
  }
  if (document.getElementById('bwm-toggle')) return document.getElementById('bwm-toggle');
  const btn = document.createElement('button');
  btn.id = 'bwm-toggle';
  btn.type = 'button';
  // 桌面壳：DSH 自带 overlayLayer 等覆盖层，z-index 100 会被吞掉点击（实测点了无反应）
  // → 桌面壳抬到顶层；web 形态维持原值
  const z = isDesktopShell() ? '2147483000' : '100';
  btn.style.cssText = [
    `position: fixed; right: 20px; bottom: 20px; z-index: ${z};`,
    'padding: 8px 16px; border-radius: 999px; border: 1px solid rgba(122,242,210,.4);',
    'background: rgba(8,13,22,.78); color: #e8efec; font: 13px -apple-system, BlinkMacSystemFont, sans-serif;',
    'cursor: pointer; backdrop-filter: blur(8px); box-shadow: 0 4px 16px rgba(0,0,0,.35);',
    'user-select: none; touch-action: none;',
  ].join('');
  document.body.appendChild(btn);
  return btn;
}

function wireToggle(bus, context, adapter, btn) {
  let mode = 'work';
  // 桌面壳 topbar 的「陪伴」是**固定文案**（发布版就是固定写「陪伴」，点它去陪伴页）；
  // 悬浮胶囊才需要跟随当前模式显示「陪伴/干活」。
  const staticPill = btn.dataset.bwmStaticPill === '1';
  const render = () => { if (!staticPill) btn.textContent = MODE_LABELS[mode] || mode; };
  const applyMode = (m, opts = {}) => {
    mode = validMode(m);
    bus.emit('presence:mode', { mode }); // Protocol 2：mode 走 presence:mode 通道，不占 context 域
    setModeAttr(mode);
    // 深色 DSH 只在启动时设一次（ensureLayer）：模式间来回切换会与 DSH 的 ThemeService
    // 争抢 body 属性，实测切回干活后被它抢回浅色（左侧变白）。陪伴模式全屏 iframe 盖住 DSH，
    // 保持深色无副作用。
    // 陪伴模式 iframe：显示 bwm friend 聊天页（外观与原版一致）；work 模式隐藏
    if (mode === 'companion') {
      const frame = ensureCompanionFrame();
      if (frame && !frame.src) frame.src = '/bwm-friend/companion/';
      if (frame) frame.style.display = 'block';
    } else {
      const frame = document.getElementById('bwm-companion');
      if (frame) frame.style.display = 'none';
    }
    if (adapter) {
      try {
        if (mode === 'work') adapter.setWorkLayout();
        else adapter.restoreLayout();
      } catch (e) { console.error('[bwm] layout error', e); }
    }
    if (opts.persist !== false) {
      // 写 ui.mode（阶段二唯一权威）。顶层 mode 不在 host 设置白名单内（会被
      // schema 守卫剥离）→ 原写法等于"永远存不下来"，此处一并修正。
      queueConfigWrite((cfg) => ({ ...cfg, ui: { ...(cfg.ui || {}), mode } }));
    }
    render();
  };
  loadSettings().then((cfg) => {
    // 阶段二：ui.mode 是唯一权威（旧顶层 cfg.mode 仅兜底）。2026-11-10 实测：
    // 历史配置里残留 mode='companion' 时，会盖掉 settings 面板写入的 ui.mode='work'，
    // 导致「启动就进陪伴」——创世者要求默认干活，故读序改为 ui.mode 优先。
    const persisted = (cfg.ui && cfg.ui.mode) || cfg.mode || 'work';
    applyMode(persisted, { persist: false });
  });
  // 点击切换（executing 禁切）
  let suppressClick = false;
  btn.addEventListener('click', () => {
    if (suppressClick) { suppressClick = false; return; }
    const presence = (context.get('presence') || {}).state;
    if (presence === 'executing') {
      btn.textContent = '生成中，稍后再切';
      setTimeout(render, 1200);
      return;
    }
    btn.classList.add('bwm-toggling');
    applyMode(mode === 'work' ? 'companion' : 'work');
    setTimeout(() => btn.classList.remove('bwm-toggling'), 300);
  });
  // 拖动（pointer events；位移 > 5px 视为拖动，抑制点击）
  // 2026-09-26 修复「拖完弹回原位」（README Known Limitations 根因）：原 pointerup 把
  // right/bottom 重置回 BTN_BASE_POS——拖动只是 transform 视觉假象，松手即归位。
  // 现在：落点即新位（transform 位移折算进 right/bottom 并 clamp 在视口内）。
  let dragging = false, moved = 0, sx = 0, sy = 0;
  if (staticPill) { /* topbar 胶囊固定在栏内，不参与拖拽 */ } else {
  let startRight = BTN_BASE_POS.right, startBottom = BTN_BASE_POS.bottom;
  btn.addEventListener('pointerdown', (e) => {
    dragging = true; moved = 0; sx = e.clientX; sy = e.clientY;
    startRight = parseFloat(btn.style.right) || BTN_BASE_POS.right;
    startBottom = parseFloat(btn.style.bottom) || BTN_BASE_POS.bottom;
    btn.setPointerCapture(e.pointerId);
  });
  btn.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
    // 屏幕坐标 y 向下为正，transform 跟随手指：向下拖 dy>0 → translateY 正值
    if (moved > 2) btn.style.transform = `translate(${dx}px, ${dy}px)`;
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    const dx = (e.clientX || sx) - sx, dy = (e.clientY || sy) - sy;
    if (moved > 5) {
      suppressClick = true;
      // bottom 向上为正 → 向下拖 dy>0 则 bottom 减小（取 -dy）；clamp 在视口内
      const nr = Math.min(Math.max(startRight - dx, 8), Math.max(8, innerWidth - btn.offsetWidth - 8));
      const nb = Math.min(Math.max(startBottom - dy, 8), Math.max(8, innerHeight - btn.offsetHeight - 8));
      btn.style.right = nr + 'px';
      btn.style.bottom = nb + 'px';
    }
    btn.style.transform = '';
  };
  btn.addEventListener('pointerup', endDrag);
  btn.addEventListener('pointercancel', endDrag);
  }
  return applyMode;
}

/* ── 9. 设置页 ──────────────────────────────────────────────────────── */
function BwmSettingsSection() {
  const [cfg, setCfg] = React.useState({ mode: 'work', version: 1, avatar: { theme: '电竞男友' } });
  const [themes, setThemes] = React.useState([]);
  React.useEffect(() => {
    loadSettings().then((c) => setCfg({ mode: 'work', version: 1, avatar: { theme: '电竞男友' }, ...c }));
    loadInventory().then(({ items }) => setThemes([...new Set(items.map((i) => i.theme))]));
  }, []);
  const switchTheme = (theme) => {
    const next = { ...cfg, avatar: { ...cfg.avatar, theme } };
    setCfg(next);
    queueConfigWrite((c) => ({ ...c, avatar: { ...(c.avatar || {}), theme } })); // 2026-09-26：串行链防竞态
    applyTheme(document.getElementById('bwm-avatar-video'), theme);
  };
  const toggleMode = () => {
    const nextMode = validMode(cfg.mode === 'work' ? 'companion' : 'work');
    const next = { ...cfg, mode: nextMode };
    setCfg(next);
    queueConfigWrite((c) => ({ ...c, mode: nextMode })); // 2026-09-26：串行链防竞态
    document.body.setAttribute('data-bwm-mode', next.mode);
  };
  return React.createElement(
    'div',
    { style: { padding: 16, maxWidth: 560 } },
    React.createElement('h3', null, 'BWM Friend'),
    React.createElement('p', null, `模式: ${cfg.mode} · schema ${cfg.version}`),
    React.createElement(
      'label',
      null,
      '主题: ',
      React.createElement(
        'select',
        { value: cfg.avatar.theme, onChange: (e) => switchTheme(e.target.value), style: { marginLeft: 8 } },
        themes.map((t) => React.createElement('option', { key: t, value: t }, t)),
      ),
    ),
    React.createElement('div', null,
      React.createElement(
        'button',
        { onClick: toggleMode, style: { marginTop: 12 } },
        '切换模式 (work ⇄ companion)',
      ),
    ),
  );
}

/* ── 嵌入式模式：work 页 iframe 内嵌原生 DSH 会话视图（业务流=原生，0 重画 0 清洗）────────── */
const EMBEDDED_CSS = `
/* BWM 原效果：对话窗口全透明，暗色虚化由父面板的 scrim（backdrop-blur + 渐变）承担 */
html, body, #root, #root > div, [class*=frame], [class*=centerCol], [class*=centerCol] > div, [class*=root]:not([class*=composerStack] *) { width: 100% !important; height: 100% !important; background: transparent !important; }
/* 2026-09-02 fix：composer dock 列内的组件 root（TodoPanel/GoalBar/Queue）必须豁免
   height:100%——否则收起态的 TodoPanel 被撑到整个 dock 高（原生只有 ~36px 一行），
   点展开后更大（用户实测 bug：todo 窗口默认很大、展开更大，与原生折叠逻辑不一致）。 */
/* 侧栏 → 右上角抽屉（默认收起，点 ☰工作区 弹出）
   width 320px（2026-08-24 第二轮：用户要求回退 320px） */
[class*=sidebarCol] { position: fixed !important; right: 0 !important; top: 0 !important; height: 100vh !important; width: 320px !important; max-width: 85vw !important; z-index: 50 !important; transform: translateX(100%); transition: transform .28s ease; background: rgba(13,18,32,.78) !important; backdrop-filter: blur(14px); border-left: 1px solid rgba(123,242,210,.2) !important; }
[class*=sidebarCol].bwm-emb-open { transform: translateX(0) !important; }
/* 侧栏内部内容改浅色 */
[class*=sidebarCol] [class*=brandName], [class*=sidebarCol] [class*=projectText], [class*=sidebarCol] [class*=sessionText], [class*=sidebarCol] [class*=searchInput], [class*=sidebarCol] [class*=triggerLabel] { color: #e8efec !important; }
[class*=sidebarCol] [class*=searchInput] { background: rgba(10,16,26,.6) !important; border: 1px solid rgba(123,242,210,.18) !important; border-radius: 8px !important; color: #e8efec !important; }
/* 只显示 centerCol 会话视图，填满 iframe */
[class*=detailsCol] { display: none !important; }
[class*=centerCol] { flex: 1 1 100% !important; width: 100% !important; height: 100% !important; min-width: 0 !important; max-width: none !important; }
[class*=frame] { flex-direction: row !important; display: grid !important; grid-template-columns: 1fr !important; grid-template-rows: 100% !important; }
[class*=centerCol] > div { height: 100% !important; }
/* 任务信息条（DSH 会话 header）上移融合顶栏：原生垂直两行（titleRow+tabs，76px）→
   横向单行紧凑条（44px），crumbs/标准模式/Session log/对话·轨迹 tabs 一行排开，
   半透明深底 + 青色底边，视觉上是 bwm 顶栏的延伸（P5「详情条上移顶栏」）。
   只改外观布局，tabs/按钮保持原生可点。 */
[class*=centerCol] header { display: flex !important; flex-direction: row !important; align-items: center !important; height: 44px !important; min-height: 44px !important; gap: 4px !important; padding: 0 10px !important; box-sizing: border-box !important; background: rgba(10,16,26,.5) !important; border-bottom: 1px solid rgba(123,242,210,.15) !important; }
[class*=centerCol] header [class*=titleRow] { flex: none !important; align-items: center !important; min-width: 0 !important; gap: 6px !important; }
[class*=centerCol] header [class*=titleCluster] { min-width: 0 !important; }
[class*=centerCol] header [class*=crumbs] { font-size: 13px !important; }
[class*=centerCol] header [class*=headerActions] { font-size: 12px !important; }
[class*=centerCol] header [class*=headerUtilities] { margin-left: 4px !important; }
[class*=centerCol] header [class*=tabs] { margin-left: auto !important; flex: none !important; align-items: center !important; gap: 2px !important; height: 100% !important; }
[class*=centerCol] header [class*=tab] { height: 28px !important; line-height: 28px !important; font-size: 12px !important; }
[class*=scrollBody] { flex: 1 1 auto !important; min-height: 0 !important; overflow-y: auto !important; display: flex !important; flex-direction: column !important; justify-content: flex-start !important; }
/* 会话区：参照原生——不显示滚动条，但鼠标滚轮能上下滚（历史可翻）
   ⚠️ 不能用 [class*=root] 宽泛选择——它命中 PNUCKq_root（模型按钮容器）/ContextMeter root 等
   组件容器，overflow auto 会把弹出的模型菜单/用量面板裁剪掉（用户实测点击无弹框）。
   滚动只给 centerCol 及其直接 root（对话视图），组件 root 保持原生 overflow visible。 */
[class*=centerCol], [class*=scrollBody], [class*=viewArea], [class*=scroll], [class*=list] { overflow-y: auto !important; scrollbar-width: none !important; -ms-overflow-style: none !important; }
[class*=centerCol] > [class*=root] { overflow-y: auto !important; scrollbar-width: none !important; -ms-overflow-style: none !important; }
[class*=centerCol]::-webkit-scrollbar, [class*=scrollBody]::-webkit-scrollbar, [class*=viewArea]::-webkit-scrollbar, [class*=scroll]::-webkit-scrollbar, [class*=list]::-webkit-scrollbar, [class*=centerCol] > [class*=root]::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
/* 2026-09-02 fix：composer dock 内的滚动容器恢复滚动条（TodoPanel .list 原生限高 180px
   且 overflow-y:auto，全局隐藏规则吞掉了它的滚动条——任务多时无法看出/进行滚动）。
   声明顺序在隐藏规则之后，同 !important 下后者生效。 */
[class*=composerStack] [class*=list], [class*=composerStack] [class*=scroll] { scrollbar-width: thin !important; -ms-overflow-style: auto !important; }
[class*=composerStack] [class*=list]::-webkit-scrollbar, [class*=composerStack] [class*=scroll]::-webkit-scrollbar { display: block !important; width: 8px !important; height: 8px !important; }
[class*=composerSeat] { margin-top: auto !important; flex: none !important; }
/* 会话区(消息)作为独立滚动容器，输入框固定底部，会话区拉大（不命中 composer 内部 scroll，避免弄坏模型按钮） */
[class*=viewArea], [class*=centerCol] > [class*=root] { flex: 1 1 auto !important; min-height: 0 !important; }
/* composer 内容收缩进窗口（不溢出右侧，发送键完整显示） */
[class*=composerSeat] { max-width: 100% !important; min-width: 0 !important; padding: 14px 4px 6px 0 !important; }
/* 输入框 = BWM 风格：青色边框 + 全透明玻璃（只动外观，不动原生控件功能） */
/* composer 卡片外层 root（hero）：原生 content-box + 16px 侧 clearance 会把边框盒撑到 648px，
   超出 iframe 620 → 卡片右缘/发送键被 iframe 裁掉。改为 border-box：宽度 100% 含 padding，
   卡片回到容器内（发送键、青色边框完整显示）。 */
.p7GS4W_root { box-sizing: border-box !important; }
/* hero 高度自适应：EMBEDDED 里 [class*=root]{height:100%} 把 hero 压到 81px，
   card 高 118px → 按钮行/发送键被 hero 内部 overflow 裁掉 37px。改 auto + overflow visible，
   让 card 完整展开（按钮行完整可见）。 */
.p7GS4W_root.p7GS4W_hero { height: auto !important; max-height: none !important; overflow: visible !important; }
.p7GS4W_card { background: transparent !important; border: 1px solid rgba(123,242,210,.55) !important; border-radius: 14px !important; box-shadow: none !important; width: 100% !important; max-width: 100% !important; min-width: 0 !important; box-sizing: border-box !important; }
.p7GS4W_backdrop, .p7GS4W_grow, .p7GS4W_scroll, .p7GS4W_root, .p7GS4W_row, .p7GS4W_tools, .p7GS4W_trailing, .p7GS4W_overlayAnchor { background: transparent !important; min-width: 0 !important; }
.p7GS4W_input { background: transparent !important; border: 0 !important; color: #e8efec !important; width: 100% !important; }
.p7GS4W_input::placeholder { color: rgba(223,231,228,.55) !important; }
.p7GS4W_primary { background: linear-gradient(135deg,#7bf2d2,#52fefe) !important; color: #09241d !important; border: 0 !important; border-radius: 10px !important; box-shadow: 0 4px 14px rgba(123,242,210,.35) !important; flex: 0 0 auto !important; }
/* 发送键可见性：原生 disabled 态 opacity .4 在透明背景上几乎消失 →
   disabled 保持可辨认（.65），非 disabled 完全可见。只动外观。 */
.p7GS4W_primary { opacity: 1 !important; }
.p7GS4W_primary:disabled { opacity: .65 !important; }
/* 操作按钮行可见性：EMBEDDED 全透明背景后，命令/访问模式/模型按钮 = 透明底+浅灰字，
   在深色幕布上对比度不足（用户实测"模型按钮不见了/发送键看不到"）。
   给按钮行加 BWM 风格深色半透明底 + 高对比文字 + 青色细边（只改外观，不碰点击/菜单）。 */
.p7GS4W_add, .p7GS4W_tools button, [class*=trailing] button { background: rgba(10,16,26,.55) !important; border: 1px solid rgba(123,242,210,.28) !important; color: #e8efec !important; border-radius: 999px !important; box-shadow: 0 2px 10px rgba(0,0,0,.25) !important; }
/* 发送键单独恢复 BWM 青色渐变（须在按钮行样式之后、特异性更高，否则被 rgba 深底覆盖） */
.p7GS4W_trailing .p7GS4W_primary { background: linear-gradient(135deg,#7bf2d2,#52fefe) !important; border: 0 !important; color: #09241d !important; box-shadow: 0 4px 14px rgba(123,242,210,.35) !important; }
.p7GS4W_add { color: #7bf2d2 !important; }
.PNUCKq_triggerLabel { color: #e8efec !important; font-weight: 500 !important; }
.PNUCKq_triggerEffort { color: #7bf2d2 !important; font-weight: 600 !important; }
.PNUCKq_chevron { color: #7bf2d2 !important; }
.eLe3jW_trigger { color: #e8efec !important; }
.eLe3jW_trigger svg { color: #7bf2d2 !important; }
/* 清掉 composer 区域（卡片外的容器/阴影）任何暗底与阴影（只影响外观）
   2026-09-26：删除无效声明 child-shadow（非 CSS 属性，浏览器静默忽略——笔误清零） */
[class*=composerSeat], [class*=composerStack], [class*=heroWorkspaceRow], [class*=centerCol] > div, [class*=scrollBody], [class*=root] { box-shadow: none !important; background: transparent !important; }
.p7GS4W_root { box-shadow: none !important; }
/* ContextMeter（上下文用量圆环）：原生组件，位于 trailing 内、发送键旁（InputBar 渲染顺序 =
   模型 trigger → ContextMeter → primary）。空间不足时保护圆环不收缩（长模型名优先截断模型名）。
   绝不做 JS transform 位移——那会把圆环叠到模型按钮上并拦截点击（历史教训）。 */
[class*=trailing] { flex-wrap: nowrap !important; min-width: 0 !important; }
/* ContextMeter root（span）：line 763 的 [class*=root]{width:100%} 误伤它 → span 被撑到整行宽
   341px，flex 挤压把模型按钮容器压塌成 w0（trigger 溢出、圆环与模型名重叠）。恢复 width auto。 */
[class*=trailing] > span { width: auto !important; flex: 0 0 auto !important; }
/* 模型按钮容器（原生 data-slot 稳定锚点）：trailing 空间不足时保 min-width=内容宽，
   模型名优先截断（原生 max-width:min(360px,45cqw)），圆环/发送键不收缩不重叠。 */
[data-slot="conversation.input.model"] { min-width: auto !important; flex: 0 1 auto !important; }
/* hero 背光椭圆（纯装饰 svg，pointer-events:none，原生故意按 1051/776 比例溢出）——
   溢出 88px 把 scrollBody 撑出垂直滚动，composer 按钮行/发送键被推出可视区（需滚动才见）。
   嵌入式模式隐藏装饰，让 composer 完整贴底。 */
[class*=heroGlow] { display: none !important; }
/* 窄屏自适应（P1）：iframe/窗口过窄（<560px）时压缩 hero clearance，输入框/按钮不溢出 */
@media (max-width: 560px) {
  .p7GS4W_root { padding-left: 8px !important; padding-right: 8px !important; }
  [class*=composerSeat] { padding: 10px 2px 4px 0 !important; }
  [class*=centerCol] header { padding: 0 6px !important; }
}
/* 2026-09-02 fix：ask/choice 选项卡片防横向截断。
   实测卡片（section.eT_Osq_card，登记于 EMBEDDED_SELECTORS）内容需 ~802px，
   iframe 742px 时右缘被祖先 overflow-x:hidden 裁掉 ~60px——选项按钮/「提交」键不可见
   （用户实测 bug：AI 发起选项选择时对话框显示不完整）。
   卡片有两个挂载位：待回答时在 composerSeat 座位区、回答后进 scrollBody 消息流——两处都约束；
   父级 eT_Osq_frame 自身恒定超宽 60px（原生装饰性溢出，被裁部分为空白边缘，无视觉损失，不处理）。 */
[class*=composerSeat] section[class*=card], [class*=scrollBody] section[class*=card] { max-width: calc(100vw - 40px) !important; min-width: 0 !important; box-sizing: border-box !important; }
[class*=composerSeat] section[class*=card] [class*=headerActions], [class*=scrollBody] section[class*=card] [class*=headerActions] { flex-wrap: wrap !important; row-gap: 6px !important; max-width: 100% !important; }
[class*=composerSeat] section[class*=card] button, [class*=scrollBody] section[class*=card] button { white-space: normal !important; }
`;
function applyEmbeddedHarness(ctx) {
  const isPop = /[?&]pop=1/.test(typeof location !== 'undefined' ? location.search : '');
  const style = document.createElement('style');
  // pop 弹窗模式（☰ 工作区弹窗内嵌 iframe）：只显示侧栏会话树（会话选择窗口）
  const POP_CSS = isPop ? `
/* pop 弹窗模式：仅侧栏会话树，全屏填充弹窗（父页面弹窗 320px 透明毛玻璃） */
[class*=frame] { display: block !important; grid-template-columns: none !important; }
[class*=sidebarCol] { position: relative !important; right: auto !important; top: auto !important; transform: none !important; width: 100% !important; height: 100vh !important; max-width: none !important; background: rgba(10,16,26,.45) !important; backdrop-filter: blur(16px); border-left: none !important; }
[class*=centerCol], [class*=detailsCol] { display: none !important; }
` : '';
  style.textContent = EMBEDDED_CSS + POP_CSS;
  document.head.appendChild(style);
  // 接收父页消息：打开/关闭侧栏抽屉（原生侧栏 = 会话/工作区树，用于切多会话）
  const sb = document.querySelector('[class*=sidebarCol]');
  window.addEventListener('message', (e) => {
    if (!e || e.origin !== location.origin) return; // P0 安全：仅接受同源消息
    if (e.data && e.data.type === 'bwm-embedded') {
      if (e.data.openSidebar !== undefined && sb) sb.classList.toggle('bwm-emb-open', !!e.data.openSidebar);
    }
    // 主 iframe：☰ 工作区弹窗选择了会话 → 切换本 iframe 会话
    // 2026-09-26 修复「首次切换静默失败」（用户实测：第一次切不过、第二次成功）：
    // 原实现目标可见才点、文件夹链展开后只等固定 400ms 单次查找即放弃——真实工作区
    // 会话量大、React 渲染慢时首轮必失败（第二次因首轮已把文件夹点开才成功）。
    // 改为轮询重试：每轮先找目标（可见即点），找不到则继续展开 folders 链中未展开层，
    // 300ms × 16 ≈ 5s 上限，不无限循环。
    if (e.data && e.data.type === 'bwm-switch-session' && !isPop) {
      const title = e.data.title;
      const folders = Array.isArray(e.data.folders) ? e.data.folders : [];
      const findTarget = () => [...document.querySelectorAll('[role=treeitem]')]
        .find((t) => String(t.innerText || '').split('\n')[0] === title);
      let tries = 0;
      const attempt = () => {
        const target = findTarget();
        if (target) { target.click(); return; }
        if (++tries > 16) return; // 5s 上限：超时放弃（不抢原生行为，也不无限循环）
        if (folders.length) {
          // 扁平虚拟树：只需展开最近一层文件夹；每轮重查（树可能整树重渲染）
          const f = [...document.querySelectorAll('[role="treeitem"]')]
            .find((t) => String(t.innerText || '').split('\n')[0] === folders[0] && t.getAttribute('aria-expanded') === 'false');
          if (f) f.click();
        }
        setTimeout(attempt, 300);
      };
      attempt();
    }
    // 2026-09-02 fix：主 iframe 收「新会话」→ 点击本 iframe 原生「新会话」按钮
    // （走原生新建+切换流程，与原生 DSH 行为一致；不直接调 API 避免绕过 UI 状态）
    // 2026-09-26 同类加固：按钮未渲染时轮询重试（原单次查找静默失败——与会话切换同一类时序缺陷）
    if (e.data && e.data.type === 'bwm-new-session' && !isPop) {
      let ntries = 0;
      const nattempt = () => {
        const btn = [...document.querySelectorAll('button')]
          .find((b) => (b.textContent || '').trim() === '新会话' || (b.getAttribute('aria-label') || '') === '新建会话');
        if (btn) { btn.click(); return; }
        if (++ntries > 8) return; // ~2.4s 上限
        setTimeout(nattempt, 300);
      };
      nattempt();
    }
  });
  // pop 弹窗 iframe：点击叶子会话 → 通知父页面切换主 iframe（弹窗保持打开，不关闭）
  // 文件夹节点（可展开/折叠，带 aria-expanded）只做原生展开/折叠，不触发切换；
  // 关闭弹窗统一由父页面右上角 ✕ 按钮 / 遮罩点击 / ☰ 按钮完成。
  if (isPop) {
    document.addEventListener('click', (e) => {
      const item = e.target && e.target.closest ? e.target.closest('[role=treeitem]') : null;
      if (item && window.parent !== window && !item.hasAttribute('aria-expanded')) {
        // 解析所属文件夹：DSH 会话树是「扁平虚拟树」（每行独立 SPAN 占位），
        // 文件夹 treeitem（带 aria-expanded）与其子会话相邻平铺、子项紧随其后渲染。
        // → 目标前面最近的带 aria-expanded 的 treeitem 即其所属文件夹；
        //   主 iframe 侧该文件夹可能折叠 → 需先展开才能点到目标会话。
        const folders = [];
        const tree = item.closest ? item.closest('[role="tree"]') : null;
        if (tree) {
          const allItems = [...tree.querySelectorAll('[role="treeitem"]')];
          const idx = allItems.indexOf(item);
          for (let i = idx - 1; i >= 0; i--) {
            if (allItems[i].hasAttribute('aria-expanded')) {
              folders.push(String(allItems[i].innerText || '').split('\n')[0]);
              break; // 扁平树：只需最近一层
            }
          }
        }
        window.parent.postMessage(
          { type: 'bwm-pop-select', title: String(item.innerText || '').split('\n')[0], folders },
          location.origin
        ); // P0：targetOrigin 收紧同源
      }
    }, true);
    // 2026-09-02 fix：弹层内点「新会话」→ 阻断弹层自身创建（否则主/弹层各建一个重复会话），
    // 转发父页面 → 主 iframe 走原生「新建+切换」（用户实测 bug：弹层建了新会话但主窗口不动，
    // 与原生行为明显不一致）。捕获阶段 stopImmediatePropagation 先于 React root 委托触发。
    document.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!btn || window.parent === window) return;
      const label = (btn.textContent || '').trim();
      const isComposerNew = (btn.getAttribute('aria-label') || '').indexOf('新建会话') > -1;
      if (label === '新会话' || isComposerNew) {
        e.preventDefault();
        e.stopImmediatePropagation();
        window.parent.postMessage({ type: 'bwm-pop-new-session' }, location.origin);
      }
    }, true);
  }
  // 选择会话后自动收起抽屉（抽屉 320px 会遮住 composer 右侧按钮行；
  // 移动端模式：选中即收起，会话内容立即全幅呈现，composer 恢复完整可见）
  // listener 内实时查询 sidebarCol（不依赖闭包捕获——DSH 侧栏异步渲染，捕获可能为 null）
  document.addEventListener('click', (e) => {
    const item = e.target && e.target.closest ? e.target.closest('[role=treeitem]') : null;
    if (!item) return;
    const sbEl = document.querySelector('[class*=sidebarCol]');
    if (sbEl && sbEl.classList.contains('bwm-emb-open')) {
      sbEl.classList.remove('bwm-emb-open');
      if (window.parent !== window) window.parent.postMessage({ type: 'bwm-embedded', openSidebar: false }, location.origin); // P0：targetOrigin 收紧同源
    }
  }, true);

  // 2026-08-26 fix：对话区自动滚动。
  // 背景：EMBEDDED_CSS 把消息列表（[class*=scroll]/[class*=list]）与 scrollBody 都设成
  // overflow-y:auto，长会话时实际承接滚动的是消息列表而非 scrollBody；旧实现只滚
  // scrollBody（scrollTop=scrollHeight 对无溢出元素是 no-op），导致输入/回复后不自动下滚。
  // 修复：每次实时查询所有候选滚动容器，逐个滚到底（幂等，无溢出者 no-op）；观察器
  // 挂在 body 上，会话切换/React 重建不失效。
  (function wireAutoScroll() {
    if (isPop || window.__bwmAutoScrollWired) return;
    window.__bwmAutoScrollWired = true;
    // 2026-09-26 修复：候选容器收敛到「会话区」（centerCol 内），排除侧栏（waGfua_list 会话树）
    // 与 composer dock（TodoPanel .list）——原全文档 [class*=scroll]/[class*=list] 会把侧栏
    // 和任务列表也强制滚到底（用户浏览会话树被抢滚动），且任一非底部容器会误触发全局暂停。
    const SCROLLERS = '[class*=scrollBody], [class*=viewArea], [class*=centerCol] > [class*=root], [class*=scroll], [class*=list]';
    const isConversationScroller = (el) =>
      el.closest('[class*=centerCol]') && !el.closest('[class*=sidebarCol]') && !el.closest('[class*=composerStack]');
    const scrollContainers = () => {
      const set = new Set();
      document.querySelectorAll(SCROLLERS).forEach((el) => { if (isConversationScroller(el)) set.add(el); });
      return [...set];
    };
    const scrollToBottom = () => {
      scrollContainers().forEach((el) => { el.scrollTop = el.scrollHeight; });
    };
    // 用户主动上翻（离开底部）→ 暂停自动滚（避免抢滚动）；回到底部 → 恢复。
    // 捕获阶段监听：scroll 事件不冒泡，但会经捕获阶段到达 document，覆盖任意实际滚动容器。
    // 只考虑会话区容器：侧栏/任务列表的滚动位置与「是否跟随最新消息」无关（误判根因）。
    document.addEventListener('scroll', (e) => {
      const t = e.target;
      if (!t || t.nodeType !== 1 || !isConversationScroller(t)) return;
      let nearBottom = true;
      scrollContainers().forEach((el) => {
        if (el.scrollHeight - el.scrollTop - el.clientHeight >= 60) nearBottom = false;
      });
      window.__bwmAutoScrollPaused = !nearBottom;
    }, { capture: true, passive: true });
    // 事件驱动：body 上任何 DOM 变化（新消息/流式 token/换会话重建）后，双 rAF 等布局
    // 稳定再滚到底；滚动容器每次实时查询，React 重建后依然有效。
    const mo = new MutationObserver(() => {
      if (window.__bwmAutoScrollPaused) return;
      requestAnimationFrame(() => requestAnimationFrame(scrollToBottom));
    });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    scrollToBottom();
  })();

  // 窄屏自动折叠问题：iframe 620 < SIDEBAR_AUTO_COLLAPSE(1024) → DSH 原生把侧栏置为
  // collapsed（React 条件渲染，会话树 treeitem 根本不出现在 DOM，CSS 无法补救）。
  // 触发原生 toggle 点击（narrowExpanded=true）让侧栏渲染完整会话树；侧栏本体
  // 仍由 EMBEDDED_CSS 抽屉（transform）控制，不影响 centerCol。只调用原生功能，
  // 不拦截点击、不加覆盖层。
  let tries = 0;
  const expandSidebar = () => {
    const root = document.querySelector('[class*=sidebarCol] [class*=root]');
    if (!root) {
      if (++tries < 20) setTimeout(expandSidebar, 500);
      return;
    }
    if (String(root.className).includes('collapsed')) {
      const toggle = document.querySelector('[class*=sidebarCol] [class*=toggle]');
      if (toggle) toggle.click();
    }
  };
  expandSidebar();

  // 2026-09-02 fix：抽屉收起时对屏幕阅读器/自动化隐藏侧栏（视口外但仍在 a11y 树，
  // 读屏与自动化工具会读到大量不可见会话项）。打开（bwm-emb-open）时恢复。
  // 🔴 2026-09-02 回归修复：inert 会吞掉真实鼠标点击（程序化 .click() 不受影响，合成事件
  // 也绕过——首轮回归因此漏检）。pop 弹窗模式里侧栏就是全部 UI，一旦 inert 整个会话列表
  // 无法点击（用户实测 bug：点工作区后对话列表无法切换）→ pop 模式必须完全跳过。
  (function wireSidebarA11y() {
    if (isPop) return;
    const syncA11y = () => {
      const sbEl = document.querySelector('[class*=sidebarCol]');
      if (!sbEl) return;
      const open = sbEl.classList.contains('bwm-emb-open');
      if (open) {
        sbEl.removeAttribute('aria-hidden');
        sbEl.removeAttribute('inert');
      } else {
        sbEl.setAttribute('aria-hidden', 'true');
        sbEl.setAttribute('inert', '');
      }
    };
    syncA11y();
    new MutationObserver(syncA11y).observe(document.documentElement, { attributes: true, subtree: false, childList: false, attributeFilter: ['class'] });
    // 侧栏容器本身可能被 React 重建：类变化监听不到新节点时，退化为低频兜底
    setInterval(syncA11y, 3000);
  })();

  // 2026-09-02 fix：历史会话正文裸 DSML 控制标记兜底清洗。
  // 背景：早期会话落盘时，代理把模型 DSML 控制标记（<｜｜DSML｜｜invoke …> 等）当普通文本
  // 存储，渲染层原样显示为协议乱码（用户实测 bug）。DSH 原生渲染不做清洗（0 重画 0 清洗），
  // 这里在显示层做增量兜底：命中标记的文本节点替换为占位说明，完整原文放 title 可悬停查看。
  // 只改 text node 内容，不碰 DOM 结构（React 重渲染覆盖后 observer 会再清洗）。
  (function wireDsmlSanitizer() {
    if (window.__bwmDsmlWired) return;
    window.__bwmDsmlWired = true;
    const MARK = '｜｜DSML｜｜';
    const RE = /<\/?｜｜DSML｜｜[a-zA-Z_]+[^>]*>/g;
    const cleanText = (raw) => {
      if (!raw || raw.indexOf(MARK) === -1) return null;
      const parts = raw.split(RE);
      const marks = raw.match(RE) || [];
      let out = '';
      parts.forEach((p, i) => {
        out += p;
        if (marks[i]) out += '⟨历史工具调用 · 已折叠⟩';
      });
      return out;
    };
    const sanitizeIn = (rootEl) => {
      const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
      const hits = [];
      let n;
      while ((n = walker.nextNode())) {
        if (n.nodeValue && n.nodeValue.indexOf(MARK) !== -1 && n.parentNode && !n.parentNode.closest('#bwm-dsml-original')) hits.push(n);
      }
      hits.forEach((n) => {
        const original = n.nodeValue;
        const cleaned = cleanText(original);
        if (cleaned == null) return;
        n.nodeValue = cleaned;
        const p = n.parentNode;
        if (p) p.title = '含历史工具调用标记（已折叠）\n' + original.slice(0, 800);
      });
      return hits.length;
    };
    sanitizeIn(document.body);
    const mo = new MutationObserver((muts) => {
      let dirty = false;
      for (const m of muts) {
        if (m.type === 'characterData' && m.target && m.target.nodeValue && m.target.nodeValue.indexOf(MARK) !== -1) { dirty = true; break; }
        for (const node of m.addedNodes) {
          if (node.nodeType === 1 && sanitizeIn(node) > 0) { dirty = true; break; }
          if (node.nodeType === 3 && node.nodeValue && node.nodeValue.indexOf(MARK) !== -1) { dirty = true; break; }
        }
        if (dirty) break;
      }
      if (dirty) sanitizeIn(document.body);
    });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
  })();

  // P2-8 presence 联动：监听对话流活动（Think/工具调用）→ 通知父页数字人视频状态
  // Runtime v1.1：MutationObserver 事件驱动替代每秒轮询——只在 DOM 变化时判定（删 setInterval）
  if (!isPop) {
    let presenceCurrent = 'idle';
    const sendPresence = (state) => {
      if (state === presenceCurrent) return;
      presenceCurrent = state;
      if (window.parent !== window) window.parent.postMessage({ type: 'bwm-presence', state }, location.origin);
    };
    const judgePresence = () => {
      // 运行信号（原生）：composer 发送键在任务运行时变为 Stop（InputBar primaryStops）
      // ——比检测对话流 Think 块可靠：历史 Think 块会让空闲态误判 thinking（用户实测 bug）
      const primary = document.querySelector('.p7GS4W_primary');
      const running = primary && !primary.disabled && /stop|停止/i.test((primary.getAttribute('aria-label') || '') + (primary.textContent || ''));
      if (!running) {
        sendPresence('idle');
        return;
      }
      // 运行中：区分 thinking vs executing——只看最近 20 个 tool 节点（textContent 不触发 reflow）
      let executing = false;
      const nodes = document.querySelectorAll('[class*=tool]');
      for (let i = nodes.length - 1; i >= Math.max(0, nodes.length - 20); i--) {
        const t = String(nodes[i].textContent || '');
        if (t.length < 200 && /调用工具|tool\/call|Tool call|工具/.test(t)) { executing = true; break; }
      }
      sendPresence(executing ? 'executing' : 'thinking');
    };
    // 事件驱动：primary 按钮 aria-label/disabled 变化（Stop↔Send）+ 对话区新节点（工具行/回复）
    const mo = new MutationObserver(() => judgePresence());
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-label', 'disabled'] });
    judgePresence(); // 初始态
  }

  // （用量圆环定位暂时撤掉：JS transform 会在模型按钮上方叠覆盖层、拦截点击/把模型菜单弄坏。
  //  先保住原生功能（模型菜单/推理等级/点击），圆环位置作为后续单独的低风险优化再做。
  //  2026-08-24 更新：圆环位置已通过 CSS 修复（[class*=trailing] > span width auto +
  //  [data-slot="conversation.input.model"] min-width auto），原生 ContextMeter 位于模型按钮与发送键之间。）

  // P1.3：嵌入式模式同样执行 Shell 握手（Capability Layer）——暴露协商结果供降级 UI/调试
  try {
    const runtime = createRuntime();
    const welcome = runtime.hello({
      shellVersion: '0.3.0',
      dshVersion: 'embedded',
      capabilities: SHELL_CAPABILITIES,
      requires: SHELL_REQUIRES,
    });
    if (typeof window !== 'undefined') {
      window.__bwm = Object.assign(window.__bwm || {}, {
        runtime: { mode: welcome.mode, negotiation: welcome.negotiation, versions: runtime.versions },
      });
    }
  } catch (_) { /* 嵌入式握手失败不影响原生 DSH（no-op 原则） */ }

  return () => {};
}

/* ── 桌面壳判定（仅 dsh-app:// ）────────────────────────────────────
 * 桌面 App 渲染器加载自有特权 scheme dsh-app://app/，没有地址栏，/bwm-friend/* 不可达。
 * 因此根路径直接执行原设计的干活模式注入（见 apply），陪伴模式由同一悬浮按钮切成
 * 全屏 iframe。web 浏览器形态下本函数恒 false → 根路径严格 no-op（行为零变化）。
 */
function isDesktopShell() {
  try {
    return typeof location !== 'undefined' && location.protocol === 'dsh-app:';
  } catch (_) {
    return false;
  }
}

/* ── apply ──────────────────────────────────────────────────────────── */
function apply(ctx) {
  const path = (typeof location !== 'undefined' ? location.pathname : '/');
  const q = (typeof location !== 'undefined' ? location.search : '');
  // 嵌入式模式：/ 带 ?bwm=embedded（work 页 iframe 内）→ 原生 DSH 只显示 centerCol 会话视图，侧栏作右上角抽屉
  if (/[?&]bwm=embedded/.test(q)) {
    return applyEmbeddedHarness(ctx);
  }
  const isBwmPage = path === '/bwm-friend' || path.indexOf('/bwm-friend/') === 0;
  // web 浏览器形态：DSH 根 / 严格 no-op（原生界面一字不动），双模式走独立沉浸页 /bwm-friend/*
  // 桌面壳（dsh-app://）：无地址栏、/bwm-friend/* 不可达 → 在根路径执行**原设计的干活模式注入**
  //   （全屏数字人层 + 左幕布 + DSH 聊天左对齐 clamp(620px,58vw,940px) + 侧栏 ☰ 抽屉 + mint composer）；
  //   陪伴模式由同一悬浮按钮切成全屏 iframe（原设计 ensureCompanionFrame）。
  //   不新增任何原设计里没有的控件与布局（2026-11-10 裁定）。
  const desktopShell = isDesktopShell();
  if (!isBwmPage && !desktopShell) {
    return () => {};
  }
  const { layer, video } = ensureLayer();

  // Phase 0：Runtime 协议面（P1.1-1.4：Event Kernel/Context/Ledger/Presence 状态机全部在 runtime-core）
  // P1.4：Shell 只持有 bus（订阅）+ context（只读）+ hydrateContext（恢复）——不持有任何核心状态机
  // 2026-09-10 B2 反超第一步：wireLedger 落盘（persist→reload→Agent 可用）——
  //   timeline 仍归 'runtime' 快照策略不含；账本走独立 store（settings 通道，宿主侧持久），
  //   未来平移宿主 JSONL/SQL（P6 agent_actions）时只换本函数实现，core 不动。
  const runtime = createRuntime({ ledger: createLedgerStore() });
  const bus = runtime.bus;
  const context = runtime.context;
  const adapter = resolveAdapter();
  let dshVersion = 'unknown';
  try { dshVersion = (typeof window !== 'undefined' && window.__DSH_VERSION__) || 'embedded'; } catch (_) { /* noop */ }
  const welcome = runtime.hello({
    shellVersion: '0.3.0',
    dshVersion,
    capabilities: SHELL_CAPABILITIES,
    requires: SHELL_REQUIRES,
  });
  window.__bwm = { bus, context, adapter, registry: ADAPTER_REGISTRY, versions: runtime.versions, embeddedSelectors: EMBEDDED_SELECTORS, negotiation: welcome.negotiation, mode: welcome.mode, shell: { capabilities: SHELL_CAPABILITIES, requires: SHELL_REQUIRES } };
  // Ledger/Presence 状态机由 runtime 内部接线（wireLedger + createPresenceMachine）——Shell 不再调用

  // R1：强制横屏（竖屏提示层 + 横屏锁定）
  wireForceLandscape();

  // A 批（骨架对齐）：桌面壳顶部品牌栏——必须先于抽屉/切换按钮建好，两者都挂在它的动作区
  ensureTopbar();

  // R3：侧边栏 ☰ 抽屉（默认收起）
  wireSidebarDrawer(adapter);

  // B4/C2：输入框对齐 bwm composer（语音球|输入|发送；composer 晚渲染则重试）
  // ⚠️ 桌面壳**不启用**：发布版干活页的实际呈现里没有语音球（当时 iframe 跨文档，locateComposer
  // 根本没命中），而 DSH 原生输入区自带发送键 → 再插一枚会变成「两个发送键 + 语音球挤在
  // placeholder 前面」。1:1 对标发布版 = 桌面壳不注入这组控件（web 形态保持原样）。
  if (!desktopShell) {
    let ct = 0;
    const tryComposer = () => {
      if (ensureBwmComposer(adapter)) return;
      if (++ct < 20) setTimeout(tryComposer, 500);
    };
    tryComposer();
  }

  // M2：悬浮按钮 + ModeMachine（初始模式从配置恢复，应用布局）
  const toggleBtn = ensureToggleButton();
  const setMode = wireToggle(bus, context, adapter, toggleBtn);

  // 桌面壳：DSH 是异步渲染且频繁重渲染（会话切换/流式输出都会重挂节点），
  // 注入的定位与透明化会被冲掉 → 用 MutationObserver 做**幂等校正**（只重设样式，不新增控件）。
  // 多次定时全量 re-apply 覆盖首屏晚到的面板（侧栏/右侧预览列都是延迟挂载的）。
  if (desktopShell) {
    let relayoutTimer = null;
    const isWork = () => document.body.getAttribute('data-bwm-mode') === 'work';
    const correct = () => { if (isWork()) { try { adapter.setWorkLayout(); } catch (_) { /* noop */ } } };
    try {
      new MutationObserver(() => {
        clearTimeout(relayoutTimer);
        relayoutTimer = setTimeout(correct, 700);
      }).observe(document.body, { childList: true, subtree: true });
    } catch (_) { /* noop */ }
    for (const ms of [800, 2500, 6000]) {
      setTimeout(() => { if (isWork()) { try { adapter.setWorkLayout(); } catch (_) { /* noop */ } } }, ms);
    }
  }

  // 陪伴页顶部"切换到干活"按钮 → 通知父页切回干活模式
  window.addEventListener('message', (e) => {
    const d = (e && e.data) || {};
    if (desktopShell) {
      // 桌面壳：iframe 与父文档互为 opaque origin（origin 退化成 "null"），
      // 改按**来源窗口**校验（e.source === 陪伴 iframe），只认两个无害的关闭语义。
      const frame = document.getElementById('bwm-companion');
      if (!frame || e.source !== frame.contentWindow) return;
      if (d.type === 'bwm-desktop-close' || (d.type === 'bwm-switch-mode' && d.mode === 'work')) {
        setMode('work');
      }
      return;
    }
    if (!e || e.origin !== location.origin) return; // P0 安全：仅接受同源消息
    if (d.type === 'bwm-switch-mode' && d.mode === 'work') {
      setMode('work');
    }
  });

  // Context 持久化（Runtime v1.1：决策在 Runtime——persistSnapshot 只含 persist 域，
  // 运行态 presence/timeline 不落盘；1.5s 防抖避免任务中高频写盘）
  let persistTimer = null;
  const persistContext = () => {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      const snapshot = runtime.persistSnapshot();
      queueConfigWrite((cfg) => ({ ...cfg, context: snapshot })); // 2026-09-26：串行链防竞态（与 ledger append 互丢字段的根因）
    }, 1500);
  };
  context.watch(() => persistContext());

  // 恢复持久化 Context
  loadSettings().then((cfg) => {
    if (cfg.context) runtime.hydrateContext(cfg.context);
    bus.replay();
  });

  // Presence 视觉联动（P1.4：订阅渲染，状态机在 runtime）
  subscribePresenceRender(bus, layer);

  // VideoEngine 电源管理（可见性 + 电池感知；配置取启动快照避免异步竞态）
  let activeCfg = { power: {} };
  bindPowerManagement(video, () => activeCfg.power || {});
  loadSettings().then((cfg) => {
    activeCfg = cfg;
    applyTheme(video, cfg.avatar && cfg.avatar.theme);
  });

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      { name: 'settings.section', id: 'bwm-friend', order: 500, label: 'BWM Friend' },
      BwmSettingsSection,
    ),
  );

  // 桌面壳：分两次采样诊断（3s 看注入落地 / 9s 看视频与异步渲染后的稳定态）
  if (desktopShell) {
    setTimeout(() => postDesktopDiag('t3'), 3000);
    setTimeout(() => postDesktopDiag('t9'), 9000);
  }
}

exports.apply = apply;
exports.inject = inject;
return module.exports;
