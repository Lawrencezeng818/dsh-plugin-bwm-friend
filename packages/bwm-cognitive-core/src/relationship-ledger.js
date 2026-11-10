/**
 * Relationship Ledger —— 可验证关系账本（七步机制链实现）
 *
 * 七步机制链：
 *   步骤一 候选事件获取：全链路事件标识 / 事件类型 / 结构化摘要 / 上下文引用；行为事件由运行侧写入
 *   步骤二 多策略准入：隐私策略 + 显著性 + 置信度（策略带版本标识）；未知证据来源拒绝
 *   步骤三 绑定与溯源：主体标识 + 关系范围 + 证据来源 + 溯源元数据
 *   步骤四 上下文快照关联与规范化输入固化：用户目标 / 行为摘要 / 结果状态 + 计算用规范化输入
 *   步骤五 初始关系增量 Δ0 计算：事件类型权重 × 结果状态系数 × 证据置信度系数（**不含时间衰减**，不可变写入）
 *   步骤六 原子幂等追加：全链路事件标识为幂等键，持久化失败不提交
 *   步骤七 重算比较验证 + 指定评价时刻重放：按条目记录的规则版本重算 Δ0 并比较；Δ(T)=Δ0·e^(−λ·ΔT)
 *
 * 两层量模型（修复早期实现的"二次衰减"缺陷）：
 *   Δ0        —— 事件处理时刻按映射规则算出的初始增量，入账后**不可变**，不再随事件年龄衰减
 *   Δ(T)      —— 评价时刻 T 的有效贡献 = Δ0 × exp(−λ × max(0, T − 事件发生时刻))
 *   S(T)      —— 按事件时间顺序逐条应用 Δ(T)，每步执行条目所记规则版本对应的限界函数
 *
 * 模块边界：
 *   ❌ 不生成存在状态
 *   ❌ 不做感知会话/跨域路由决策——本模块消费路由器产出的「候选写入指令」
 *   ✅ 本模块独占：准入复核 + 绑定溯源 + 规范化输入与版本固化 + 增量计算 + 原子落账 + 重算验证 + 指定时刻重放
 *
 * 纯逻辑：无 DOM / 无 React / 无 IO 依赖（store 为可选注入）。
 */

/** 错误码 */
const LEDGER_ERRORS = Object.freeze({
  NO_EVENT_ID: 'no_event_id',
  NOT_BOUND: 'not_bound',
  RELATION_SCOPE_MISMATCH: 'relation_scope_mismatch',
  UNKNOWN_RULE: 'unknown_rule',
  UNKNOWN_RULE_VERSION: 'unknown_rule_version',
  UNKNOWN_EVENT_TYPE: 'unknown_event_type',
  UNKNOWN_OUTCOME: 'unknown_outcome',
  UNKNOWN_EVIDENCE_SOURCE: 'unknown_evidence_source',
  DUPLICATE_EVENT: 'duplicate_event',
  PERSIST_FAILED: 'persist_failed',
  NO_STORE: 'no_store',
  LOAD_FAILED: 'load_failed',
});

const DAY_MS = 86400000;
const DELTA_EPSILON = 1e-12;

/**
 * 预定义映射规则表（**版本化、不可变**）。
 * 历史条目不按新规则重算；重算验证与重放均按条目内记录的规则版本执行。
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
    /**
     * 结果状态系数。枚举与系数一一对应，不含未定义项：
     * completed 正常完成 = 1.0；partial 完成但含失败段 = 0.7；
     * failed 执行失败 = 0.0（口径：不因失败惩罚关系，失败事件不产生正向增量）；
     * cancelled 用户取消 = 0.2。
     */
    outcomeFactor: Object.freeze({
      completed: 1.0,
      partial: 0.7,
      failed: 0.0,
      cancelled: 0.2,
    }),
    /** 证据置信度系数（感知派生事件另行按显著性分值/10 计算） */
    evidenceFactor: Object.freeze({
      runtime: 1.0,          // 运行侧直采
      user_confirmed: 0.9,   // 用户确认
    }),
    /** 增强类型（替代早期无定义的"重大事件"）：命中即按 factor 放大初始增量 */
    enhancement: Object.freeze({
      eventTypes: Object.freeze([]),
      factor: 1.5,
    }),
    /** 三维度分配系数 */
    dimensionShare: Object.freeze({ trust: 0.5, intimacy: 0.4, familiarity: 0.3 }),
    /** 时间衰减率（每日） */
    decayPerDay: Object.freeze({ trust: 0.002, intimacy: 0.001, familiarity: 0.0005 }),
    /** 单次初始增量界 */
    deltaBound: 1.0,
    /** 累计值域（限界函数上界） */
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

