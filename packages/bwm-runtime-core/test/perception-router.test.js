const test = require('node:test');
const assert = require('node:assert');
const {
  createPerceptionRouter,
  DOMAIN_CLASS,
  UPDATE_MODES,
  PERCEPTION_ERRORS,
} = require('../src/perception-router.js');

/* ── 专利5 交底书 v0.3 §八：跨域一致性编排证据（非采样 Benchmark）── */

function makeClock(t0 = 1_000_000) {
  let t = t0;
  return { now: () => t, advance: (ms) => (t += ms) };
}

function setup(extra = {}) {
  const clock = makeClock();
  const applied = [];
  const compensated = [];
  const router = createPerceptionRouter({
    now: clock.now,
    apply: (u) => {
      if (extra.failPersist && u.domainClass === DOMAIN_CLASS.PERSISTENT) throw new Error('ledger_write_failed');
      applied.push(u);
    },
    // 记录回调第二参数的完整内容（逐项补偿语义：每次只含当前被补偿的易失项）
    compensate: (failed, appliedList) => compensated.push({ failed: failed.domain, applied: appliedList }),
  });
  return { router, clock, applied, compensated };
}

function openConversational(router, cfg = {}) {
  return router.openSession(
    Object.assign(
      {
        subjectId: 'sub_001',
        allowedSources: ['camera', 'explicit_share'],
        schedule: { mode: 'conversational', intervalMs: 2500 },
        ttlMs: 4000,
      },
      cfg
    )
  );
}

