const test = require('node:test');
const assert = require('node:assert');
const {
  createRelationshipLedger,
  RULE_TABLES,
  LEDGER_ERRORS,
  evidenceFactorOf,
} = require('../src/relationship-ledger.js');

/* ── 专利4 权1 七步机制链：契约证据（非界面测试）── */

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

test('步骤一：候选事件含全链路事件标识/类型/摘要/上下文引用/在场状态，缺省由运行侧写入', () => {
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

test('步骤一：候选事件区分事件发生时间与处理时间两个字段', () => {
  const { ledger, clock } = setup();
  clock.set(1000);
  const e = ledger.submitCandidate({ eventType: 'companion_chat', eventTime: 500 });
  assert.strictEqual(e.eventTime, 500, '事件发生时间可显式给定');
  assert.strictEqual(e.processTime, 1000, '处理时间为运行侧接收时刻');
  assert.strictEqual(e.at, 500, 'at 与 eventTime 保持一致（兼容别名）');
});

test('步骤一：未显式给出事件标识时自动生成，且互不重复', () => {
  const { ledger } = setup();
  const a = ledger.submitCandidate({ eventType: 'companion_chat' });
  const b = ledger.submitCandidate({ eventType: 'companion_chat' });
  assert.notStrictEqual(a.eventId, b.eventId);
});

/* ── 步骤二：多策略准入 ── */

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

test('步骤二：隐私策略不允许 → 不准入（隐私门控为必要条件）', () => {
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

test('步骤二：未知证据来源 → 拒绝准入（不默认按最高置信度放行）', () => {
  const { ledger } = setup();
  const e = ledger.submitCandidate({ eventType: 'tool_execution', salience: 8, confidence: 0.9, evidenceSource: 'mystery_feed' });
  const a = ledger.admit(e);
  assert.strictEqual(a.ok, false);
  assert.ok(a.reasons.indexOf(LEDGER_ERRORS.UNKNOWN_EVIDENCE_SOURCE) >= 0, '未知来源须显式拒绝');
});

test('步骤二：未知证据来源可配置为显式降级（降级系数生效，非按最高置信度放行）', () => {
  const { ledger } = setup({ unknownEvidencePolicy: 'degrade' });
  const e = ledger.submitCandidate({ eventType: 'tool_execution', salience: 8, confidence: 0.9, evidenceSource: 'mystery_feed' });
  const a = ledger.admit(e);
  assert.strictEqual(a.ok, true, '降级策略下放行');
  assert.strictEqual(a.evidencePolicy, 'degrade');
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
  assert.strictEqual(b.provenance.eventTime, e.eventTime);
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

test('步骤四：快照可泛化为事件上下文（感知类事件的目标/行为可为空）', () => {
  const { ledger } = setup();
  const s = ledger.attachSnapshot({ contextKind: 'perception', actionSummary: '检测到用户在座' });
  assert.strictEqual(s.userGoal, null);
  assert.strictEqual(s.contextKind, 'perception');
});

/* ── 步骤五：初始关系增量 Δ0（不含时间衰减）── */

test('步骤五：Δ0 = 事件类型权重 × 结果系数 × 置信度系数（按维度分配），不含时间衰减', () => {
  const { ledger } = setup();
  const e = ledger.submitCandidate({ eventType: 'generated_template', salience: 9, confidence: 1, at: 0 });
  const b = ledger.bind(e, { subjectId: 'u_1' });
  const snap = ledger.attachSnapshot({ outcome: 'completed' });
  const d = ledger.computeInitialDelta(e, b, snap);
  assert.strictEqual(d.ok, true);
  // 1.0 × 1.0 × 1.0 = 1.0；trust 分配 0.5
  assert.strictEqual(d.factors.base, 1);
  assert.ok(Math.abs(d.delta.trust - 0.5) < 1e-9, 'trust 应为 0.5');
  assert.ok(Math.abs(d.delta.intimacy - 0.4) < 1e-9, 'intimacy 应为 0.4');
  assert.ok(Math.abs(d.delta.familiarity - 0.3) < 1e-9, 'familiarity 应为 0.3');
  assert.deepStrictEqual(d.normalizedInput, {
    eventType: 'generated_template',
    outcome: 'completed',
    evidenceSource: 'runtime',
    salience: 9,
    userConfirmed: false,
  }, 'Δ0 计算的全部输入须固化为规范化输入');
});

test('步骤五：事件类型权重差异生效（mode_switch 远低于 generated_template）', () => {
  const { ledger } = setup();
  const mk = (type) => {
    const e = ledger.submitCandidate({ eventType: type, salience: 9, confidence: 1, at: 0 });
    const b = ledger.bind(e, { subjectId: 'u_1' });
    return ledger.computeInitialDelta(e, b, ledger.attachSnapshot({ outcome: 'completed' }));
  };
  const hi = mk('generated_template');
  const lo = mk('mode_switch');
  assert.ok(hi.factors.base > lo.factors.base * 4, '模板生成权重应显著高于模式切换');
  assert.ok(Math.abs(lo.factors.weight - 0.2) < 1e-9);
});

test('步骤五：结果状态系数生效（completed > partial > cancelled > failed=0）', () => {
  const { ledger } = setup();
  const mk = (outcome) => {
    const e = ledger.submitCandidate({ eventType: 'code_analysis', salience: 9, confidence: 1, at: 0 });
    const b = ledger.bind(e, { subjectId: 'u_1' });
    return ledger.computeInitialDelta(e, b, ledger.attachSnapshot({ outcome }));
  };
  const c = mk('completed').factors.base;
  const p = mk('partial').factors.base;
  const x = mk('cancelled').factors.base;
  const f = mk('failed');
  assert.ok(c > p && p > x, '完成 > 完成含失败段 > 取消');
  assert.ok(Math.abs(p / c - 0.7) < 1e-9);
  assert.ok(Math.abs(x / c - 0.2) < 1e-9);
  assert.strictEqual(f.ok, true, 'failed 为已定义枚举，须可计算而非"未知结果状态"');
  assert.strictEqual(f.factors.base, 0, '失败事件的增量口径：0（不因失败惩罚关系，也不产生正向增量）');
});

test('步骤五：证据置信度系数生效（运行侧 1.0 / 用户确认 0.9 / 感知派生=显著性÷10）', () => {
  const { ledger } = setup();
  const rules = RULE_TABLES['rules-v1.0'];
  assert.strictEqual(evidenceFactorOf({ salience: 0 }, 'runtime', rules), 1.0);
  assert.strictEqual(evidenceFactorOf({ salience: 0, userConfirmed: true }, 'runtime', rules), 0.9);
  assert.strictEqual(evidenceFactorOf({ salience: 8 }, 'perception', rules), 0.8);
  assert.strictEqual(evidenceFactorOf({ salience: 8 }, 'mystery', rules), null, '未知来源返回 null 而非默认 1.0');

  const e = ledger.submitCandidate({ eventType: 'companion_chat', salience: 8, confidence: 1, at: 0, userConfirmed: true });
  const b = ledger.bind(e, { subjectId: 'u_1' });
  const d = ledger.computeInitialDelta(e, b, ledger.attachSnapshot({ outcome: 'completed' }));
  assert.ok(Math.abs(d.factors.confidenceFactor - 0.9) < 1e-9);
});

test('步骤五：未知事件类型 / 未知结果状态 / 未知规则版本 → 计算失败（不静默取零）', () => {
  const { ledger } = setup();
  const e = ledger.submitCandidate({ eventType: 'nope', salience: 9, confidence: 1, at: 0 });
  const b = ledger.bind(e, { subjectId: 'u_1' });
  const d = ledger.computeInitialDelta(e, b, ledger.attachSnapshot({ outcome: 'completed' }));
  assert.strictEqual(d.ok, false);
  assert.strictEqual(d.error, LEDGER_ERRORS.UNKNOWN_EVENT_TYPE);
  const e2 = ledger.submitCandidate({ eventType: 'tool_execution', salience: 9, confidence: 1, at: 0 });
  const b2 = ledger.bind(e2, { subjectId: 'u_1' });
  const d2 = ledger.computeInitialDelta(e2, b2, ledger.attachSnapshot({ outcome: 'weird' }));
  assert.strictEqual(d2.ok, false);
  assert.strictEqual(d2.error, LEDGER_ERRORS.UNKNOWN_OUTCOME);
  const d3 = ledger.computeInitialDelta(e2, b2, ledger.attachSnapshot({ outcome: 'completed' }), 'rules-v9.9');
  assert.strictEqual(d3.ok, false);
  assert.strictEqual(d3.error, LEDGER_ERRORS.UNKNOWN_RULE_VERSION);
});

/* ── 步骤六：原子幂等追加 ── */

test('步骤六：submit 七步一次走通，账本条目含全链路事件标识/溯源/快照/准入依据/规则版本/规范化输入/Δ0', () => {
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
  assert.deepStrictEqual(e.snapshot, { userGoal: '发布方案', actionSummary: '市场分析+PPT', outcome: 'completed', contextKind: 'task' });
  assert.strictEqual(e.admission.ok, true);
  assert.strictEqual(e.rulesVersion, 'rules-v1.0');
  assert.ok(e.delta.trust > 0);
  assert.ok(e.normalizedInput, '条目须固化规范化输入');
  assert.ok(e.eventTime != null && e.processTime != null && e.ledgerTime != null, '三时间字段齐备');
  assert.strictEqual(ledger.size(), 1);
});

test('步骤六：同一全链路事件标识重复写入 → 幂等，不重复计算', () => {
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

/* ── 步骤七：重算比较验证 ── */

test('验证：未改动账本 → 重算比较全部一致', () => {
  const { ledger } = setup();
  const ctx = { binding: { subjectId: 'u_1' }, snapshot: { outcome: 'completed' } };
  ledger.submit({ eventType: 'generated_template', salience: 9, confidence: 1, at: 0 }, ctx);
  ledger.submit({ eventType: 'code_analysis', salience: 7, confidence: 0.9, at: 1000 }, ctx);
  const v = ledger.verify();
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.checked, 2);
  assert.deepStrictEqual(v.mismatches, []);
});

test('验证：条目 Δ0 被篡改 → 重算比较检出不一致（含维度与数值）', () => {
  const { ledger } = setup();
  const ctx = { binding: { subjectId: 'u_1' }, snapshot: { outcome: 'completed' } };
  ledger.submit({ eventType: 'generated_template', salience: 9, confidence: 1, at: 0 }, ctx);
  const entry = ledger.all()[0];
  entry.delta.trust = 0.99;   // 模拟账本被改写
  const v = ledger.verify();
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.mismatches.length, 1);
  assert.strictEqual(v.mismatches[0].dimension, 'trust');
  assert.ok(Math.abs(v.mismatches[0].expected - 0.5) < 1e-9);
  assert.strictEqual(v.mismatches[0].actual, 0.99);
});

test('验证：规则版本缺失 → 明确失败，不静默跳过', () => {
  const { ledger } = setup();
  const ctx = { binding: { subjectId: 'u_1' }, snapshot: { outcome: 'completed' } };
  ledger.submit({ eventType: 'tool_execution', salience: 9, confidence: 1, at: 0 }, ctx);
  ledger.all()[0].rulesVersion = 'rules-v0.0';
  const v = ledger.verify();
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.mismatches[0].reason, LEDGER_ERRORS.UNKNOWN_RULE_VERSION);
});

test('验证：limit 真实截断扫描（仅查前 N 条）；Δ 为 NaN 判为篡改', () => {
  const { ledger } = setup();
  const ctx = { binding: { subjectId: 'u_1' }, snapshot: { outcome: 'completed' } };
  ledger.submit({ eventType: 'generated_template', salience: 9, confidence: 1, at: 0 }, ctx);
  ledger.submit({ eventType: 'code_analysis', salience: 7, confidence: 0.9, at: 1000 }, ctx);
  ledger.submit({ eventType: 'tool_execution', salience: 8, confidence: 1, at: 2000 }, ctx);
  ledger.all()[2].delta.trust = NaN; // 模拟篡改（NaN）
  const v1 = ledger.verify({ limit: 2 });
  assert.strictEqual(v1.ok, true, 'limit=2 只扫描前两条（未触及被改条目）——limit 真实截断');
  assert.strictEqual(v1.checked, 2);
  const v2 = ledger.verify();
  assert.strictEqual(v2.ok, false, '全量扫描检出 NaN 篡改');
  assert.strictEqual(v2.mismatches[0].dimension, 'trust');
  assert.ok(Number.isNaN(v2.mismatches[0].actual), 'NaN 如实上报（不再被 || 0 吞掉）');
});

test('时间归一化：ISO 字符串与数值毫秒混合 → 排序稳定、区间过滤按数值生效', () => {
  const { ledger } = setup();
  const ctx = { binding: { subjectId: 'u_1' }, snapshot: { outcome: 'completed' } };
  ledger.submit({ eventType: 'tool_execution', salience: 9, confidence: 1, at: '1970-01-01T00:00:10.000Z' }, ctx); // 10000ms
  ledger.submit({ eventType: 'tool_execution', salience: 9, confidence: 1, at: 5000 }, ctx);                     // 数值 5000
  ledger.submit({ eventType: 'tool_execution', salience: 9, confidence: 1, at: '1970-01-01T00:00:20.000Z' }, ctx); // 20000ms
  // 修复前：字符串-数值相减得 NaN → 排序退化为插入序（10s, 5s, 20s 的错误顺序）
  assert.deepStrictEqual(
    ledger.report().entries.map((e) => e.at),
    [5000, '1970-01-01T00:00:10.000Z', '1970-01-01T00:00:20.000Z'],
    '按归一化后的数值时间稳定排序'
  );
  const rep = ledger.report({ from: 6000, to: 15000 });
  assert.strictEqual(rep.count, 1, '区间过滤按归一化时间生效（只命中 10s 条目）');
});

/* ── 步骤七：指定评价时刻重放（两层量）── */

test('重放：评价时刻为空 → 等价于按初始增量 Δ0 顺次累加', () => {
  const { ledger } = setup();
  const ctx = { binding: { subjectId: 'u_1' }, snapshot: { outcome: 'completed' } };
  ledger.submit({ eventType: 'generated_template', salience: 9, confidence: 1, at: 0 }, ctx);
  ledger.submit({ eventType: 'tool_execution', salience: 9, confidence: 1, at: 1000 }, ctx);
  const rep = ledger.replay();
  assert.strictEqual(rep.ok, true);
  assert.strictEqual(rep.steps.length, 2);
  const expectTrust = rep.steps[0].effective.trust + rep.steps[1].effective.trust;
  assert.ok(Math.abs(rep.state.trust - expectTrust) < 1e-9);
  assert.deepStrictEqual(Object.keys(rep.steps[0].state), ['trust', 'intimacy', 'familiarity']);
});

test('重放：同一评价时刻重复重放结果一致；改变评价时刻只改有效贡献，不改 Δ0', () => {
  const { ledger } = setup();
  const ctx = { binding: { subjectId: 'u_1' }, snapshot: { outcome: 'completed' } };
  ledger.submit({ eventType: 'generated_template', salience: 9, confidence: 1, at: 0 }, ctx);

  const a1 = ledger.replay({ at: 10 * DAY });
  const a2 = ledger.replay({ at: 10 * DAY });
  assert.deepStrictEqual(a1.state, a2.state, '同一评价时刻重复重放须一致');

  const at100 = ledger.replay({ at: 100 * DAY });
  assert.ok(at100.state.trust < a1.state.trust, '评价时刻越晚，有效贡献越低');

  // Δ0 不随评价时刻变化
  assert.strictEqual(ledger.all()[0].delta.trust, 0.5, 'Δ0 为不可变初始增量');
  assert.ok(Math.abs(a1.steps[0].effective.trust - 0.5 * Math.exp(-0.002 * 10)) < 1e-9);
  assert.ok(Math.abs(at100.steps[0].effective.trust - 0.5 * Math.exp(-0.002 * 100)) < 1e-9);
});

test('重放：按条目内记录的规则版本执行（规则升级后历史条目不重算）', () => {
  const v11 = Object.assign({}, RULE_TABLES['rules-v1.0'], {
    version: 'rules-v1.1',
    decayPerDay: { trust: 0.02, intimacy: 0.02, familiarity: 0.02 },
  });
  const registry = Object.assign({}, RULE_TABLES, { 'rules-v1.1': v11 });
  const { ledger } = setup({ rules: registry });

  ledger.submit({ eventType: 'generated_template', salience: 9, confidence: 1, at: 0 }, {
    binding: { subjectId: 'u_1' }, snapshot: { outcome: 'completed' }, rulesVersion: 'rules-v1.0',
  });
  ledger.submit({ eventType: 'generated_template', salience: 9, confidence: 1, at: 0 }, {
    binding: { subjectId: 'u_1' }, snapshot: { outcome: 'completed' }, rulesVersion: 'rules-v1.1',
  });

  const all = ledger.all();
  assert.deepStrictEqual(all.map((e) => e.rulesVersion), ['rules-v1.0', 'rules-v1.1']);
  assert.strictEqual(all[0].delta.trust, all[1].delta.trust, 'Δ0 不因规则版本不同而改变（仅衰减率不同）');

  const rep = ledger.replay({ at: 100 * DAY });
  assert.ok(Math.abs(rep.steps[0].effective.trust - 0.5 * Math.exp(-0.002 * 100)) < 1e-9);
  assert.ok(Math.abs(rep.steps[1].effective.trust - 0.5 * Math.exp(-0.02 * 100)) < 1e-9);
  assert.ok(rep.steps[1].effective.trust < rep.steps[0].effective.trust, '高衰减版本的有效值应更低');
});

test('重放：迟到事件按事件发生时间排序，且更早发生者衰减更多', () => {
  const { ledger, clock } = setup();
  const ctx = { binding: { subjectId: 'u_1' }, snapshot: { outcome: 'completed' } };
  clock.set(10_000);
  ledger.submit({ eventType: 'tool_execution', salience: 9, confidence: 1, eventTime: 9_000 }, ctx); // 先入账、发生较晚
  const late = ledger.submit({ eventType: 'tool_execution', salience: 9, confidence: 1, eventTime: 1_000 }, ctx); // 迟到、发生较早
  const earlyId = late.entry.eventId;

  const rep = ledger.replay({ at: 20_000 });
  assert.strictEqual(rep.steps.length, 2);
  assert.strictEqual(rep.steps[0].eventId, earlyId, '重放顺序须按事件发生时间，而非入账先后');
  assert.ok(rep.steps[0].effective.trust < rep.steps[1].effective.trust,
    'Δ0 相同时，更早发生的事件在评价时刻的有效贡献更低（衰减更多）');
});

test('重放：规则版本缺失 → 明确失败，不返回静默错值', () => {
  const { ledger } = setup();
  const ctx = { binding: { subjectId: 'u_1' }, snapshot: { outcome: 'completed' } };
  ledger.submit({ eventType: 'tool_execution', salience: 9, confidence: 1, at: 0 }, ctx);
  ledger.all()[0].rulesVersion = 'rules-v0.0';
  const rep = ledger.replay();
  assert.strictEqual(rep.ok, false);
  assert.strictEqual(rep.error, LEDGER_ERRORS.UNKNOWN_RULE_VERSION);
});

/* ── 关系资产查询（读模型）── */

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

/* ── 与家族边界的一致性 ── */

test('边界：本模块不产出存在状态、不做跨域路由决策（只落关系账本）', () => {
  const { ledger } = setup();
  const api = Object.keys(ledger);
  for (const forbidden of ['presence', 'setPresence', 'decide', 'route', 'commit', 'openSession']) {
    assert.strictEqual(api.indexOf(forbidden), -1, '不得侵入专利2/专利5 的职责：' + forbidden);
  }
  for (const required of ['submit', 'verify', 'replay', 'restore', 'report']) {
    assert.ok(api.indexOf(required) >= 0, '本模块须提供：' + required);
  }
});
