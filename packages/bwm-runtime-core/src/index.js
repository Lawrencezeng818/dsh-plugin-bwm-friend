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

/* ── Runtime 协议面（BWM Protocol v1：hello/welcome + subscribe/emit）── */
function createRuntime() {
  const bus = createEventBus();
  let handshake = null;
  return {
    protocol: 'bwm',
    version: '1.0',
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
    bus, // 过渡期暴露（P1.2-1.4 搬完 Context/Presence/Ledger 后 Shell 只走 subscribe/emit）
  };
}

module.exports = { createEventBus, createRuntime, EVENT_VERSIONS, negotiate, compareVersion, RUNTIME_CAPABILITIES };
