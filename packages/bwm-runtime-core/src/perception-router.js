/**
 * Perception Router —— 感知事件的跨状态域路由与一致性编排（专利5 交底书 v0.3 §四 实现）
 *
 * 边界（交底书 §二 裁决表）：
 *  - 不生成存在状态（专利2 的权）——只产出「候选域更新指令」，交给专利2 的事件内核/状态机；
 *  - 不计算关系增量、不写关系账本（专利4 的权）——只产出「候选写入指令」，交给账本端执行。
 *
 * 独权级抽象（域名下沉纪律）：目标状态域以「类」表达——
 *  - 易失运行状态域（volatile）：默认易失更新，会话销毁即失效；
 *  - 持久历史状态域（persistent）：默认拒绝，满足额外准入条件才持久化。
 * 具体域名（presence / conversation / ledger，或未来 emotion / memory / task）仅为配置实例。
 *
 * 延迟（DEFER）语义（P2 修复 · 防死循环）：延迟不是无限期保留——drainDeferred 取出时
 * 已过期（超出事件 TTL 新鲜度窗口）的更新直接丢弃并记审计，不再回塞队列；
 * 未过期的返回给调用方于下一轮重新评估。以此切断「过期→DEFER→再过期」死循环。
 */

const DOMAIN_CLASS = { VOLATILE: 'volatile', PERSISTENT: 'persistent' };

/** 域更新决策向量取值（交底书 §四 步骤4） */
const UPDATE_MODES = {
  DENY: 'deny', // 禁止
  VOLATILE: 'volatile', // 易失更新
  PERSIST: 'persist', // 持久更新
  DEFER: 'defer', // 延迟更新（迟到事件→下一轮）
};

const DEFAULT_DOMAINS = {
  presence: { class: DOMAIN_CLASS.VOLATILE },
  conversation: { class: DOMAIN_CLASS.VOLATILE },
  ledger: { class: DOMAIN_CLASS.PERSISTENT },
};

/* ── 有界运行时常量（P2 修复 · 防无界增长）──
 * 会话表 / 轮次完成标记 / 审计数组 / 延迟队列均为进程内长期结构，必须滚动有界：
 *  - MAX_SESSIONS：sessions 表中已关闭会话的保留上限（FIFO 淘汰最旧；开放会话永不淘汰）
 *  - MAX_ROUNDS_PER_SESSION：轮次完成标记保留上限（markRoundComplete 无会话参数，
 *    以全局 FIFO 滚动保留最近 100 条为上界，等效最活跃会话的保留量）
 *  - MAX_AUDIT：审计数组滚动上限（保留最近）
 *  - MAX_LATE_QUEUE：延迟队列上限（超出丢最旧并记审计）
 */
const MAX_SESSIONS = 50;
const MAX_ROUNDS_PER_SESSION = 100;
const MAX_AUDIT = 500;
const MAX_LATE_QUEUE = 200;

const ERRORS = {
  SESSION_NOT_FOUND: 'session_not_found',
  SESSION_CLOSED: 'session_closed',
  SOURCE_NOT_ALLOWED: 'source_not_allowed',
  PRIVACY_DENIED: 'privacy_denied',
  LOW_CONFIDENCE: 'low_confidence',
  POLICY_VERSION_CONFLICT: 'policy_version_conflict',
};

let SEQ = 0;
function nextEventId() {
  SEQ += 1;
  return `pe_${Date.now().toString(36)}_${SEQ.toString(36)}`;
}

/**
 * @param {object} opts
 * @param {object} [opts.domains] 目标状态域定义（类映射），默认 presence/conversation/ledger
 * @param {(update:object)=>void} [opts.apply] 域更新执行器（外部副作用：状态机注入 / 账本候选写入）
 * @param {(failed:object, applied:object[])=>void} [opts.compensate] 部分失败补偿回调
 * @param {()=>number} [opts.now] 注入时钟（测试确定性）
 */