function eventTimeOf(entry) {
  // 时间归一化为数值毫秒（P3 修复）：数值原样（非有限数回退 0）；ISO 字符串 parse 成 ms（失败回退 0）。
  // 修复前字符串与数值直接相减得 NaN → 排序/区间过滤失序；归一化后排序稳定、时间混合类型安全。
  const t = entry.eventTime != null ? entry.eventTime : entry.at;
  if (typeof t === 'number') return Number.isFinite(t) ? t : 0;
  if (typeof t === 'string') {
    const ms = Date.parse(t);
    return Number.isNaN(ms) ? 0 : ms;
  }
  return 0;
}

/**
 * 证据置信度系数。
 * @returns {number|null} `null` 表示证据来源未知 —— 由调用方按策略拒绝或降级，
 *   **不默认按最高置信度放行**（隐私优先）。
 */
function evidenceFactorOf(event, evidenceSource, rules, opts = {}) {
  const src = evidenceSource || event.evidenceSource || 'runtime';
  if (src === 'perception') return (Number(event.salience) || 0) / 10;
  if (event.userConfirmed) return rules.evidenceFactor.user_confirmed;
  const f = rules.evidenceFactor[src];
  if (f === undefined) {
    if (opts.unknownEvidencePolicy === 'degrade') {
      return opts.degradeFactor == null ? 0.1 : opts.degradeFactor;
    }
    return null;
  }
  return f;
}

/**
 * @param {object} [opts]
 * @param {object} [opts.rules] 规则表注册表（默认 RULE_TABLES）
 * @param {string} [opts.rulesVersion] 默认规则版本
 * @param {object} [opts.store] 持久层（实现 append(entry) / load()，append 失败须抛错）
 * @param {'reject'|'degrade'} [opts.unknownEvidencePolicy] 未知证据来源策略（默认 reject）
 * @param {() => number} [opts.now] 注入时钟（测试确定性）
 */
