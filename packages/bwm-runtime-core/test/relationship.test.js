const test = require('node:test');
const assert = require('node:assert');
const {
  createRuntime,
  applyRelationshipSignal,
  relationshipStageOf,
  RELATIONSHIP_STAGES,
  RELATIONSHIP_POLICY,
  CONTEXT_DOMAINS,
  DOMAIN_POLICY,
  PERSIST_DOMAINS,
} = require('../src/index.js');

/* ── 关系域（至少包括关系状态字段与亲密度字段）── */

test('[0041] 关系域存在，且至少含关系状态字段与亲密度字段', () => {
  const runtime = createRuntime();
  const rel = runtime.context.get('relationship');
  assert.ok(rel, '关系域必须存在（权1 必要技术特征）');
  assert.strictEqual(rel.stage, RELATIONSHIP_POLICY.stage, '含关系状态字段');
  assert.strictEqual(rel.intimacy, RELATIONSHIP_POLICY.intimacy, '含亲密度字段');
  assert.ok(RELATIONSHIP_STAGES.includes(rel.stage), '关系状态取值域受控');
  assert.ok(CONTEXT_DOMAINS.includes('relationship'), '关系域在域清单中');
});

test('[0041] 关系状态由亲密度经阈值表映射（阶段单调不回退）', () => {
  assert.strictEqual(relationshipStageOf(0), 'new');
  assert.strictEqual(relationshipStageOf(9), 'new');
  assert.strictEqual(relationshipStageOf(10), 'acquaintance');
  assert.strictEqual(relationshipStageOf(59), 'familiar');
  assert.strictEqual(relationshipStageOf(89), 'close');
  assert.strictEqual(relationshipStageOf(90), 'bonded');
  assert.strictEqual(relationshipStageOf(100), 'bonded');
  // 单调性：亲密度越高，阶段序号不下降
  let prev = -1;
  for (let i = 0; i <= 100; i++) {
    const idx = RELATIONSHIP_STAGES.indexOf(relationshipStageOf(i));
    assert.ok(idx >= prev, `阶段在亲密度 ${i} 处回退`);
    prev = idx;
  }
});

/* ── 交互行为产生行为事件 → 触发关系域更新 → 订阅通知广播 ── */

test('[0071] 行为事件驱动关系域更新：agent.task.success 提升亲密度', () => {
  const runtime = createRuntime();
  const before = runtime.context.get('relationship');
  runtime.emit('agent.task.success', { taskId: 't1', summary: '陪用户散步' });
  const after = runtime.context.get('relationship');
  assert.strictEqual(after.intimacy, before.intimacy + 1, '亲密度按信号增益递增');
  assert.strictEqual(after.lastReason, 'task_success');
  assert.ok(after.updatedAt, '带更新时间戳');
});

test('[0071] 行为事件写入时间线域 且 触发关系域更新（同一事件双落点）', () => {
  const runtime = createRuntime();
  runtime.emit('agent.task.success', { taskId: 't2', summary: '一起做饭' });
  const timeline = runtime.context.get('timeline');
  const last = timeline[timeline.length - 1];
  assert.strictEqual(last.action_type, 'agent_task', '行为事件写入时间线域');
  assert.strictEqual(last.summary, '一起做饭');
  assert.strictEqual(runtime.context.get('relationship').intimacy, 1, '同事件触发关系域更新');
});

test('[0071] 更新经订阅通知机制广播：relationship:changed 携带前后态', () => {
  const runtime = createRuntime();
  const seen = [];
  runtime.subscribe('relationship:changed', (p) => seen.push(p));
  runtime.emit('agent.task.success', { taskId: 't3', summary: 'x' });
  assert.strictEqual(seen.length, 1, '更新即广播');
  assert.strictEqual(seen[0].prevIntimacy, 0);
  assert.strictEqual(seen[0].intimacy, 1);
  assert.strictEqual(seen[0].changed, true);
  assert.strictEqual(seen[0].stage, 'new');
});

test('[0071] 跨阈值触发阶段跃迁，并在广播中体现（stage 变化）', () => {
  const runtime = createRuntime();
  const stages = [];
  runtime.subscribe('relationship:changed', (p) => stages.push(p.stage));
  for (let i = 0; i < 10; i++) runtime.emit('memory.updated', { note: `m${i}` });
  assert.strictEqual(runtime.context.get('relationship').intimacy, 10, 'memory.updated 亦计入交互');
  assert.strictEqual(runtime.context.get('relationship').stage, 'acquaintance', '达阈值 10 跃迁');
  assert.ok(stages.includes('new') && stages.includes('acquaintance'), '跃迁前后态均广播');
});

