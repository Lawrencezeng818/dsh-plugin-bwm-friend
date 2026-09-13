const test = require('node:test');
const assert = require('node:assert');
const {
  createRelationshipLedger,
  RULE_TABLES,
  LEDGER_ERRORS,
  evidenceFactorOf,
} = require('../src/relationship-ledger.js');

/* ── 专利4 权1 六步机制链：契约证据（非界面测试）── */

const DAY = 86400000;

function makeClock(t0 = 1_700_000_000_000) {
  let t = t0;
  return { now: () => t, set: (v) => (t = v), advance: (ms) => (t += ms) };
}

function setup(extra = {}) {
  const clock = makeClock();
  const ledger = createRelationshipLedger(Object.assign({ now: clock.now }, extra));
  return { clock, ledger };
}

/* ── 步骤一：候选事件获取 ── */

test('步骤一：候选事件含事件标识/类型/摘要/上下文引用/在场状态，缺省由运行侧写入', () => {
  const { ledger } = setup();
  const e = ledger.submitCandidate({
    eventType: 'generated_template',
    summary: '生成产品发布方案 PPT',
    contextRef: 'ds_session_88',
    presenceState: 'focused',
  });
  assert.match(e.eventId, /^re_/);
  assert.strictEqual(e.eventType, 'generated_template');
  assert.strictEqual(e.contextRef, 'ds_session_88');
  assert.strictEqual(e.presenceState, 'focused');
  assert.strictEqual(e.evidenceSource, 'runtime', '行为事件由智能体运行侧写入');
});

test('步骤一：未显式给出事件标识时自动生成，且互不重复', () => {
  const { ledger } = setup();
  const a = ledger.submitCandidate({ eventType: 'companion_chat' });
  const b = ledger.submitCandidate({ eventType: 'companion_chat' });
  assert.notStrictEqual(a.eventId, b.eventId);
});

/* ── 步骤二：准入判断 ── */

test('步骤二：置信度低于阈值 → 不准入', () => {
  const { ledger } = setup();
  const e = ledger.submitCandidate({ eventType: 'companion_chat', salience: 8, confidence: 0.2 });
  const a = ledger.admit(e);
  assert.strictEqual(a.ok, false);
  assert.deepStrictEqual(a.reasons, ['below_confidence_gate']);
});

test('步骤二：显著性低于阈值 → 不准入', () => {
  const { ledger } = setup();
  const e = ledger.submitCandidate({ eventType: 'companion_chat', salience: 1, confidence: 0.9 });
  const a = ledger.admit(e);
  assert.strictEqual(a.ok, false);
  assert.ok(a.reasons.indexOf('below_salience_gate') >= 0);
});

test('步骤二：隐私策略不允许 → 不准入', () => {
  const { ledger } = setup();
  const e = ledger.submitCandidate({ eventType: 'companion_chat', salience: 8, privacyAllowed: false });
  const a = ledger.admit(e);
  assert.strictEqual(a.ok, false);
  assert.ok(a.reasons.indexOf('privacy_denied') >= 0);
});

test('步骤二：三项门控全过 → 获准，且记录准入策略版本', () => {
  const { ledger } = setup();
  const e = ledger.submitCandidate({ eventType: 'code_analysis', salience: 6, confidence: 0.8 });
  const a = ledger.admit(e);
  assert.strictEqual(a.ok, true);
  assert.deepStrictEqual(a.reasons, ['admitted']);
  assert.match(a.policyVersion, /^admission-s/);
});

/* ── 步骤三：绑定与溯源 ── */

test('步骤三：缺主体标识 → 拒绝绑定', () => {
  const { ledger } = setup();
  const e = ledger.submitCandidate({ eventType: 'tool_execution', salience: 5 });
  const b = ledger.bind(e, {});
  assert.strictEqual(b.ok, false);
  assert.strictEqual(b.error, LEDGER_ERRORS.NOT_BOUND);
});

