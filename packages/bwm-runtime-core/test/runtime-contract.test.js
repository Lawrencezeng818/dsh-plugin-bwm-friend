const test = require('node:test');
const assert = require('node:assert');
const {
  createRuntime,
  createAgentContext,
  createPresenceMachine,
  wireLedger,
  CONTEXT_VERSIONS,
  CONTEXT_ERRORS,
  negotiate,
} = require('../src/index.js');

/* ── P1.4 验收：Runtime Contract 模拟链路（hello → welcome full → emit → shell render 输入）── */
test('链路: hello → welcome full → emit agent.thinking.start → presence 状态机输出', () => {
  const runtime = createRuntime();
  const welcome = runtime.hello({
    capabilities: [{ name: 'video-layer', version: '1.0' }],
    requires: [{ name: 'presence-provide', version: '1.0' }],
  });
  assert.strictEqual(welcome.mode, 'full');

  // Shell 渲染层订阅 presence:state（渲染输入）
  const rendered = [];
  runtime.subscribe('presence:state', (p) => rendered.push(p.state));
  assert.strictEqual(rendered[0], 'idle'); // 初始态

  // Runtime 收到 agent 事件 → presence 状态机 → shell 渲染输入
  runtime.emit('agent.thinking.start');
  assert.strictEqual(runtime.context.get('presence').state, 'thinking');
  assert.strictEqual(rendered[rendered.length - 1], 'thinking');

  runtime.emit('agent.tool.call');
  assert.strictEqual(runtime.context.get('presence').state, 'executing');
  assert.strictEqual(rendered[rendered.length - 1], 'executing');

  runtime.emit('agent.tool.result');
  assert.strictEqual(runtime.context.get('presence').state, 'thinking');

  runtime.emit('agent.thinking.end');
  assert.strictEqual(runtime.context.get('presence').state, 'idle');
  assert.strictEqual(rendered[rendered.length - 1], 'idle');
});

test('链路: agent.task.success → presence success(transient→idle) + Ledger timeline 记录', async () => {
  const runtime = createRuntime();
  const rendered = [];
  runtime.subscribe('presence:state', (p) => rendered.push(p.state));
  runtime.emit('agent.task.success', { taskId: 't1', summary: '完成' });
  assert.strictEqual(runtime.context.get('presence').state, 'success');
  assert.strictEqual(runtime.context.get('tasks').last, 'success');
  const timeline = runtime.context.get('timeline');
  assert.ok(Array.isArray(timeline) && timeline.length >= 1);
  assert.strictEqual(timeline[timeline.length - 1].action_type, 'agent_task');
  assert.strictEqual(timeline[timeline.length - 1].summary, '完成');
  // transient 1400ms 后回 idle
  await new Promise((r) => setTimeout(r, 1500));
  assert.strictEqual(runtime.context.get('presence').state, 'idle');
  assert.strictEqual(rendered[rendered.length - 1], 'idle');
});

test('链路: agent.tool.call → Ledger 记录 tool_execution', () => {
  const runtime = createRuntime();
  runtime.emit('agent.tool.call', { tool: 'bash' });
  const timeline = runtime.context.get('timeline');
  const last = timeline[timeline.length - 1];
  assert.strictEqual(last.action_type, 'tool_execution');
  assert.strictEqual(last.summary, 'bash');
});

/* ── P1.4 验收：Context Ownership（Shell 写 runtime 域拒绝 / shared 域允许）── */
test('ownership: Shell shellSet 写 runtime 域（presence）→ 拒绝 CONTEXT_PERMISSION_DENIED', () => {
  const runtime = createRuntime();
  assert.throws(() => runtime.context.shellSet('presence', { state: 'hacked' }), /CONTEXT_PERMISSION_DENIED/);
  assert.strictEqual(runtime.context.get('presence').state, 'idle'); // 未被篡改
});

test('ownership: Shell shellSet 写 shared 域（conversation）→ 允许', () => {
  const runtime = createRuntime();
  runtime.context.shellSet('conversation', { topic: '老人陪伴' });
  assert.deepStrictEqual(runtime.context.get('conversation'), { topic: '老人陪伴' });
});

test('context: 非法 domain → CONTEXT_INVALID_DOMAIN', () => {
  const runtime = createRuntime();
  assert.throws(() => runtime.context.set('bogus', {}), /CONTEXT_INVALID_DOMAIN/);
  assert.throws(() => runtime.context.shellSet('bogus', {}), /CONTEXT_INVALID_DOMAIN/);
});

test('context: CONTEXT_VERSIONS 冻结 + schemaVersion 可查', () => {
  const runtime = createRuntime();
  assert.deepStrictEqual(CONTEXT_VERSIONS, { '0.9': '1.0' });
  assert.strictEqual(runtime.context.schemaVersion(), '1.0');
});

