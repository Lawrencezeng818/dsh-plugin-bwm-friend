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

/* ── 感知路由器（专利5 交底书 v0.3 §四 实现；跨域路由与一致性编排，纯逻辑）── */
const {
  createPerceptionRouter,
  DOMAIN_CLASS,
  UPDATE_MODES,
  PERCEPTION_ERRORS,
} = require('./perception-router.js');

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

/* ── 关系域策略（专利1 说明书 [0041]/[0071]）──
 * [0041] 关系域至少包括「关系状态」字段与「亲密度」字段；由交互行为事件驱动更新，结果各视图共享。
 * [0071] 交互行为产生行为事件 → 事件写入时间线域 → 触发关系域更新 → 经订阅通知广播至各视图。
 * 阈值表把亲密度映射为关系状态阶段；决策私有（阈值/增益不外泄为协议面）。
 */
const RELATIONSHIP_STAGES = Object.freeze(['new', 'acquaintance', 'familiar', 'close', 'bonded']);
const RELATIONSHIP_POLICY = Object.freeze({
  stage: 'new',       // 初始关系状态（当前阶段）
  intimacy: 0,        // 初始亲密度（当前程度）
  max: 100,
  thresholds: Object.freeze([0, 10, 30, 60, 90]), // 升序；与 RELATIONSHIP_STAGES 等长
});

/* ── 上下文域清单：单一来源（消除计数漂移）──
 * 历史缺陷：context-govern 能力约束里写死 `domains: 8`，而 2026-08-24 引入 capability 域后
 * 实际域数已为 9；说明书侧也曾出现"包括八个域"却紧接着列举九项。计数分散在多处 = 必然漂移。
 * 现由本清单唯一推导：createAgentContext 初值、context-govern 的 domains 计数、测试断言均引用
 * CONTEXT_DOMAINS。新增域只需在本表加一行。
 * 与专利1 说明书 [0039]–[0047] 的九个域一一同名；capability 为实现内部域
 * （权利要求用"至少包括"表述，不构成支持性缺陷）。
 */
const CONTEXT_DOMAIN_INIT = Object.freeze({
  identity: {},
  personality: {},
  relationship: { stage: RELATIONSHIP_POLICY.stage, intimacy: RELATIONSHIP_POLICY.intimacy, updatedAt: null, lastReason: null },
  memory: {},
  conversation: {},
  tasks: {},
  preferences: {},
  timeline: [],
  presence: { state: 'idle' },
  capability: { available: [], dynamic: true },
});
const CONTEXT_DOMAINS = Object.freeze(Object.keys(CONTEXT_DOMAIN_INIT));

/* ── Capability Layer（P1.3：能力协商——多宿主降级运行，接近 Agent Plugin ABI）──
 * 能力结构 { name, version, level, constraints }（评审 R5：不只"有没有"，还要版本/等级/约束）
 * 协议公开（capability 列表+协商格式）；决策私有（降级策略阈值在 Runtime 内部）
 */