test('步骤三：关系范围不匹配 → 拒绝绑定（跨主体事件不写入）', () => {
  const { ledger } = setup();
  const e = ledger.submitCandidate({ eventType: 'tool_execution', salience: 5, subjectId: 'u_1', relationScope: 'u_1' });
  const b = ledger.bind(e, { subjectId: 'u_1', relationScope: 'u_1', expectedScope: 'u_2' });
  assert.strictEqual(b.ok, false);
  assert.strictEqual(b.error, LEDGER_ERRORS.RELATION_SCOPE_MISMATCH);
});

test('步骤三：绑定成功 → 产出主体标识、关系范围、证据来源与溯源元数据', () => {
  const { ledger } = setup();
  const e = ledger.submitCandidate({ eventType: 'tool_execution', salience: 5, subjectId: 'u_1', contextRef: 'sess_7' });
  const b = ledger.bind(e, { subjectId: 'u_1' });
  assert.strictEqual(b.ok, true);
  assert.strictEqual(b.subjectId, 'u_1');
  assert.strictEqual(b.relationScope, 'u_1');
  assert.strictEqual(b.evidenceSource, 'runtime');
  assert.strictEqual(b.provenance.at, e.at);
  assert.strictEqual(b.provenance.basis, 'admission_passed');
  assert.strictEqual(b.provenance.sessionRef, 'sess_7');
});

/* ── 步骤四：上下文快照关联 ── */

test('步骤四：快照含用户目标/行为摘要/结果状态，结果状态缺省为 completed', () => {
  const { ledger } = setup();
  const s1 = ledger.attachSnapshot({ userGoal: '完成产品发布方案', actionSummary: '市场分析+PPT' });
  assert.strictEqual(s1.outcome, 'completed');
  const s2 = ledger.attachSnapshot({ userGoal: 'g', actionSummary: 'a', outcome: 'cancelled' });
  assert.strictEqual(s2.outcome, 'cancelled');
});

/* ── 步骤五：确定性增量计算 ── */

test('步骤五：增量 = 事件类型权重 × 结果系数 × 置信度系数（按维度分配）', () => {
  const { ledger } = setup();
  const e = ledger.submitCandidate({ eventType: 'generated_template', salience: 9, confidence: 1, at: 0 });
  const b = ledger.bind(e, { subjectId: 'u_1' });
  const snap = ledger.attachSnapshot({ outcome: 'completed' });
  const d = ledger.computeDelta(e, b, snap, 0);
  assert.strictEqual(d.ok, true);
  // 1.0 × 1.0 × 1.0 = 1.0；trust 分配 0.5
  assert.strictEqual(d.factors.base, 1);
  assert.ok(Math.abs(d.delta.trust - 0.5) < 1e-9, 'trust 应为 0.5');
  assert.ok(Math.abs(d.delta.intimacy - 0.4) < 1e-9, 'intimacy 应为 0.4');
  assert.ok(Math.abs(d.delta.familiarity - 0.3) < 1e-9, 'familiarity 应为 0.3');
});

test('步骤五：事件类型权重差异生效（mode_switch 远低于 generated_template）', () => {
  const { ledger } = setup();
  const mk = (type) => {
    const e = ledger.submitCandidate({ eventType: type, salience: 9, confidence: 1, at: 0 });
    const b = ledger.bind(e, { subjectId: 'u_1' });
    return ledger.computeDelta(e, b, ledger.attachSnapshot({ outcome: 'completed' }), 0);
  };
  const hi = mk('generated_template');
  const lo = mk('mode_switch');
  assert.ok(hi.factors.base > lo.factors.base * 4, '模板生成权重应显著高于模式切换');
  assert.ok(Math.abs(lo.factors.weight - 0.2) < 1e-9);
});

test('步骤五：结果状态系数生效（completed > partial > cancelled）', () => {
  const { ledger } = setup();
  const mk = (outcome) => {
    const e = ledger.submitCandidate({ eventType: 'code_analysis', salience: 9, confidence: 1, at: 0 });
    const b = ledger.bind(e, { subjectId: 'u_1' });
    return ledger.computeDelta(e, b, ledger.attachSnapshot({ outcome }), 0);
  };
  const c = mk('completed').factors.base;
  const p = mk('partial').factors.base;
  const x = mk('cancelled').factors.base;
  assert.ok(c > p && p > x, '完成 > 完成含失败段 > 取消');
  assert.ok(Math.abs(p / c - 0.7) < 1e-9);
  assert.ok(Math.abs(x / c - 0.2) < 1e-9);
});

