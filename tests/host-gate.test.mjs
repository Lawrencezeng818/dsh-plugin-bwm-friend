/* 宿主鉴权闸门三态单测（P0，2026-11-25）
 *
 * 运行: node --test tests/host-gate.test.mjs
 *
 * 覆盖的三种宿主形态（语义取自 dsh-market 生产代码 src/http.ts + src/index.ts）：
 *   ① connection.requestRejection(req)  —— DSH ≤0.2.2，免 inject
 *   ② connection.admit(facts)           —— DSH ≥0.2.3，必须从声明的注入作用域调
 *   ③ 两者皆无                          —— 更老宿主，降级交回自建同源防线
 *
 * 并固化两个「不能重犯」的回归：
 *   · #1299：作用域冷时**不得**从根 ctx 调 admit（否则抛 without inject → 全站 403）
 *   · fail-closed：闸门抛异常必须 403，绝不能 fail-open
 */
import test from 'node:test';
import assert from 'node:assert';
import { createHostGate, hostAdmissionFacts } from '../lib/index.js';

/** 极简 req/res 桩：够闸门用（headers/method/url/socket + writeHead/end） */
function makeReq(over = {}) {
  return { method: 'GET', url: '/bwm-friend/health', headers: { host: '127.0.0.1:3080' }, socket: {}, ...over };
}
function makeRes() {
  const res = { statusCode: 0, body: '', writeHead(code) { this.statusCode = code; return this; }, end(s) { this.body = s || ''; } };
  return res;
}
function bodyOf(res) { try { return JSON.parse(res.body); } catch { return null; } }

/** 带注入能力的 ctx 桩：inject 立即以 loginCtx 回调，loginCtx.get 走同一 connection */
function makeCtx(connection, { withInject = true } = {}) {
  const calls = { injectDeps: null, getFrom: [] };
  const ctx = {
    get(name) { calls.getFrom.push('root'); return name === 'connection' ? connection : undefined; },
  };
  if (withInject) {
    ctx.inject = (deps, cb) => {
      calls.injectDeps = deps;
      const loginCtx = { get(name) { calls.getFrom.push('scope'); return name === 'connection' ? connection : undefined; } };
      const restore = cb(loginCtx);
      return { dispose: () => { if (typeof restore === 'function') restore(); } };
    };
  }
  return { ctx, calls };
}

/* ── ① requestRejection 宿主（≤0.2.2） ── */

test('① requestRejection 返回 403 → 拒绝并应答 403', () => {
  const connection = { requestRejection: () => 403 };
  const { ctx } = makeCtx(connection);
  const gate = createHostGate(ctx);
  const res = makeRes();
  assert.strictEqual(gate.refuse(makeReq(), res), true, '应判为已拒绝');
  assert.strictEqual(res.statusCode, 403);
  assert.match(JSON.parse(res.body).error, /未通过宿主访问校验|did not pass/, '应带可读原因');
  assert.strictEqual(gate.state(), 'requestRejection');
  gate.dispose();
});

test('① requestRejection 返回 401 → 401 且提示登录 DSH', () => {
  const { ctx } = makeCtx({ requestRejection: () => 401 });
  const gate = createHostGate(ctx);
  const res = makeRes();
  assert.strictEqual(gate.refuse(makeReq(), res), true);
  assert.strictEqual(res.statusCode, 401);
  assert.match(JSON.parse(res.body).error, /DSH login required/);
  gate.dispose();
});

test('① requestRejection 返回 undefined → 准入（不拦截）', () => {
  const { ctx } = makeCtx({ requestRejection: () => undefined });
  const gate = createHostGate(ctx);
  const res = makeRes();
  assert.strictEqual(gate.refuse(makeReq(), res), false);
  assert.strictEqual(res.statusCode, 0, '不得写响应');
  gate.dispose();
});

/* ── ② admit 宿主（≥0.2.3） ── */

test('② admit 从注入作用域读 connection，{rejection:401} → 401', () => {
  const seen = [];
  const connection = { admit: (facts) => { seen.push(facts); return { rejection: 401 }; } };
  const { ctx, calls } = makeCtx(connection);
  const gate = createHostGate(ctx);
  const res = makeRes();
  assert.strictEqual(gate.refuse(makeReq(), res), true);
  assert.strictEqual(res.statusCode, 401);
  assert.deepStrictEqual(calls.injectDeps, ['connection', 'connection.authentication'], '必须声明这两个服务');
  assert.ok(calls.getFrom.includes('scope'), 'connection 必须从注入作用域读（#1299）');
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(gate.state(), 'admit');
  gate.dispose();
});

test('② admit 返回 {peer} → 准入', () => {
  const { ctx } = makeCtx({ admit: () => ({ peer: { id: 'x' } }) });
  const gate = createHostGate(ctx);
  const res = makeRes();
  assert.strictEqual(gate.refuse(makeReq(), res), false);
  assert.strictEqual(res.statusCode, 0);
  gate.dispose();
});

test('② admit 返回 undefined → 403（没给答复 = 没准入）', () => {
  const { ctx } = makeCtx({ admit: () => undefined });
  const gate = createHostGate(ctx);
  const res = makeRes();
  assert.strictEqual(gate.refuse(makeReq(), res), true);
  assert.strictEqual(res.statusCode, 403);
  gate.dispose();
});

