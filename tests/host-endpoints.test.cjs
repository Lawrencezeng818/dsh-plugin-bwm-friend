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

/* ══ 5. 发布评审 P0 加固（2026-09-03 boss-bug-hunt 路径B）══ */

test('CSRF绕过: 顶层表单形态(dest=document+cross-site) POST /chat → 403', async () => {
  // 顶层 <form enctype=text/plain> 导航：浏览器发 dest=document + site=cross-site、无 Origin
  const { status } = await req('/bwm-friend/companion/chat', {
    method: 'POST',
    headers: { 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Content-Type': 'text/plain' },
    body: '{"message":"pwned"}',
  });
  assert.strictEqual(status, 403, 'dest=document 只应放行 GET/HEAD，写端点必须 403');
});

test('CSRF绕过: Origin:null 沙箱页 PUT /settings → 403 且配置不被改写', async () => {
  // 先用合法无头请求归零基线（红灯期绕过请求可能已污染过沙盒配置）
  await req('/bwm-friend/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voice: { voice: '冰糖' } }) });
  const r = await req('/bwm-friend/settings', {
    method: 'PUT',
    headers: { Origin: 'null', 'Content-Type': 'application/json' },
    body: JSON.stringify({ voice: { voice: 'HACKED' } }),
  });
  assert.strictEqual(r.status, 403, 'origin=null（沙箱 iframe/data: 页）不得驱动写端点');
  const cfg = JSON.parse((await req('/bwm-friend/settings')).text);
  assert.notStrictEqual(cfg.voice.voice, 'HACKED', '绕过请求不得落盘');
});

test('Origin/Host 不一致提前拒（伪装同源头，重排回归）', async () => {
  const { status } = await req('/bwm-friend/companion/chat', {
    method: 'POST',
    headers: { Origin: 'http://evil.example', 'Content-Type': 'text/plain' },
    body: 'x',
  });
  assert.strictEqual(status, 403);
});

test('auth/status 不泄露原始手机号（掩码显示，登录态仍可见）', async () => {
  await req('/bwm-friend/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '13800001234', password: 'x' }),
  });
  const { text } = await req('/bwm-friend/auth/status');
  assert.ok(!text.includes('13800001234'), '原始手机号不得回显给任意同源脚本');
  const body = JSON.parse(text);
  assert.strictEqual(body.loggedIn, true, '登录态必须保留（UI 依赖）');
});

test('auth/login 成功响应不携带 Hub token（服务端持有即可）', async () => {
  // 契约回归：dev 路径本就不带 token；生产代理路径禁止把 token 下发客户端
  const { text } = await req('/bwm-friend/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '13800001235', password: 'x' }),
  });
  const body = JSON.parse(text);
  assert.strictEqual(body.ok, true);
  assert.ok(!('token' in body), 'token 不得出现在登录响应');
});

/* ══ 6. settings 写入健壮化（2026-09-03 发布评审 P1）══ */

test('settings: version 服务端管辖，客户端覆写无效', async () => {
  await req('/bwm-friend/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 99 }) });
  const cfg = JSON.parse((await req('/bwm-friend/settings')).text);
  assert.strictEqual(cfg.version, 1, 'version 必须钉在 schema 版本');
});

test('settings: 未知顶层 key 不落盘', async () => {
  await req('/bwm-friend/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ evilKey: { x: 1 } }) });
  const cfg = JSON.parse((await req('/bwm-friend/settings')).text);
  assert.ok(!('evilKey' in cfg), '未知 key 不得写入配置');
});

test('settings: 类型非法载荷 → 400 且不落盘', async () => {
  const r = await req('/bwm-friend/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voice: '垃圾' }) });
  assert.strictEqual(r.status, 400);
  const cfg = JSON.parse((await req('/bwm-friend/settings')).text);
  assert.ok(cfg.voice && typeof cfg.voice === 'object' && !('0' in cfg.voice), '字符串载荷不得破坏 voice 结构');
});

test('settings: 并发多 key PUT 全部存活（串行化）', async () => {
  const writes = [
    { account: { subject: '并发测试A' } },
    { llm: { provider: 'local' } },
    { ui: { mode: 'work' } },
    { power: { pauseOnBlur: true } },
    { avatar: { driver: 'video' } },
    { voice: { volume: 1 } },
  ];
  await Promise.all(writes.map((w) => req('/bwm-friend/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(w) })));
  const cfg = JSON.parse((await req('/bwm-friend/settings')).text);
  assert.strictEqual(cfg.account.subject, '并发测试A');
  assert.strictEqual(cfg.llm.provider, 'local');
  assert.strictEqual(cfg.power.pauseOnBlur, true);
  assert.strictEqual(cfg.voice.volume, 1);
});