test('权1 一致性：多个视图订阅读到同一关系状态（不出现视图间分叉）', () => {
  const runtime = createRuntime();
  // 两个视图各自订阅（视图 A 走语义事件，视图 B 走域订阅），互为独立消费者
  const viewA = [];
  const viewB = [];
  runtime.subscribe('relationship:changed', (p) => viewA.push([p.stage, p.intimacy]));
  runtime.context.watch((domain, value) => { if (domain === 'relationship') viewB.push([value.stage, value.intimacy]); });

  runtime.emit('agent.task.success', { taskId: 't4', summary: '共同完成计划' });
  runtime.emit('agent.task.success', { taskId: 't5', summary: '继续推进' });

  assert.strictEqual(viewA.length, 2);
  assert.strictEqual(viewB.length, 2);
  assert.deepStrictEqual(viewA[1], viewB[1], '两视图读到的关系状态完全一致');
  assert.deepStrictEqual(runtime.context.get('relationship').stage, viewA[1][0], '与上下文当前值一致');
});

/* ── 写权与合并写 ── */

test('权限：视图无关系域写权（shellSet → CONTEXT_PERMISSION_DENIED），状态不被篡改', () => {
  const runtime = createRuntime();
  runtime.emit('agent.task.success', { taskId: 't6', summary: 'x' });
  const before = { ...runtime.context.get('relationship') };
  assert.throws(() => runtime.context.shellSet('relationship', { stage: 'bonded', intimacy: 100 }), /CONTEXT_PERMISSION_DENIED/);
  assert.deepStrictEqual(runtime.context.get('relationship'), before, '视图直写被拒且状态未变');
});

test('合并写（F2 回归）：更新关系域不得抹掉既有/扩展字段', () => {
  const runtime = createRuntime();
  runtime.context.patch('relationship', { customNote: '保留字段', affinityVector: { trust: 3 } });
  runtime.emit('agent.task.success', { taskId: 't7', summary: 'x' });
  const rel = runtime.context.get('relationship');
  assert.strictEqual(rel.customNote, '保留字段', '既有字段被保留（非整体替换）');
  assert.deepStrictEqual(rel.affinityVector, { trust: 3 }, '扩展字段被保留');
  assert.strictEqual(rel.intimacy, 1, '本次变更仍生效');
});

test('失败交互不减亲密度（agent.task.failed 增益 0，不做负反馈惩罚）', () => {
  const runtime = createRuntime();
  const seen = [];
  // 注：Event Bus 的 on() 会回放该通道历史事件 —— 新视图挂载即拿到当前关系状态（跨视图一致性所需）
  runtime.subscribe('relationship:changed', (p) => seen.push(p));
  runtime.emit('agent.task.success', { taskId: 'ok', summary: 'x' });
  const mid = runtime.context.get('relationship').intimacy;
  runtime.emit('agent.task.failed', { taskId: 'bad', summary: 'y' });
  assert.strictEqual(runtime.context.get('relationship').intimacy, mid, '失败不扣减');
  assert.strictEqual(seen.length, 2, '两次行为事件各广播一次');
  assert.strictEqual(seen[1].changed, false, '广播如实标记未变更');
  assert.strictEqual(seen[1].reason, 'task_failed');
});

test('后订阅视图立即回放当前关系状态（挂载即对齐，无需等待下一次交互）', () => {
  const runtime = createRuntime();
  runtime.emit('agent.task.success', { taskId: 'a', summary: 'x' });
  runtime.emit('agent.task.success', { taskId: 'b', summary: 'x' });
  const late = [];
  runtime.subscribe('relationship:changed', (p) => late.push(p));
  assert.strictEqual(late.length, 2, '历史广播按序回放');
  assert.strictEqual(late[late.length - 1].intimacy, 2, '末条即当前亲密度');
  assert.strictEqual(runtime.context.get('relationship').intimacy, 2, '与上下文当前值一致');
});

test('亲密度上下界收敛（不下穿 0、不上穿 max）', () => {
  const runtime = createRuntime();
  runtime.emit('agent.task.success', { taskId: 'a', summary: 'x', relationship_delta: -50 });
  assert.strictEqual(runtime.context.get('relationship').intimacy, 0, '下界 0');
  runtime.emit('agent.task.success', { taskId: 'b', summary: 'x', relationship_delta: 999 });
  assert.strictEqual(runtime.context.get('relationship').intimacy, RELATIONSHIP_POLICY.max, '上界 max');
  assert.strictEqual(runtime.context.get('relationship').stage, 'bonded');
});

