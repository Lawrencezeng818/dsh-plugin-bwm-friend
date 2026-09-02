window.__ModuleLoader__.load({
	id: "dsh-plugin-bwm-friend",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var __bwmModules = {};
		__bwmModules['@laikaton/bwm-runtime-core'] = (function() {
			var module = { exports: {} };
			var exports = module.exports;
			/**
			 * @laikaton/bwm-runtime-core — Event Kernel + Runtime 协议面（P1.1）
			 *
			 * 边界（BWM-ARCHITECTURE-BOUNDARY.md）：
			 *   🔒 Runtime 核心：本包（Event Kernel 自此归 Runtime 所有）
			 *   ❌ 禁止：DOM / React / CSS / DSH UI 依赖（纯逻辑，Node + 浏览器通用）
			 *   ✅ 协议：Shell 经 createRuntime() 的协议面（hello/subscribe/emit）消费，不直接持有内部实现
			 *
			 * 本文件为 P1.1 单文件形态（event-bus + protocol face 同文件）；
			 * 后续引入真正 bundler 后拆分 src/event-bus.js / src/runtime.js / src/index.js。
			 */

			/* ── Event 版本登记（Additive-only；载荷演进 bump，订阅方按 version 兼容解析）── */
			// 与 docs/BWM-PROTOCOL-v1.md §2.1 一致（审计：协议枚举 ↔ 代码完全一致）
			const EVENT_VERSIONS = {
			  'agent.thinking.start': '1.0',
			  'agent.thinking.end': '1.0',
			  'agent.tool.call': '1.0',
			  'agent.tool.result': '1.0',
			  'agent.task.success': '1.0',
			  'agent.task.failed': '1.0',
			  'memory.updated': '1.0',
			  'emotion.changed': '1.0',
			  'presence:state': '1.0',
			  'presence:mode': '1.0',
			};

			/* ── Event Kernel（Agent Event Bus v1.1：Router + Policy + Subscriber + 事件 version）── */
			// 从 src/client.js 原样搬移（2026-08-24 P1.1）——自此 Event Kernel 归 Runtime，Shell 不再拥有
			function createEventBus() {
			  const listeners = new Map(); // channel → Set<{fn, when}>
			  const history = [];
			  const routes = []; // Router 规则：[eventPattern, route(payload, meta) → {channels, blocked}]
			  return {
			    // Router：事件按 meta（mode/presence/user/silent）裁决目标通道
			    route(pattern, router) {
			      routes.push({ pattern, router });
			      return () => {
			        const i = routes.findIndex((r) => r.pattern === pattern && r.router === router);
			        if (i >= 0) routes.splice(i, 1);
			      };
			    },
			    // Subscriber：可带 when 谓词（Policy Engine）
			    on(channel, fn, opts = {}) {
			      const when = opts.when || (() => true);
			      if (!listeners.has(channel)) listeners.set(channel, new Set());
			      const entry = { fn, when };
			      listeners.get(channel).add(entry);
			      for (const ev of history) if (ev.channel === channel && when(ev.payload, ev.meta)) fn(ev.payload);
			      return () => listeners.get(channel)?.delete(entry);
			    },
			    emit(channel, payload = {}, meta = {}) {
			      // Router 裁决：可阻止或改道
			      let target = channel;
			      let blocked = false;
			      for (const { pattern, router } of routes) {
			        if (pattern === channel || (pattern instanceof RegExp && pattern.test(channel))) {
			          const r = router(payload, meta);
			          if (r && r.blocked) blocked = true;
			          if (r && r.channel) target = r.channel;
			        }
			      }
			      const ev = { channel, target, version: EVENT_VERSIONS[channel] || '1.0', payload, meta, at: new Date().toISOString() };
			      history.push(ev);
			      if (history.length > 500) history.shift();
			      if (blocked) return ev;
			      for (const entry of listeners.get(target) || []) {
			        try {
			          if (entry.when(payload, meta)) entry.fn(payload, meta);
			        } catch (e) {
			          console.error(`[bwm] event ${target} handler failed`, e);
			        }
			      }
			      return ev;
			    },
			    replay() {
			      for (const ev of history) for (const entry of listeners.get(ev.target) || []) entry.fn(ev.payload, ev.meta);
			    },
			  };
			}

			/* ── Capability Layer（P1.3：能力协商——多宿主降级运行，接近 Agent Plugin ABI）──
			 * 能力结构 { name, version, level, constraints }（评审 R5：不只"有没有"，还要版本/等级/约束）
			 * 协议公开（capability 列表+协商格式）；决策私有（降级策略阈值在 Runtime 内部）
			 */
			const RUNTIME_CAPABILITIES = [
			  { name: 'presence-provide', version: '1.0', level: 'full', constraints: { presence: 9, modes: 3 } },
			  { name: 'context-govern',   version: '1.0', level: 'full', constraints: { domains: 8, writable: 'ownership-model' } },
			  { name: 'ledger-record',    version: '1.0', level: 'full', constraints: { entries: 'append-only', retention: 500 } },
			  { name: 'identity-hold',    version: '1.0', level: 'basic', constraints: { persona: 'mira' } },
			  { name: 'evolution-run',    version: '1.0', level: 'basic', constraints: { algorithm: 'proprietary' } },
			];

			// 语义化版本比较：a >= b → ≥0；a < b → <0（'1.0' === '1.0.0'）
			function compareVersion(a, b) {
			  const pa = String(a || '0').split('.').map(Number);
			  const pb = String(b || '0').split('.').map(Number);
			  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
			    const d = (pa[i] || 0) - (pb[i] || 0);
			    if (d !== 0) return d;
			  }
			  return 0;
			}

			// 能力协商（纯函数）：shell 需求 ∩ runtime 提供 → matched / degraded / missing + mode
			// 版本匹配：runtime.version >= shell.version → matched；否则 degraded（runtime 旧）
			// mode：无需求或全部匹配 = full；有任何 degraded/missing = lite（降级运行，UI 完整）
			function negotiate(requires = [], runtimeCaps = RUNTIME_CAPABILITIES) {
			  const norm = (caps) => caps.map((c) => (typeof c === 'string' ? { name: c, version: '1.0' } : c));
			  const shell = norm(requires);
			  const rt = new Map(norm(runtimeCaps).map((c) => [c.name, c]));
			  const matched = [];
			  const degraded = [];
			  const missing = [];
			  for (const sc of shell) {
			    const rc = rt.get(sc.name);
			    if (!rc) {
			      missing.push({ name: sc.name, shell: sc.version, reason: 'not-provided' });
			      continue;
			    }
			    if (compareVersion(rc.version, sc.version) >= 0) {
			      matched.push({
			        name: sc.name,
			        shell: sc.version,
			        runtime: rc.version,
			        level: rc.level || sc.level || 'basic',
			        constraints: rc.constraints || null,
			      });
			    } else {
			      degraded.push({ name: sc.name, shell: sc.version, runtime: rc.version, reason: 'version-mismatch' });
			    }
			  }
			  return {
			    matched,
			    degraded,
			    missing,
			    mode: degraded.length === 0 && missing.length === 0 ? 'full' : 'lite',
			  };
			}

			/* ── 持久化策略（Runtime v1.1：Runtime State ≠ Persistent State）──
			 * 第一条设计原则：高频运行态（presence/ledger/timeline/task）不落盘；
			 * 只有静态/配置/长期记忆（identity/personality/memory/preferences/conversation）持久化。
			 * 决策在 Runtime（persistSnapshot），Shell 只调用，不自行判断哪些域落盘。
			 */
			const DOMAIN_POLICY = Object.freeze({
			  identity: 'persist',      // 静态：我是谁
			  personality: 'persist',   // 配置：人格特征
			  memory: 'persist',        // 长期：用户记忆
			  preferences: 'persist',   // 配置：用户偏好
			  conversation: 'persist',  // 历史：会话数据（可选，暂落盘）
			  presence: 'runtime',      // 运行态：presence 状态（高频，不落盘）
			  timeline: 'runtime',      // 事件流：行为生命周期（可重放，不落盘）
			  tasks: 'runtime',         // 瞬态：任务状态
			  capability: 'runtime',    // 动态：能力协商结果
			});
			const PERSIST_DOMAINS = Object.entries(DOMAIN_POLICY)
			  .filter(([, p]) => p === 'persist')
			  .map(([d]) => d);

			/* ── Context Runtime（P1.2/P1.4：8 域共享上下文 + ownership 治理 + 版本迁移）──
			 * 从 src/client.js 原样搬移（2026-08-24 P1.4）——自此 Context 归 Runtime，Shell 只读/订阅。
			 * ownership 模型 v1（docs/BWM-CONTEXT-CONTRACT-v1.md）：
			 *   runtime 域（Shell 只读）：identity/personality/memory/preferences/timeline/presence/capability
			 *   shared 域（双方可写）：conversation/tasks（业务数据）
			 */
			const CONTEXT_SCHEMA_VERSION = '1.0';
			const CONTEXT_VERSIONS = { '0.9': '1.0' }; // 版本链（Additive-only；迁移在 CONTEXT_MIGRATIONS 登记）
			const CONTEXT_MIGRATIONS = {
			  // '0.9': (ctx) => { ... }  未来版本迁移在此登记
			};
			const CONTEXT_RUNTIME_DOMAINS = new Set(['identity', 'personality', 'memory', 'preferences', 'timeline', 'presence', 'capability']);
			const CONTEXT_ERRORS = Object.freeze({
			  INVALID_DOMAIN: 'CONTEXT_INVALID_DOMAIN',
			  PERMISSION_DENIED: 'CONTEXT_PERMISSION_DENIED',
			});

			function createAgentContext() {
			  const domains = {
			    identity: {},
			    personality: {},
			    memory: {},
			    conversation: {},
			    tasks: {},
			    preferences: {},
			    timeline: [],
			    presence: { state: 'idle' },
			    capability: { available: [], dynamic: true },
			  };
			  const watchers = new Set();
			  let schemaVersion = CONTEXT_SCHEMA_VERSION;
			  const migrate = (from) => {
			    // 沿版本链顺序执行迁移（当前无历史版本，链为空；框架就位）
			    let v = from;
			    while (v && v !== CONTEXT_SCHEMA_VERSION) {
			      const step = CONTEXT_MIGRATIONS[v];
			      if (!step) break; // 未知旧版本 → 保留原数据，标记
			      step(domains);
			      v = nextVersion(v);
			    }
			    schemaVersion = CONTEXT_SCHEMA_VERSION;
			  };
			  return {
			    schemaVersion() {
			      return schemaVersion;
			    },
			    get(domain) {
			      return domain === undefined ? { schemaVersion, ...domains } : domains[domain];
			    },
			    // Runtime 内部写入口（wireLedger/presenceMachine 等）
			    set(domain, value) {
			      if (!(domain in domains)) throw new Error(`${CONTEXT_ERRORS.INVALID_DOMAIN}: ${domain}`);
			      domains[domain] = value;
			      for (const fn of watchers) fn(domain, value);
			    },
			    patch(domain, partial) {
			      this.set(domain, { ...domains[domain], ...partial });
			    },
			    // Shell 写入口（ownership 校验：runtime 域只读）
			    shellSet(domain, value) {
			      if (!(domain in domains)) throw new Error(`${CONTEXT_ERRORS.INVALID_DOMAIN}: ${domain}`);
			      if (CONTEXT_RUNTIME_DOMAINS.has(domain)) throw new Error(`${CONTEXT_ERRORS.PERMISSION_DENIED}: ${domain} is runtime-owned`);
			      domains[domain] = value;
			      for (const fn of watchers) fn(domain, value);
			    },
			    watch(fn) {
			      watchers.add(fn);
			      return () => watchers.delete(fn);
			    },
			    toJSON() {
			      return { schemaVersion, ...JSON.parse(JSON.stringify(domains)) };
			    },
			    hydrate(raw) {
			      if (raw && typeof raw === 'object') {
			        if (raw.schemaVersion && raw.schemaVersion !== CONTEXT_SCHEMA_VERSION) {
			          migrate(raw.schemaVersion); // 旧版本 → 迁移链
			        }
			        for (const k of Object.keys(domains)) {
			          if (raw[k] !== undefined) domains[k] = raw[k];
			        }
			      }
			    },
			  };
			}

			// 版本链推进（当前仅 1.0，框架为未来版本就位）
			function nextVersion(v) {
			  return CONTEXT_VERSIONS[v] || CONTEXT_SCHEMA_VERSION;
			}

			/* ── Ledger Runtime（P1.4：Event→Context→Ledger，Agent 行为生命周期）──
			 * Agent 经历（timeline）与任务状态（tasks）由事件驱动更新；timeline 即 P6 读模型
			 */
			function wireLedger(bus, context) {
			  const record = (actionType, detail) => {
			    const timeline = Array.isArray(context.get('timeline')) ? context.get('timeline') : [];
			    timeline.push({ action_type: actionType, outcome: detail.outcome || 'success', summary: detail.summary || '', at: new Date().toISOString() });
			    context.set('timeline', timeline.slice(-200)); // 上限 200 条
			  };
			  const off = [
			    bus.on('agent.task.success', (p) => { context.set('tasks', { last: 'success', taskId: p && p.taskId, at: new Date().toISOString() }); record('agent_task', { outcome: 'success', summary: p && p.summary }); }),
			    bus.on('agent.task.failed', (p) => { context.set('tasks', { last: 'failed', taskId: p && p.taskId, at: new Date().toISOString() }); record('agent_task', { outcome: 'failed', summary: p && p.summary }); }),
			    bus.on('agent.tool.call', (p) => record('tool_execution', { outcome: 'started', summary: p && p.tool })),
			  ];
			  return () => off.forEach((d) => d());
			}

			/* ── Presence 状态机（P1.4：事件 → presence 状态，纯逻辑无 DOM）──
			 * Shell 渲染层订阅 bus 'presence:state'（或 context.watch('presence')）应用视觉
			 */
			function createPresenceMachine(bus, context) {
			  const applyState = (state, transient) => {
			    context.set('presence', { ...context.get('presence'), state, at: new Date().toISOString() });
			    bus.emit('presence:state', { state });
			    if (transient > 0) {
			      setTimeout(() => {
			        if ((context.get('presence') || {}).state === state) applyState('idle', 0);
			      }, transient);
			    }
			  };
			  const setPresence = (state, { transient = 0 } = {}) => {
			    if ((context.get('presence') || {}).state === state) return; // 幂等
			    applyState(state, transient);
			  };
			  const off = [
			    bus.on('agent.thinking.start', () => setPresence('thinking')),
			    bus.on('agent.thinking.end', () => setPresence('idle')),
			    bus.on('agent.tool.call', () => setPresence('executing')),
			    bus.on('agent.tool.result', () => setPresence('thinking')),
			    bus.on('agent.task.success', () => setPresence('success', { transient: 1400 })),
			    bus.on('agent.task.failed', () => setPresence('error', { transient: 2000 })),
			  ];
			  applyState('idle', 0); // 初始态
			  return () => off.forEach((d) => d());
			}

			/* ── 协议值域（BWM Protocol v1 §3：state.json 值域冻结，P1.4 迁入核心）──
			 * 与 docs/BWM-PROTOCOL-v1.md §3.2/§3.3 对齐；Shell 经 validMode/validPresence 消费
			 */
			const MODES = new Set(['companion', 'work', 'meeting']); // 视图（决定布局）
			const PRESENCE_STATES = new Set(['idle', 'attention', 'thinking', 'executing', 'speaking', 'success', 'error', 'offline', 'transition']);
			function validMode(m) {
			  return MODES.has(m) ? m : 'work';
			}
			function validPresence(s) {
			  return PRESENCE_STATES.has(s) ? s : 'idle';
			}

			/* ── Identity Runtime 雏形（P2-Persona：人格≠上下文，identity=我是谁）──
			 * 与 RUNTIME_CAPABILITIES['identity-hold'] 对应；单一来源（host 经 require 引用，client 经 context 域读）
			 * 决策私有：人格演进/关系规则为闭源核心（Evolution Runtime 未来在此扩展）
			 */
			const IDENTITY_PRESET = {
			  name: 'Mira',
			  tagline: 'be water my friend',
			  role: '用户的 AI 陪伴伙伴',
			  coreValues: ['温柔陪伴', '真诚倾听', '轻松自然'],
			  style: {
			    tone: '温柔、亲切',
			    length: '简短自然（通常 1-3 句，不啰嗦）',
			    language: '中文',
			    emoji: '适度',
			  },
			  relationship: {
			    formality: '老朋友式聊天',
			    boundaries: '不评判、不越界，先倾听再回应',
			  },
			};

			const PERSONALITY_PRESET = {
			  archetype: '温暖陪伴型',
			  traits: ['共情', '耐心', '乐观'],
			  communication: '口语化、有温度、不机械',
			  memoryStyle: '记得用户说过的重要事情（偏好/人物/经历）',
			};

			/* ── Request 状态机（Runtime v1.1：conversation.requestState）──
			 * Shell 发送请求 → thinking →（replying）→ idle；防重复提交/多端统一。
			 * 状态机在 Runtime（协议层）；Shell 只发事件 + 读状态渲染。
			 */
			const REQUEST_STATES = ['idle', 'thinking', 'replying'];
			function createRequestMachine(bus, context) {
			  const current = () => ((context.get('conversation') || {}).requestState) || { state: 'idle', requestId: null, startedAt: null };
			  const apply = (state, patch = {}) => {
			    context.set('conversation', {
			      ...(context.get('conversation') || {}),
			      requestState: { ...current(), ...patch, state },
			    });
			  };
			  const off = [
			    bus.on('conversation.request.start', (p) => {
			      if (current().state !== 'idle') return; // 已有请求进行中 → 拒绝重复
			      apply('thinking', { requestId: (p && p.requestId) || null, startedAt: new Date().toISOString() });
			    }),
			    bus.on('conversation.request.reply', () => apply('replying')),
			    bus.on('conversation.request.cancel', () => apply('idle', { requestId: null, startedAt: null, cancelled: true })),
			    bus.on('conversation.request.end', () => apply('idle', { requestId: null, startedAt: null })),
			  ];
			  return () => off.forEach((d) => d());
			}

			/* ── Runtime 协议面（BWM Protocol v1：hello/welcome + subscribe/emit）── */
			function createRuntime() {
			  const bus = createEventBus();
			  const context = createAgentContext();
			  context.set('identity', { ...IDENTITY_PRESET });           // Identity Runtime：我是谁
			  context.set('personality', { ...PERSONALITY_PRESET });     // 人格特征
			  wireLedger(bus, context);           // Ledger Runtime（事件 → timeline/tasks）
			  createPresenceMachine(bus, context); // Presence 状态机（事件 → presence 状态）
			  createRequestMachine(bus, context);  // Request 状态机（conversation.requestState 防重复）
			  let handshake = null;
			  return {
			    protocol: 'bwm',
			    version: '1.0',
			    bus,       // 事件总线（Shell 订阅渲染）
			    context,   // 共享上下文（Shell 只读 runtime 域；shellSet 写 shared 域）
			    hydrateContext(raw) { context.hydrate(raw); }, // 快照恢复（runtime 内部，绕过 ownership）
			    // Runtime v1.1：持久化快照（只含 persist 域——运行态不落盘，决策在 Runtime）
			    persistSnapshot() {
			      const all = context.toJSON();
			      const snap = { schemaVersion: all.schemaVersion };
			      for (const d of PERSIST_DOMAINS) if (all[d] !== undefined) snap[d] = all[d];
			      return snap;
			    },
			    // Shell → Runtime 握手（格式公开，策略私有——协商结果由 negotiate 计算）
			    // capabilities：shell 自身提供的能力（信息性，供 runtime 了解宿主）；requires：shell 需要 runtime 提供的核心能力（决定 full/lite）
			    hello({ shellVersion = '0.0.0', dshVersion = 'unknown', capabilities = [], requires = [] } = {}) {
			      const negotiation = negotiate(requires, RUNTIME_CAPABILITIES);
			      handshake = { shellVersion, dshVersion, capabilities, requires, negotiation, at: new Date().toISOString() };
			      return {
			        protocol: 'bwm',
			        version: '1.0',
			        runtimeVersion: '0.1.0',
			        mode: negotiation.mode, // full：需求全部满足；lite：部分缺失/降级（UI 完整，降级体验）
			        presence: ['idle', 'attention', 'thinking', 'executing', 'speaking', 'success', 'error', 'offline', 'transition'],
			        capabilities: RUNTIME_CAPABILITIES.map((c) => c.name),
			        negotiation, // { matched, degraded, missing, mode } —— Shell 按此降级对应 UI
			      };
			    },
			    // Shell 订阅（协议事件）
			    subscribe(channel, fn, opts) {
			      return bus.on(channel, fn, opts);
			    },
			    // Runtime 发布（协议事件）
			    emit(channel, payload, meta) {
			      return bus.emit(channel, payload, meta);
			    },
			    versions: EVENT_VERSIONS,
			  };
			}

			module.exports = {
			  createEventBus,
			  createRuntime,
			  createAgentContext,
			  createPresenceMachine,
			  createRequestMachine,
			  wireLedger,
			  EVENT_VERSIONS,
			  CONTEXT_VERSIONS,
			  CONTEXT_ERRORS,
			  DOMAIN_POLICY,
			  PERSIST_DOMAINS,
			  REQUEST_STATES,
			  validMode,
			  validPresence,
			  MODES,
			  PRESENCE_STATES,
			  IDENTITY_PRESET,
			  PERSONALITY_PRESET,
			  negotiate,
			  compareVersion,
			  RUNTIME_CAPABILITIES,
			};

			return module.exports;
		})();
		var __bwmRequire = function(name) { return __bwmModules[name] || require(name); };
		const React = require('react');
		// P1.1：Event Kernel 已迁入 @laikaton/bwm-runtime-core（闭源核心，独立包）
		// Shell 经 createRuntime() 协议面消费；require 由 build-client.mjs 内联注入解析
		const { createRuntime } = __bwmRequire('@laikaton/bwm-runtime-core');

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
		 * 经 __bwmRequire('@laikaton/bwm-runtime-core') 的 createRuntime() 协议面消费。
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

		function ensureLayer() {
		  if (document.getElementById('bwm-layer')) return { layer: document.getElementById('bwm-layer'), video: document.getElementById('bwm-avatar-video') };
		  const style = document.createElement('style');
		  style.textContent = PRESENCE_CSS;
		  document.head.appendChild(style);
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
		  document.body.setAttribute('data-bwm-mode', 'work');
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
		  const off = bus.on('presence:state', (p) => { if (p && p.state) applyClass(p.state); });
		  applyClass('idle'); // 初始态
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
		const ADAPTER_REGISTRY = [
		  {
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
		  },
		  // 未来 dsh-v2.ts：DSH 升级后新增条目，不修改 v1
		];

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
		const { validMode, validPresence } = __bwmRequire('@laikaton/bwm-runtime-core');

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
		  const toggleBtn = document.createElement('button');
		  toggleBtn.id = 'bwm-sidebar-toggle';
		  toggleBtn.setAttribute('aria-label', '展开/收起侧边栏');
		  toggleBtn.textContent = '☰';
		  document.body.appendChild(toggleBtn);
		  const scrim = document.createElement('div');
		  scrim.id = 'bwm-sidebar-scrim';
		  document.body.appendChild(scrim);
		  const setOpen = (v) => {
		    open = v;
		    adapter.setSidebarCollapsed(!v);
		    scrim.classList.toggle('on', v);
		    toggleBtn.textContent = v ? '✕' : '☰';
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
		  frame.style.cssText = [
		    'position: fixed; inset: 0; z-index: 20; border: 0; display: none;',
		    'background: #090e18; pointer-events: auto;',
		  ].join('');
		  document.body.appendChild(frame);
		  return frame;
		}

		function ensureToggleButton() {  if (document.getElementById('bwm-toggle')) return document.getElementById('bwm-toggle');
		  const btn = document.createElement('button');
		  btn.id = 'bwm-toggle';
		  btn.type = 'button';
		  btn.style.cssText = [
		    'position: fixed; right: 20px; bottom: 20px; z-index: 100;',
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
		  const render = () => { btn.textContent = MODE_LABELS[mode] || mode; };
		  const applyMode = (m, opts = {}) => {
		    mode = validMode(m);
		    bus.emit('presence:mode', { mode }); // Protocol 2：mode 走 presence:mode 通道，不占 context 域
		    document.body.setAttribute('data-bwm-mode', mode);
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
		      loadSettings().then((cfg) => saveSettings({ ...cfg, mode }));
		    }
		    render();
		  };
		  loadSettings().then((cfg) => applyMode(cfg.mode || 'work', { persist: false }));
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
		  let dragging = false, moved = 0, sx = 0, sy = 0;
		  btn.addEventListener('pointerdown', (e) => { dragging = true; moved = 0; sx = e.clientX; sy = e.clientY; btn.setPointerCapture(e.pointerId); });
		  btn.addEventListener('pointermove', (e) => {
		    if (!dragging) return;
		    const dx = e.clientX - sx, dy = e.clientY - sy;
		    moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
		    if (moved > 2) btn.style.transform = `translate(${dx}px, ${dy}px)`;
		  });
		  btn.addEventListener('pointerup', () => {
		    dragging = false;
		    if (moved > 5) {
		      suppressClick = true;
		      btn.style.right = BTN_BASE_POS.right + 'px';
		      btn.style.bottom = BTN_BASE_POS.bottom + 'px';
		    }
		    btn.style.transform = '';
		  });
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
		    saveSettings(next);
		    applyTheme(document.getElementById('bwm-avatar-video'), theme);
		  };
		  const toggleMode = () => {
		    const next = { ...cfg, mode: validMode(cfg.mode === 'work' ? 'companion' : 'work') };
		    setCfg(next);
		    saveSettings(next);
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
		/* 清掉 composer 区域（卡片外的容器/阴影）任何暗底与阴影（只影响外观） */
		[class*=composerSeat], [class*=composerStack], [class*=heroWorkspaceRow], [class*=centerCol] > div, [class*=scrollBody], [class*=root] { box-shadow: none !important; background: transparent !important; child-shadow: none !important; }
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
		    // 目标会话可能折叠在未展开的文件夹里 → 先沿 folders 链逐层展开（等 React 渲染）再点；
		    // 目标已可见则直接点（快速路径）。
		    if (e.data && e.data.type === 'bwm-switch-session' && !isPop) {
		      const title = e.data.title;
		      const folders = Array.isArray(e.data.folders) ? e.data.folders : [];
		      const findTarget = () => [...document.querySelectorAll('[role=treeitem]')]
		        .find((t) => String(t.innerText || '').split('\n')[0] === title);
		      const target = findTarget();
		      if (target) {
		        target.click();
		      } else if (folders.length) {
		        const chain = folders.slice();
		        const expandNext = () => {
		          const name = chain.shift();
		          if (!name) { const t2 = findTarget(); if (t2) t2.click(); return; }
		          const f = [...document.querySelectorAll('[role="treeitem"]')]
		            .find((t) => String(t.innerText || '').split('\n')[0] === name);
		          if (f && f.getAttribute('aria-expanded') === 'false') f.click(); // 展开该层
		          setTimeout(expandNext, 400); // 等 React 渲染子项
		        };
		        expandNext();
		      }
		    }
		    // 2026-09-02 fix：主 iframe 收「新会话」→ 点击本 iframe 原生「新会话」按钮
		    // （走原生新建+切换流程，与原生 DSH 行为一致；不直接调 API 避免绕过 UI 状态）
		    if (e.data && e.data.type === 'bwm-new-session' && !isPop) {
		      const btn = [...document.querySelectorAll('button')]
		        .find((b) => (b.textContent || '').trim() === '新会话' || (b.getAttribute('aria-label') || '') === '新建会话');
		      if (btn) btn.click();
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
		    const SCROLLERS = '[class*=scrollBody], [class*=viewArea], [class*=centerCol] > [class*=root], [class*=scroll], [class*=list]';
		    const scrollContainers = () => {
		      const set = new Set();
		      document.querySelectorAll(SCROLLERS).forEach((el) => set.add(el));
		      return [...set];
		    };
		    const scrollToBottom = () => {
		      scrollContainers().forEach((el) => { el.scrollTop = el.scrollHeight; });
		    };
		    // 用户主动上翻（离开底部）→ 暂停自动滚（避免抢滚动）；回到底部 → 恢复。
		    // 捕获阶段监听：scroll 事件不冒泡，但会经捕获阶段到达 document，覆盖任意实际滚动容器。
		    document.addEventListener('scroll', () => {
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

		/* ── apply ──────────────────────────────────────────────────────────── */
		function apply(ctx) {
		  const path = (typeof location !== 'undefined' ? location.pathname : '/');
		  const q = (typeof location !== 'undefined' ? location.search : '');
		  // 嵌入式模式：/ 带 ?bwm=embedded（work 页 iframe 内）→ 原生 DSH 只显示 centerCol 会话视图，侧栏作右上角抽屉
		  if (/[?&]bwm=embedded/.test(q)) {
		    return applyEmbeddedHarness(ctx);
		  }
		  const isBwmPage = path === '/bwm-friend' || path.indexOf('/bwm-friend/') === 0;
		  // 方案②：DSH harness 根 / 保持原生界面完全不动；数字人双模式走独立沉浸式页 /bwm-friend/*
		  if (!isBwmPage) {
		    return () => {};
		  }
		  const { layer, video } = ensureLayer();

		  // Phase 0：Runtime 协议面（P1.1-1.4：Event Kernel/Context/Ledger/Presence 状态机全部在 runtime-core）
		  // P1.4：Shell 只持有 bus（订阅）+ context（只读）+ hydrateContext（恢复）——不持有任何核心状态机
		  const runtime = createRuntime();
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

		  // R3：侧边栏 ☰ 抽屉（默认收起）
		  wireSidebarDrawer(adapter);

		  // B4/C2：输入框对齐 bwm composer（语音球|输入|发送；composer 晚渲染则重试）
		  let ct = 0;
		  const tryComposer = () => {
		    if (ensureBwmComposer(adapter)) return;
		    if (++ct < 20) setTimeout(tryComposer, 500);
		  };
		  tryComposer();

		  // M2：悬浮按钮 + ModeMachine（初始模式从配置恢复，应用布局）
		  const toggleBtn = ensureToggleButton();
		  const setMode = wireToggle(bus, context, adapter, toggleBtn);

		  // 陪伴页顶部"切换到干活"按钮 → 通知父页切回干活模式
		  window.addEventListener('message', (e) => {
		    if (!e || e.origin !== location.origin) return; // P0 安全：仅接受同源消息
		    if (e.data && e.data.type === 'bwm-switch-mode' && e.data.mode === 'work') {
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
		      loadSettings().then((cfg) => saveSettings({ ...cfg, context: snapshot }));
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
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
