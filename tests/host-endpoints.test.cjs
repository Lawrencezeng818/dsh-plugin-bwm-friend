/**
 * Host 端点回归测试（2026-08-24 代码审查修复固化）
 *
 * 覆盖本轮修复的 4 类问题：
 *   1. CSRF 防护（Sec-Fetch-Site cross-site / 恶意 Origin → 403；无头/同源 → 放行）
 *   2. 静态资源 DoS（不存在文件/编码穿越载荷 → 404/403 且进程存活）
 *   3. 路径穿越（resolve 校验 → 不越界、不返回敏感内容）
 *   4. media Range（RFC 7233：suffix-range 正确、start>end 416、正常 206）
 *
 * 运行前提：沙盒已启动（cd /Users/zengtian/projects/dsh-sandbox && ./start.sh 3200）
 * 运行：node --test tests/host-endpoints.test.cjs
 */
const test = require('node:test');
const assert = require('node:assert');

const BASE = process.env.BWM_E2E_BASE || 'http://127.0.0.1:3200';

async function req(path, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(BASE + path, { method, headers, body });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

test('前置: 沙盒健康（无沙盒则测试无意义）', async () => {
  const { status } = await req('/bwm-friend/health');
  assert.strictEqual(status, 200, '沙盒必须运行');
});

/* ── 1. CSRF 防护 ── */
test('CSRF: Sec-Fetch-Site cross-site POST /work/task → 403（防 RCE）', async () => {
  const { status, text } = await req('/bwm-friend/work/task', {
    method: 'POST',
    headers: { 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'text/plain' },
    body: '{"message":"whoami"}',
  });
  assert.strictEqual(status, 403);
  assert.match(text, /forbidden/);
});

test('CSRF: 恶意 Origin POST /companion/chat → 403', async () => {
  const { status } = await req('/bwm-friend/companion/chat', {
    method: 'POST',
    headers: { Origin: 'http://evil.com', 'Content-Type': 'text/plain' },
    body: 'hello',
  });
  assert.strictEqual(status, 403);
});

test('CSRF: 无头请求（curl 类，无 Origin/Sec-Fetch-Site）→ 放行', async () => {
  const { status } = await req('/bwm-friend/companion/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"message":"hi"}',
  });
  assert.strictEqual(status, 200);
});

test('CSRF: 同源 GET /settings → 放行', async () => {
  const { status } = await req('/bwm-friend/settings', { headers: { 'Sec-Fetch-Site': 'same-origin' } });
  assert.strictEqual(status, 200);
});

/* ── 2. 静态资源 DoS（曾崩进程）── */
test('DoS: 不存在静态资源 → 404 且进程存活', async () => {
  const { status } = await req('/bwm-friend/work/nonexistent.js');
  assert.strictEqual(status, 404);
  const { status: h } = await req('/bwm-friend/health');
  assert.strictEqual(h, 200, '服务器必须仍存活（createReadStream error 曾崩进程）');
});

test('DoS: 编码穿越载荷 ..%2f → 403/404 且进程存活', async () => {
  const { status } = await req('/bwm-friend/work/..%2f..%2fetc%2fpasswd');
  assert.ok(status === 403 || status === 404, `应 403/404，实际 ${status}`);
  const { status: h } = await req('/bwm-friend/health');
  assert.strictEqual(h, 200);
});

/* ── 3. 路径穿越 ── */
test('穿越: 明文 ../../etc/passwd → 403/404 且不返回敏感内容', async () => {
  const { status, text } = await req('/bwm-friend/work/../../etc/passwd');
  assert.ok(status === 403 || status === 404, `应 403/404，实际 ${status}`);
  assert.ok(!text.includes('root:'), '不得返回 /etc/passwd 内容');
});

test('穿越: 编码斜杠 ..%2f..%2fetc → 403/404 且不返回敏感内容', async () => {
  const { status, text } = await req('/bwm-friend/work/..%2f..%2fetc%2fhosts');
  assert.ok(status === 403 || status === 404, `应 403/404，实际 ${status}`);
  assert.ok(!text.includes('localhost'), '不得返回 /etc/hosts 内容');
});

/* ── 4. media Range（RFC 7233）── */
let TOKEN = null;
let TOTAL = null;

test('inventory: 媒体 token 为随机 UUID（32 hex，防路径泄漏）', async () => {
  const { status, text } = await req('/bwm-friend/inventory');
  assert.strictEqual(status, 200);
  const data = JSON.parse(text);
  const idle = (data.items || []).find((i) => i.type === 'idle');
  assert.ok(idle, 'inventory 应有 idle 媒体项');
  TOKEN = idle.url.split('/').pop();
  assert.match(TOKEN, /^[0-9a-f]{32}$/, `token 应为随机 UUID 32hex，实际 ${TOKEN}`);
});

test('Range: 全量 → 206 + 记录 total', async () => {
  const r = await req(`/bwm-friend/media/${TOKEN}`);
  assert.strictEqual(r.status, 206);
  const m = /^bytes \d+-\d+\/(\d+)$/.exec(r.headers.get('content-range') || '');
  assert.ok(m, 'content-range 应有 total');
  TOTAL = Number(m[1]);
  assert.ok(TOTAL > 1000, '媒体文件应有合理大小');
});

test('Range: bytes=0-99 → 206 len=100', async () => {
  const r = await req(`/bwm-friend/media/${TOKEN}`, { headers: { Range: 'bytes=0-99' } });
  assert.strictEqual(r.status, 206);
  assert.strictEqual(Number(r.headers.get('content-length')), 100);
});

test('Range: bytes=-100（suffix）→ 206 且为末尾 100 字节（曾错返前 501 字节）', async () => {
  const r = await req(`/bwm-friend/media/${TOKEN}`, { headers: { Range: 'bytes=-100' } });
  assert.strictEqual(r.status, 206);
  assert.strictEqual(Number(r.headers.get('content-length')), 100);
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(r.headers.get('content-range') || '');
  assert.ok(m, 'content-range 格式');
  assert.strictEqual(Number(m[1]), TOTAL - 100, 'suffix 应返回末尾段（曾错返开头）');
  assert.strictEqual(Number(m[2]), TOTAL - 1);
});

test('Range: bytes=100-50（start>end）→ 416（曾负 Content-Length 崩/404）', async () => {
  const r = await req(`/bwm-friend/media/${TOKEN}`, { headers: { Range: 'bytes=100-50' } });
  assert.strictEqual(r.status, 416);
  assert.match(r.headers.get('content-range') || '', /bytes \*\/\d+/);
});

test('Range: bytes=99999999-（超界）→ 416', async () => {
  const r = await req(`/bwm-friend/media/${TOKEN}`, { headers: { Range: `bytes=${TOTAL + 1000}-` } });
  assert.strictEqual(r.status, 416);
});

/* ── 5. 请求体上限（v0.3.2 发布加固）── */
test('DoS: POST /work/task 超 1MB body → 4xx 且进程存活（readJsonBody 上限）', async () => {
  const big = JSON.stringify({ message: 'x'.repeat(1_200_000) });
  const r = await req('/bwm-friend/work/task', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: big,
  });
  assert.ok(r.status >= 400 && r.status < 500, `期望 4xx，实际 ${r.status}`);
  const health = await req('/bwm-friend/health');
  assert.strictEqual(health.status, 200, '超限请求后进程必须存活');
});

test('DoS: 正常大小 body → 不受上限影响（新连接，避开超限请求后的 keep-alive 竞态）', async () => {
  const r = await req('/bwm-friend/work/task', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: JSON.stringify({ message: '' }),
  });
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /有什么任务/);
});
