/**
 * Relationship Ledger —— 可验证关系账本（专利4 权1 六步机制链实现）
 *
 * 六步（与权利要求书 01 权1 步骤一～六 逐字对应）：
 *   步骤一 候选事件获取：事件类型/事件标识/内容摘要/上下文引用/在场状态；行为事件由运行侧写入
 *   步骤二 准入判断：显著性 / 置信度 / 隐私策略
 *   步骤三 绑定与溯源：主体标识 + 关系范围 + 证据来源 + 溯源元数据
 *   步骤四 上下文快照关联：用户目标 / 行为摘要 / 结果状态
 *   步骤五 确定性增量计算：事件类型权重 × 结果状态系数 × 证据置信度系数 × 时间衰减 + 规则版本
 *   步骤六 账本写入：以共享事件标识关联写入，幂等可重放
 *
 * 家族边界纪律（BWM 专利族）：
 *   ❌ 不生成存在状态（专利2 的权）
 *   ❌ 不做感知会话/跨域路由决策（专利5 的权）——本模块消费其产出的「候选写入指令」
 *   ✅ 本模块独占：准入后的确定性关系增量计算 + 关系账本写入/幂等/重放 + 关系资产查询
 *
 * 纯逻辑：无 DOM / 无 React / 无 IO 依赖（store 为可选注入）。
 */

/** 错误码 */
const LEDGER_ERRORS = Object.freeze({
  NO_EVENT_ID: 'no_event_id',
  NOT_BOUND: 'not_bound',
  RELATION_SCOPE_MISMATCH: 'relation_scope_mismatch',
  UNKNOWN_RULE: 'unknown_rule',
  UNKNOWN_EVENT_TYPE: 'unknown_event_type',
  UNKNOWN_OUTCOME: 'unknown_outcome',
  DUPLICATE_EVENT: 'duplicate_event',
});

const DAY_MS = 86400000;

/**
 * 预定义映射规则表（**版本化**）。
 * 历史条目不重算：重放审计按条目内记录的规则版本执行。
 */
const RULE_TABLES = Object.freeze({
  'rules-v1.0': Object.freeze({
    version: 'rules-v1.0',
    /** 事件类型权重 */
    eventTypeWeight: Object.freeze({
      generated_template: 1.0,
      code_analysis: 0.8,
      tool_execution: 0.6,
      memory_organize: 0.5,
      companion_chat: 0.4,
      mode_switch: 0.2,
    }),
    /** 结果状态系数 */
    outcomeFactor: Object.freeze({
      completed: 1.0,
      partial: 0.7,   // 完成但含失败段
      cancelled: 0.2,
    }),
    /** 证据置信度系数（感知派生事件另行按显著性分值/10 计算） */
    evidenceFactor: Object.freeze({
      runtime: 1.0,          // 运行侧直采
      user_confirmed: 0.9,   // 用户确认
    }),
    /** 三维度分配系数 */
    dimensionShare: Object.freeze({ trust: 0.5, intimacy: 0.4, familiarity: 0.3 }),
    /** 时间衰减率（每日） */
    decayPerDay: Object.freeze({ trust: 0.002, intimacy: 0.001, familiarity: 0.0005 }),
    /** 单次增量界 */
    deltaBound: 1.0,
    /** 累计值域 */
    cumulativeBound: 100,
    /** 准入门槛 */
    admission: Object.freeze({ minSalience: 3, minConfidence: 0.3 }),
  }),
});

const DEFAULT_RULES_VERSION = 'rules-v1.0';
const RELATIONSHIP_DIMENSIONS = Object.freeze(['trust', 'intimacy', 'familiarity']);

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * 证据置信度系数：感知派生 = 显著性/10；用户确认 = 0.9；运行侧直采 = 1.0。
 */
function evidenceFactorOf(event, evidenceSource, rules) {
  const src = evidenceSource || event.evidenceSource || 'runtime';
  if (src === 'perception') return (Number(event.salience) || 0) / 10;
  if (event.userConfirmed) return rules.evidenceFactor.user_confirmed;
  const f = rules.evidenceFactor[src];
  return f === undefined ? 1.0 : f;
}

/**
 * @param {object} [opts]
 * @param {object} [opts.rules] 规则表注册表（默认 RULE_TABLES）
 * @param {string} [opts.rulesVersion] 默认规则版本
 * @param {object} [opts.store] 持久层（需实现 append(entry) / load()）
 * @param {() => number} [opts.now] 注入时钟（测试确定性）
 */
