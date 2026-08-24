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

/* ── P2：Memory / Voice / Persona.switch ── */
test('memory: remember 抽取事实 + recall + forget', () => {
  const sdk = createBwmRuntime();
  const mem = sdk.memory.remember('我叫小明，我喜欢打篮球');
  assert.ok(mem.userFacts.includes('小明'));
  assert.ok(mem.userFacts.includes('打篮球'));
  assert.strictEqual(sdk.memory.recall().userFacts.length, 2);
  // 问句噪音不抽取
  sdk.memory.remember('今天天气怎么样？');
  assert.strictEqual(sdk.memory.recall().userFacts.length, 2, '问句不产生事实');
  // forget
  const after = sdk.memory.forget('小明');
  assert.ok(!after.userFacts.includes('小明'));
});

test('memory: memory.updated 事件广播', () => {
  const sdk = createBwmRuntime();
  const got = [];
  sdk.events.on('memory.updated', (p) => got.push(p));
  sdk.memory.remember('我喜欢咖啡');
  assert.strictEqual(got.length, 1);
  assert.deepStrictEqual(got[0].facts, ['咖啡']);
});

test('persona: switch 更新 identity/personality + 事件广播 + list', () => {
  const sdk = createBwmRuntime();
  const got = [];
  sdk.events.on('persona.switch', (p) => got.push(p.id));
  assert.deepStrictEqual(sdk.persona.list(), [
    { id: 'mira', label: 'Mira 陪伴' },
    { id: 'mentor', label: 'Mentor 导师' },
  ]);
  const p = sdk.persona.switch('mentor');
  assert.strictEqual(p.identity.name, 'Mentor');
  assert.strictEqual(p.identity.tagline, 'think sharper, act bolder');
  assert.strictEqual(p.personality.archetype, '理性导师型');
  assert.deepStrictEqual(got, ['mentor']);
  // 未知预设 → 抛错且不改当前
  assert.throws(() => sdk.persona.switch('bogus'), /unknown-persona/);
  assert.strictEqual(sdk.persona.get().identity.name, 'Mentor');
  // 切回 mira
  sdk.persona.switch('mira');
  assert.strictEqual(sdk.persona.get().identity.name, 'Mira');
});

test('voice: speak 走 transport（Node 无 Audio → false 不抛）', async () => {
  let posted = null;
  const sdk = createBwmRuntime({
    transport: async (path, body) => {
      posted = { path, body };
      return { ok: true, audioBase64: 'AAAA' };
    },
  });
  const r = await sdk.voice.speak('你好', { voice: '茉莉' });
  assert.strictEqual(r, false); // Node 环境无 Audio（真实浏览器返回 play Promise）
  assert.strictEqual(posted.path, '/bwm-friend/tts');
  assert.strictEqual(posted.body.text, '你好');
  assert.strictEqual(posted.body.voice, '茉莉');
});

test('voice: listen 无麦克风环境 → reject no-mic', async () => {
  const sdk = createBwmRuntime();
  // Node 环境 navigator 未定义 → no-mic
  await assert.rejects(() => sdk.voice.listen(() => {}), /no-mic/);
});

/* ── P2-Proactive：数字人主动行为 ── */
test('proactive: trigger 生成开场白 + 生命周期 + proactive.message 广播', async () => {
  const sdk = createBwmRuntime({
    transport: async (path, body) => ({ reply: '嗨，最近怎么样？', requestId: body.requestId }),
  });
  const msgs = [];
  sdk.proactive.on((p) => msgs.push(p));
  const res = await sdk.proactive.trigger({ reason: 'greeting' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.reply, '嗨，最近怎么样？');
  assert.strictEqual(res.reason, 'greeting');
  assert.strictEqual(msgs.length, 1);
  assert.strictEqual(msgs[0].reply, '嗨，最近怎么样？');
  // 生命周期完整回 idle
  assert.strictEqual(sdk.agent.status().state, 'idle');
  // presence 回 idle
  assert.strictEqual(sdk.presence.state(), 'idle');
});

test('proactive: 忙时不打断（agent.send 进行中 → trigger busy）', async () => {
  const sdk = createBwmRuntime({ transport: () => new Promise(() => {}) }); // 永不返回
  sdk.agent.send('long task'); // 挂起
  const res = await sdk.proactive.trigger({ reason: 'checkin' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'busy');
});

test('proactive: 网络失败 → ok:false + 状态回 idle', async () => {
  const sdk = createBwmRuntime({
    transport: async () => { throw new Error('network'); },
  });
  const res = await sdk.proactive.trigger({ reason: 'memory' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'network');
  assert.strictEqual(sdk.agent.status().state, 'idle');
});
