#!/usr/bin/env node
/**
 * tests/companion-chain.e2e.cjs — 陪伴智能链路 E2E（完成度批次2）
 * Mock MiMo/DeepSeek 注入（BWM_MIMO_BASE_URL/BWM_CHAT_BASE_URL），HOME 全隔离：
 * ASR 转写 → 聊天（含凭证真实读取路径）→ 记忆落盘 → TTS 合成 → metrics 联动，全链路断言。
 * 真实 key 冒烟仍走 tests/p2-voice-smoke.cjs（可选）。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { startMockLlmServer } from './mock-llm-server.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const home = mkdtempSync(join(tmpdir(), 'bwm-chain-e2e.'));
mkdirSync(join(home, '.dsh'), { recursive: true });
mkdirSync(join(home, '.dsh-bwm-friend'), { recursive: true });
writeFileSync(join(home, '.dsh', '.credentials.yaml'), "DEEPSEEK_API_KEY: test-key-123\n"); // 走真实凭证读取路径
writeFileSync(join(home, '.dsh-bwm-friend', 'config.json'), JSON.stringify({ version: 1, account: {}, avatar: { theme: '甜心女孩' }, voice: {}, llm: {}, ui: {}, power: {} }));

const mock = await startMockLlmServer();
const PORT = 8931;
let failed = 0;
const ok = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) failed = 1; return cond; };
const base = `http://127.0.0.1:${PORT}`;
// 端口占用快败（僵尸 shim = 无 mock env 的假阳性来源）
try { const stale = await fetch(base + '/bwm-friend/health'); if (stale.status === 200) { console.log('FATAL: 端口 ' + PORT + ' 已被占用（僵尸 shim？）'); process.exit(2); } } catch { /* 空闲，正常 */ }
const shim = spawn(process.execPath, [join(repo, 'tests', 'verify-shim.mjs'), join(repo, 'lib', 'index.js'), String(PORT)], {
  env: { ...process.env, HOME: home, BWM_MIMO_BASE_URL: mock.url, BWM_CHAT_BASE_URL: mock.url, XIAOMI_MIMO_API_KEY: 'test-key-e2e', BWM_LOG_DISABLE: '1', BWM_TASK_MIN_MS: '1500' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
try { await runAssertions(); } finally { shim.kill(); try { mock.server.close(); } catch { /* noop */ } rmSync(home, { recursive: true, force: true }); }
process.exit(failed);

async function runAssertions() {

let up = false;
for (let i = 0; i < 40; i++) {
  try { const r = await fetch(base + '/bwm-friend/health'); if (r.status === 200) { up = true; break; } } catch { /* retry */ }
  await new Promise((r) => setTimeout(r, 250));
}
ok('shim 启动（HOME 隔离 + mock 注入）', up);
if (up) {
  // 0. 主题目录名含 HTML：inventory 契约不崩（symlink 条目另由 host 端点套件覆盖）
  try {
    const evilTheme = join(home, '.bwm-friend', 'assets', '<img src=x onerror=alert(1)>');
    mkdirSync(evilTheme, { recursive: true });
    writeFileSync(join(evilTheme, 'idle-x.mp4'), 'x');
  } catch { /* 不阻塞主链路 */ }
  // 1. ASR：音频 → 转写
  const asr = await (await fetch(base + '/bwm-friend/transcribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audioBase64: 'dGVzdA==', format: 'mp3' }) })).json();
  ok('ASR 转写走 Mock MiMo（Bearer 接线正确）', asr.ok === true && asr.text === mock.ASR_TEXT) || console.log('  [dbg asr]', JSON.stringify(asr));
  // 2. 聊天：DeepSeek 凭证真实读取 + mock 回复
  const chat = await (await fetch(base + '/bwm-friend/companion/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '我叫张三，住在杭州' }) })).json();
  ok('聊天走 Mock DeepSeek（credentials.yaml 读取路径）', typeof chat.reply === 'string' && chat.reply.includes('mock')) || console.log('  [dbg chat]', JSON.stringify(chat).slice(0,200));
  // 3. 记忆落盘：聊天后事实入库
  await new Promise((r) => setTimeout(r, 300));
  let memFacts = '';
  try { memFacts = JSON.parse(readFileSync(join(home, '.dsh-bwm-friend', 'memory.json'), 'utf8')).userFacts.join('|'); } catch { /* no memory */ }
  ok('记忆抽取落盘（我叫张三 → userFacts）', memFacts.includes('张三'));
  // 4. TTS：文本 → 音频
  const tts = await (await fetch(base + '/bwm-friend/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '你好呀', voice: '冰糖' }) })).json();
  ok('TTS 合成走 Mock MiMo', tts.ok === true && tts.audioBase64 === mock.TTS_AUDIO) || console.log('  [dbg tts]', JSON.stringify(tts));
  // 4.5 任务并发上限（P1-3）：seam 放慢任务 → 第 3 个并发 429
  const slow = Number(process.env.BWM_TASK_MIN_MS || 0);
  if (slow > 0) {
    const t = [1, 2, 3].map(() => fetch(base + '/bwm-friend/work/task', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '并发测试' }) }));
    const rs = await Promise.all(t);
    const statuses = rs.map((r) => r.status);
    ok('任务并发上限（第 3 个 429）', statuses.filter((c) => c === 429).length >= 1);
    const met2 = JSON.parse(await (await fetch(base + '/bwm-friend/metrics')).text());
    ok('限速后服务存活且 metrics 可用', typeof met2.totals.tasks === 'number');
  }
  // 5. metrics 联动（批次1 基础设施被批次2 消费）
  const met = JSON.parse(await (await fetch(base + '/bwm-friend/metrics')).text());
  ok('metrics 总量联动（chats/transcribes 计数）', met.totals.chats >= 1 && met.totals.transcribes >= 1);
}
  console.log(failed ? '❌ CHAIN E2E FAIL' : '✅ CHAIN E2E ALL PASS');
}