function createPerceptionRouter(opts = {}) {
  const domains = Object.assign({}, DEFAULT_DOMAINS, opts.domains || {});
  const now = opts.now || (() => Date.now());
  const apply = opts.apply || (() => {});
  const compensate = opts.compensate || (() => {});

  const sessions = new Map();
  const completedRounds = new Set();
  const lateQueue = [];
  const audit = [];
  let sessionSeq = 0;

  /** 审计滚动写入（上限 MAX_AUDIT，超出丢最旧） */
  function pushAudit(rec) {
    audit.push(rec);
    if (audit.length > MAX_AUDIT) audit.splice(0, audit.length - MAX_AUDIT);
  }

  /** 步骤1：建立感知会话（允许采集的感知类别 / 调度策略 / 允许流向的域 / 销毁条件） */
  function openSession(cfg = {}) {
    const policyVersion = cfg.policyVersion || 'policy-v1';
    const session = {
      sessionId: `ps_${(sessionSeq += 1)}`,
      subjectId: cfg.subjectId || 'sub_unknown',
      interactionState: cfg.interactionState || 'idle',
      allowedSources: cfg.allowedSources || ['camera'],
      schedule: cfg.schedule || { mode: 'conversational', intervalMs: 2500 },
      allowedDomains: cfg.allowedDomains || null, // 为 null 时按域类默认
      ttlMs: cfg.ttlMs || 4000, // 感知新鲜度窗口
      privacy: Object.assign({ requiresForeground: true }, cfg.privacy || {}),
      policyVersion,
      openedAt: now(),
      closed: false,
      closeReason: null,
    };
    sessions.set(session.sessionId, session);
    return session;
  }

  /** 销毁条件：关闭会话（易失域随之失效） */
  function closeSession(sessionId, reason = 'user_closed') {
    const s = sessions.get(sessionId);
    if (!s) return { ok: false, error: ERRORS.SESSION_NOT_FOUND };
    s.closed = true;
    s.closeReason = reason;
    evictClosedSessions(); // 会话表有界化：closed 会话超量按 FIFO 淘汰
    return { ok: true, sessionId, reason };
  }

  /** 已关闭会话超过 MAX_SESSIONS 时按插入序（FIFO）淘汰最旧；开放会话永不淘汰 */
  function evictClosedSessions() {
    const closedIds = [];
    for (const [id, sess] of sessions) {
      if (sess.closed) closedIds.push(id);
    }
    const excess = closedIds.length - MAX_SESSIONS;
    if (excess > 0) for (const id of closedIds.slice(0, excess)) sessions.delete(id);
  }

  /** 步骤2：将感知结果转换为结构化感知事件（事件标识/来源类型/生成时间/有效期） */
  function ingest(sessionId, raw = {}) {
    const s = sessions.get(sessionId);
    if (!s) return { ok: false, error: ERRORS.SESSION_NOT_FOUND };
    if (s.closed) return { ok: false, error: ERRORS.SESSION_CLOSED };
    if (!s.allowedSources.includes(raw.sourceType)) {
      return { ok: false, error: ERRORS.SOURCE_NOT_ALLOWED };
    }
    if (s.privacy.requiresForeground && raw.foreground === false) {
      return { ok: false, error: ERRORS.PRIVACY_DENIED };
    }
    const at = raw.generatedAt || now();
    const event = {
      eventId: nextEventId(),
      sessionId,
      subjectId: s.subjectId,
      sourceType: raw.sourceType,
      summary: raw.summary || '',
      salience: typeof raw.salience === 'number' ? raw.salience : 0,
      confidence: typeof raw.confidence === 'number' ? raw.confidence : 1,
      relationScope: raw.relationScope || s.subjectId,
      generatedAt: at,
      expiresAt: at + (raw.ttlMs || s.ttlMs),
      roundId: raw.roundId == null ? null : raw.roundId,
      userConfirmed: !!raw.userConfirmed,
    };
    return { ok: true, event };
  }

  function domainClass(name) {
    const d = domains[name];
    return d ? d.class : DOMAIN_CLASS.PERSISTENT; // 未声明的域按最保守处理
  }

  /**
   * 步骤3~5：生成域更新决策向量 + 带同一事件标识的域更新指令
   * 规则要点：
   *  - 置信度门控（低于阈值直接拒绝，不进入路由）；
   *  - 易失域默认易失更新；持久域默认拒绝；
   *  - 持久化需同时满足：显著性阈值 + 会话允许 + 关系范围匹配 + （显式分享或用户确认）；
   *  - 过期（不新鲜）事件：易失域降级为延迟（下一轮），持久域拒绝；
   *  - 迟到事件（生成时所属轮次已完成）：会话域延迟到下一轮，绝不回写已完成轮。
   */
  function decide(sessionId, event, ctx = {}) {
    const s = sessions.get(sessionId);
    if (!s) return { ok: false, error: ERRORS.SESSION_NOT_FOUND };
    if (s.closed) return { ok: false, error: ERRORS.SESSION_CLOSED };
    const minConfidence = ctx.minConfidence == null ? 0.3 : ctx.minConfidence;
    const minSalience = ctx.minSalience == null ? 3 : ctx.minSalience;
    const persistMinSalience = ctx.persistMinSalience == null ? 7 : ctx.persistMinSalience;

    const vector = {};
    const reasons = {};
    const t = now();
    const stale = t > event.expiresAt;
    const late = event.roundId != null && completedRounds.has(event.roundId);
    const scopeOk = event.relationScope === s.subjectId;

    for (const name of Object.keys(domains)) {
      const cls = domainClass(name);
      const allowed = s.allowedDomains ? s.allowedDomains[name] !== false : true;
      const base = cls === DOMAIN_CLASS.VOLATILE ? UPDATE_MODES.VOLATILE : UPDATE_MODES.DENY;

      if (event.confidence < minConfidence) {
        vector[name] = UPDATE_MODES.DENY;
        reasons[name] = [ERRORS.LOW_CONFIDENCE];
        continue;
      }
      if (!allowed) {
        vector[name] = UPDATE_MODES.DENY;
        reasons[name] = ['domain_not_allowed_by_session'];
        continue;
      }
      if (event.salience < minSalience) {
        vector[name] = UPDATE_MODES.DENY;
        reasons[name] = ['below_salience_gate'];
        continue;
      }
      if (late) {
        vector[name] = cls === DOMAIN_CLASS.VOLATILE ? UPDATE_MODES.DEFER : UPDATE_MODES.DENY;
        reasons[name] = ['late_event_isolation'];
        continue;
      }
      if (stale) {
        vector[name] = cls === DOMAIN_CLASS.VOLATILE ? UPDATE_MODES.DEFER : UPDATE_MODES.DENY;
        reasons[name] = ['stale_event'];
        continue;
      }
      if (cls === DOMAIN_CLASS.PERSISTENT) {
        const explicit = event.sourceType === 'explicit_share' || event.userConfirmed;
        if (event.salience >= persistMinSalience && scopeOk && explicit) {
          vector[name] = UPDATE_MODES.PERSIST;
          reasons[name] = ['persist_granted'];
        } else {
          vector[name] = UPDATE_MODES.DENY;
          reasons[name] = [
            event.salience < persistMinSalience ? 'below_persist_salience' : null,
            !scopeOk ? 'relation_scope_mismatch' : null,
            !explicit ? 'not_explicit_or_confirmed' : null,
          ].filter(Boolean);
        }
        continue;
      }
      vector[name] = base;
      reasons[name] = ['volatile_default'];
    }

    const decision = { eventId: event.eventId, vector, reasons, policyVersion: s.policyVersion, at: t };
    pushAudit({ eventId: event.eventId, sessionId, vector, reasons, policyVersion: s.policyVersion, at: t });
    return { ok: true, decision };
  }

  /** 步骤5：生成域更新指令（同一 eventId 串联各域） */
  function route(sessionId, event, decision) {
    const s = sessions.get(sessionId);
    if (!s) return { ok: false, error: ERRORS.SESSION_NOT_FOUND };
    if (s.closed) return { ok: false, error: ERRORS.SESSION_CLOSED }; // 会话销毁即失效：关闭后不再产出指令
    const updates = [];
    for (const [name, mode] of Object.entries(decision.vector)) {
      if (mode === UPDATE_MODES.DENY) continue;
      updates.push({
        domain: name,
        domainClass: domainClass(name),
        mode,
        eventId: event.eventId,
        subjectId: s.subjectId,
        relationScope: event.relationScope,
        policyVersion: decision.policyVersion,
        payload: {
          summary: event.summary,
          salience: event.salience,
          sourceType: event.sourceType,
          userConfirmed: event.userConfirmed, // 确认标记随指令传递：账本端准入复核需要（防持久化准入旁路）
        },
        at: decision.at,
        expiresAt: event.expiresAt, // 有效期随指令传递：drain 路径据此丢弃过期延迟项（防 DEFER 死循环）
      });
    }
    return { ok: true, updates };
  }

  /** 轮次完成标记：之前生成、之后到达的事件视为迟到（隔离，不污染已完成轮） */
  function markRoundComplete(roundId) {
    completedRounds.add(roundId);
    // 滚动上限：保留最近 MAX_ROUNDS_PER_SESSION 条（Set 按插入序迭代，淘汰最旧）
    if (completedRounds.size > MAX_ROUNDS_PER_SESSION) {
      completedRounds.delete(completedRounds.values().next().value);
    }
    return { ok: true, roundId };
  }

  /** 延迟入队（有界：超出 MAX_LATE_QUEUE 丢最旧并记审计） */
  function enqueueDeferred(u) {
    lateQueue.push(u);
    if (lateQueue.length > MAX_LATE_QUEUE) {
      const dropped = lateQueue.shift();
      pushAudit({ eventId: dropped.eventId, dropped: 'late_queue_overflow', domain: dropped.domain, at: now() });
    }
  }

  /**
   * 取出延迟到下一轮的更新（迟到事件与不新鲜事件）。
   * 语义（P2 修复，见文件头）：延迟不是无限期保留——取出时已过期（超出事件 TTL）的
   * 更新直接丢弃并记审计，不再回塞，切断「过期→DEFER→再过期」死循环；
   * 未过期的返回给调用方于下一轮重新评估。
   */
  function drainDeferred() {
    const t = now();
    const out = [];
    for (const u of lateQueue.splice(0, lateQueue.length)) {
      if (u.expiresAt != null && t > u.expiresAt) {
        pushAudit({ eventId: u.eventId, dropped: 'deferred_expired', domain: u.domain, at: t }); // 过期即丢弃（防死循环）
        continue;
      }
      out.push(u);
    }
    return out;
  }

  /**
   * 步骤6：跨域一致性控制 —— 顺序 / 版本冲突 / 部分失败补偿
   * @returns {{ok:boolean, applied:object[], deferred:object[], compensated:object[], pendingPersist:object[], shelved:object[], error?:string}}
   */
  function commit(sessionId, updates = []) {
    const s = sessions.get(sessionId);
    if (!s) return { ok: false, error: ERRORS.SESSION_NOT_FOUND, applied: [], deferred: [], compensated: [], pendingPersist: [], shelved: [] };
    if (s.closed) return { ok: false, error: ERRORS.SESSION_CLOSED, applied: [], deferred: [], compensated: [], pendingPersist: [], shelved: [] }; // 会话销毁即失效
    const applied = [];
    const deferred = [];
    const compensated = [];
    const pendingPersist = [];
    const shelved = [];

    // 版本冲突：指令的策略版本与会话当前版本不一致 → 拒绝（不执行）
    const conflict = updates.find((u) => u.policyVersion !== s.policyVersion);
    if (conflict) {
      return { ok: false, error: ERRORS.POLICY_VERSION_CONFLICT, applied, deferred, compensated, pendingPersist: updates, shelved };
    }

    // 顺序：先易失域，后持久域（易失失败不影响持久域判定；持久失败须补偿易失）
    const ordered = updates
      .slice()
      .sort((a, b) => (a.domainClass === DOMAIN_CLASS.VOLATILE ? -1 : 1) - (b.domainClass === DOMAIN_CLASS.VOLATILE ? -1 : 1));

    for (let i = 0; i < ordered.length; i++) {
      const u = ordered[i];
      if (u.mode === UPDATE_MODES.DEFER) {
        enqueueDeferred(u);
        deferred.push(u);
        continue;
      }
      try {
        apply(u);
        applied.push(u);
      } catch (err) {
        if (u.domainClass === DOMAIN_CLASS.PERSISTENT) {
          // 部分失败：持久域失败 → 逐项补偿已执行的易失更新（回调第二参数只含该易失项）+ 标记待重试
          for (const v of applied.filter((x) => x.domainClass === DOMAIN_CLASS.VOLATILE)) {
            compensate(u, [v]);
            compensated.push(v);
          }
          const kept = applied.filter((x) => x.domainClass === DOMAIN_CLASS.PERSISTENT);
          pendingPersist.push(u);
          // 剩余未处理指令不再静默丢弃：持久项转入待重试，易失/延迟项按既有重试语义转入下轮，全部列入 shelved
          const rest = ordered.slice(i + 1);
          for (const w of rest) {
            if (w.domainClass === DOMAIN_CLASS.PERSISTENT) pendingPersist.push(w);
            else if (w.mode === UPDATE_MODES.DEFER) { enqueueDeferred(w); deferred.push(w); }
            else deferred.push(w);
          }
          shelved.push(...rest);
          return {
            ok: false,
            error: String((err && err.message) || err),
            applied: kept,
            deferred,
            compensated,
            pendingPersist,
            shelved,
          };
        }
        // 易失域失败：静默丢弃（不阻塞持久域），记入 deferred 供下轮重试
        deferred.push(u);
      }
    }
    return { ok: true, applied, deferred, compensated, pendingPersist, shelved };
  }

  /** 审计视图（证据/重放用）：决策历史含策略版本 */
  function auditLog() {
    return audit.slice();
  }

  return {
    openSession,
    closeSession,
    ingest,
    decide,
    route,
    markRoundComplete,
    drainDeferred,
    commit,
    auditLog,
    domains: () => Object.assign({}, domains),
  };
}

module.exports = {
  createPerceptionRouter,
  DOMAIN_CLASS,
  UPDATE_MODES,
  DEFAULT_DOMAINS,
  PERCEPTION_ERRORS: ERRORS,
};
