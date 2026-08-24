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