test('会话生命周期：关闭会话后 ingest 被拒（销毁条件生效）', () => {
  const { router } = setup();
  const s = openConversational(router);
  assert.equal(router.ingest(s.sessionId, { sourceType: 'camera', salience: 5 }).ok, true);
  router.closeSession(s.sessionId);
  const r = router.ingest(s.sessionId, { sourceType: 'camera', salience: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.error, PERCEPTION_ERRORS.SESSION_CLOSED);
});

test('隐私/来源准入拒绝路径：非白名单来源与后台感知均被拒', () => {
  const { router } = setup();
  const s = openConversational(router);
  const bad = router.ingest(s.sessionId, { sourceType: 'microphone', salience: 9 });
  assert.equal(bad.error, PERCEPTION_ERRORS.SOURCE_NOT_ALLOWED);
  const bg = router.ingest(s.sessionId, { sourceType: 'camera', salience: 9, foreground: false });
  assert.equal(bg.error, PERCEPTION_ERRORS.PRIVACY_DENIED);
});

test('门控：低置信度与低显著性事件全域拒绝', () => {
  const { router } = setup();
  const s = openConversational(router);
  const lowConf = router.ingest(s.sessionId, { sourceType: 'camera', salience: 9, confidence: 0.1 });
  const d1 = router.decide(s.sessionId, lowConf.event).decision;
  assert.deepEqual(Object.values(d1.vector), [UPDATE_MODES.DENY, UPDATE_MODES.DENY, UPDATE_MODES.DENY]);

  const lowSal = router.ingest(s.sessionId, { sourceType: 'camera', salience: 1 });
  const d2 = router.decide(s.sessionId, lowSal.event).decision;
  assert.deepEqual(Object.values(d2.vector), [UPDATE_MODES.DENY, UPDATE_MODES.DENY, UPDATE_MODES.DENY]);
});

test('持久性默认值不对称：易失运行状态域默认易失，持久历史状态域默认拒绝', () => {
  const { router } = setup();
  const s = openConversational(router);
  const ev = router.ingest(s.sessionId, { sourceType: 'camera', salience: 5 });
  const d = router.decide(s.sessionId, ev.event).decision;
  assert.equal(d.vector.presence, UPDATE_MODES.VOLATILE);
  assert.equal(d.vector.conversation, UPDATE_MODES.VOLATILE);
  assert.equal(d.vector.ledger, UPDATE_MODES.DENY);
  assert.ok(d.reasons.ledger.includes('not_explicit_or_confirmed'));
});

test('持久化准入：显式分享+高显著+关系范围匹配才获准持久写入', () => {
  const { router } = setup();
  const s = openConversational(router);
  const ok = router.ingest(s.sessionId, { sourceType: 'explicit_share', salience: 8 });
  assert.equal(router.decide(s.sessionId, ok.event).decision.vector.ledger, UPDATE_MODES.PERSIST);

  const lowSal = router.ingest(s.sessionId, { sourceType: 'explicit_share', salience: 5 });
  assert.equal(router.decide(s.sessionId, lowSal.event).decision.vector.ledger, UPDATE_MODES.DENY);

  const wrongScope = router.ingest(s.sessionId, { sourceType: 'explicit_share', salience: 8, relationScope: 'sub_other' });
  const d = router.decide(s.sessionId, wrongScope.event).decision;
  assert.equal(d.vector.ledger, UPDATE_MODES.DENY);
  assert.ok(d.reasons.ledger.includes('relation_scope_mismatch'));
});

test('迟到事件隔离：所属轮次已完成 → 会话域延迟到下一轮，持久域拒绝，不回写已完成轮', () => {
  const { router, applied } = setup();
  const s = openConversational(router);
  router.markRoundComplete(7);
  const ev = router.ingest(s.sessionId, { sourceType: 'explicit_share', salience: 9, roundId: 7 });
  const d = router.decide(s.sessionId, ev.event).decision;
  assert.equal(d.vector.presence, UPDATE_MODES.DEFER);
  assert.equal(d.vector.conversation, UPDATE_MODES.DEFER);
  assert.equal(d.vector.ledger, UPDATE_MODES.DENY);
  assert.ok(d.reasons.presence.includes('late_event_isolation'));

  const { updates } = router.route(s.sessionId, ev.event, d);
  const res = router.commit(s.sessionId, updates);
  assert.equal(res.applied.length, 0); // 已完成轮零写入
  assert.equal(res.deferred.length, 2);
  assert.equal(applied.length, 0);
  const next = router.drainDeferred();
  assert.equal(next.length, 2);
  assert.ok(next.every((u) => u.eventId === ev.event.eventId && u.mode === UPDATE_MODES.DEFER));
});

test('过期（不新鲜）事件：易失域延迟、持久域拒绝', () => {
  const { router, clock } = setup();
  const s = openConversational(router);
  const ev = router.ingest(s.sessionId, { sourceType: 'explicit_share', salience: 9, ttlMs: 1000 });
  clock.advance(1500);
  const d = router.decide(s.sessionId, ev.event).decision;
  assert.equal(d.vector.presence, UPDATE_MODES.DEFER);
  assert.equal(d.vector.ledger, UPDATE_MODES.DENY);
  assert.ok(d.reasons.presence.includes('stale_event'));
});

test('部分失败补偿：持久域写入失败 → 易失更新被补偿、持久指令标记待重试、无残留易失副作用', () => {
  const { router, compensated } = setup({ failPersist: true });
  const s = openConversational(router);
  const ev = router.ingest(s.sessionId, { sourceType: 'explicit_share', salience: 9 });
  const d = router.decide(s.sessionId, ev.event).decision;
  const { updates } = router.route(s.sessionId, ev.event, d);
  const res = router.commit(s.sessionId, updates);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'ledger_write_failed');
  assert.equal(res.pendingPersist.length, 1);
  assert.equal(res.pendingPersist[0].domain, 'ledger');
  assert.equal(res.applied.filter((u) => u.domainClass === DOMAIN_CLASS.VOLATILE).length, 0);
  // 逐项补偿语义（修复后）：每个易失项各补偿一次，回调第二参数只含该易失项
  assert.equal(compensated.length, 2, 'presence 与 conversation 各补偿一次');
  assert.deepEqual(
    compensated.map((c) => c.applied.map((x) => x.domain)),
    [['presence'], ['conversation']],
    '补偿回调收到的第二参数只含对应易失项（不传全量 applied）'
  );
});

test('会话关闭后 route/commit 被拒（SESSION_CLOSED）：预生成指令不得再执行', () => {
  const { router, applied } = setup();
  const s = openConversational(router);
  const ev = router.ingest(s.sessionId, { sourceType: 'explicit_share', salience: 9 }); // 显式分享 → 三域均产出指令
  const d = router.decide(s.sessionId, ev.event).decision;
  const { updates } = router.route(s.sessionId, ev.event, d); // 关闭前产出指令
  assert.equal(updates.length, 3);
  router.closeSession(s.sessionId);
  const r1 = router.route(s.sessionId, ev.event, d);
  assert.equal(r1.ok, false);
  assert.equal(r1.error, PERCEPTION_ERRORS.SESSION_CLOSED);
  const r2 = router.commit(s.sessionId, updates);
  assert.equal(r2.ok, false);
  assert.equal(r2.error, PERCEPTION_ERRORS.SESSION_CLOSED);
  assert.equal(applied.length, 0, '会话销毁即失效：关闭后 commit 不得 apply');
});