test('步骤五：证据置信度系数生效（运行侧 1.0 / 用户确认 0.9 / 感知派生=显著性÷10）', () => {
  const { ledger } = setup();
  const rules = RULE_TABLES['rules-v1.0'];
  assert.strictEqual(evidenceFactorOf({ salience: 0 }, 'runtime', rules), 1.0);
  assert.strictEqual(evidenceFactorOf({ salience: 0, userConfirmed: true }, 'runtime', rules), 0.9);
  assert.strictEqual(evidenceFactorOf({ salience: 8 }, 'perception', rules), 0.8);

  const e = ledger.submitCandidate({ eventType: 'companion_chat', salience: 8, confidence: 1, at: 0, userConfirmed: true });
  const b = ledger.bind(e, { subjectId: 'u_1' });
  const d = ledger.computeDelta(e, b, ledger.attachSnapshot({ outcome: 'completed' }), 0);
  assert.ok(Math.abs(d.factors.confidenceFactor - 0.9) < 1e-9);
});

test('步骤五：时间衰减生效（Δ(t)=Δ₀·e^(−λ·Δdays)）', () => {
  const { ledger } = setup();
  const e = ledger.submitCandidate({ eventType: 'generated_template', salience: 9, confidence: 1, at: 0 });
  const b = ledger.bind(e, { subjectId: 'u_1' });
  const snap = ledger.attachSnapshot({ outcome: 'completed' });
  const fresh = ledger.computeDelta(e, b, snap, 0);
  const aged = ledger.computeDelta(e, b, snap, 1000 * DAY);
  assert.ok(Math.abs(aged.delta.trust / fresh.delta.trust - Math.exp(-0.002 * 1000)) < 1e-6, 'trust 衰减率 0.002/天');
  assert.ok(Math.abs(aged.delta.intimacy / fresh.delta.intimacy - Math.exp(-0.001 * 1000)) < 1e-6, '亲密度衰减更慢');
  assert.ok(aged.delta.intimacy / fresh.delta.intimacy > aged.delta.trust / fresh.delta.trust, '亲密度衰减应慢于信任度');
});

test('步骤五：未知事件类型 / 未知结果状态 → 计算失败（不静默取零）', () => {
  const { ledger } = setup();
  const e = ledger.submitCandidate({ eventType: 'nope', salience: 9, confidence: 1, at: 0 });
  const b = ledger.bind(e, { subjectId: 'u_1' });
  const d = ledger.computeDelta(e, b, ledger.attachSnapshot({ outcome: 'completed' }), 0);
  assert.strictEqual(d.ok, false);
  assert.strictEqual(d.error, LEDGER_ERRORS.UNKNOWN_EVENT_TYPE);
  const e2 = ledger.submitCandidate({ eventType: 'tool_execution', salience: 9, confidence: 1, at: 0 });
  const b2 = ledger.bind(e2, { subjectId: 'u_1' });
  const d2 = ledger.computeDelta(e2, b2, ledger.attachSnapshot({ outcome: 'weird' }), 0);
  assert.strictEqual(d2.ok, false);
  assert.strictEqual(d2.error, LEDGER_ERRORS.UNKNOWN_OUTCOME);
});

/* ── 步骤六：账本写入（幂等 + 规则版本）── */

