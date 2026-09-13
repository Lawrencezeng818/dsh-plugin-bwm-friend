const test = require('node:test');
const assert = require('node:assert');
const { createPerceptionRouter } = require('../src/perception-router.js');
const { createRelationshipLedger } = require('../src/relationship-ledger.js');
const { bridgePerceptionToLedger } = require('../src/index.js');

/* ── 家族边界接线（专利4 ⇄ 专利5）：感知路由「候选写入指令」→ 关系账本写入 ── */

function makeClock(t0 = 1_700_000_000_000) {
  let t = t0;
  return { now: () => t, advance: (ms) => (t += ms) };
}

function setupPipeline() {
  const clock = makeClock();
  const router = createPerceptionRouter({ now: clock.now });
  const ledger = createRelationshipLedger({ now: clock.now });
  const session = router.openSession({ subjectId: 'u_1', allowedSources: ['camera'] });
  return { clock, router, ledger, session };
}

function route(s, raw) {
  const ing = s.router.ingest(s.session.sessionId, raw);
  assert.strictEqual(ing.ok, true, 'ingest 应成功：' + JSON.stringify(ing));
  const dec = s.router.decide(s.session.sessionId, ing.event);
  assert.strictEqual(dec.ok, true);
  const routed = s.router.route(s.session.sessionId, ing.event, dec.decision);
  assert.strictEqual(routed.ok, true);
  return { event: ing.event, updates: routed.updates };
}

test('接线：感知事件经门控后写入关系账本，共享事件标识跨模块一致', () => {
  const s = setupPipeline();
  const { event, updates } = route(s, {
    sourceType: 'camera',
    salience: 8,
    confidence: 0.9,
    summary: '桌面上出现图形',
    userConfirmed: true,
    foreground: true,
  });

  const ledgerUpdates = updates.filter((u) => u.domain === 'ledger');
  assert.strictEqual(ledgerUpdates.length, 1, '持久域应产出 1 条候选写入指令');
  assert.strictEqual(ledgerUpdates[0].mode, 'persist');

  const r = bridgePerceptionToLedger(s.ledger, ledgerUpdates[0], {
    eventType: 'companion_chat',
    presenceState: 'focused',
    contextRef: 'sess_1',
    snapshot: { userGoal: '视频通话', actionSummary: '主动评论桌面图形', outcome: 'completed' },
  });

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.entry.eventId, event.eventId, '共享事件标识必须跨模块一致');
  assert.strictEqual(r.entry.evidenceSource, 'perception');
  assert.strictEqual(r.entry.subjectId, 'u_1');
  assert.strictEqual(r.entry.provenance.basis, 'perception_route_permitted');
  // 感知派生：置信度系数 = 显著性÷10 = 0.8
  assert.ok(Math.abs(r.delta.factors.confidenceFactor - 0.8) < 1e-9);
  assert.strictEqual(s.ledger.size(), 1);
});

test('接线：未获准事件（低显著性）无候选写入指令 → 账本保持为空', () => {
  const s = setupPipeline();
  const { updates } = route(s, {
    sourceType: 'camera',
    salience: 1,          // 低于显著性门控
    confidence: 0.9,
    summary: '无关噪点',
    foreground: true,
  });
  assert.strictEqual(updates.filter((u) => u.domain === 'ledger').length, 0, '低显著性不得产出持久域指令');
  // 仅有易失域指令；即便强行桥接也应有明确失败路径
  const volatile = updates.find((u) => u.domain === 'presence');
  if (volatile) {
    const r = bridgePerceptionToLedger(s.ledger, volatile, {});
    assert.strictEqual(s.ledger.size(), 0, '未获准路径不得写入账本');
    assert.strictEqual(r.ok, false);
  }
});

test('接线：持久域未获显式确认/分享 → 拒绝持久化 → 账本为空', () => {
  const s = setupPipeline();
  const { updates } = route(s, {
    sourceType: 'camera',
    salience: 9,
    confidence: 0.9,
    summary: '高显著性但未确认',
    foreground: true,
    userConfirmed: false,
  });
  assert.strictEqual(updates.filter((u) => u.domain === 'ledger').length, 0, '未显式确认不得持久化');
  assert.strictEqual(s.ledger.size(), 0);
});

test('接线：同一感知事件重复桥接 → 账本幂等，不重复计算关系增量', () => {
  const s = setupPipeline();
  const { updates } = route(s, {
    sourceType: 'camera',
    salience: 8,
    confidence: 0.9,
    summary: '同一场景',
    userConfirmed: true,
    foreground: true,
  });
  const u = updates.find((x) => x.domain === 'ledger');
  const r1 = bridgePerceptionToLedger(s.ledger, u, { eventType: 'companion_chat' });
  const r2 = bridgePerceptionToLedger(s.ledger, u, { eventType: 'companion_chat' });
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.idempotent, true);
  assert.strictEqual(s.ledger.size(), 1);
});
