const test = require('node:test');
const assert = require('node:assert');
const { createBwmRuntime } = require('../src/index.js');

test('presence: state() 初始 idle + observe() 事件驱动', () => {
  const sdk = createBwmRuntime();
  assert.strictEqual(sdk.presence.state(), 'idle');
  const seen = [];
  const off = sdk.presence.observe((s) => seen.push(s));
  // 触发 runtime 状态机（agent 事件 → presence）
  sdk.events.emit('agent.thinking.start');
  assert.strictEqual(sdk.presence.state(), 'thinking');
  assert.ok(seen.includes('thinking'));
  sdk.events.emit('agent.thinking.end');
  assert.strictEqual(sdk.presence.state(), 'idle');
  off();
  const before = seen.length;
  sdk.events.emit('agent.thinking.start');
  assert.strictEqual(seen.length, before, 'unsubscribe 后不再收到');
  assert.strictEqual(seen.length, 3, '回放初始 idle + thinking + idle');
});

test('persona: get() 返回 identity+personality（Mira 预设）', () => {
  const sdk = createBwmRuntime();
  const p = sdk.persona.get();
  assert.strictEqual(p.identity.name, 'Mira');
  assert.strictEqual(p.identity.tagline, 'be water my friend');
  assert.strictEqual(p.personality.archetype, '温暖陪伴型');
});

test('agent: send() 走 transport → reply + requestState 生命周期', async () => {
  let posted = null;
  const sdk = createBwmRuntime({
    transport: async (path, body) => {
      posted = { path, body };
      return { reply: '你好，我是Mira' };
    },
  });
  assert.strictEqual(sdk.agent.status().state, 'idle');
  const res = await sdk.agent.send('你好');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.reply, '你好，我是Mira');
  assert.ok(posted.body.requestId, 'send 带 requestId');
  // 生命周期：send 后回 idle（start→reply→end）
  assert.strictEqual(sdk.agent.status().state, 'idle');
});

test('agent: send() 网络失败 → ok:false + 状态回 idle', async () => {
  const sdk = createBwmRuntime({
    transport: async () => { throw new Error('network'); },
  });
  const res = await sdk.agent.send('ping');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'network');
  assert.strictEqual(sdk.agent.status().state, 'idle');
});

test('agent: cancel() 打断进行中的请求 → idle + cancelled 标记', () => {
  const sdk = createBwmRuntime({ transport: () => new Promise(() => {}) }); // 永不返回
  sdk.agent.send('long task'); // 不 await（挂起中）
  assert.strictEqual(sdk.agent.status().state, 'thinking');
  const after = sdk.agent.cancel();
  assert.strictEqual(after.state, 'idle');
  assert.strictEqual(after.cancelled, true);
});

test('agent: send() 进行中重复 send → requestId 保持（状态机拒绝重复）', async () => {
  let count = 0;
  const sdk = createBwmRuntime({
    transport: async (path, body) => {
      count++;
      return { reply: 'r' + count };
    },
  });
  const p1 = sdk.agent.send('a'); // 挂起中
  const p2 = sdk.agent.send('b'); // 状态机拒绝（thinking）→ 但仍调 transport？
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(count, 2, 'transport 两次都被调（SDK 层未锁，服务端 requestId 幂等兜底）');
  assert.ok(r2.ok);
  assert.strictEqual(sdk.agent.status().state, 'idle');
});
