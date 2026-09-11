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
    compensate: (failed, appliedList) => compensated.push({ failed: failed.domain, applied: appliedList.length }),
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
  assert.ok(compensated.length > 0, '应触发补偿回调');
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
