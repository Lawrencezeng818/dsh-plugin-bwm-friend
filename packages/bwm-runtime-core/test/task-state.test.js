/**
 * 任务域合并写专测（「当前任务状态与最近任务状态」）
 *
 * 背景：外部评审核验（2026-09-13）坐实历史缺陷 F2——
 *   原 `wireLedger` 以 `context.set('tasks', {last,taskId,at})` 整体替换任务域，
 *   视图写入的 pending（当前任务）在任一任务事件后被抹掉，
 *   导致「当前任务状态与最近任务状态」无实测支撑。
 * 现改为合并写（`updateTaskState`），本文件锁定该语义，防止回退。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { createRuntime, updateTaskState } = require('../src/index.js');

test('任务域合并写：完成事件不抹掉当前待办（F2 回归）', () => {
  const runtime = createRuntime();
  // 视图写入两条待办（tasks 为 shared 域，视图可写）
  runtime.context.shellSet('tasks', {
    pending: [
      { id: 'T-1001', desc: '订双月湾海景房', stage: '待办' },
      { id: 'T-1002', desc: '租 7 座车', stage: '待办' },
    ],
  });
  const before = runtime.context.get('tasks');
  assert.strictEqual(before.pending.length, 2, '前置：两条待办已写入');

  runtime.emit('agent.task.success', { taskId: 'T-1001', summary: '已订房' });

  const after = runtime.context.get('tasks');
  assert.strictEqual(after.last, 'success', '最近任务结果状态为 success');
  assert.strictEqual(after.taskId, 'T-1001', '最近任务标识为 T-1001');
  // 关键：当前任务状态仍保留（原缺陷在此处丢失）
  assert.strictEqual(after.pending.length, 1, '已完成项从 pending 移出，其余待办保留');
  assert.strictEqual(after.pending[0].id, 'T-1002', '未完成待办 T-1002 未被抹掉');
  assert.strictEqual(after.pending[0].desc, '租 7 座车', '描述字段保留');
  // 最近任务状态
  assert.strictEqual(after.recent[0].id, 'T-1001', '已完成任务进入 recent');
  assert.strictEqual(after.recent[0].stage, 'success');
});

test('任务域合并写：既有扩展字段不被覆盖（[0048] 字段可扩展）', () => {
  const runtime = createRuntime();
  runtime.context.shellSet('tasks', { pending: [], customField: { note: '自定义' } });
  runtime.emit('agent.task.success', { taskId: 'X', summary: 's' });
  assert.deepStrictEqual(runtime.context.get('tasks').customField, { note: '自定义' }, '扩展字段保留');
});

test('任务域合并写：失败事件同样合并，不做负反馈清空', () => {
  const runtime = createRuntime();
  runtime.context.shellSet('tasks', { pending: [{ id: 'T-9', desc: 'd', stage: '待办' }] });
  runtime.emit('agent.task.failed', { taskId: 'T-9', summary: '失败' });
  const t = runtime.context.get('tasks');
  assert.strictEqual(t.last, 'failed');
  assert.strictEqual(t.pending.length, 0, '失败任务移出 pending');
  assert.strictEqual(t.recent[0].stage, 'failed');
});

test('任务域合并写：无 pending 时更新不注入空 pending 字段', () => {
  const runtime = createRuntime();
  runtime.emit('agent.task.success', { taskId: 'Y', summary: 's' });
  const t = runtime.context.get('tasks');
  assert.strictEqual('pending' in t, false, '未提供 pending 时不应凭空创建该字段');
  assert.strictEqual(t.last, 'success');
});

test('任务域合并写：recent 上限 10，且同一任务标识不重复堆积', () => {
  const runtime = createRuntime();
  for (let i = 0; i < 15; i++) runtime.emit('agent.task.success', { taskId: 'T-' + i, summary: 's' + i });
  assert.strictEqual(runtime.context.get('tasks').recent.length, 10, 'recent 守住上限 10');
  assert.strictEqual(runtime.context.get('tasks').recent[0].id, 'T-14', '最近完成项在最前');

  runtime.emit('agent.task.success', { taskId: 'T-14', summary: 're' });
  const ids = runtime.context.get('tasks').recent.map((r) => r.id);
  assert.strictEqual(ids.filter((x) => x === 'T-14').length, 1, '同一任务标识不重复出现');
});

test('任务域仍不落盘（运行域策略不变）', () => {
  const runtime = createRuntime();
  runtime.emit('agent.task.success', { taskId: 'T-1', summary: 's' });
  const snap = runtime.persistSnapshot();
  assert.strictEqual('tasks' in snap, false, '运行态域按策略不落盘');
});

test('updateTaskState 可独立调用（导出契约）', () => {
  const runtime = createRuntime();
  runtime.context.shellSet('tasks', { pending: [{ id: 'A', desc: 'd', stage: '待办' }] });
  updateTaskState(runtime.context, { taskId: 'A', outcome: 'success', at: '2026-09-13T00:00:00.000Z' });
  const t = runtime.context.get('tasks');
  assert.strictEqual(t.at, '2026-09-13T00:00:00.000Z', '可注入时间戳（确定性测试用）');
  assert.strictEqual(t.pending.length, 0);
});