test('context: watch 变更通知 + hydrate 恢复', () => {
  const runtime = createRuntime();
  const seen = [];
  runtime.context.watch((domain, value) => seen.push([domain, value]));
  runtime.emit('agent.thinking.start');
  assert.ok(seen.some(([d]) => d === 'presence'));
  runtime.hydrateContext({ schemaVersion: '1.0', memory: { note: 'hi' } });
  assert.strictEqual(runtime.context.get('memory').note, 'hi');
});

/* ── P1.4 验收：Lite 模式（无 Runtime 能力 → 降级）── */
test('lite: requires 含 runtime 未提供能力 → welcome.mode=lite + missing 列出（Shell 降级 UI 依据）', () => {
  const runtime = createRuntime();
  const welcome = runtime.hello({
    requires: [
      { name: 'presence-provide', version: '1.0' },
      { name: 'future-runtime-y', version: '3.0' },
    ],
  });
  assert.strictEqual(welcome.mode, 'lite');
  assert.strictEqual(welcome.negotiation.missing[0].name, 'future-runtime-y');
  // lite 下 Shell 应显示 offline/idle（协议 state.json offline 值可用）
  const presenceVals = welcome.presence;
  assert.ok(presenceVals.includes('offline'));
  assert.ok(presenceVals.includes('idle'));
});

test('lite: 直接 negotiate 缺能力 → lite mode（纯函数验证）', () => {
  const r = negotiate([{ name: 'presence-provide', version: '1.0' }, { name: 'missing-cap', version: '1.0' }]);
  assert.strictEqual(r.mode, 'lite');
  assert.strictEqual(r.missing[0].name, 'missing-cap');
});

/* ── P2-Persona：Identity Runtime 雏形测试 ── */
test('identity: createRuntime 初始化 identity/personality 域（我是谁）', () => {
  const runtime = createRuntime();
  const identity = runtime.context.get('identity');
  const personality = runtime.context.get('personality');
  assert.strictEqual(identity.name, 'Mira');
  assert.strictEqual(identity.tagline, 'be water my friend');
  assert.ok(Array.isArray(identity.coreValues) && identity.coreValues.length >= 3);
  assert.strictEqual(personality.archetype, '温暖陪伴型');
  assert.ok(Array.isArray(personality.traits) && personality.traits.includes('共情'));
});

test('identity: Shell 不能篡改 identity 域（runtime 域只读）', () => {
  const runtime = createRuntime();
  assert.throws(() => runtime.context.shellSet('identity', { name: 'Hacked' }), /CONTEXT_PERMISSION_DENIED/);
  assert.strictEqual(runtime.context.get('identity').name, 'Mira');
});

/* ── Runtime v1.1：DOMAIN_POLICY（运行态不落盘）+ Request 状态机 ── */
test('persist: persistSnapshot 只含 persist 域（运行态 presence/timeline 不落盘）', () => {
  const runtime = createRuntime();
  // 制造运行态
  runtime.emit('agent.thinking.start');
  runtime.emit('agent.tool.call', { tool: 'bash' });
  const snap = runtime.persistSnapshot();
  assert.ok(snap.identity && snap.identity.name === 'Mira');
  assert.ok(snap.personality);
  assert.ok('presence' in snap === false, 'presence 运行态不得落盘');
  assert.ok('timeline' in snap === false, 'timeline 事件流不得落盘');
  assert.ok('tasks' in snap === false, 'tasks 瞬态不得落盘');
  assert.ok('capability' in snap === false, 'capability 动态不得落盘');
  assert.strictEqual(snap.schemaVersion, '1.0');
});

test('request: start → thinking，重复 start 拒绝（防重复提交）', () => {
  const runtime = createRuntime();
  runtime.emit('conversation.request.start', { requestId: 'r1' });
  assert.strictEqual(runtime.context.get('conversation').requestState.state, 'thinking');
  assert.strictEqual(runtime.context.get('conversation').requestState.requestId, 'r1');
  // 重复 start（快速连点）→ 拒绝
  runtime.emit('conversation.request.start', { requestId: 'r2' });
  assert.strictEqual(runtime.context.get('conversation').requestState.requestId, 'r1', '重复请求被拒绝');
});

test('request: reply → replying；end → idle（完整生命周期）', () => {
  const runtime = createRuntime();
  runtime.emit('conversation.request.start', { requestId: 'r3' });
  runtime.emit('conversation.request.reply');
  assert.strictEqual(runtime.context.get('conversation').requestState.state, 'replying');
  runtime.emit('conversation.request.end');
  const rs = runtime.context.get('conversation').requestState;
  assert.strictEqual(rs.state, 'idle');
  assert.strictEqual(rs.requestId, null);
});

