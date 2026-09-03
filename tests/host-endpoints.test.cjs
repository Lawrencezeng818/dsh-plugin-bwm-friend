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
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

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

/* ══ 7. 可观测性（完成度地图批次1）══ */
const SANDBOX_HOME = process.env.BWM_E2E_HOME || '/Users/zengtian/projects/dsh-sandbox/home';
const LOG_PATH = join(SANDBOX_HOME, '.dsh-bwm-friend', 'logs', 'host.log');
const readLogLines = () => {
  try {
    return readFileSync(LOG_PATH, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
};

test('obs: health 深度化（版本/uptime/组件状态）', async () => {
  const { status, text } = await req('/bwm-friend/health');
  assert.strictEqual(status, 200);
  const j = JSON.parse(text);
  assert.strictEqual(j.version, '0.4.0', '版本号必须出现在 health');
  assert.strictEqual(typeof j.uptimeSec, 'number');
  assert.strictEqual(typeof j.components.voice.configured, 'boolean');
  assert.ok(j.components.assets.roots >= 0);
  assert.ok(['hub', 'dev'].includes(j.components.auth.mode));
});

test('obs: metrics 请求计数与延迟分位', async () => {
  await req('/bwm-friend/health');
  await req('/bwm-friend/health');
  await req('/bwm-friend/settings');
  const { status, text } = await req('/bwm-friend/metrics');
  assert.strictEqual(status, 200);
  const j = JSON.parse(text);
  const h = j.requests['GET /bwm-friend/health'];
  assert.ok(h && h.count >= 2, 'health 计数 >= 2');
  assert.strictEqual(typeof h.p50Ms, 'number');
  assert.strictEqual(typeof h.p95Ms, 'number');
  assert.ok(j.requests['GET /bwm-friend/settings'], 'settings 路由有条目');
  assert.strictEqual(typeof j.totals, 'object');
});

test('obs: 审计日志 config.write 落盘（JSON 行）', async () => {
  await req('/bwm-friend/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ui: { mode: 'work' } }) });
  await new Promise((r) => setTimeout(r, 200));
  const lines = readLogLines();
  assert.ok(lines.some((l) => l.ev === 'config.write'), '必须存在 config.write 事件');
});

test('obs: 审计日志 非法写入留痕 config.write_rejected', async () => {
  await req('/bwm-friend/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voice: '垃圾' }) });
  await new Promise((r) => setTimeout(r, 200));
  const lines = readLogLines();
  assert.ok(lines.some((l) => l.ev === 'config.write_rejected'), '400 必须留痕');
});

test('obs: 请求行含路由/状态码；auth 事件不落敏感原文', async () => {
  await req('/bwm-friend/auth/status');
  await new Promise((r) => setTimeout(r, 200));
  const lines = readLogLines();
  assert.ok(lines.some((l) => l.ev === 'req' && l.route === 'PUT /bwm-friend/settings' && l.status === 200));
  assert.ok(lines.some((l) => l.ev === 'auth.status'));
  const dump = JSON.stringify(lines);
  assert.ok(!dump.includes('13800001234'), '原始手机号不得入日志');
});


/* ══ 8. 安全对抗评审发现（完成度批次3 红灯）══ */
const httpRaw = require('node:http');

// 原始请求（可伪造 Host —— 复现 DNS rebinding 形态的唯一方式）
function rawReq(port, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const r = httpRaw.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

test('sec: companion/chat 2MB 载荷 → 4xx 且服务存活（P1-1 内存 DoS）', async () => {
  const big = JSON.stringify({ message: 'x'.repeat(2 * 1024 * 1024) });
  const r = await req('/bwm-friend/companion/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: big });
  assert.ok(r.status >= 400 && r.status < 500, '超大 body 必须 4xx，实得 ' + r.status);
  const h = await req('/bwm-friend/health');
  assert.strictEqual(h.status, 200, '服务必须存活');
});

test('sec: rebinding 防线——Host 信任判定（P1-2，子进程求值）', async () => {
  const { execFileSync } = require('node:child_process');
  const out = execFileSync(process.execPath, ['-e', `
    import('file:///Users/zengtian/projects/dsh-plugin-bwm-friend/lib/index.js').then((m) => {
      const h = m.__securityTestHooks.isTrustedHost;
      console.log(JSON.stringify([
        h('127.0.0.1:3200'), h('localhost:80'), h('[::1]:3200'),
        h('evil.test:3080'), h('box.lan:3200'),
      ]));
      process.exit(0);
    });
  `], { encoding: 'utf8', timeout: 30000 });
  const [loopIp, localName, v6, evil, lan] = JSON.parse(out.trim());
  assert.ok(loopIp, '回环 IP 可信');
  assert.ok(localName, 'localhost 可信');
  assert.ok(v6, 'IPv6 回环可信');
  assert.strictEqual(evil, false, '攻击域不可信');
  assert.strictEqual(lan, false, 'LAN 默认不可信（需 BWM_TRUSTED_HOSTS 显式扩展）');
  // 回环正常访问不受影响（同步阻塞后 keep-alive 连接可能被服务端回收 → ECONNRESET 时重试一次）
  let ok2;
  try { ok2 = await req('/bwm-friend/settings'); } catch { ok2 = await req('/bwm-friend/settings'); }
  assert.strictEqual(ok2.status, 200);
});

test('sec: auth 登录限速（P2-5）', async () => {
  let got429 = false;
  for (let i = 0; i < 8; i++) {
    const r = await req('/bwm-friend/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '13900009999', password: 'wrong' + i }) });
    if (r.status === 429) { got429 = true; break; }
  }
  assert.ok(got429, '同号连续尝试必须触发 429');
  const other = await req('/bwm-friend/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '13900008888', password: 'x' }) });
  assert.notStrictEqual(other.status, 429, '异号不受同号限速牵连');
});

test('sec: 主题目录名含 HTML 时 inventory 契约不崩 + 客户端转义静态断言（P2-4 配套）', async () => {
  const r = await req('/bwm-friend/inventory');
  assert.strictEqual(r.status, 200);
  JSON.parse(r.text); // 不抛即契约成立
  const src = readFileSync(join('/Users/zengtian/projects/dsh-plugin-bwm-friend', 'lib', 'index.js'), 'utf8');
  assert.ok(src.includes('__bwmEsc(window.__bwmThemeLabel'), '模板卡主题名必须经 __bwmEsc（防未来裸拼接回退）');
});

test('sec: 审计留痕——403 与掩码登录入账（覆盖缺口5）', async () => {
  await req('/bwm-friend/work/task', { method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'text/plain' }, body: '{"message":"x"}' });
  await new Promise((r) => setTimeout(r, 250));
  const lines = readLogLines();
  assert.ok(lines.some((l) => l.ev === 'req' && l.route === 'POST /bwm-friend/work/task' && l.status === 403), '403 必须留痕');
  const dump = JSON.stringify(lines);
  assert.ok(!dump.includes('13800001234'), '原始手机号不得入日志');
});