test('② admit 调用时喂的是绝对 url（入参 req.url 只有路径）', () => {
  let facts;
  const { ctx } = makeCtx({ admit: (f) => { facts = f; return { peer: {} }; } });
  const gate = createHostGate(ctx);
  gate.refuse(makeReq({ url: '/bwm-friend/settings?x=1' }), makeRes());
  assert.strictEqual(facts.url, 'http://127.0.0.1:3080/bwm-friend/settings?x=1');
  assert.strictEqual(facts.method, 'GET');
  gate.dispose();
});

/* ── ③ 无宿主闸门（老宿主 / 无 connection） ── */

test('③ 无 connection → 不拦截（降级自建防线）', () => {
  const { ctx } = makeCtx(undefined);
  const gate = createHostGate(ctx);
  const res = makeRes();
  assert.strictEqual(gate.refuse(makeReq(), res), false);
  assert.strictEqual(res.statusCode, 0);
  assert.strictEqual(gate.state(), 'none');
  gate.dispose();
});

test('③ connection 无任何闸门方法 → 不拦截', () => {
  const { ctx } = makeCtx({ someOtherThing: 1 });
  const gate = createHostGate(ctx);
  assert.strictEqual(gate.refuse(makeReq(), makeRes()), false);
  assert.strictEqual(gate.state(), 'none');
  gate.dispose();
});

/* ── 回归 #1299：作用域冷时不得调 admit ── */

test('🔴 回归 #1299：没有注入能力（老 ctx）时，即使有 admit 也不调它', () => {
  let called = 0;
  const connection = { admit: () => { called += 1; throw new Error('cannot get property "connection.authentication" without inject'); } };
  const { ctx } = makeCtx(connection, { withInject: false });
  const gate = createHostGate(ctx);
  for (let i = 0; i < 3; i++) {
    const res = makeRes();
    assert.strictEqual(gate.refuse(makeReq(), res), false, '必须降级放行，不能 403');
    assert.strictEqual(res.statusCode, 0);
  }
  assert.strictEqual(called, 0, 'admit 一次都不该被调（否则就是全站 403 风暴）');
  assert.strictEqual(gate.state(), 'none');
  gate.dispose();
});

test('🔴 作用域冷但有 requestRejection → 仍用它（它不需要 inject）', () => {
  const connection = { requestRejection: () => 403, admit: () => { throw new Error('should not be called'); } };
  const { ctx } = makeCtx(connection, { withInject: false });
  const gate = createHostGate(ctx);
  const res = makeRes();
  assert.strictEqual(gate.refuse(makeReq(), res), true);
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(gate.state(), 'requestRejection');
  gate.dispose();
});

/* ── fail-closed ── */

test('🔴 闸门抛异常 → 403（绝不 fail-open）', () => {
  const { ctx } = makeCtx({ requestRejection: () => { throw new Error('host bug'); } });
  const gate = createHostGate(ctx);
  const res = makeRes();
  assert.strictEqual(gate.refuse(makeReq(), res), true, '抛错也必须拦住');
  assert.strictEqual(res.statusCode, 403);
  gate.dispose();
});

/* ── 退出口 ── */

test('BWM_HOST_GATE=off → 完全不介入', () => {
  const prev = process.env.BWM_HOST_GATE;
  process.env.BWM_HOST_GATE = 'off';
  try {
    const { ctx } = makeCtx({ requestRejection: () => 403 });
    const gate = createHostGate(ctx);
    const res = makeRes();
    assert.strictEqual(gate.refuse(makeReq(), res), false);
    assert.strictEqual(gate.state(), 'off');
    gate.dispose();
  } finally {
    if (prev === undefined) delete process.env.BWM_HOST_GATE; else process.env.BWM_HOST_GATE = prev;
  }
});

/* ── dispose ── */

test('dispose 后作用域归还：admit 路径随之失效（不再调用宿主）', () => {
  let disposed = 0;
  let admitted = 0;
  const connection = { admit: () => { admitted += 1; return { rejection: 401 }; } };
  const ctx = {
    get: () => connection,
    inject: (deps, cb) => { const r = cb({ get: () => connection }); return { dispose: () => { disposed += 1; if (typeof r === 'function') r(); } }; },
  };
  const gate = createHostGate(ctx);
  const res1 = makeRes();
  assert.strictEqual(gate.refuse(makeReq(), res1), true, 'dispose 前：admit 闸门生效');
  assert.strictEqual(res1.statusCode, 401);
  assert.strictEqual(admitted, 1);

  gate.dispose();
  assert.strictEqual(disposed, 1, '注入作用域必须被回收');

  // dispose 后 gateCtx 已清：只剩 admit 的宿主必须降级（不得回到 #1299 那条路）
  const res2 = makeRes();
  assert.strictEqual(gate.refuse(makeReq(), res2), false, 'dispose 后应降级放行');
  assert.strictEqual(res2.statusCode, 0);
  assert.strictEqual(admitted, 1, 'admit 不得再被调用');
});

/* ── 纯函数 ── */

test('hostAdmissionFacts：https 由 socket.encrypted 推导', () => {
  const f = hostAdmissionFacts(makeReq({ socket: { encrypted: true } }));
  assert.strictEqual(f.url, 'https://127.0.0.1:3080/bwm-friend/health');
});

test('hostAdmissionFacts：畸形 Host 不抛（回落 localhost）', () => {
  const f = hostAdmissionFacts(makeReq({ headers: { host: 'a b c' } }));
  assert.ok(typeof f.url === 'string' && f.url.length > 0);
});
