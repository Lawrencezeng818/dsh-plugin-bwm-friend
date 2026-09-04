#!/usr/bin/env node
/**
 * tests/embedded-selectors.e2e.mjs — 选择器抗改版回归（完成度批次7）
 * 前提：沙盒 3200 运行中。headless Chrome + CDP（Node 内建 WebSocket，零依赖）
 * 真渲染 DOM 上逐个核验 EMBEDDED_SELECTORS 登记的哈希类前缀/结构选择器——
 * 上游 DSH 改版重命名即红灯（外壳持续税的自动化收租）。
 * 分级：hard=常驻结构（缺=漂移）；soft=条件渲染组件（缺=记录不判败）。
 * Chrome 收尾：只杀自己 spawn 的 PID（仓库纪律：禁止 pkill -f Chrome）。
 */
import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BWM_E2E_BASE || 'http://127.0.0.1:3200';
const CDP_PORT = 9224;
let failed = 0;
const ok = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) failed = 1; return cond; };

// 1. 静态解析登记表（hard/soft 分级表见下）
const src = readFileSync(join(repo, 'src', 'client.js'), 'utf8');
const blockMatch = src.match(/const EMBEDDED_SELECTORS = \{[\s\S]*?\n\};/);
if (!blockMatch) { console.log('FAIL 未找到 EMBEDDED_SELECTORS'); process.exit(1); }
const block = blockMatch[0];
const entries = [];
for (const m of block.matchAll(/(\w+):\s*'([A-Za-z0-9_]{5,})'/g)) entries.push({ key: m[1], token: m[2] });
const stableMatch = block.match(/stable:\s*\[([\s\S]*?)\],/);
const stableItems = stableMatch ? [...stableMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
const HARD = ['composer', 'conversation', 'shell', 'sidebarInner', 'modelSelect'];
ok(`登记表解析（${entries.length} token + ${stableItems.length} stable）`, entries.length >= 8 && stableItems.length >= 3);

// 2. headless Chrome + CDP 真渲染
const profile = mkdtempSync(join(tmpdir(), 'chrome-drift-'));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`,
  '--password-store=basic', '--use-mock-keychain', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });
let domReport = null;
try {
  let wsUrl = null;
  for (let i = 0; i < 30 && !wsUrl; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) wsUrl = page.webSocketDebuggerUrl;
    } catch { /* retry */ }
  }
  ok('CDP 就绪', !!wsUrl);
  if (wsUrl) {
    const ws = new WebSocket(wsUrl);
    let id = 0; const pending = new Map();
    const send = (method, params = {}) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws 错误')); setTimeout(() => j(new Error('ws 超时')), 15000); });
    await send('Page.enable');
    await send('Page.navigate', { url: `${BASE}/?bwm=embedded` });
    let hydrated = false;
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const r = await send('Runtime.evaluate', { expression: '!!window.__bwm', returnByValue: true });
        if (r && r.result && r.result.value === true) { hydrated = true; break; }
      } catch { /* retry */ }
    }
    ok('client.js 已注入并生效（window.__bwm）', hydrated);
    const expr = `(() => {
      const tokens = ${JSON.stringify(entries.map((e) => e.token))};
      const miss = tokens.filter((t) => !document.querySelector('[class*="' + t + '"]'));
      const stableMiss = ${JSON.stringify(stableItems)}.filter((s) => {
        try { return !document.querySelector(s); } catch { return true; }
      });
      return JSON.stringify({ miss, stableMiss, classes: document.querySelectorAll('[class]').length });
    })()`;
    const q = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    domReport = q && q.result && q.result.value ? JSON.parse(q.result.value) : null;
  }
} finally { try { chrome.kill('SIGKILL'); } catch { /* noop */ } try { rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ } }

// 3. 分级断言
if (domReport) {
  ok(`真渲染 DOM 就绪（${domReport.classes} 个 class 元素）`, domReport.classes >= 50);
  const hardMiss = entries.filter((e) => HARD.includes(e.key) && domReport.miss.includes(e.token));
  const softMiss = entries.filter((e) => !HARD.includes(e.key) && domReport.miss.includes(e.token));
  ok(`常驻结构零漂移（hard ${HARD.length} 项）`, hardMiss.length === 0) ||
    console.log('  [硬漂移]', hardMiss.map((e) => `${e.key}(${e.token})`).join(', '));
  console.log(`  [记录] 条件组件缺席（不判败）: ${softMiss.map((e) => e.key).join(', ') || '无'}`);
  ok('stable 结构选择器存活', domReport.stableMiss.length === 0) ||
    console.log('  [stable 漂移]', domReport.stableMiss.join(', '));
} else { ok('真渲染 DOM 报告', false); }

// 4. 双页面外观基线（页面关键标记 + 壳资产随包）
for (const [page, marker] of [['work/', 'templateGrid'], ['companion/', 'avatarVideo']]) {
  const html = await (await fetch(`${BASE}/bwm-friend/${page}`)).text();
  ok(`页面标记: /bwm-friend/${page} 含 ${marker}`, html.includes(marker));
}
for (const asset of ['brand-mark-54.png', 'styles.css', 'app.js']) {
  const r = await fetch(`${BASE}/bwm-friend/work/${asset}`);
  ok(`壳资产随包: ${asset}`, r.status === 200);
}

console.log(failed ? '❌ EMBEDDED SELECTORS FAIL' : '✅ EMBEDDED SELECTORS ALL PASS');
process.exit(failed);
