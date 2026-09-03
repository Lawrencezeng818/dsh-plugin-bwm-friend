#!/usr/bin/env node
/** tests/task-timeout.e2e.mjs — 工作模式真挂起验证（完成度批次4）：超时→中止→指标→并发上限→工作区边界 */
import { spawn, execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8941;
const base = `http://127.0.0.1:${PORT}`;
let failed = 0;
const ok = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) failed = 1; return cond; };

const shim = spawn(process.execPath, [join(repo, 'tests', 'agent-hang-shim.mjs'), join(repo, 'lib', 'index.js'), String(PORT)], {
  env: { ...process.env, BWM_AGENT_MOCK: '1', BWM_TASK_TIMEOUT_MS: '600', BWM_LOG_DISABLE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
try {
  let up = false;
  for (let i = 0; i < 40; i++) { try { if ((await fetch(base + '/bwm-friend/health')).status === 200) { up = true; break; } } catch { /* retry */ } await new Promise((r) => setTimeout(r, 250)); }
  ok('shim 启动', up);
  if (up) {
    // 1. 真挂起 → 超时返回（≤8s，超时阈值 600ms）
    const t0 = Date.now();
    const r1 = await (await fetch(base + '/bwm-friend/work/task', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '挂起任务' }) })).json();
    const dt = Date.now() - t0;
    ok(`真挂起超时返回 task-timeout（${dt}ms）`, r1.error && r1.error.includes('task-timeout') && dt < 8000);
    // 2. 超时路径调用了 dispose（agent 被尽力中止，不再"已失败却仍在跑"）
    const spy1 = JSON.parse((await (await fetch(base + '/__spy')).text()));
    ok('超时后 agent 已被 dispose 中止', spy1.disposed >= 1);
    // 3. metrics 记账 taskTimeouts
    const met = JSON.parse(await (await fetch(base + '/bwm-friend/metrics')).text());
    ok('metrics.taskTimeouts 记账', met.totals.taskTimeouts >= 1);
    // 4. 挂起态下并发：第 3 个 429（无需 seam——挂起本身就是确定性窗口）
    const t = [1, 2, 3].map(() => fetch(base + '/bwm-friend/work/task', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '并发' + 1 }) }));
    const statuses = (await Promise.all(t)).map((r) => r.status);
    ok('挂起态并发第 3 个 → 429', statuses.filter((c) => c === 429).length >= 1);
    // 5. 空消息友好回复（不占并发槽）
    const r5 = JSON.parse(await (await fetch(base + '/bwm-friend/work/task', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '' }) })).text());
    ok('空消息友好回复', (r5.reply || '').includes('有什么任务'));
    // 6. 工作区列表：fake sessions → 标题抽取自 user/message
    const ws = JSON.parse(await (await fetch(base + '/bwm-friend/work/workspaces')).text());
    ok('工作区标题抽取自 user/message', Array.isArray(ws.items) && ws.items.length >= 1 && ws.items[0].title.includes('帮我修 bug'));
  }
} finally { shim.kill(); }
console.log(failed ? '❌ TASK TIMEOUT E2E FAIL' : '✅ TASK TIMEOUT E2E ALL PASS');
process.exit(failed);