function createRelationshipLedger(opts = {}) {
  const registry = opts.rules || RULE_TABLES;
  const defaultRulesVersion = opts.rulesVersion || DEFAULT_RULES_VERSION;
  const store = opts.store || null;
  const now = opts.now || (() => Date.now());

  if (!registry[defaultRulesVersion]) {
    throw new Error('unknown rules version: ' + defaultRulesVersion);
  }

  let seq = 0;
  const entries = [];        // 追加式关系账本
  const seen = new Set();    // 幂等：已写入的共享事件标识

  function nextEventId() {
    seq += 1;
    return 're_' + now().toString(36) + '_' + seq.toString(36);
  }

  /* ── 步骤一：候选事件获取（行为事件由智能体运行侧写入）── */
  function submitCandidate(raw = {}) {
    return {
      eventId: raw.eventId || nextEventId(),
      eventType: raw.eventType || null,
      summary: String(raw.summary || ''),
      contextRef: raw.contextRef || null,       // 关联会话 / 任务 / 模板版本
      presenceState: raw.presenceState || null, // 事件发生时的在场状态
      evidenceSource: raw.evidenceSource || 'runtime',
      subjectId: raw.subjectId || null,
      relationScope: raw.relationScope || null,
      salience: typeof raw.salience === 'number' ? raw.salience : 0,
      confidence: typeof raw.confidence === 'number' ? raw.confidence : 1,
      privacyAllowed: raw.privacyAllowed !== false,
      userConfirmed: !!raw.userConfirmed,
      at: raw.at == null ? now() : raw.at,
    };
  }

  /* ── 步骤二：准入判断（显著性 / 置信度 / 隐私策略）── */
  function admit(event, policy = {}) {
    const rules = registry[policy.rulesVersion || defaultRulesVersion];
    const minSalience = policy.minSalience == null ? rules.admission.minSalience : policy.minSalience;
    const minConfidence = policy.minConfidence == null ? rules.admission.minConfidence : policy.minConfidence;
    const reasons = [];
    if (!(Number(event.confidence) >= minConfidence)) reasons.push('below_confidence_gate');
    if (!(Number(event.salience) >= minSalience)) reasons.push('below_salience_gate');
    if (!event.privacyAllowed) reasons.push('privacy_denied');
    const ok = reasons.length === 0;
    return {
      ok,
      reasons: ok ? ['admitted'] : reasons,
      policyVersion: 'admission-s' + minSalience + '-c' + minConfidence,
    };
  }

  /* ── 步骤三：绑定与溯源（主体标识 / 关系范围 / 证据来源 + 溯源元数据）── */
  function bind(event, binding = {}) {
    const subjectId = binding.subjectId || event.subjectId;
    if (!subjectId) return { ok: false, error: LEDGER_ERRORS.NOT_BOUND };
    const relationScope = binding.relationScope || event.relationScope || subjectId;
    const evidenceSource = binding.evidenceSource || event.evidenceSource || 'runtime';
    // 关系范围匹配：仅当事件关系范围与账本主体对匹配时计入；跨主体事件拒绝
    const expected = binding.expectedScope;
    const scopeOk = expected == null || relationScope === expected;
    if (!scopeOk) return { ok: false, error: LEDGER_ERRORS.RELATION_SCOPE_MISMATCH };
    return {
      ok: true,
      subjectId,
      relationScope,
      evidenceSource,
      provenance: {
        at: event.at,                                   // 事件发生时间
        basis: binding.basis || 'admission_passed',      // 处理依据
        sessionRef: binding.sessionRef || event.contextRef || null, // 关联会话标识
      },
    };
  }

  /* ── 步骤四：上下文快照关联（用户目标 / 行为摘要 / 结果状态）── */
  function attachSnapshot(snapshot = {}) {
    return {
      userGoal: snapshot.userGoal || null,
      actionSummary: snapshot.actionSummary || '',
      outcome: snapshot.outcome || 'completed',
    };
  }

  /* ── 步骤五：确定性增量计算（权重 × 结果系数 × 置信度系数 × 时间衰减 + 规则版本）── */
  function computeDelta(event, binding, snapshot, at, rulesVersion) {
    const version = rulesVersion || defaultRulesVersion;
    const rules = registry[version];
    if (!rules) return { ok: false, error: LEDGER_ERRORS.UNKNOWN_RULE };
    const weight = rules.eventTypeWeight[event.eventType];
    if (weight === undefined) return { ok: false, error: LEDGER_ERRORS.UNKNOWN_EVENT_TYPE };
    const outcomeFactor = rules.outcomeFactor[snapshot.outcome];
    if (outcomeFactor === undefined) return { ok: false, error: LEDGER_ERRORS.UNKNOWN_OUTCOME };
    const confidenceFactor = evidenceFactorOf(event, binding.evidenceSource, rules);
    const base = weight * outcomeFactor * confidenceFactor;
    const t = at == null ? now() : at;
    const days = Math.max(0, (t - event.at) / DAY_MS);
    const delta = {};
    for (const dim of RELATIONSHIP_DIMENSIONS) {
      const raw = base * (rules.dimensionShare[dim] || 0);
      const bounded = clamp(raw, -rules.deltaBound, rules.deltaBound);
      delta[dim] = bounded * Math.exp(-rules.decayPerDay[dim] * days);
    }
    return {
      ok: true,
      delta,
      rulesVersion: rules.version,
      factors: { weight, outcomeFactor, confidenceFactor, base },
      decayDays: days,
    };
  }

  /* ── 步骤六：账本写入（共享事件标识关联；同标识重复写入按幂等处理）── */
  function write(record) {
    const { event, admission, binding, snapshot, delta } = record;
    const eventId = event && event.eventId;
    if (!eventId) return { ok: false, error: LEDGER_ERRORS.NO_EVENT_ID };
    if (seen.has(eventId)) return { ok: false, error: LEDGER_ERRORS.DUPLICATE_EVENT, idempotent: true };
    const entry = {
      eventId,                                   // 共享事件标识（关联键）
      subjectId: binding.subjectId,
      relationScope: binding.relationScope,
      eventType: event.eventType,
      summary: event.summary,
      contextRef: event.contextRef,
      presenceState: event.presenceState,
      evidenceSource: binding.evidenceSource,
      provenance: binding.provenance,             // 溯源元数据
      snapshot,                                   // 上下文快照
      admission,                                  // 准入与绑定处理依据
      rulesVersion: delta.rulesVersion,           // 计算所用规则版本
      delta: delta.delta,                         // 关系状态变化量
      at: event.at,
    };
    entries.push(entry);
    seen.add(eventId);
    if (store && typeof store.append === 'function') {
      try { store.append(entry); } catch (_) { /* 持久失败不阻断账本写入（镜像已入） */ }
    }
    return { ok: true, entry };
  }

  /** 六步一次走完（供调用方与闭环实测使用） */
  function submit(raw, ctx = {}) {
    const event = submitCandidate(raw);
    const admission = admit(event, ctx.admission || {});
    if (!admission.ok) return { ok: false, stage: 'admit', event, admission };
    const binding = bind(event, ctx.binding || {});
    if (!binding.ok) return { ok: false, stage: 'bind', event, admission, binding };
    const snapshot = attachSnapshot(ctx.snapshot || {});
    // 未显式指定计算时刻时，以事件发生时刻计算增量（此时时间衰减因子为 1）
    const computedAt = ctx.at == null ? event.at : ctx.at;
    const delta = computeDelta(event, binding, snapshot, computedAt, ctx.rulesVersion);
    if (!delta.ok) return { ok: false, stage: 'compute', event, admission, binding, snapshot, delta };
    const written = write({ event, admission, binding, snapshot, delta });
    return {
      ok: written.ok || !!written.idempotent,
      stage: 'write',
      idempotent: !!written.idempotent,
      event, admission, binding, snapshot, delta,
      entry: written.entry || null,
      error: written.ok ? null : written.error,
    };
  }

  /* ── 关系资产查询（权6 读模型）── */
  function report(query = {}) {
    const { from = null, to = null, eventTypes = null, topic = null } = query;
    let rows = entries.slice();
    if (from != null) rows = rows.filter((e) => e.at >= from);
    if (to != null) rows = rows.filter((e) => e.at <= to);
    if (eventTypes) rows = rows.filter((e) => eventTypes.indexOf(e.eventType) >= 0);
    if (topic) rows = rows.filter((e) => (e.summary && e.summary.indexOf(topic) >= 0) || (e.contextRef && String(e.contextRef).indexOf(topic) >= 0));
    rows.sort((a, b) => a.at - b.at);
    const totals = { trust: 0, intimacy: 0, familiarity: 0 };
    for (const e of rows) {
      for (const d of RELATIONSHIP_DIMENSIONS) totals[d] += (e.delta && e.delta[d]) || 0;
    }
    return {
      count: rows.length,
      timeRange: rows.length ? [rows[0].at, rows[rows.length - 1].at] : null,
      totals,
      entries: rows,
    };
  }

  /**
   * 可重放审计：按**条目内记录的规则版本**重放，规则升级后历史条目不重算。
   * @param {{at?:number|null}} [o] at 非空时按该时刻计算各条目的衰减后有效值
   */
  function replay(o = {}) {
    const at = o.at == null ? null : o.at;
    const state = { trust: 0, intimacy: 0, familiarity: 0 };
    const steps = [];
    for (const e of entries) {
      const rules = registry[e.rulesVersion] || registry[defaultRulesVersion];
      const days = at == null ? 0 : Math.max(0, (at - e.at) / DAY_MS);
      const step = {};
      for (const d of RELATIONSHIP_DIMENSIONS) {
        const raw = clamp((e.delta && e.delta[d]) || 0, -rules.deltaBound, rules.deltaBound);
        step[d] = raw * Math.exp(-rules.decayPerDay[d] * days);
        state[d] = clamp(state[d] + step[d], 0, rules.cumulativeBound);
      }
      steps.push({ eventId: e.eventId, rulesVersion: e.rulesVersion, step, state: Object.assign({}, state) });
    }
    return { state, steps };
  }

  function all() { return entries.slice(); }
  function size() { return entries.length; }

  return {
    submitCandidate,
    admit,
    bind,
    attachSnapshot,
    computeDelta,
    write,
    submit,
    report,
    replay,
    all,
    size,
    rulesVersion: defaultRulesVersion,
  };
}

module.exports = {
  createRelationshipLedger,
  RULE_TABLES,
  DEFAULT_RULES_VERSION,
  RELATIONSHIP_DIMENSIONS,
  LEDGER_ERRORS,
  evidenceFactorOf,
};