test('步骤六：submit 六步一次走通，账本条目含共享事件标识/溯源/快照/准入依据/规则版本/增量', () => {
  const { ledger } = setup();
  const r = ledger.submit(
    { eventType: 'generated_template', summary: '生成发布方案', contextRef: 'sess_1', presenceState: 'focused', salience: 9, confidence: 1 },
    { binding: { subjectId: 'u_1' }, snapshot: { userGoal: '发布方案', actionSummary: '市场分析+PPT', outcome: 'completed' } }
  );
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.stage, 'write');
  const e = r.entry;
  assert.match(e.eventId, /^re_/);
  assert.strictEqual(e.subjectId, 'u_1');
  assert.strictEqual(e.relationScope, 'u_1');
  assert.strictEqual(e.eventType, 'generated_template');
  assert.strictEqual(e.evidenceSource, 'runtime');
  assert.strictEqual(e.provenance.basis, 'admission_passed');
  assert.deepStrictEqual(e.snapshot, { userGoal: '发布方案', actionSummary: '市场分析+PPT', outcome: 'completed' });
  assert.strictEqual(e.admission.ok, true);
  assert.strictEqual(e.rulesVersion, 'rules-v1.0');
  assert.ok(e.delta.trust > 0);
  assert.strictEqual(ledger.size(), 1);
});

test('步骤六：同一共享事件标识重复写入 → 幂等，不重复计算', () => {
  const { ledger } = setup();
  const raw = { eventId: 'shared_evt_1', eventType: 'code_analysis', salience: 9, confidence: 1 };
  const ctx = { binding: { subjectId: 'u_1' }, snapshot: { outcome: 'completed' } };
  const r1 = ledger.submit(raw, ctx);
  const r2 = ledger.submit(raw, ctx);
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.idempotent, true, '第二次应标记幂等命中');
  assert.strictEqual(ledger.size(), 1, '账本中只应有一条');
  assert.strictEqual(r2.entry, null);
});

test('步骤六：写入阶段失败时可分别定位（准入失败不落账本）', () => {
  const { ledger } = setup();
  const r = ledger.submit(
    { eventType: 'companion_chat', salience: 9, confidence: 0.1 },
    { binding: { subjectId: 'u_1' }, snapshot: { outcome: 'completed' } }
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.stage, 'admit');
  assert.strictEqual(ledger.size(), 0, '未获准事件不得进入账本');
});

/* ── 重放（可验证 / 规则版本化）── */

test('重放：账本可确定性重建，结果与顺次累加一致', () => {
  const { ledger } = setup();
  const ctx = (subjectId) => ({ binding: { subjectId }, snapshot: { outcome: 'completed' } });
  ledger.submit({ eventType: 'generated_template', salience: 9, confidence: 1, at: 0 }, ctx('u_1'));
  ledger.submit({ eventType: 'tool_execution', salience: 9, confidence: 1, at: 1000 }, ctx('u_1'));
  const rep = ledger.replay();
  assert.strictEqual(rep.steps.length, 2);
  const expectTrust = rep.steps[0].step.trust + rep.steps[1].step.trust;
  assert.ok(Math.abs(rep.state.trust - expectTrust) < 1e-9);
  assert.deepStrictEqual(Object.keys(rep.steps[0].state), ['trust', 'intimacy', 'familiarity']);
});

test('重放：按条目内记录的规则版本执行（规则升级后历史条目不重算）', () => {
  const v11 = Object.assign({}, RULE_TABLES['rules-v1.0'], {
    version: 'rules-v1.1',
    decayPerDay: { trust: 0.02, intimacy: 0.02, familiarity: 0.02 },
  });
  const registry = Object.assign({}, RULE_TABLES, { 'rules-v1.1': v11 });
  const { ledger } = setup({ rules: registry });

  // 两条事件，分别以不同规则版本计算
  ledger.submit({ eventType: 'generated_template', salience: 9, confidence: 1, at: 0 }, {
    binding: { subjectId: 'u_1' }, snapshot: { outcome: 'completed' }, rulesVersion: 'rules-v1.0',
  });
  ledger.submit({ eventType: 'generated_template', salience: 9, confidence: 1, at: 0 }, {
    binding: { subjectId: 'u_1' }, snapshot: { outcome: 'completed' }, rulesVersion: 'rules-v1.1',
  });

  const all = ledger.all();
  assert.deepStrictEqual(all.map((e) => e.rulesVersion), ['rules-v1.0', 'rules-v1.1']);

  const rep = ledger.replay({ at: 100 * DAY });
  // 由条目内版本决定衰减：v1.0 的 trust λ=0.002，v1.1 的 λ=0.02
  assert.ok(Math.abs(rep.steps[0].step.trust - 0.5 * Math.exp(-0.002 * 100)) < 1e-9);
  assert.ok(Math.abs(rep.steps[1].step.trust - 0.5 * Math.exp(-0.02 * 100)) < 1e-9);
  assert.ok(rep.steps[1].step.trust < rep.steps[0].step.trust, '高衰减版本的有效值应更低');
});

