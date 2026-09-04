#!/usr/bin/env node
/** tests/settings-robust.e2e.mjs — 设置同步收尾（完成度批次6）：迁移/损坏兜底/并发读写/默认形状/schema 边角 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const home = mkdtempSync(join(tmpdir(), 'bwm-set-robust.'));
const cfgDir = join(home, '.dsh-bwm-friend');
const cfgPath = join(cfgDir, 'config.json');
mkdirSync(cfgDir, { recursive: true });
const PORT = 8953;
const base = `http://127.0.0.1:${PORT}`;
let failed = 0;
const ok = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) failed = 1; return cond; };

const shim = spawn(process.execPath, [join(repo, 'tests', 'verify-shim.mjs'), join(repo, 'lib', 'index.js'), String(PORT)], {
  env: { ...process.env, HOME: home, BWM_LOG_DISABLE: '1' }, stdio: ['ignore', 'ignore', 'ignore'],
});
try {
  let up = false;
  for (let i = 0; i < 40; i++) { try { if ((await fetch(base + '/bwm-friend/health')).status === 200) { up = true; break; } } catch { /* retry */ } await new Promise((r) => setTimeout(r, 250)); }
  ok('shim 启动', up);

  // 1. 旧结构迁移：mode/layout → ui.mode/ui.chatWidth
  writeFileSync(cfgPath, JSON.stringify({ version: 1, mode: 'companion', layout: { chatWidth: 800 }, avatar: { theme: '甜心女孩' } }));
  let cfg = JSON.parse(await (await fetch(base + '/bwm-friend/settings')).text());
  ok('迁移: layout.chatWidth → ui.chatWidth', cfg.ui && cfg.ui.chatWidth === 800);
  ok('迁移: mode → ui.mode', cfg.ui && cfg.ui.mode === 'companion');
  ok('迁移: avatar.theme 保留', cfg.avatar && cfg.avatar.theme === '甜心女孩');

  // 2. 损坏配置 → 默认兜底不崩
  writeFileSync(cfgPath, '{corrupt!!!');
  cfg = JSON.parse(await (await fetch(base + '/bwm-friend/settings')).text());
  ok('损坏配置: 回默认且 version=1', cfg.version === 1 && cfg.ui && typeof cfg.ui.mode === 'string');

  // 3. 空对象 → 全默认形状（顶层键齐备）
  writeFileSync(cfgPath, JSON.stringify({}));
  cfg = JSON.parse(await (await fetch(base + '/bwm-friend/settings')).text());
  ok('空对象: 顶层键齐备（version/account/avatar/voice/llm/ui/power）',
    ['version', 'account', 'avatar', 'voice', 'llm', 'ui', 'power'].every((k) => k in cfg));

  unlinkSync(cfgPath);
  // 4. 并发读写：15 GET + 10 PUT 交错，读侧恒 200 合法 JSON，最终写存活
  const puts = [];
  for (let i = 0; i < 10; i++) {
    puts.push(fetch(base + '/bwm-friend/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ui: { chatWidth: 600 + i } }) }));
  }
  const gets = [];
  for (let i = 0; i < 15; i++) {
    gets.push(fetch(base + '/bwm-friend/settings').then(async (r) => ({ status: r.status, body: await r.text() })));
    if (i % 2 === 0 && puts[i]) gets.push(puts[i].then(async (r) => ({ status: r.status, body: await r.text() })));
  }
  const reads = await Promise.all(gets);
  const bad = reads.filter((r) => !(r.status === 200 && (() => { try { JSON.parse(r.body); return true; } catch { return false; } })()));
  ok('并发读: 全部 200 且 JSON 合法', reads.length >= 15 && bad.length === 0);
  const finalCfg = JSON.parse(await (await fetch(base + '/bwm-friend/settings')).text());
  ok('并发写: 恰有一个 chatWidth 存活且在写入域内', finalCfg.ui && finalCfg.ui.chatWidth >= 600 && finalCfg.ui.chatWidth <= 609);
  const met = JSON.parse(await (await fetch(base + '/bwm-friend/metrics')).text());
  ok('metrics: configWrites=10 全记账', met.totals.configWrites === 10);
} finally { shim.kill(); rmSync(home, { recursive: true, force: true }); }

// 5. schema 边角（纯函数单测段）
const schema = await import(join(repo, 'packages', 'bwm-protocol', 'schema', 'index.js').replace(/^/, 'file://'));
const v1 = schema.validateSettings({ ...schema.DEFAULT_SETTINGS, version: 1 });
ok('schema: 默认设置自校验通过', v1.valid === true);
const v2 = schema.validateSettings({ ...schema.DEFAULT_SETTINGS, version: 2 });
ok('schema: version=2 拒绝（major 变更走新 schema）', v2.valid === false);
const norm = schema.normalizeSettings({});
ok('schema: normalize 补齐全部顶层键', ['account', 'avatar', 'voice', 'llm', 'ui', 'power'].every((k) => k in norm));

console.log(failed ? '❌ SETTINGS ROBUST FAIL' : '✅ SETTINGS ROBUST ALL PASS');
process.exit(failed);
