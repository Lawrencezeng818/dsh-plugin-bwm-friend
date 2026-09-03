#!/usr/bin/env node
/**
 * tests/agent-hang-shim.mjs — 提供完整 fake DSH ctx 的 shim（完成度批次4）
 * agents.create 返回 whenIdle 永不 resolve 的挂起 agent + dispose 间谍；
 * /__spy 回收间谍状态。用于真挂起超时/中止/并发上限的确定性验证。
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const libPath = process.argv[2];
const port = Number(process.argv[3] || 8941);
const mod = await import(pathToFileURL(libPath).href);

const spy = { disposed: 0, created: 0 };
const handlers = [];
const webServer = { register: (o) => { handlers.push(o); return () => {}; } };
const makeHangingAgent = () => ({
  session: { seq: 1, id: 'hang-agent', events: [] },
  whenIdle: () => new Promise(() => {}), // 永不 resolve = 真挂起
  followup() {},
  dispose() { spy.disposed += 1; },
});
const ctx = {
  webServer,
  get(name) {
    if (name === 'agents') return { create: async () => { spy.created += 1; return { agent: makeHangingAgent() }; } };
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'mock', model: 'mock-model' }) };
    if (name === 'sessions') return { flush: async () => {}, list: () => [{ id: 's1', header: { meta: { cwd: '/tmp/work' } }, events: [{ type: 'user/message', data: { message: { content: [{ type: 'text', text: '帮我修 bug' }] } } }] }] };
    return undefined;
  },
};
await mod.apply(ctx);

const server = http.createServer((req, res) => {
  const u = new URL(req.url || '/', 'http://x');
  if (u.pathname === '/__spy') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(spy));
  }
  const h = handlers.find((x) => u.pathname.startsWith(x.path));
  if (h) return h.handler(req, res);
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{}');
});
server.listen(port, '127.0.0.1', () => console.log('agent-hang-shim on ' + port));