/* ── 载荷兼容（关系语义前向兼容）── */

test('relationship_delta 数字 → 直接采纳为增量', () => {
  const runtime = createRuntime();
  runtime.emit('agent.task.success', { taskId: 't8', summary: 'x', relationship_delta: 5 });
  assert.strictEqual(runtime.context.get('relationship').intimacy, 5);
});

test('relationship_delta 对象：{delta} / {intimacy 目标值} / {stage 显式} 三式可用', () => {
  const runtime = createRuntime();
  runtime.emit('agent.task.success', { taskId: 'a', summary: 'x', relationship_delta: { delta: 7 } });
  assert.strictEqual(runtime.context.get('relationship').intimacy, 7);
  runtime.emit('agent.task.success', { taskId: 'b', summary: 'x', relationship_delta: { intimacy: 25 } });
  assert.strictEqual(runtime.context.get('relationship').intimacy, 25, '显式目标值 → 差值');
  assert.strictEqual(runtime.context.get('relationship').stage, 'acquaintance');
  runtime.emit('agent.task.success', { taskId: 'c', summary: 'x', relationship_delta: { stage: 'bonded' } });
  assert.strictEqual(runtime.context.get('relationship').stage, 'bonded', '显式阶段声明生效');
});

test('relationship_delta 为任意 JSON（如 {trust:1} / 非法 stage）不抛错，回落默认增益', () => {
  const runtime = createRuntime();
  runtime.emit('agent.task.success', { taskId: 'a', summary: 'x', relationship_delta: { trust: 1 } });
  assert.strictEqual(runtime.context.get('relationship').intimacy, 1, '未知键 → 默认增益');
  runtime.emit('agent.task.success', { taskId: 'b', summary: 'x', relationship_delta: { stage: '不存在的阶段' } });
  assert.strictEqual(runtime.context.get('relationship').intimacy, 2, '非法 stage 被忽略但不阻断');
  assert.ok(RELATIONSHIP_STAGES.includes(runtime.context.get('relationship').stage));
  runtime.emit('agent.task.success', { taskId: 'c', summary: 'x', relationship_delta: 'not-a-number' });
  assert.strictEqual(runtime.context.get('relationship').intimacy, 3, '非数字非对象 → 回落默认增益');
});

test('applyRelationshipSignal 可独立调用（纯函数式更新，返回最新域值）', () => {
  const runtime = createRuntime();
  const next = applyRelationshipSignal(runtime.context, { delta: 30, reason: 'manual' });
  assert.strictEqual(next.intimacy, 30);
  assert.strictEqual(next.stage, 'familiar');
  assert.strictEqual(next.lastReason, 'manual');
  assert.deepStrictEqual(runtime.context.get('relationship'), next, '上下文与返回值一致');
});

/* ── 持久化与域清单一致性（可序列化持久化；字段可扩展） ── */

test('持久化：关系域属 persist 域，persistSnapshot 携带，hydrate 恢复（权4）', () => {
  const runtime = createRuntime();
  runtime.emit('agent.task.success', { taskId: 'p1', summary: 'x' });
  runtime.emit('agent.task.success', { taskId: 'p2', summary: 'x' });
  assert.ok(PERSIST_DOMAINS.includes('relationship'), '关系域落盘：关系状态需跨重启保持');
  const snap = runtime.persistSnapshot();
  assert.ok(snap.relationship, '快照含关系域');
  assert.strictEqual(snap.relationship.intimacy, 2);

  // 新运行载体（换载体/换端口）反序列化恢复 → 关系状态不丢
  const revived = createRuntime();
  revived.hydrateContext(JSON.parse(JSON.stringify(snap)));
  assert.deepStrictEqual(revived.context.get('relationship'), snap.relationship, '反序列化后逐字段一致');
});

test('域清单单一来源：CONTEXT_DOMAINS 与 DOMAIN_POLICY / 上下文实例完全一致', () => {
  const runtime = createRuntime();
  const actual = Object.keys(runtime.context.get()).filter((k) => k !== 'schemaVersion');
  assert.deepStrictEqual([...actual].sort(), [...CONTEXT_DOMAINS].sort(), '上下文实例域 = 域清单');
  assert.deepStrictEqual(Object.keys(DOMAIN_POLICY).sort(), [...CONTEXT_DOMAINS].sort(), '持久化策略覆盖全清单');
});
