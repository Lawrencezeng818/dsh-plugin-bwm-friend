// Event Kernel 单测（node:test）——P1.1 搬移后验证核心不回归
const { test } = require('node:test');
const assert = require('node:assert');
const { createEventBus, createRuntime, EVENT_VERSIONS } = require('../src/index.js');

test('EVENT_VERSIONS 覆盖协议 10 事件（与 BWM-PROTOCOL-v1 一致）', () => {
  assert.equal(Object.keys(EVENT_VERSIONS).length, 10);
  assert.equal(EVENT_VERSIONS['agent.thinking.start'], '1.0');
  assert.equal(EVENT_VERSIONS['presence:mode'], '1.0');
});

test('subscribe/emit 基础投递 + 版本字段', () => {
  const bus = createEventBus();
  const got = [];
  bus.on('agent.thinking.start', (p) => got.push(p));
  const ev = bus.emit('agent.thinking.start', { session: 's1' });
  assert.equal(got.length, 1);
  assert.equal(got[0].session, 's1');
  assert.equal(ev.version, '1.0');
  assert.ok(ev.at);
});

test('on 回放历史（订阅在 emit 之后也收到）', () => {
  const bus = createEventBus();
  bus.emit('agent.tool.call', { tool: 'bash' });
  const got = [];
  bus.on('agent.tool.call', (p) => got.push(p));
  assert.equal(got.length, 1);
  assert.equal(got[0].tool, 'bash');
});

test('route 裁决：blocked 阻止投递', () => {
  const bus = createEventBus();
  bus.route('agent.task.failed', () => ({ blocked: true }));
  const got = [];
  bus.on('agent.task.failed', (p) => got.push(p));
  bus.emit('agent.task.failed', { error: 'x' });
  assert.equal(got.length, 0);
});

test('when 谓词过滤', () => {
  const bus = createEventBus();
  const got = [];
  bus.on('presence:state', (p) => got.push(p), { when: (p) => p.state === 'thinking' });
  bus.emit('presence:state', { state: 'idle' });
  bus.emit('presence:state', { state: 'thinking' });
  assert.deepEqual(got, [{ state: 'thinking' }]);
});

test('createRuntime 握手：hello → welcome full + 能力', () => {
  const rt = createRuntime();
  const welcome = rt.hello({ shellVersion: '0.3.0', dshVersion: '1.2.3', capabilities: ['video-layer'] });
  assert.equal(welcome.protocol, 'bwm');
  assert.equal(welcome.version, '1.0');
  assert.equal(welcome.mode, 'full');
  assert.ok(welcome.capabilities.includes('presence-provide'));
  assert.ok(welcome.presence.includes('thinking'));
});

test('createRuntime subscribe/emit 协议面可用', () => {
  const rt = createRuntime();
  const got = [];
  rt.subscribe('emotion.changed', (p) => got.push(p));
  rt.emit('emotion.changed', { emotion: 'warm' });
  assert.deepEqual(got, [{ emotion: 'warm' }]);
});

test('非法 presence fallback（协议 state.json 语义）', () => {
  // 协议语义：非法值按 idle fallback——这里验证 runtime 不因非法输入抛错
  // P1.4 变化：createRuntime 内部 Presence 状态机启动时 emit 初始 idle；bus.on 回放 history
  // → 订阅者立即收到当前状态（{state:'idle'}），随后 emit 的 bogus 原样透传（决策层负责规范化）
  const rt = createRuntime();
  const got = [];
  rt.subscribe('presence:state', (p) => got.push(p));
  assert.equal(got[0].state, 'idle'); // 回放初始态（P1.4：Shell 订阅即知当前状态）
  rt.emit('presence:state', { state: 'bogus' });
  assert.equal(got[got.length - 1].state, 'bogus'); // 传输层不拦截；决策层（Presence Runtime）负责规范化
});

/* ── 回调隔离（P2 修复）：route 裁决回调 / 订阅即回放 / replay 三处逐帧隔离 ── */

test('route 裁决回调抛错不中断 emit（按未裁决处理）', () => {
  const bus = createEventBus();
  bus.route('agent.tool.call', () => { throw new Error('router boom'); });
  const got = [];
  bus.on('agent.tool.call', (p) => got.push(p));
  let ev = null;
  assert.doesNotThrow(() => { ev = bus.emit('agent.tool.call', { tool: 'x' }); });
  assert.equal(got.length, 1, '订阅者照常收到事件');
  assert.ok(ev && ev.channel === 'agent.tool.call', 'emit 正常返回事件帧');
});

test('replay：一个监听器抛错不中断其余监听器的回放', () => {
  const bus = createEventBus();
  bus.emit('agent.tool.call', { tool: 'x' });
  const got = [];
  assert.doesNotThrow(() => {
    // 先注册（迭代序在前）：订阅即回放时抛错被隔离
    bus.on('agent.tool.call', () => { throw new Error('boom in replay'); });
  });
  bus.on('agent.tool.call', (p) => got.push(p)); // 后注册：订阅回放得 1 次
  assert.doesNotThrow(() => bus.replay());
  assert.equal(got.length, 2, '订阅回放 1 次 + 显式 replay 1 次：replay 中前者抛错不中断后者的投递');
});

test('on 订阅即回放：回放中抛错被隔离，后续监听器不受影响', () => {
  const bus = createEventBus();
  bus.emit('agent.tool.call', { tool: 'x' });
  const got = [];
  assert.doesNotThrow(() => {
    bus.on('agent.tool.call', () => { throw new Error('boom during subscribe-replay'); });
  });
  bus.on('agent.tool.call', (p) => got.push(p));
  assert.equal(got.length, 1, '第二个监听器的订阅回放照常执行');
});