function createRelationshipLedger(opts = {}) {
  const registry = opts.rules || RULE_TABLES;
  const defaultRulesVersion = opts.rulesVersion || DEFAULT_RULES_VERSION;
  const store = opts.store || null;
  const now = opts.now || (() => Date.now());
  const unknownEvidencePolicy = opts.unknownEvidencePolicy || 'reject';

  if (!registry[defaultRulesVersion]) {
    throw new Error('unknown rules version: ' + defaultRulesVersion);
  }

  let seq = 0;
  const entries = [];        // 追加式关系账本（内存权威视图）
  const seen = new Set();    // 幂等：已提交的共享事件标识
  const pending = new Set(); // 并发保护：正在持久化的标识（未提交前一律视为重复）
  let lastPersistError = null; // 内部错误标志（P2 修复）：异步持久失败可见（无既有错误事件通道 → console.error + 标志）

  function nextEventId() {
    seq += 1;
    return 're_' + now().toString(36) + '_' + seq.toString(36);
  }

  /* ── 步骤一：候选事件获取（行为事件由智能体运行侧写入）── */
  function submitCandidate(raw = {}) {
    const eventTime = raw.eventTime == null ? (raw.at == null ? now() : raw.at) : raw.eventTime;
    return {
      eventId: raw.eventId || nextEventId(),   // 全链路事件标识
      eventType: raw.eventType || null,
      summary: String(raw.summary == null ? '' : raw.summary), // 结构化摘要载荷（不含对话全文）
      contextRef: raw.contextRef || null,       // 关联会话 / 任务 / 模板版本
      presenceState: raw.presenceState || null, // 事件发生时的在场状态
      evidenceSource: raw.evidenceSource || 'runtime',
      subjectId: raw.subjectId || null,
      relationScope: raw.relationScope || null,
      salience: typeof raw.salience === 'number' ? raw.salience : 0,
      confidence: typeof raw.confidence === 'number' ? raw.confidence : 1,
      privacyAllowed: raw.privacyAllowed !== false,
      userConfirmed: !!raw.userConfirmed,
      at: eventTime,                            // 兼容别名：等同于事件发生时间
      eventTime,                                // 事件发生时间
      processTime: raw.processTime == null ? now() : raw.processTime, // 处理时间
    };
  }

  /* ── 步骤二：多策略准入（隐私 + 显著性 + 置信度；策略带版本标识）── */
  function admit(event, policy = {}) {
    const rules = registry[policy.rulesVersion || defaultRulesVersion];
    const minSalience = policy.minSalience == null ? rules.admission.minSalience : policy.minSalience;
    const minConfidence = policy.minConfidence == null ? rules.admission.minConfidence : policy.minConfidence;
    const reasons = [];
    if (!(Number(event.confidence) >= minConfidence)) reasons.push('below_confidence_gate');
    if (!(Number(event.salience) >= minSalience)) reasons.push('below_salience_gate');
    if (!event.privacyAllowed) reasons.push('privacy_denied');
    // 感知来源条目的显式确认门（P1 修复 · 与路由侧持久化准入一致）：
    // 无用户确认的感知条目拒绝入账（防止持久化准入经伪造的 persist 指令旁路）；
    // 普通 agent 事件路径（evidenceSource=runtime 等）不受影响。
    if (event.evidenceSource === 'perception' && !event.userConfirmed) {
      reasons.push('perception_not_user_confirmed');
    }
    const factor = evidenceFactorOf(event, event.evidenceSource, rules, { unknownEvidencePolicy });
    if (factor === null) reasons.push(LEDGER_ERRORS.UNKNOWN_EVIDENCE_SOURCE);
    const ok = reasons.length === 0;
    return {
      ok,
      reasons: ok ? ['admitted'] : reasons,
      policyVersion: 'admission-s' + minSalience + '-c' + minConfidence + '-' + (policy.privacyPolicyVersion || 'p1'),
      evidencePolicy: unknownEvidencePolicy,
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
        eventTime: event.eventTime != null ? event.eventTime : event.at, // 事件发生时间
        basis: binding.basis || 'admission_passed',                      // 处理依据
        sessionRef: binding.sessionRef || event.contextRef || null,      // 关联会话标识
      },
    };
  }

  /* ── 步骤四：上下文快照关联（用户目标 / 行为摘要 / 结果状态）── */
  function attachSnapshot(snapshot = {}) {
    return {
      userGoal: snapshot.userGoal || null,
      actionSummary: snapshot.actionSummary == null ? '' : String(snapshot.actionSummary),
      outcome: snapshot.outcome || 'completed',
      // 快照泛化：任务型事件才有目标/行为/结果；感知类事件这些字段可为空
      contextKind: snapshot.contextKind || 'task',
    };
  }

  /**
   * 步骤五：初始关系增量 Δ0 计算（**不含时间衰减**）。
   * Δ0 = 事件类型权重 × 结果状态系数 × 证据置信度系数 ×（增强系数）× 维度分配，并截断至 ±deltaBound。
   * 同时产出 normalizedInput —— 固化本次计算的全部输入，供后续按同版本规则重算比较。
   */
  function computeInitialDelta(event, binding, snapshot, rulesVersion) {
    const version = rulesVersion || defaultRulesVersion;
    const rules = registry[version];
    if (!rules) return { ok: false, error: LEDGER_ERRORS.UNKNOWN_RULE_VERSION };
    const weight = rules.eventTypeWeight[event.eventType];
    if (weight === undefined) return { ok: false, error: LEDGER_ERRORS.UNKNOWN_EVENT_TYPE };
    const outcomeFactor = rules.outcomeFactor[snapshot.outcome];
    if (outcomeFactor === undefined) return { ok: false, error: LEDGER_ERRORS.UNKNOWN_OUTCOME };
    const confidenceFactor = evidenceFactorOf(event, binding.evidenceSource, rules, { unknownEvidencePolicy });
    if (confidenceFactor === null) return { ok: false, error: LEDGER_ERRORS.UNKNOWN_EVIDENCE_SOURCE };

    const enhanced = rules.enhancement.eventTypes.indexOf(event.eventType) >= 0;
    const enhancementFactor = enhanced ? rules.enhancement.factor : 1.0;
    const base = weight * outcomeFactor * confidenceFactor * enhancementFactor;

    const delta = {};
    for (const dim of RELATIONSHIP_DIMENSIONS) {
      const raw = base * (rules.dimensionShare[dim] || 0);
      delta[dim] = clamp(raw, -rules.deltaBound, rules.deltaBound);
    }
    return {
      ok: true,
      delta,
      rulesVersion: rules.version,
      factors: { weight, outcomeFactor, confidenceFactor, enhancementFactor, enhanced, base },
      // 规范化账本输入：重算比较只依赖这些字段 + rulesVersion
      normalizedInput: {
        eventType: event.eventType,
        outcome: snapshot.outcome,
        evidenceSource: binding.evidenceSource,
        salience: Number(event.salience) || 0,
        userConfirmed: !!event.userConfirmed,
      },
    };
  }

  /** 依据规范化输入按指定规则版本重算 Δ0（验证与重放共用） */
  function recomputeFromNormalized(normalizedInput, rulesVersion) {
    const rules = registry[rulesVersion];
    if (!rules) return { ok: false, error: LEDGER_ERRORS.UNKNOWN_RULE_VERSION };
    const weight = rules.eventTypeWeight[normalizedInput.eventType];
    if (weight === undefined) return { ok: false, error: LEDGER_ERRORS.UNKNOWN_EVENT_TYPE };
    const outcomeFactor = rules.outcomeFactor[normalizedInput.outcome];
    if (outcomeFactor === undefined) return { ok: false, error: LEDGER_ERRORS.UNKNOWN_OUTCOME };
    const confidenceFactor = evidenceFactorOf(
      { salience: normalizedInput.salience, userConfirmed: normalizedInput.userConfirmed },
      normalizedInput.evidenceSource,
      rules,
      { unknownEvidencePolicy }
    );
    if (confidenceFactor === null) return { ok: false, error: LEDGER_ERRORS.UNKNOWN_EVIDENCE_SOURCE };
    const enhanced = rules.enhancement.eventTypes.indexOf(normalizedInput.eventType) >= 0;
    const enhancementFactor = enhanced ? rules.enhancement.factor : 1.0;
    const base = weight * outcomeFactor * confidenceFactor * enhancementFactor;
    const delta = {};
    for (const dim of RELATIONSHIP_DIMENSIONS) {
      delta[dim] = clamp(base * (rules.dimensionShare[dim] || 0), -rules.deltaBound, rules.deltaBound);
    }
    return { ok: true, delta, rulesVersion: rules.version };
  }

  /** 评价时刻有效贡献 Δ(T) = Δ0 × exp(−λ × max(0, T − 事件发生时刻)) */
  function effectiveContribution(entry, evaluationTime, rules) {
    const r = rules || registry[entry.rulesVersion] || registry[defaultRulesVersion];
    const t0 = eventTimeOf(entry);
    const days = evaluationTime == null ? 0 : Math.max(0, (evaluationTime - t0) / DAY_MS);
    const step = {};
    for (const dim of RELATIONSHIP_DIMENSIONS) {
      const d0 = clamp((entry.delta && entry.delta[dim]) || 0, -r.deltaBound, r.deltaBound);
      step[dim] = d0 * Math.exp(-r.decayPerDay[dim] * days);
    }
    return step;
  }

  /* ── 步骤六：原子幂等追加（持久化失败 → 不提交，不吞异常）── */
  function write(record) {
    const { event, admission, binding, snapshot, delta } = record;
    const eventId = event && event.eventId;
    if (!eventId) return { ok: false, error: LEDGER_ERRORS.NO_EVENT_ID };
    if (seen.has(eventId) || pending.has(eventId)) {
      return { ok: false, error: LEDGER_ERRORS.DUPLICATE_EVENT, idempotent: true };
    }

    const ledgerTime = now();
    const entry = {
      eventId,                                    // 全链路事件标识（幂等键 / 关联键）
      subjectId: binding.subjectId,
      relationScope: binding.relationScope,
      eventType: event.eventType,
      summary: event.summary,
      contextRef: event.contextRef,
      presenceState: event.presenceState,
      evidenceSource: binding.evidenceSource,
      provenance: binding.provenance,              // 溯源元数据（含事件发生时间）
      snapshot,                                    // 上下文快照
      admission,                                   // 准入与绑定的处理依据
      rulesVersion: delta.rulesVersion,            // 计算所用的规则版本（不可变）
      normalizedInput: delta.normalizedInput,      // 规范化输入（供重算比较）
      delta: delta.delta,                          // 初始关系增量 Δ0
      eventTime: event.eventTime != null ? event.eventTime : event.at, // 事件发生时间
      processTime: event.processTime != null ? event.processTime : ledgerTime, // 处理时间
      ledgerTime,                                  // 入账时间
      at: event.at != null ? event.at : event.eventTime,
    };

    // 先落持久层，成功后才更新内存权威视图 —— 保证"持久失败不提交"
    if (store && typeof store.append === 'function') {
      pending.add(eventId);
      let res = null;
      try {
        res = store.append(entry);
      } catch (err) {
        pending.delete(eventId);
        return {
          ok: false,
          error: LEDGER_ERRORS.PERSIST_FAILED,
          stage: 'persist',
          persisted: false,
          cause: String((err && err.message) || err),
        };
      }
      if (res && typeof res.catch === 'function') {
        // append 返回 rejected Promise（P2 修复）：失败异步抵达 → 从 entries/seen 回滚该条并清 pending，
        // 保持「持久失败不提交」；不静默逃逸（console.error + 内部标志）
        res.catch((err) => {
          pending.delete(eventId);
          const i = entries.indexOf(entry);
          if (i >= 0) entries.splice(i, 1);
          seen.delete(eventId);
          lastPersistError = String((err && err.message) || err);
          console.error('[bwm-ledger] persist failed:', lastPersistError);
        });
      }
      pending.delete(eventId);
    }

    entries.push(entry);
    seen.add(eventId);
    return { ok: true, entry };
  }

  /** 七步一次走完（供调用方与闭环实测使用） */
  function submit(raw, ctx = {}) {
    const event = submitCandidate(raw);
    const admission = admit(event, ctx.admission || {});
    if (!admission.ok) return { ok: false, stage: 'admit', event, admission };
    const binding = bind(event, ctx.binding || {});
    if (!binding.ok) return { ok: false, stage: 'bind', event, admission, binding };
    const snapshot = attachSnapshot(ctx.snapshot || {});
    const delta = computeInitialDelta(event, binding, snapshot, ctx.rulesVersion);
    if (!delta.ok) return { ok: false, stage: 'compute', event, admission, binding, snapshot, delta };
    const written = write({ event, admission, binding, snapshot, delta });
    return {
      ok: written.ok || !!written.idempotent,
      stage: written.ok ? 'write' : (written.stage || 'write'),
      idempotent: !!written.idempotent,
      persisted: written.ok ? true : written.persisted === true,
      event, admission, binding, snapshot, delta,
      entry: written.entry || null,
      error: written.ok ? null : written.error,
      cause: written.cause || null,
    };
  }

  /* ── 步骤七之一：重算比较验证 ── */
  /**
   * 按条目记录的规则版本与规范化输入重算 Δ0，与账本所存 Δ0 比较。
   * 可检出：规则版本错配、条目计算值被篡改、计算漂移、规则表缺失。
   */
  function verify(o = {}) {
    const mismatches = [];
    let checkedCount = 0;
    // limit 真实截断扫描（P3 修复：此前仅事后截断计数，扫描仍全量）
    const limit = o.limit == null ? entries.length : Math.max(0, Number(o.limit) || 0);
    for (const e of entries.slice(0, limit)) {
      const rules = registry[e.rulesVersion];
      if (!rules) {
        mismatches.push({ eventId: e.eventId, reason: LEDGER_ERRORS.UNKNOWN_RULE_VERSION });
        continue;
      }
      if (!e.normalizedInput) {
        mismatches.push({ eventId: e.eventId, reason: 'missing_normalized_input' });
        continue;
      }
      const re = recomputeFromNormalized(e.normalizedInput, e.rulesVersion);
      if (!re.ok) {
        mismatches.push({ eventId: e.eventId, reason: re.error });
        continue;
      }
      let same = true;
      for (const dim of RELATIONSHIP_DIMENSIONS) {
        const expected = re.delta[dim];
        const raw = e.delta ? e.delta[dim] : undefined;
        const actual = raw == null ? 0 : raw; // 缺失维度按 0（既有口径）
        // Δ 为非有限数（NaN/Infinity）判为篡改（P3 修复：原 `|| 0` 会把 NaN 吞成 0 掩盖篡改）
        if (!Number.isFinite(actual) || Math.abs(expected - actual) > DELTA_EPSILON) {
          same = false;
          mismatches.push({ eventId: e.eventId, dimension: dim, expected, actual });
        }
      }
      if (same) checkedCount += 1;
    }
    return {
      ok: mismatches.length === 0,
      checked: checkedCount,
      total: entries.length,
      mismatches,
    };
  }

  /* ── 步骤七之二：指定评价时刻重放（两层量 + 按版本限界）── */
  /**
   * 重放：按事件发生时间顺序逐条应用 Δ(T)，每步按条目所记规则版本执行限界函数。
   * @param {{at?:number|null}} [o] at 为评价时刻 T；为空则 T 取各条目事件发生时刻（等效 Δ0 累加）
   */
  function replay(o = {}) {
    const T = o.at == null ? null : o.at;
    const rows = entries.slice().sort((a, b) => eventTimeOf(a) - eventTimeOf(b));
    const state = { trust: 0, intimacy: 0, familiarity: 0 };
    const steps = [];
    for (const e of rows) {
      const rules = registry[e.rulesVersion];
      if (!rules) {
        return { ok: false, error: LEDGER_ERRORS.UNKNOWN_RULE_VERSION, eventId: e.eventId, state: null, steps };
      }
      const step = effectiveContribution(e, T, rules);
      for (const d of RELATIONSHIP_DIMENSIONS) {
        state[d] = clamp(state[d] + step[d], 0, rules.cumulativeBound);
      }
      steps.push({ eventId: e.eventId, rulesVersion: e.rulesVersion, effective: step, state: Object.assign({}, state) });
    }
    return { ok: true, state, steps, evaluationTime: T };
  }

  /* ── 持久层恢复（store.load 双契约归一——P2 修复：同步数组或 Promise 均兼容；对外结果形状不变）── */
  function restore() {
    if (!store || typeof store.load !== 'function') return { ok: false, error: LEDGER_ERRORS.NO_STORE };
    let loaded;
    try {
      loaded = store.load();
    } catch (err) {
      return { ok: false, error: LEDGER_ERRORS.LOAD_FAILED, cause: String((err && err.message) || err) };
    }
    const applyRows = (rows) => {
      try {
        entries.length = 0;
        seen.clear();
        pending.clear();
        for (const e of rows || []) {
          entries.push(e);
          seen.add(e.eventId);
        }
        entries.sort((a, b) => eventTimeOf(a) - eventTimeOf(b));
        return { ok: true, restored: entries.length };
      } catch (err) {
        // try/catch 覆盖迭代段：脏数据（不可迭代/坏条目）明确报 LOAD_FAILED，不抛裸异常
        return { ok: false, error: LEDGER_ERRORS.LOAD_FAILED, cause: String((err && err.message) || err) };
      }
    };
    if (loaded && typeof loaded.then === 'function') {
      // 异步契约：返回 Promise（结果对象形状与同步路径一致）
      return loaded.then(applyRows, (err) => ({ ok: false, error: LEDGER_ERRORS.LOAD_FAILED, cause: String((err && err.message) || err) }));
    }
    return applyRows(loaded); // 同步契约：行为与旧版一致（直接返回结果对象）
  }

  /* ── 关系资产查询（读模型，可重建；不作为原始事实条目）── */
  function report(query = {}) {
    const { from = null, to = null, eventTypes = null, topic = null } = query;
    let rows = entries.slice();
    if (from != null) rows = rows.filter((e) => eventTimeOf(e) >= from);
    if (to != null) rows = rows.filter((e) => eventTimeOf(e) <= to);
    if (eventTypes) rows = rows.filter((e) => eventTypes.indexOf(e.eventType) >= 0);
    if (topic) {
      rows = rows.filter(
        (e) => (e.summary && e.summary.indexOf(topic) >= 0) || (e.contextRef && String(e.contextRef).indexOf(topic) >= 0)
      );
    }
    rows.sort((a, b) => eventTimeOf(a) - eventTimeOf(b));
    const totals = { trust: 0, intimacy: 0, familiarity: 0 };
    for (const e of rows) {
      for (const d of RELATIONSHIP_DIMENSIONS) totals[d] += (e.delta && e.delta[d]) || 0;
    }
    return {
      count: rows.length,
      timeRange: rows.length ? [eventTimeOf(rows[0]), eventTimeOf(rows[rows.length - 1])] : null,
      totals,
      entries: rows,
    };
  }

  function all() { return entries.slice(); }
  function size() { return entries.length; }
  function has(eventId) { return seen.has(eventId); }

  return {
    submitCandidate,
    admit,
    bind,
    attachSnapshot,
    computeInitialDelta,
    effectiveContribution,
    write,
    submit,
    verify,
    replay,
    restore,
    report,
    all,
    size,
    has,
    lastPersistError: () => lastPersistError, // 内部错误标志读取口（异步持久失败可见）
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
