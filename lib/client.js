window.__ModuleLoader__.load({
	id: "dsh-plugin-bwm-friend",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var __bwmModules = {};
		var __bwmRequire = function(name) { return __bwmModules[name] || require(name); };
		__bwmModules["./perception-router.js"] = (function() {
			var module = { exports: {} };
			var exports = module.exports;
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

			return module.exports;
		})();
		__bwmModules["./relationship-ledger.js"] = (function() {
			var module = { exports: {} };
			var exports = module.exports;
			/**
			 * Relationship Ledger —— 可验证关系账本（专利4 授权优先版：七步机制链实现）
			 *
			 * 七步（与权利要求书 01 权1 步骤一～七 逐字对应）：
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
			 * 家族边界纪律（BWM 专利族）：
			 *   ❌ 不生成存在状态（专利2 的权）
			 *   ❌ 不做感知会话/跨域路由决策（专利5 的权）——本模块消费其产出的「候选写入指令」
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

			return module.exports;
		})();
		__bwmModules["@laikaton/bwm-runtime-core"] = (function() {
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

			/* ── 感知路由器（专利5 交底书 v0.3 §四 实现；跨域路由与一致性编排，纯逻辑）── */
			const {
			  createPerceptionRouter,
			  DOMAIN_CLASS,
			  UPDATE_MODES,
			  PERCEPTION_ERRORS,
			} = __bwmRequire('./perception-router.js');

			/* ── 关系账本（专利4 权1 六步机制链：准入 → 绑定溯源 → 快照 → 确定性增量 → 账本写入，可验证可重放）── */
			const {
			  createRelationshipLedger,
			  RULE_TABLES,
			  LEDGER_ERRORS,
			} = __bwmRequire('./relationship-ledger.js');

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
			  // Presence is a current-value channel, not an animation history.
			  const retained = new Map();
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
			      const entry = { fn, when, replay: opts.replay !== false };
			      listeners.get(channel).add(entry);
			      if (opts.replay !== false) {
			        const frames = channel === 'presence:state'
			          ? (retained.has(channel) ? [retained.get(channel)] : [])
			          : history.filter(ev => ev.target === channel);
			        // 订阅即回放：逐帧隔离——单监听器（含 when 谓词）抛错不中断回放（P2 修复）
			        for (const ev of frames) {
			          try {
			            if (when(ev.payload, ev.meta)) fn(ev.payload, ev.meta);
			          } catch (e) {
			            console.error(`[bwm] event ${channel} replay handler failed`, e);
			          }
			        }
			      }
			      return () => listeners.get(channel)?.delete(entry);
			    },
			    emit(channel, payload = {}, meta = {}) {
			      // Router 裁决：可阻止或改道（裁决回调逐个隔离：抛错按「未裁决」处理，不中断 emit——P2 修复）
			      let target = channel;
			      let blocked = false;
			      for (const { pattern, router } of routes) {
			        if (pattern === channel || (pattern instanceof RegExp && pattern.test(channel))) {
			          let r = null;
			          try {
			            r = router(payload, meta);
			          } catch (e) {
			            console.error(`[bwm] route handler failed for ${channel}`, e);
			          }
			          if (r && r.blocked) blocked = true;
			          if (r && r.channel) target = r.channel;
			        }
			      }
			      const ev = { channel, target, version: EVENT_VERSIONS[channel] || '1.0', payload, meta, at: new Date().toISOString() };
			      // Only the admitted, routed frame can enter either delivery path.
			      if (blocked) return ev;
			      history.push(ev);
			      if (history.length > 500) history.shift();
			      if (target === 'presence:state') retained.set(target, ev);
			      for (const entry of listeners.get(target) || []) {
			        if (target === 'presence:state' && retained.get(target) !== ev) break;
			        try {
			          if (entry.when(payload, meta)) entry.fn(payload, meta);
			        } catch (e) {
			          console.error(`[bwm] event ${target} handler failed`, e);
			        }
			      }
			      return ev;
			    },
			    replay() {
			      // Freeze history traversal: handlers may synchronously emit new frames.
			      const deliver = ev => {
			        for (const entry of listeners.get(ev.target) || []) {
			          if (ev.target === 'presence:state' && retained.get(ev.target) !== ev) break;
			          // 回放隔离：单监听器（含 when 谓词）抛错不中断全部回放（P2 修复）
			          try {
			            if (entry.replay && entry.when(ev.payload, ev.meta)) entry.fn(ev.payload, ev.meta);
			          } catch (e) {
			            console.error(`[bwm] event ${ev.target} replay handler failed`, e);
			          }
			        }
			      };
			      for (const ev of history.slice()) if (ev.target !== 'presence:state') deliver(ev);
			      for (const ev of retained.values()) deliver(ev);
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
			          const v = raw[k];
			          if (v === undefined) continue;
			          // 浅拷贝入域（P3 修复）：外部引用直改不再穿透 context 绕过 ownership
			          // （数组与普通对象分别做顶层拷贝；嵌套层级仍共享——快照通道为 JSON 序列化数据，够用）
			          domains[k] = Array.isArray(v) ? v.slice() : (v && typeof v === 'object' ? { ...v } : v);
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
			/* ── 任务域更新（专利1 [0043]：任务域表征「当前任务状态与最近任务状态」）──
			 * 历史缺陷 F2（2026-09-13 外部评审核验坐实）：原实现以 context.set('tasks', {last,taskId,at})
			 *   整体替换，抹掉视图写入的 pending（当前任务），使「当前任务状态」在事件后丢失，
			 *   权1「当前任务状态与最近任务状态」因此零实测支撑。
			 * 现为合并写：保留既有字段；pending 移出已完成项；recent 记录最近完成列表（上限 10）。
			 * 与关系域同一模式，满足 [0048] 字段可扩展。
			 */
			function updateTaskState(context, { taskId = null, outcome = null, at = null } = {}) {
			  const raw = context.get('tasks');
			  const prev = raw && typeof raw === 'object' ? { ...raw } : {};
			  const stamp = at || new Date().toISOString();
			  const next = { ...prev, last: outcome, taskId, at: stamp };
			  if (Array.isArray(prev.pending)) {
			    // 真过滤（P3 修复）：null/undefined 垃圾项不再保留（原 `!t ||` 会把空项留在列表里）
			    next.pending = prev.pending.filter((t) => t && t.id !== taskId);
			  }
			  const done = { id: taskId, stage: outcome, at: stamp };
			  next.recent = [done, ...(Array.isArray(prev.recent) ? prev.recent.filter((t) => t && t.id !== taskId) : [])].slice(0, 10);
			  context.set('tasks', next);
			}

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
			      const notify = (err) => {
			        // 持久失败不阻断事件管线：经既有事件通道上报（同步异常与 rejected Promise 同等对待——P2 修复）
			        try { bus.emit('ledger:persist.error', { error: String((err && err.message) || err), entry }); } catch (_) { /* 通知失败不再抛 */ }
			      };
			      let res = null;
			      try { res = store.append(entry); } catch (err) { notify(err); } // 同步异常（保持原同步语义，测试可同步断言）
			      if (res && typeof res.catch === 'function') res.catch(notify); // rejected Promise 不再静默逃逸
			    }
			  };
			  // 启动恢复（store.load 双契约归一——P2 修复）：同步返回数组或返回 Promise 均兼容；
			  // 恢复迭代/合并段在 then 内执行，异常统一落 .catch（恢复失败不阻断 runtime，降级为内存级）
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
			    bus.on('agent.task.success', (p) => { updateTaskState(context, { taskId: p && p.taskId, outcome: 'success' }); record('agent_task', { ...(p || {}), outcome: 'success', summary: p && p.summary }); }),
			    bus.on('agent.task.failed', (p) => { updateTaskState(context, { taskId: p && p.taskId, outcome: 'failed' }); record('agent_task', { ...(p || {}), outcome: 'failed', summary: p && p.summary }); }),
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
			  // 「发布中」重入护栏（P3 修复）：relationship:changed 的监听方若再发关系信号（互激），
			  // 重入的信号处理器直接忽略，防止「信号→更新→广播→信号」递归回路。
			  let publishing = false;
			  const off = Object.entries(RELATIONSHIP_SIGNALS).map(([channel, sig]) =>
			    bus.on(channel, (payload) => {
			      if (publishing) {
			        console.warn(`[bwm] relationship re-entry suppressed on ${channel}`); // 审计痕迹：重入被拒绝
			        return;
			      }
			      publishing = true;
			      try {
			        const prev = { ...(context.get('relationship') || {}) };
			        const { delta, stage } = resolveRelationshipDelta(payload && payload.relationship_delta, sig.gain, prev);
			        const next = applyRelationshipSignal(context, { delta, reason: sig.reason, stage });
			        const changed = prev.stage !== next.stage || prev.intimacy !== next.intimacy;
			        // [0071] 更新结果经订阅通知机制广播 → 各视图据此对齐，避免出现不同视图显示不同关系状态
			        bus.emit('relationship:changed', {
			          stage: next.stage, intimacy: next.intimacy, reason: next.lastReason, changed,
			          prevStage: prev.stage, prevIntimacy: prev.intimacy,
			        });
			      } finally {
			        publishing = false;
			      }
			    })
			  );
			  return () => off.forEach((d) => d());
			}

			/* ── Presence 状态机（P1.4：事件 → presence 状态，纯逻辑无 DOM）──
			 * Shell 渲染层订阅 bus 'presence:state'（或 context.watch('presence')）应用视觉
			 */
			function createPresenceMachine(bus, context) {
			  let resetTimer = null;
			  let generation = 0;
			  let disposed = false;
			  const applyState = (state, transient) => {
			    clearTimeout(resetTimer);
			    resetTimer = null;
			    const currentGeneration = ++generation;
			    context.set('presence', { ...context.get('presence'), state, at: new Date().toISOString() });
			    if (disposed || generation !== currentGeneration) return;
			    bus.emit('presence:state', { state });
			    if (transient > 0 && generation === currentGeneration && !disposed) {
			      resetTimer = setTimeout(() => {
			        if (!disposed && generation === currentGeneration) applyState('idle', 0);
			      }, transient);
			    }
			  };
			  const setPresence = (state, { transient = 0 } = {}) => {
			    if (disposed || (context.get('presence') || {}).state === state) return; // 幂等
			    applyState(state, transient);
			  };
			  const off = [
			    bus.on('agent.thinking.start', () => setPresence('thinking'), { replay: false }),
			    bus.on('agent.thinking.end', () => setPresence('idle'), { replay: false }),
			    bus.on('agent.tool.call', () => setPresence('executing'), { replay: false }),
			    bus.on('agent.tool.result', () => setPresence('thinking'), { replay: false }),
			    bus.on('agent.task.success', () => setPresence('success', { transient: 1400 }), { replay: false }),
			    bus.on('agent.task.failed', () => setPresence('error', { transient: 2000 }), { replay: false }),
			  ];
			  applyState('idle', 0); // 初始态
			  return () => {
			    disposed = true;
			    generation++;
			    clearTimeout(resetTimer);
			    off.forEach(d => d());
			  };
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

			/**
			 * 家族边界接线（专利4 ⇄ 专利5）：把感知路由器产出的「候选写入指令」消费为关系账本条目。
			 *
			 * 感知路由器只决策"某域是否允许写入"，**不做关系增量计算、不写关系账本**（其文件头声明）；
			 * 本函数即那条声明所指的「账本端」——准入后的确定性增量计算与账本写入由关系账本模块独占。
			 * 共享事件标识（update.eventId）在此串联感知侧与账本侧，保证同源可溯。
			 */
			function bridgePerceptionToLedger(ledger, update, opts = {}) {
			  if (!ledger || !update) return { ok: false, error: 'missing_ledger_or_update' };
			  // 准入复核（P1 修复 · 家族边界：账本端独占最终准入）：仅当指令确实落在持久域（ledger）
			  // 且获准持久化（PERSIST）才可进账本；易失/延迟/拒绝指令被强行桥接时拒绝并如实返回，
			  // 持久化准入不可经桥接旁路。
			  if (update.domain !== 'ledger' || update.mode !== UPDATE_MODES.PERSIST) {
			    return { ok: false, error: 'not_persist_granted', domain: update.domain || null, mode: update.mode || null };
			  }
			  const payload = update.payload || {};
			  return ledger.submit(
			    {
			      eventId: update.eventId,                 // 共享事件标识（跨域串联）
			      eventType: opts.eventType || 'companion_chat',
			      summary: payload.summary || '',
			      contextRef: opts.contextRef || null,
			      presenceState: opts.presenceState || null,
			      evidenceSource: 'perception',            // 感知派生事件 → 置信度系数 = 显著性÷10
			      subjectId: update.subjectId,
			      relationScope: update.relationScope,
			      salience: payload.salience == null ? 0 : payload.salience,
			      confidence: opts.confidence == null ? 1 : opts.confidence,
			      // 确认标记透传（账本端 admit 二次门复核）：优先取调用方显式值，否则取路由指令携带的确认信息
			      userConfirmed: opts.userConfirmed != null
			        ? !!opts.userConfirmed
			        : (payload.sourceType === 'explicit_share' || payload.userConfirmed === true),
			      at: update.at,
			    },
			    {
			      binding: {
			        subjectId: update.subjectId,
			        relationScope: update.relationScope,
			        evidenceSource: 'perception',
			        basis: 'perception_route_permitted',
			      },
			      snapshot: opts.snapshot || {},
			      at: update.at,
			    }
			  );
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
			  // Relationship Ledger（专利4 权1 六步机制链）：候选事件 → 准入 → 绑定溯源 → 快照 → 确定性增量 → 账本写入
			  const relationshipLedger = createRelationshipLedger(opts.relationshipLedger || {});
			  createPresenceMachine(bus, context); // Presence 状态机（事件 → presence 状态）
			  createRequestMachine(bus, context);  // Request 状态机（conversation.requestState 防重复）
			  let handshake = null;
			  return {
			    protocol: 'bwm',
			    version: '1.0',
			    bus,       // 事件总线（Shell 订阅渲染）
			    context,   // 共享上下文（Shell 只读 runtime 域；shellSet 写 shared 域）
			    relationshipLedger, // 关系账本（专利4：可验证/可重放的关系资产；查询与重放由调用方使用）
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
			  createRelationshipLedger,
			  RULE_TABLES,
			  LEDGER_ERRORS,
			  bridgePerceptionToLedger,
			  wireLedger,
			  updateTaskState,
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

			return module.exports;
		})();
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

		/* ── Ledger 账本 store（2026-09-10 B2 反超第一步 / 专利4 实施例）──
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
		      queueConfigWrite((cfg) => ({ ...cfg, mode })); // 2026-09-26：过全局串行链防读改写竞态
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
		  // 2026-09-26 修复「拖完弹回原位」（README Known Limitations 根因）：原 pointerup 把
		  // right/bottom 重置回 BTN_BASE_POS——拖动只是 transform 视觉假象，松手即归位。
		  // 现在：落点即新位（transform 位移折算进 right/bottom 并 clamp 在视口内）。
		  let dragging = false, moved = 0, sx = 0, sy = 0;
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
		  // 2026-09-10 B2 反超第一步：wireLedger 落盘（专利4 实施例：persist→reload→Agent 可用）——
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
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