/* ── 2026-09-10 B2 反超第一步：wireLedger 落盘（专利4 硬门槛链）──
 * 链：Action→Event→Outcome→Ledger entry→store.append（persist）→ 新 runtime store.load（reload）
 *    → context.timeline 恢复 → Agent 可读（"Agent can use it"）
 */
test('Ledger 落盘: 逐事件 append（冻结形状）+ reload 恢复 → Agent 可读', async () => {
  const backing = []; // 模拟持久层（settings/JSONL/SQL 皆是此接口的宿主实现）
  const mkStore = () => ({
    append(e) { backing.push(JSON.parse(JSON.stringify(e))); },
    load() { return Promise.resolve(backing.map((e) => JSON.parse(JSON.stringify(e)))); },
  });

  // 会话 1：两个行为事件 → 逐条落盘
  const r1 = createRuntime({ ledger: mkStore() });
  r1.emit('agent.tool.call', { tool: 'web.search' });
  r1.emit('agent.task.success', { taskId: 't9', summary: '查到 3 条' });
  assert.strictEqual(backing.length, 2, '逐事件 append');
  // 冻结形状：action_type/outcome/summary/at
  assert.strictEqual(backing[0].action_type, 'tool_execution');
  assert.strictEqual(backing[0].outcome, 'started');
  assert.strictEqual(backing[1].outcome, 'success');
  assert.ok(backing[1].at, 'ISO 时间戳在');

  // 会话 2（重启）：同一持久层 → timeline 恢复 → Agent 可读
  const r2 = createRuntime({ ledger: mkStore() });
  await new Promise((res) => setTimeout(res, 10)); // store.load 为异步恢复
  const tl = r2.context.get('timeline');
  assert.strictEqual(tl.length, 2, '重启后 timeline 恢复');
  assert.strictEqual(tl[1].action_type, 'agent_task');
  assert.strictEqual(tl[1].summary, '查到 3 条');
});

test('Ledger 语义字段透传（relationship_delta 等，专利4 前向兼容）+ 恢复合并守 200 上限', async () => {
  const backing = [];
  const mkStore = () => ({
    append(e) { backing.push(e); },
    load() { return Promise.resolve(backing.slice()); },
  });
  // 未雨绸缪字段：detail 里带 relationship_delta → 落盘保留（core 不解释，只忠实记录）
  const r1 = createRuntime({ ledger: mkStore() });
  r1.emit('agent.task.success', { taskId: 't1', summary: '陪看猫片', relationship_delta: { trust: +1 }, emotion_context: '开心' });
  const withDelta = backing.find((e) => e.relationship_delta);
  assert.deepStrictEqual(withDelta.relationship_delta, { trust: 1 });

  // 恢复合并：持久层 200 条 + 本会话新事件 → 合并后仍 200（不重复、不丢失新事件）
  for (let i = 0; i < 200; i++) backing.push({ action_type: 'agent_task', outcome: 'success', summary: `h${i}`, at: new Date().toISOString() });
  const r2 = createRuntime({ ledger: mkStore() });
  r2.emit('agent.task.success', { taskId: 'new', summary: '新会话事件' });
  await new Promise((res) => setTimeout(res, 10));
  const tl = r2.context.get('timeline');
  assert.strictEqual(tl.length, 200, '合并守 200');
  assert.strictEqual(tl[tl.length - 1].summary, '新会话事件', '本会话新事件不被恢复覆盖');
});

test('Ledger append 抛错不阻断事件管线（ledger:persist.error 通知）', () => {
  const errs = [];
  const r = createRuntime({
    ledger: { append() { throw new Error('disk full'); }, load() { return Promise.resolve([]); } },
  });
  r.subscribe('ledger:persist.error', (e) => errs.push(e.error));
  r.emit('agent.task.success', { taskId: 't1', summary: 'x' });
  assert.strictEqual(errs.length, 1, '错误经事件通知');
  assert.ok(/disk full/.test(errs[0]));
  assert.strictEqual(r.context.get('timeline').length, 1, 'context 更新不受影响');
  assert.strictEqual(r.context.get('tasks').last, 'success', '任务状态不受影响');
});

test('向后兼容: 不传 ledger 时行为与 v0.5 一致（无 store 不落盘不报错）', async () => {
  const r = createRuntime();
  r.emit('agent.tool.call', { tool: 'x' });
  assert.strictEqual(r.context.get('timeline').length, 1);
  await new Promise((res) => setTimeout(res, 5)); // 无 store → 无恢复路径
  assert.strictEqual(r.context.get('timeline').length, 1);
});
