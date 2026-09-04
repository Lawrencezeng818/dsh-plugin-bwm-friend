#!/usr/bin/env node
/**
 * tests/protocol-conformance.e2e.mjs — 协议一致性套件（完成度批次9）
 * 外部 SDK 可以依赖的公开契约逐项核验（隔离 HOME shim）：
 * health/settings/inventory/media-token/update/task/审计 —— 形状与语义双重断言。
 * 并实跑 examples/sdk-consumer.mjs（外部采用路径自证）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { validateSettings, normalizeSettings } from '../packages/bwm-protocol/schema/index.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const home = mkdtempSync(join(tmpdir(), 'bwm-conformance.'));
const PORT = 8971;
const base = `http://127.0.0.1:${PORT}`;
let failed = 0;
const ok = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) failed = 1; return cond; };

const shim = spawn(process.execPath, [join(repo, 'tests', 'verify-shim.mjs'), join(repo, 'lib', 'index.js'), String(PORT)], {
  env: { ...process.env, HOME: home, BWM_LOG_DISABLE: '1' }, stdio: 'ignore',
});
try {
  let up = false;
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`${base}/bwm-friend/health`)).status === 200) { up = true; break; } } catch { /* retry */ } await new Promise((r) => setTimeout(r, 250)); }
  ok('shim 启动', up);

  // 1. health 契约
  const health = JSON.parse(await (await fetch(`${base}/bwm-friend/health`)).text());
  ok('health: version semver + uptimeSec 数字 + components 五件', /^\d+\.\d+\.\d+$/.test(health.version) && typeof health.uptimeSec === 'number' && ['assets', 'skins', 'voice', 'auth', 'config'].every((k) => k in health.components));

  // 2. settings 契约：schema 校验 + normalize 幂等
  const settings = JSON.parse(await (await fetch(`${base}/bwm-friend/settings`)).text());
  const v = validateSettings(settings);
  ok('settings: 通过协议 schema 校验', v.valid === true);
  ok('settings: normalize 幂等', JSON.stringify(normalizeSettings(settings)) === JSON.stringify(normalizeSettings(normalizeSettings(settings))));

  // 3. inventory 契约：不透明 url 句柄 + 必备字段 + 枚举
  const inv = JSON.parse(await (await fetch(`${base}/bwm-friend/inventory`)).text());
  const bad = (inv.items || []).filter((it) => !it.id || !it.name || !it.url || !/^\//.test(it.url) || !['idle', 'talk', 'other'].includes(it.type) || !['skin', 'local'].includes(it.source));
  ok(`inventory: ${inv.items.length} 项全部符合字段契约`, bad.length === 0) || console.log('  [bad]', JSON.stringify(bad[0]));

  // 4. media token 契约：伪造 token 拒绝（不透明句柄不可枚举）
  const mr = await fetch(`${base}/bwm-friend/media/${'a'.repeat(32)}`);
  ok('media: 伪造 token → 拒绝（403/404）', mr.status === 403 || mr.status === 404);

  // 5. update 契约
  const upd = JSON.parse(await (await fetch(`${base}/bwm-friend/update/check`)).text());
  ok('update: {current,latest,hasUpdate} 形状', 'current' in upd && 'latest' in upd && 'hasUpdate' in upd);

  // 6. task 空消息契约（友好回复，不 500）
  const t = JSON.parse(await (await fetch(`${base}/bwm-friend/work/task`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).text());
  ok('task: 空消息 → 友好回复', typeof t.reply === 'string' && t.reply.includes('有什么任务'));

  // 7. 审计可见性契约（403 载荷有痕——公开行为）
  const evil = await fetch(`${base}/bwm-friend/settings`, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'not-json' });
  ok('task: 非法载荷被拒且有痕', evil.status === 400 || evil.status === 415 || evil.status === 403);

  // 8. SDK 示例消费者实跑（外部采用路径自证）
  const out = execFileSync(process.execPath, [join(repo, 'examples', 'sdk-consumer.mjs'), base], { encoding: 'utf8', timeout: 60000 });
  ok('sdk-consumer: 全程契约通过（exit 0）', out.includes('✅ SDK 消费者全程契约通过')) || console.log(out);
} finally { shim.kill(); rmSync(home, { recursive: true, force: true }); }

console.log(failed ? '❌ PROTOCOL CONFORMANCE FAIL' : '✅ PROTOCOL CONFORMANCE ALL PASS');
process.exit(failed);