test('部分失败搁置：持久失败后剩余指令不再静默丢弃（pendingPersist 收编持久项，shelved 如实列出）', () => {
  const clock = makeClock();
  const applied = [];
  const router = createPerceptionRouter({
    now: clock.now,
    apply: (u) => {
      if (u.domain === 'ledger') throw new Error('ledger_down'); // ledger 失败，memory 尚未到达
      applied.push(u);
    },
    domains: {
      presence: { class: DOMAIN_CLASS.VOLATILE },
      ledger: { class: DOMAIN_CLASS.PERSISTENT },
      memory: { class: DOMAIN_CLASS.PERSISTENT },
    },
  });
  const s = router.openSession({ subjectId: 'sub_001', allowedSources: ['explicit_share'] });
  const ev = router.ingest(s.sessionId, { sourceType: 'explicit_share', salience: 9 });
  const d = router.decide(s.sessionId, ev.event).decision;
  const { updates } = router.route(s.sessionId, ev.event, d);
  const res = router.commit(s.sessionId, updates);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'ledger_down');
  assert.equal(res.applied.length, 0, '易失更新已被补偿，无残留');
  assert.deepEqual(res.pendingPersist.map((u) => u.domain), ['ledger', 'memory'], '失败项 + 剩余持久项均入待重试');
  assert.equal(res.shelved.length, 1, '被搁置项如实列出（向后兼容新增字段）');
  assert.equal(res.shelved[0].domain, 'memory');
});

test('延迟项过期即丢弃（drain 防死循环），未过期项正常取出并记审计', () => {
  const { router, clock } = setup();
  const s = openConversational(router);
  // 过期项：轮次 7 已完成 → DEFER 入队
  router.markRoundComplete(7);
  const evA = router.ingest(s.sessionId, { sourceType: 'camera', salience: 6, roundId: 7 });
  router.commit(s.sessionId, router.route(s.sessionId, evA.event, router.decide(s.sessionId, evA.event).decision).updates);
  clock.advance(3000);
  // 新鲜项：轮次 9 已完成 → DEFER 入队，但 TTL 窗口更晚
  router.markRoundComplete(9);
  const evB = router.ingest(s.sessionId, { sourceType: 'camera', salience: 6, roundId: 9 });
  router.commit(s.sessionId, router.route(s.sessionId, evB.event, router.decide(s.sessionId, evB.event).decision).updates);

  clock.advance(2000); // evA（TTL 4000，起点 t0）已过期；evB（起点 t0+3000）仍在窗口内
  const drained = router.drainDeferred();
  assert.equal(drained.length, 2, '过期延迟项被丢弃，不再回塞（切断死循环）；evB 的 2 条易失指令正常取出');
  assert.ok(drained.every((u) => u.eventId === evB.event.eventId), '未过期项正常取出');
  const drops = router.auditLog().filter((r) => r.dropped === 'deferred_expired');
  assert.equal(drops.length, 2, '过期丢弃记审计（evA 的 presence/conversation 各一条）');
  assert.ok(drops.every((r) => r.eventId === evA.event.eventId));
});

test('有界运行时：closed 会话 FIFO 淘汰（保留最近 50）', () => {
  const { router } = setup();
  const ids = [];
  for (let i = 0; i < 55; i++) ids.push(openConversational(router).sessionId);
  for (const id of ids) router.closeSession(id);
  // 最旧的 5 个已淘汰：访问返回 session_not_found（而非 session_closed）
  assert.equal(router.ingest(ids[0], { sourceType: 'camera' }).error, PERCEPTION_ERRORS.SESSION_NOT_FOUND);
  assert.equal(router.ingest(ids[4], { sourceType: 'camera' }).error, PERCEPTION_ERRORS.SESSION_NOT_FOUND);
  assert.equal(router.ingest(ids[5], { sourceType: 'camera' }).error, PERCEPTION_ERRORS.SESSION_CLOSED, '保留窗口内 closed 会话仍可识别');
  assert.equal(router.ingest(ids[54], { sourceType: 'camera' }).error, PERCEPTION_ERRORS.SESSION_CLOSED);
});

test('有界运行时：轮次完成标记滚动保留最近 100', () => {
  const { router } = setup();
  const s = openConversational(router);
  for (let r = 1; r <= 100; r++) router.markRoundComplete(r);
  router.markRoundComplete(101); // 触发滚动：轮次 1 被淘汰
  const evOld = router.ingest(s.sessionId, { sourceType: 'camera', salience: 6, roundId: 1 });
  const dOld = router.decide(s.sessionId, evOld.event).decision;
  assert.equal(dOld.vector.presence, UPDATE_MODES.VOLATILE, '最旧轮次标记已滚出 → 不再判迟到');
  const evNew = router.ingest(s.sessionId, { sourceType: 'camera', salience: 6, roundId: 101 });
  const dNew = router.decide(s.sessionId, evNew.event).decision;
  assert.equal(dNew.vector.presence, UPDATE_MODES.DEFER, '窗口内轮次仍判迟到');
});