const RUNTIME_CAPABILITIES = [
  { name: 'presence-provide', version: '1.0', level: 'full', constraints: { presence: 9, modes: 3 } },
  { name: 'context-govern',   version: '1.0', level: 'full', constraints: { domains: CONTEXT_DOMAINS.length, writable: 'ownership-model' } },
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
  relationship: 'persist',  // 长期：关系状态与亲密度（跨重启必须保持；非高频运行态）
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

/* ── Context Runtime（P1.2/P1.4：共享上下文 + ownership 治理 + 版本迁移）──
 * 从 src/client.js 原样搬移（2026-08-24 P1.4）——自此 Context 归 Runtime，Shell 只读/订阅。
 * 域数与域清单以 CONTEXT_DOMAINS 为唯一来源（不在此处硬写计数）。
 * ownership 模型 v1（docs/BWM-CONTEXT-CONTRACT-v1.md）：
 *   runtime 域（Shell 只读）：identity/personality/relationship/memory/preferences/timeline/presence/capability
 *     ——relationship 归 runtime：权1 要求各视图「读取到同一智能体状态」，
 *       关系状态由行为事件驱动（说明书 [0071]）而非视图直写，故 Shell 无写权。
 *   shared 域（双方可写）：conversation/tasks（业务数据）
 */
const CONTEXT_SCHEMA_VERSION = '1.0';
const CONTEXT_VERSIONS = { '0.9': '1.0' }; // 版本链（Additive-only；迁移在 CONTEXT_MIGRATIONS 登记）
const CONTEXT_MIGRATIONS = {
  // '0.9': (ctx) => { ... }  未来版本迁移在此登记
};
const CONTEXT_RUNTIME_DOMAINS = new Set(['identity', 'personality', 'relationship', 'memory', 'preferences', 'timeline', 'presence', 'capability']);
const CONTEXT_ERRORS = Object.freeze({
  INVALID_DOMAIN: 'CONTEXT_INVALID_DOMAIN',
  PERMISSION_DENIED: 'CONTEXT_PERMISSION_DENIED',
});

function createAgentContext() {
  // 初值由 CONTEXT_DOMAIN_INIT 单一推导（深拷贝：避免多实例共享嵌套引用）
  const domains = {};
  for (const name of CONTEXT_DOMAINS) domains[name] = JSON.parse(JSON.stringify(CONTEXT_DOMAIN_INIT[name]));
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
 * 2026-09-10 B2 反超第一步（专利4 实施例链：Action→Event→Outcome→Ledger→persist→reload→Agent 可用）：
 *   可选 opts.store = { append(entry), load(): Promise<entry[]> } —— 逐事件写透 + 启动恢复；
 *   store 由 Shell 提供（JSON-in-settings / 未来宿主侧 JSONL/SQL P6），core 保持纯逻辑无 I/O。
 *   append 失败不阻断事件管线：emit 'ledger:persist.error'；load 失败静默（运行态照常）。
 *   timeline 仍归 DOMAIN_POLICY 'runtime'（快照不含）——账本走独立 store，不混入快照通道。
 */
function wireLedger(bus, context, opts = {}) {
  const store = opts.store || null;
  const record = (actionType, detail) => {
    const d = detail || {};
    const entry = { action_type: actionType, outcome: d.outcome || 'success', summary: d.summary || '', at: new Date().toISOString() };
    // 透传未来语义字段（relationship_delta/emotion_context 等，专利4）——JSON 安全过滤
    for (const k of Object.keys(d)) {
      if (!(k in entry) && d[k] !== undefined && typeof d[k] !== 'function') entry[k] = d[k];
    }
    const timeline = Array.isArray(context.get('timeline')) ? context.get('timeline') : [];
    timeline.push(entry);
    context.set('timeline', timeline.slice(-200)); // 上限 200 条
    if (store && typeof store.append === 'function') {
      try { store.append(entry); } catch (err) {
        try { bus.emit('ledger:persist.error', { error: String((err && err.message) || err), entry }); } catch (_) { /* 通知失败不再抛 */ }
      }
    }
  };
  // 启动恢复：持久层是事实源，旧账本在前、本会话新事件在后，合并后仍守 200 上限
  if (store && typeof store.load === 'function') {
    Promise.resolve()
      .then(() => store.load())
      .then((prev) => {
        if (Array.isArray(prev) && prev.length) {
          const cur = Array.isArray(context.get('timeline')) ? context.get('timeline') : [];
          context.set('timeline', prev.slice(-200).concat(cur).slice(-200));
        }
      })
      .catch(() => { /* 恢复失败不阻断 runtime（降级为内存级，与旧行为一致） */ });
  }
  const off = [
    // 透传完整 payload（outcome/summary 定名，其余字段如 relationship_delta/emotion_context 原样进账本）
    bus.on('agent.task.success', (p) => { context.set('tasks', { last: 'success', taskId: p && p.taskId, at: new Date().toISOString() }); record('agent_task', { ...(p || {}), outcome: 'success', summary: p && p.summary }); }),
    bus.on('agent.task.failed', (p) => { context.set('tasks', { last: 'failed', taskId: p && p.taskId, at: new Date().toISOString() }); record('agent_task', { ...(p || {}), outcome: 'failed', summary: p && p.summary }); }),
    bus.on('agent.tool.call', (p) => record('tool_execution', { ...(p || {}), outcome: 'started', summary: p && p.tool })),
  ];
  return () => off.forEach((d) => d());
}

/* ── Relationship Runtime（专利1 [0041]/[0071]：关系域由行为事件驱动更新）──
 * 链路（[0071] 逐字对应）：
 *   交互行为 → 行为事件（agent.task.success 等）→ 事件写入时间线域（wireLedger）
 *            → 触发关系域更新（本函数）→ 经订阅通知机制广播至已订阅的各视图
 * 写权归属 Runtime：CONTEXT_RUNTIME_DOMAINS 含 relationship，视图 shellSet 被拒——
 *   与权1「各视图读取到同一智能体状态」一致（视图是消费者，不是关系状态的写入者）。
 * 合并写而非整体替换：F2 教训——wireLedger 曾以整体替换写 tasks，抹掉既有字段；
 *   关系域字段可扩展（[0048]），必须保留既有字段。
 * 载荷兼容（专利4 关系语义前向兼容）：relationship_delta 可为数字，或 { delta | intimacy | stage }。
 */
const RELATIONSHIP_SIGNALS = Object.freeze({
  'agent.task.success': { gain: 1, reason: 'task_success' },
  'memory.updated':     { gain: 1, reason: 'memory_persisted' },
  'agent.task.failed':  { gain: 0, reason: 'task_failed' }, // 失败不减：不做负反馈惩罚
});

function relationshipStageOf(intimacy, thresholds = RELATIONSHIP_POLICY.thresholds) {
  let stage = RELATIONSHIP_STAGES[0];
  for (let i = 0; i < thresholds.length; i++) if (intimacy >= thresholds[i]) stage = RELATIONSHIP_STAGES[i];
  return stage;
}

// 解析载荷声明的增量 → { delta, stage }（非法/缺失一律回落到信号默认增益，不抛错）
function resolveRelationshipDelta(raw, fallbackGain, prev) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return { delta: raw, stage: null };
  if (raw && typeof raw === 'object') {
    let delta = Number.isFinite(raw.delta) ? raw.delta : fallbackGain;
    if (!Number.isFinite(raw.delta) && Number.isFinite(raw.intimacy)) {
      const base = Number.isFinite(prev.intimacy) ? prev.intimacy : RELATIONSHIP_POLICY.intimacy;
      delta = raw.intimacy - base; // 显式目标值 → 差值
    }
    const stage = typeof raw.stage === 'string' && RELATIONSHIP_STAGES.includes(raw.stage) ? raw.stage : null;
    return { delta, stage };
  }
  return { delta: fallbackGain, stage: null };
}

function applyRelationshipSignal(context, { delta = 0, reason = null, stage = null, at = null } = {}) {
  const prev = { ...(context.get('relationship') || {}) };
  const base = Number.isFinite(prev.intimacy) ? prev.intimacy : RELATIONSHIP_POLICY.intimacy;
  const stepped = Math.max(0, Math.min(RELATIONSHIP_POLICY.max, base + (Number(delta) || 0)));
  const nextStage = stage || relationshipStageOf(stepped);
  context.set('relationship', {
    ...prev,                                   // 保留既有/扩展字段
    stage: nextStage,
    intimacy: stepped,
    updatedAt: at || new Date().toISOString(),
    lastReason: reason || prev.lastReason || null,
  });
  return context.get('relationship');
}

function wireRelationship(bus, context) {
  const off = Object.entries(RELATIONSHIP_SIGNALS).map(([channel, sig]) =>
    bus.on(channel, (payload) => {
      const prev = { ...(context.get('relationship') || {}) };
      const { delta, stage } = resolveRelationshipDelta(payload && payload.relationship_delta, sig.gain, prev);
      const next = applyRelationshipSignal(context, { delta, reason: sig.reason, stage });
      const changed = prev.stage !== next.stage || prev.intimacy !== next.intimacy;
      // [0071] 更新结果经订阅通知机制广播 → 各视图据此对齐，避免出现不同视图显示不同关系状态
      bus.emit('relationship:changed', {
        stage: next.stage, intimacy: next.intimacy, reason: next.lastReason, changed,
        prevStage: prev.stage, prevIntimacy: prev.intimacy,
      });
    })
  );
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
function createRuntime(opts = {}) {
  const bus = createEventBus();
  const context = createAgentContext();
  context.set('identity', { ...IDENTITY_PRESET });           // Identity Runtime：我是谁
  context.set('personality', { ...PERSONALITY_PRESET });     // 人格特征
  // opts.ledger = 账本 store（Shell 提供）：事件逐条落盘 + 启动恢复（B2/专利4 实施例）
  wireLedger(bus, context, opts.ledger ? { store: opts.ledger } : {});   // Ledger Runtime（事件 → timeline/tasks）
  wireRelationship(bus, context);      // Relationship Runtime（行为事件 → 关系状态/亲密度；专利1 [0071]）
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
  wireRelationship,
  RELATIONSHIP_STAGES,
  RELATIONSHIP_POLICY,
  RELATIONSHIP_SIGNALS,
  relationshipStageOf,
  applyRelationshipSignal,
  EVENT_VERSIONS,
  CONTEXT_VERSIONS,
  CONTEXT_ERRORS,
  CONTEXT_DOMAINS,
  CONTEXT_DOMAIN_INIT,
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
  // 感知路由器（专利5 v0.3）：感知事件的跨状态域路由与一致性编排
  createPerceptionRouter,
  DOMAIN_CLASS,
  UPDATE_MODES,
  PERCEPTION_ERRORS,
};