/* ── 关系资产查询（权6）── */

test('查询：按时间 / 事件类型 / 主题过滤，并给出各维度累计', () => {
  const { ledger } = setup();
  const ctx = (extra) => Object.assign({ binding: { subjectId: 'u_1' }, snapshot: { outcome: 'completed' } }, extra);
  ledger.submit({ eventType: 'generated_template', summary: '生成项目方案', contextRef: 'proj_a', salience: 9, confidence: 1, at: 1000 }, ctx());
  ledger.submit({ eventType: 'code_analysis', summary: '修改代码', contextRef: 'proj_a', salience: 9, confidence: 1, at: 2000 }, ctx());
  ledger.submit({ eventType: 'companion_chat', summary: '日常闲聊', contextRef: 'chat_b', salience: 9, confidence: 1, at: 3000 }, ctx());

  const all = ledger.report();
  assert.strictEqual(all.count, 3);
  assert.deepStrictEqual(all.timeRange, [1000, 3000]);

  const byType = ledger.report({ eventTypes: ['code_analysis'] });
  assert.strictEqual(byType.count, 1);
  assert.strictEqual(byType.entries[0].eventType, 'code_analysis');

  const byTopic = ledger.report({ topic: 'proj_a' });
  assert.strictEqual(byTopic.count, 2, '按上下文引用聚类');

  const byTime = ledger.report({ from: 2000 });
  assert.strictEqual(byTime.count, 2);

  assert.ok(all.totals.trust > byType.totals.trust);
});

test('查询：时间线按发生时刻升序输出（关系资产报告的时间线语义）', () => {
  const { ledger } = setup();
  const ctx = { binding: { subjectId: 'u_1' }, snapshot: { outcome: 'completed' } };
  ledger.submit({ eventType: 'mode_switch', salience: 9, confidence: 1, at: 5000 }, ctx);
  ledger.submit({ eventType: 'generated_template', salience: 9, confidence: 1, at: 1000 }, ctx);
  const rep = ledger.report();
  assert.deepStrictEqual(rep.entries.map((e) => e.at), [1000, 5000]);
});

/* ── 持久层接线（可选注入）── */

test('持久层：注入 store 时逐条 append；append 抛错不阻断账本写入', () => {
  const appended = [];
  let boom = false;
  const store = {
    append(entry) {
      if (boom) throw new Error('disk full');
      appended.push(entry);
    },
  };
  const { ledger } = setup({ store });
  const ctx = { binding: { subjectId: 'u_1' }, snapshot: { outcome: 'completed' } };
  ledger.submit({ eventType: 'tool_execution', salience: 9, confidence: 1 }, ctx);
  assert.strictEqual(appended.length, 1);

  boom = true;
  const r = ledger.submit({ eventType: 'tool_execution', salience: 9, confidence: 1 }, ctx);
  assert.strictEqual(r.ok, true, '持久失败不应阻断账本写入');
  assert.strictEqual(ledger.size(), 2);
});

/* ── 与家族边界的一致性 ── */

test('边界：本模块不产出存在状态、不做跨域路由决策（只落关系账本）', () => {
  const { ledger } = setup();
  const api = Object.keys(ledger);
  for (const forbidden of ['presence', 'setPresence', 'decide', 'route', 'commit', 'openSession']) {
    assert.strictEqual(api.indexOf(forbidden), -1, '不得侵入专利2/专利5 的职责：' + forbidden);
  }
  assert.ok(api.indexOf('submit') >= 0);
  assert.ok(api.indexOf('replay') >= 0);
  assert.ok(api.indexOf('report') >= 0);
});