test('有界运行时：延迟队列上限 200（超出丢最旧并记审计）', () => {
  const { router } = setup();
  const s = openConversational(router);
  const mk = (i) => ({
    domain: 'presence', domainClass: DOMAIN_CLASS.VOLATILE, mode: UPDATE_MODES.DEFER,
    eventId: 'e_' + i, subjectId: 'sub_001', relationScope: 'sub_001',
    policyVersion: 'policy-v1', payload: {}, at: 0, expiresAt: Number.MAX_SAFE_INTEGER,
  });
  for (let i = 0; i < 202; i++) router.commit(s.sessionId, [mk(i)]);
  const drained = router.drainDeferred();
  assert.equal(drained.length, 200, '队列守住 200 上限');
  assert.equal(drained[0].eventId, 'e_2', '最旧的 2 条被丢弃');
  assert.ok(router.auditLog().some((r) => r.dropped === 'late_queue_overflow'), '溢出丢弃记审计');
});

test('有界运行时：审计数组滚动上限 500（保留最近）', () => {
  const { router } = setup();
  const s = openConversational(router);
  let lastEventId = null;
  for (let i = 0; i < 510; i++) {
    const ev = router.ingest(s.sessionId, { sourceType: 'camera', salience: 6 });
    router.decide(s.sessionId, ev.event);
    lastEventId = ev.event.eventId;
  }
  const log = router.auditLog();
  assert.equal(log.length, 500, '审计守住 500 上限');
  assert.equal(log[log.length - 1].eventId, lastEventId, '保留的是最近记录');
});

test('策略版本冲突：版本不一致的指令被整体拒绝（零副作用）', () => {
  const { router, applied } = setup();
  const s = openConversational(router, { policyVersion: 'policy-v2' });
  const ev = router.ingest(s.sessionId, { sourceType: 'camera', salience: 6 });
  const d = router.decide(s.sessionId, ev.event).decision;
  const { updates } = router.route(s.sessionId, ev.event, d);
  const conflicted = updates.map((u) => Object.assign({}, u, { policyVersion: 'policy-v1' }));
  const res = router.commit(s.sessionId, conflicted);
  assert.equal(res.ok, false);
  assert.equal(res.error, PERCEPTION_ERRORS.POLICY_VERSION_CONFLICT);
  assert.equal(applied.length, 0);
});

test('同一事件标识串联各域更新指令（可追溯、可撤销）', () => {
  const { router } = setup();
  const s = openConversational(router);
  const ev = router.ingest(s.sessionId, { sourceType: 'explicit_share', salience: 9 });
  const d = router.decide(s.sessionId, ev.event).decision;
  const { updates } = router.route(s.sessionId, ev.event, d);
  assert.equal(updates.length, 3);
  assert.ok(updates.every((u) => u.eventId === ev.event.eventId));
  assert.ok(updates.every((u) => u.subjectId === 'sub_001' && u.policyVersion === 'policy-v1'));
});

test('域扩展性（演化空间）：新增 emotion/memory/task 域按类默认语义生效', () => {
  const clock = makeClock();
  const applied = [];
  const router = createPerceptionRouter({
    now: clock.now,
    apply: (u) => applied.push(u),
    domains: {
      presence: { class: DOMAIN_CLASS.VOLATILE },
      emotion: { class: DOMAIN_CLASS.VOLATILE },
      memory: { class: DOMAIN_CLASS.PERSISTENT },
      task: { class: DOMAIN_CLASS.PERSISTENT },
    },
  });
  const s = router.openSession({ subjectId: 'sub_001', allowedSources: ['camera'] });
  const ev = router.ingest(s.sessionId, { sourceType: 'camera', salience: 6 });
  const d = router.decide(s.sessionId, ev.event).decision;
  assert.equal(d.vector.presence, UPDATE_MODES.VOLATILE);
  assert.equal(d.vector.emotion, UPDATE_MODES.VOLATILE);
  assert.equal(d.vector.memory, UPDATE_MODES.DENY);
  assert.equal(d.vector.task, UPDATE_MODES.DENY);
});

test('审计视图：决策历史含事件标识与策略版本（可重放依据）', () => {
  const { router } = setup();
  const s = openConversational(router);
  const ev = router.ingest(s.sessionId, { sourceType: 'camera', salience: 6 });
  router.decide(s.sessionId, ev.event);
  const log = router.auditLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].eventId, ev.event.eventId);
  assert.equal(log[0].policyVersion, 'policy-v1');
});
