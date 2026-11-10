// dsh-plugin-bwm-friend — host 半（P1/M1：资产描述符 + 媒体路由 + 配置持久化）
// 职责：同源 HTTP 路由（资产 inventory / 媒体流 Range / 配置读写 / bwm 服务探测）
// 纯 ESM，无需构建（lib/index.js 即源码）。
import { readFile, writeFile, mkdir, readdir, stat, rename, open as fsOpen } from 'node:fs/promises';
import { readFileSync, readdirSync, statSync, lstatSync, createReadStream, watch, existsSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

export const inject = ['webServer'];

const CONFIG_DIR = join(homedir(), '.dsh-bwm-friend');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
// 阶段二：DEFAULT_CONFIG 对齐 BWM Settings Schema v1（protocol 层，三端统一）
// ui.mode 替代旧顶层 mode；ui.type/chatWidth 替代旧 layout
const DEFAULT_CONFIG = {
  version: 1,
  account: { subject: null, loggedIn: false },
  avatar: { theme: '甜心女孩', idle: null, persona: '', personas: {}, driver: 'video' },
  voice: { voice: '冰糖', volume: 1 },
  llm: { provider: 'local', baseUrl: '', model: 'deepseek-chat' },
  ui: { mode: 'work', type: 'stage', chatWidth: 720 },
  power: { pauseOnBlur: true, pauseOnBattery: false },
};

// readConfig 迁移兼容：旧 layout 结构 → ui 结构
function migrateConfig(raw) {
  const c = { ...raw };
  if (raw && raw.layout && typeof raw.layout === 'object' && !c.ui) {
    c.ui = { ...(raw.ui || {}), ...raw.layout };
  }
  if (raw && raw.mode !== undefined && !(raw.ui && raw.ui.mode)) {
    c.ui = { ...(c.ui || {}), mode: raw.mode };
  }
  return c;
}

// bwm 待机/说话视频资产根目录（打包路径优先，开发工程兜底）
// P0 配置化（2026-08-24）：环境变量优先（逗号分隔多个）——跨机器/生产可覆盖
// 2026-09-03 发布加固：默认值去掉个人绝对路径（评审 P0——异机 inventory 恒空），
// 改为 ① 用户资产目录 ~/.bwm-friend/assets（文档化投递点）② BWM_STATIC 的同级
// heygem-data/input（bwm-electron 工程布局习惯：设了 BWM_STATIC 即自动带上素材）
// 皮肤包自动发现（2026-08-24）：node_modules/@laikaton/bwm-skin-*/assets —— 换皮肤=换资产包
const envAssetRoots = String(process.env.BWM_ASSET_ROOTS || '').split(',').map((s) => s.trim()).filter(Boolean);
const BWM_STATIC = process.env.BWM_STATIC || join(dirname(fileURLToPath(import.meta.url)), '..', 'static-ui'); // 2026-09-03：壳随包发布（static-ui/），不再指向个人工程
const LOCAL_ASSET_ROOTS = [
  join(homedir(), '.bwm-friend', 'assets'), // 文档化用户资产投递点
  join(BWM_STATIC, '..', 'heygem-data', 'input'), // bwm-electron 布局习惯的同级素材
];
function discoverSkinRoots() {
  const roots = [];
  try {
    const nmCandidates = [];
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) { nmCandidates.push(join(dir, 'node_modules')); dir = dirname(dir); }
    for (const nm of nmCandidates) {
      try {
        const scoped = readdirSync(join(nm, '@laikaton')).filter((n) => n.startsWith('bwm-skin-'));
        for (const name of scoped) {
          const assets = join(nm, '@laikaton', name, 'assets');
          if (statSync(assets).isDirectory()) roots.push(assets);
        }
      } catch { /* 无 @laikaton scope 目录 → 跳过 */ }
    }
  } catch { /* noop */ }
  return roots;
}
const ASSET_ROOTS = [...new Set([...envAssetRoots, ...(envAssetRoots.length ? [] : LOCAL_ASSET_ROOTS), ...discoverSkinRoots()])];
// 皮肤包根集合（source 标记用：皮肤包=产品默认皮肤，pick 优先）
const SKIN_ROOTS = new Set(discoverSkinRoots());

const BWM_UI_PORT = Number(process.env.BWM_UI_PORT || 7860);
// 任务工作目录（runRealAgentTask 的 cwd）——默认用户主目录，env 可覆盖
const DSH_WORK_DIR = process.env.DSH_WORK_DIR || homedir();
// media token 已改用随机 UUID（review：base64url 可逆解码泄漏本地路径）

// token → 绝对路径白名单（仅 inventory 扫描过的路径可被 /media 访问，不暴露任意文件系统）
const mediaMap = new Map();
const mediaPathToken = new Map();
let transcribeInFlight = 0; // /transcribe 并发守卫
let taskInFlight = 0; // P1-3：/work/task 并发守卫
let chatInFlight = 0; // 2026-09-26：/companion/chat 并发守卫（对齐 transcribe/task——原唯一无守卫重端点）
const TASK_MIN_MS = Number(process.env.BWM_TASK_MIN_MS || 0); // 测试接缝：放慢任务以确定性测并发

// ═══ 可观测性（2026-09-03 完成度地图 40→100）：深度 health / metrics / 结构化审计日志 ═══
const LOG_DIR = join(CONFIG_DIR, 'logs');
const LOG_PATH = join(LOG_DIR, 'host.log');
const LOG_MAX_BYTES = Number(process.env.BWM_LOG_MAX_BYTES || 5 * 1024 * 1024); // 可调以供测试
const LOG_DISABLED = process.env.BWM_LOG_DISABLE === '1';
let auditChain = Promise.resolve();
const loginAttempts = new Map(); // P2-5 登录限速：按 subject 分桶（同号共享窗口，异号互不影响）
let loginFailWindow = 0;
// 审计事件：串行追加（保序）+ 满轮转（host.log → host.log.1）；永不抛出影响业务
function audit(ev, fields = {}) {
  if (LOG_DISABLED) return;
  auditChain = auditChain.then(async () => {
    try {
      await mkdir(LOG_DIR, { recursive: true });
      try { const st = await stat(LOG_PATH); if (st.size > LOG_MAX_BYTES) await rename(LOG_PATH, `${LOG_PATH}.1`); } catch { /* 首写无文件 */ }
      await writeFile(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ev, ...fields }) + '\n', { flag: 'a' });
    } catch { /* 日志失败静默 */ }
  });
}
const OBS_ROUTE_TABLE = [
  [/^\/bwm-friend\/media\/[^/]+$/, '/bwm-friend/media/:token'],
  [/^\/bwm-friend\/settings$/, '/bwm-friend/settings'],
  [/^\/bwm-friend\/health$/, '/bwm-friend/health'],
  [/^\/bwm-friend\/metrics$/, '/bwm-friend/metrics'],
  [/^\/bwm-friend\/inventory$/, '/bwm-friend/inventory'],
  [/^\/bwm-friend\/companion\/chat$/, '/bwm-friend/companion/chat'],
  [/^\/bwm-friend\/transcribe$/, '/bwm-friend/transcribe'],
  [/^\/bwm-friend\/work\/task$/, '/bwm-friend/work/task'],
  [/^\/bwm-friend\/work\/workspaces$/, '/bwm-friend/work/workspaces'],
  [/^\/bwm-friend\/auth\//, '/bwm-friend/auth/*'],
  [/^\/bwm-friend\/update\//, '/bwm-friend/update/*'],
  [/^\/bwm-friend\/cloud\//, '/bwm-friend/cloud/*'],
];
function routeNameOf(method, pathname) {
  for (const [re, name] of OBS_ROUTE_TABLE) if (re.test(pathname)) return `${method} ${name}`;
  if (pathname.startsWith('/bwm-friend/work/') || pathname.startsWith('/bwm-friend/companion/')) return 'static';
  return 'other';
}
const obsMetrics = {
  startedAt: Date.now(),
  totals: { chats: 0, transcribes: 0, tasks: 0, taskTimeouts: 0, configWrites: 0, configRejected: 0 },
  routes: Object.create(null),
};
function recordRequest(route, status, ms) {
  const r = obsMetrics.routes[route] || (obsMetrics.routes[route] = { count: 0, errors: 0, latencies: [] });
  r.count += 1;
  if (status >= 400) r.errors += 1;
  r.latencies.push(ms);
  if (r.latencies.length > 200) r.latencies.shift();
}
const obsPercentile = (arr, p) => {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}; // 2026-09-03 发布加固：路径→token 稳定映射（inventory 重建不再换发新 token）

async function readConfig() {
  try {
    const parsed = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
    const migrated = migrateConfig(parsed);
    return { ...DEFAULT_CONFIG, ...migrated };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function writeConfig(cfg) {
  await mkdir(CONFIG_DIR, { recursive: true });
  // 2026-09-03 发布加固：原子写（同 saveMemory：临时文件 + rename）——崩溃不再整份配置回默认
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(cfg, null, 2));
  await rename(tmp, CONFIG_PATH);
}

// 2026-09-03 发布加固：config 读改写互斥队列（此前并发 PUT 各自 read-merge-write，
// 后写覆盖先写丢更新——评审并发用例 6 写丢 4）。memory 已有同类队列，config 对齐。
let configWriteQueue = Promise.resolve();
function withConfigLock(fn) {
  const run = configWriteQueue.then(fn, fn);
  configWriteQueue = run.catch(() => {});
  return run;
}

// settings 校验（protocol 层；随包副本优先，加载失败则跳过校验——不阻断保存）
let settingsValidator = null;
try { settingsValidator = (await import('../packages/bwm-protocol/schema/index.js')).validateSettings; }
catch {
  try { settingsValidator = (await import('@laikaton/bwm-protocol')).validateSettings; }
  catch {
    // 2026-09-26：降级显式化（原完全静默——fail-open 无任何痕迹，违背「显式失灵不静默」纪律）
    console.error('[bwm-friend] settings validator unavailable — PUT 校验降级为放行');
  }
}

// 探测 bwm friend UI 服务（7860）是否在线
function probeBwm() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: BWM_UI_PORT, path: '/', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// 资产描述符（四轮评审：asset:// 结构化契约，扩展 idle/talk/gesture/emotion/reaction）
// checksum/resolution 为 P1 占位（接入 ffprobe 后升级）
// ═══ 资产管线增强（完成度批次5 90→100）：流式 sha256 + tkhd 分辨率（无 ffprobe 依赖）═══
const assetHashCache = new Map(); // abs → { mtimeMs, size, hash }（未变更文件复用，重建不重算）
function fileChecksum(abs, st) {
  const cached = assetHashCache.get(abs);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return Promise.resolve(cached.hash);
  return new Promise((resolve) => {
    try {
      const h = createHash('sha256');
      const stream = createReadStream(abs);
      stream.on('data', (c) => h.update(c));
      stream.on('error', () => resolve(null));
      stream.on('end', () => {
        const hash = h.digest('hex');
        assetHashCache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, hash });
        resolve(hash);
      });
    } catch { resolve(null); }
  });
}
// mp4 tkhd box best-effort 解析：width/height 为 16.16 定点（v0 +80/+84，v1 +88/+92）；头尾各扫 4MB
async function mp4Resolution(abs, size) {
  const WINDOW = 4 * 1024 * 1024;
  const findTkhd = (buf) => {
    const idx = buf.indexOf(Buffer.from('tkhd'));
    if (idx < 0 || idx + 5 > buf.length) return null;
    const version = buf[idx + 4];
    const wOff = idx + (version & 1 ? 88 : 80);
    if (wOff + 8 > buf.length) return null;
    const width = buf.readUInt32BE(wOff) / 65536;
    const height = buf.readUInt32BE(wOff + 4) / 65536;
    if (width > 0 && height > 0) return { width: Math.round(width), height: Math.round(height) };
    return null;
  };
  try {
    const headLen = Math.min(WINDOW, size);
    const head = Buffer.alloc(headLen);
    const fh = await fsOpen(abs, 'r');
    try { await fh.read(head, 0, headLen, 0); } finally { await fh.close().catch(() => {}); } // 2026-09-26：读失败也关 fd（此前泄漏）
    let r = findTkhd(head);
    if (r) return r;
    if (size > WINDOW) {
      const tail = Buffer.alloc(WINDOW);
      const fh2 = await fsOpen(abs, 'r');
      try { await fh2.read(tail, 0, WINDOW, size - WINDOW); } finally { await fh2.close().catch(() => {}); }
      r = findTkhd(tail);
    }
    return r;
  } catch { return null; }
}

async function buildInventory() {
  const items = [];
  const seen = new Set();
  const liveTokens = new Set();
  for (const root of ASSET_ROOTS) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue; // 目录不存在 → 跳过
    }
    for (const entry of entries) {
      const files = entry.isDirectory()
        ? await readdir(join(root, entry.name)).catch(() => [])
        : [entry.name];
      for (const f of files) {
        if (!/\.mp4$/i.test(f)) continue;
        const abs = entry.isDirectory() ? join(root, entry.name, f) : join(root, f);
        try { if (lstatSync(abs).isSymbolicLink()) continue; } catch { continue; } // P2-4：symlink 条目不入清单（防任意文件经 token 外发）
        if (seen.has(abs)) continue;
        seen.add(abs);
        const type = /^idle-/.test(f) ? 'idle' : /^heygem-/.test(f) ? 'talk' : 'other';
        const theme = entry.isDirectory() ? entry.name : '(root)';
        const base = f.replace(/\.mp4$/i, '');
        // 🔴 review 修复：token 用随机 UUID（原来 base64url 可逆解码泄漏本地绝对路径）
        // 2026-09-03 发布加固：路径→token 稳定复用 + 失效回收（此前每次重建换新 token，
        // 旧 token 永久有效且 mediaMap 无界增长——评审 P1）
        let token = mediaPathToken.get(abs);
        if (!token) {
          token = randomUUID().replace(/-/g, '');
          mediaPathToken.set(abs, token);
        }
        mediaMap.set(token, abs);
        liveTokens.add(token);
        const st = await stat(abs).catch(() => null);
        const [checksum, resolution] = st
          ? await Promise.all([fileChecksum(abs, st), mp4Resolution(abs, st.size)])
          : [null, null];
        items.push({
          id: `${type}-${base.replace(/[^a-zA-Z0-9_-]/g, '-')}`,
          type,
          theme,
          name: f,
          source: SKIN_ROOTS.has(root) ? 'skin' : 'local', // 皮肤包=产品默认；本地=开发/自定义
          url: `/bwm-friend/media/${token}`,
          resolution: resolution ? `${resolution.width}x${resolution.height}` : null, // 批次5：tkhd best-effort
          checksum: checksum || (st ? `${st.size}_${st.mtimeMs}` : null), // 批次5：sha256（mtime/size 缓存）；异常回退尺寸指纹
        });
      }
    }
  }
  // 失效 token 回收：扫描后不在存活集的条目双向清除
  for (const [tok, p] of mediaMap) {
    if (!liveTokens.has(tok)) {
      mediaMap.delete(tok);
      mediaPathToken.delete(p);
    }
  }
  return items;
}

// Runtime v1.1：inventory 生命周期缓存（启动扫描一次 + fs.watch 失效）——替代每次 GET 全量扫描（S6）
let inventoryCache = null;
let inventoryDirty = true;
let lastInventoryBuildAt = 0;
const inventoryWatchers = [];
async function buildInventoryCached() {
  ensureAssetWatchers();
  // 热投递兜底（README 用户流程：启动后才创建 ~/.bwm-friend/assets 并投递素材）：
  // 根目录启动时不存在 → watch 挂不上 → 用户后建目录不会触发任何事件，纯事件驱动会永久陈旧。
  // 存在挂不上 watcher 的根时，缓存只信 2 秒，超时即重扫；重扫成功后 watcher 补挂，回到纯事件驱动。
  const allWatched = watchedRoots.size >= ASSET_ROOTS.length;
  if (inventoryCache && !inventoryDirty && (allWatched || Date.now() - lastInventoryBuildAt < 2000)) return inventoryCache;
  inventoryCache = await buildInventory();
  inventoryDirty = false;
  lastInventoryBuildAt = Date.now();
  return inventoryCache;
}
function invalidateInventory() {
  inventoryDirty = true; // 下次请求重建（避免 watch 高频触发重建风暴）
}
// 启动扫描一次（preload）调用点移至 watchedRoots 声明之后（2026-09-26 TDZ 修复：
// 原在此处调用会因下方 `const watchedRoots` 尚未初始化抛 ReferenceError，被 .catch(()=>{})
// 静默吞掉——「启动扫描一次」实际从未生效，首次请求才补扫描）
// fs.watch 资产根目录（变化 → 标记 dirty；目录不存在/不可 watch → 忽略）

// ═══ P2-云端同步（阶段三：登录后从广州 Hub 拉模板/记忆）═══
// 契约: /api/v1/custom-templates + /memory/permanent + /memory/persona（Bearer token）
async function cloudGet(path) {
  const token = authSession._token;
  if (!token) return { ok: false, error: 'not-logged-in' };
  try {
    const res = await fetch(`${AUTH_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data, error: res.ok ? null : `http-${res.status}` };
  } catch {
    return { ok: false, error: 'network' };
  }
}

export async function cloudTemplates() {
  const r = await cloudGet('/api/v1/custom-templates');
  if (!r.ok) return r;
  const templates = (r.data && Array.isArray(r.data.templates)) ? r.data.templates : [];
  return { ok: true, templates, count: templates.length };
}

export async function cloudMemory() {
  const perm = await cloudGet('/api/v1/memory/permanent');
  const persona = await cloudGet('/api/v1/memory/persona');
  if (perm.error === 'not-logged-in' || persona.error === 'not-logged-in') return { ok: false, error: 'not-logged-in' };
  const extract = (r) => (r && r.ok && r.data && r.data.data && r.data.data.memory) || null;
  return { ok: true, permanent: extract(perm), persona: extract(persona) };
}

// ═══ P1-更新检查（设置页）═══
// BWM_UPDATE_URL：版本信息地址（默认广州 /var/www/update/bwm-version.json）；未配置 = dev 无更新
const UPDATE_URL = String(process.env.BWM_UPDATE_URL || '').trim();
const PLUGIN_VERSION = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version; // 单一来源 package.json（v0.4.0 定版漂移成 0.3.2 的事故闭环）

export function compareVersion(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

export async function updateCheckLocal(current, latest) {
  if (!latest) return { current: current || PLUGIN_VERSION, latest: null, hasUpdate: false };
  return {
    current: current || PLUGIN_VERSION,
    latest,
    hasUpdate: compareVersion(current || PLUGIN_VERSION, latest) < 0,
  };
}

async function runUpdateCheck() {
  const current = PLUGIN_VERSION;
  if (!UPDATE_URL) return { current, latest: null, hasUpdate: false, dev: true };
  try {
    const res = await fetch(UPDATE_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { current, latest: null, hasUpdate: false, error: `http-${res.status}` };
    const data = await res.json().catch(() => null);
    const latest = data && (data.version || data.latestVersion);
    return await updateCheckLocal(current, latest);
  } catch {
    return { current, latest: null, hasUpdate: false, error: 'network' };
  }
}

// ═══ P0-账号登录（设置页）═══
// BWM_AUTH_BASE：生产认证后端（广州 /auth/login/sms）；未配置 = dev 模式（本地验证）
// 凭据不落盘（token 内存会话）；生产代理转发带三头（X-Timestamp/X-Nonce/X-Device-Id）
const AUTH_BASE = String(process.env.BWM_AUTH_BASE || '').trim();

// 安全测试钩子（对抗评审覆盖缺口：rebinding 形态无法经真实 DSH 驱动——宿主层已滤非可信 Host）
export const __securityTestHooks = { isTrustedHost };
export const authSession = {
  _subject: null,
  _token: null,
  login(subject, token) { this._subject = subject; this._token = token; },
  logout() { this._subject = null; this._token = null; },
  isLoggedIn() { return Boolean(this._subject); },
  subject() { return this._subject; },
};

// 2026-09-03 发布加固：手机号掩码（/auth/status 与登录回显统一走这里——
// 任意同源脚本可读 /auth/status，原始手机号不得外泄；UI 只需展示态）
function maskSubject(s) {
  const t = String(s || '');
  // P2-6（对抗评审）：最小化——不再暴露前 3 位（号段公开，剩余熵不足为凭）
  return t ? '***' + (t.length >= 7 ? t.slice(-2) : '') : t;
}

export async function authLoginLocal({ phone, password } = {}) {
  const p = String(phone || '').trim();
  const pw = String(password || '');
  if (!p || !pw) return { ok: false, error: 'empty-credentials' };
  if (!AUTH_BASE) {
    // dev 模式：本地验证（沙盒/开发环境；生产由 BWM_AUTH_BASE 代理）
    authSession.login(p, 'dev-token');
    return { ok: true, dev: true, subject: p };
  }
  // 生产代理：转发 /api/v1/auth/login（三头防重放；username=手机号；兼容 access_token/token）
  try {
    const ts = String(Math.floor(Date.now() / 1000)); // 生产校验秒级 Unix 时间戳（毫秒会超窗）
    const nonce = randomUUID().replace(/-/g, '');
    const deviceId = `plugin-${randomUUID().slice(0, 8)}`;
    const res = await fetch(`${AUTH_BASE}/api/v1/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Timestamp': ts,
        'X-Nonce': nonce,
        'X-Device-Id': deviceId,
      },
      body: JSON.stringify({ username: p, password: pw, tenant_id: 'tnt_default', device_id: deviceId }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    const body = data && data.data ? data.data : data;
    const token = (body && (body.token || body.access_token)) || null;
    if (res.ok && token) {
      const subject = (body && (body.username || String(body.user_id || ''))) || p;
      authSession.login(subject, token);
      // 2026-09-03 发布加固：token 服务端持有即可（cloudGet 服务端消费），不下发客户端
      return { ok: true, subject: maskSubject(subject) };
    }
    // P2-5：不透传远端 message（控制文本信息面），统一状态码形态
    return { ok: false, error: `http-${res.status}` };
  } catch (e) {
    return { ok: false, error: e && e.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}
// 批次5：懒挂 watcher——启动时尚不存在的根（用户"先启动后放素材"）在每次重建时补挂
const watchedRoots = new Set();
function ensureAssetWatchers() {
  for (const root of ASSET_ROOTS) {
    if (watchedRoots.has(root)) continue;
    try {
      // recursive：主题子目录内后投递的文件也触发失效（macOS/Windows 原生支持；不支持的平台回退非递归=旧行为）
      try {
        inventoryWatchers.push(watch(root, { persistent: false, recursive: true }, () => invalidateInventory()));
      } catch {
        inventoryWatchers.push(watch(root, { persistent: false }, () => invalidateInventory()));
      }
      watchedRoots.add(root);
    } catch { /* 根尚不存在：热投递 TTL 兜底 + 下次重建重试 */ }
  }
}
ensureAssetWatchers();
// 启动扫描一次（preload——server 启动即构建，首次请求零等待）；失败落审计不再静默
buildInventoryCached().catch((e) => { try { audit('inventory.preload_failed', { error: String(e && e.message || e) }); } catch { /* noop */ } });

// P2-Persona：人格单一来源 = packages/bwm-protocol/schema/persona.js（随包发布，权威源）
// 2026-09-03 发布加固：随包副本优先（行为确定性——registry 版可能漂移），包名解析兜底。
let IDENTITY_PRESET = null;
let PERSONALITY_PRESET = null;
try {
  const persona = await import('../packages/bwm-protocol/schema/persona.js'); // 随包副本（files 白名单内）
  ({ IDENTITY_PRESET, PERSONALITY_PRESET } = persona);
} catch {
  const persona = await import('@laikaton/bwm-protocol/persona'); // 兜底：外部协议包
  ({ IDENTITY_PRESET, PERSONALITY_PRESET } = persona);
}

// Mira 陪伴人设（P2：从 IDENTITY_PRESET 生成，不再散落字符串——单一来源）
// 生成规则：identity（我是谁）+ personality（人格特征）+ memory 注入（由 companionChat 附加）
// P0：personaOverride（config.avatar.persona）追加到系统提示——设置页可编辑人格
export function buildPersonaSystem(personaOverride) {
  const id = IDENTITY_PRESET;
  const p = PERSONALITY_PRESET;
  const base = `你是 ${id.name}（${id.tagline}）——${id.role}。${id.style.tone}、${id.style.length}。用${id.style.language}回复，${id.style.emoji}使用 emoji。${id.relationship.formality}，${id.relationship.boundaries}。性格：${p.traits.join('、')}，${p.communication}。${p.memoryStyle}。`;
  if (personaOverride && String(personaOverride).trim()) {
    return `${base}\n【用户自定义人格设定】${String(personaOverride).trim()}`;
  }
  return base;
}

// P2-Memory：Mira 记忆文件（~/.dsh-bwm-friend/memory.json；host 侧落盘，未来归 Context Governance）
// 抽取逻辑单一来源 = @laikaton/bwm-protocol/memory（host 与 SDK 共享）
// 2026-09-03 发布加固：随包副本优先（同上——行为确定性）
let protocolMemoryMod = null;
try { protocolMemoryMod = await import('../packages/bwm-protocol/schema/memory.js'); }
catch { protocolMemoryMod = await import('@laikaton/bwm-protocol/memory'); }
const { mergeMemory, MEMORY_DEFAULTS } = protocolMemoryMod;
const MEMORY_PATH = join(CONFIG_DIR, 'memory.json');
async function loadMemory() {
  try { return { ...MEMORY_DEFAULTS, ...JSON.parse(await readFile(MEMORY_PATH, 'utf8')) }; } catch { return { ...MEMORY_DEFAULTS }; }
}
async function saveMemory(mem) {
  try {
    mem.updatedAt = new Date().toISOString();
    // 🔴 review 修复：原子写（临时文件 + rename）——避免并发读改写丢更新/读到半写状态
    const tmp = `${MEMORY_PATH}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(mem, null, 2));
    await rename(tmp, MEMORY_PATH);
  } catch { /* 记忆落盘失败不阻断聊天 */ }
}
// Runtime v1.1：memory 写串行化（promise 队列）——并发读改写防丢更新（S5）
let memoryQueue = Promise.resolve();
async function rememberUserMessage(message) {
  memoryQueue = memoryQueue
    .then(async () => {
      const mem = await loadMemory();
      const next = mergeMemory(mem, message);
      await saveMemory(next);
    })
    .catch(() => { /* 防毒护栏（对齐 withConfigLock）：单条记忆失败不得让队列永久 rejection——否则此后每条聊天 500 */ });
  return memoryQueue;
}
async function memoryPrompt() {
  const mem = await loadMemory();
  const facts = Array.isArray(mem.userFacts) ? mem.userFacts : [];
  const topics = Array.isArray(mem.recentTopics) ? mem.recentTopics : [];
  if (facts.length === 0 && topics.length === 0) return '';
  const f = facts.length > 0 ? `关于用户记得：${facts.join('；')}。` : '';
  // 2026-09-26 同步：recentTopics 已改 push+slice(-N)（最新在尾部）——取最近 3 条并倒序展示
  // （对齐 packages/bwm-protocol/schema/memory.js:72；原 slice(0,3) 在新顺序下取到最旧 3 条）
  const r = topics.length > 0 ? `最近聊过：${topics.slice(-3).reverse().join(' | ')}。` : '';
  return `${f}${r}`;
}

// 读 DeepSeek key（真实 ~/.dsh/.credentials.yaml）
function readDeepseekKey() {
  try {
    const raw = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8');
    const m = /DEEPSEEK_API_KEY:\s*['"]?([^'"\s]+)/.exec(raw);
    return m ? m[1] : null;
  } catch { return null; }
}

// DSML（工具调用 XML）→ 可读"🔧 调用工具：X（命令）"；其余标签剔除
function stripDSML(t) {
  return String(t || '')
    // 整段 tool_calls 块（含未闭合）→ 提取 invoke 名
    .replace(/<tool_calls>[\s\S]*?<invoke name="([^"]+)"[\s\S]*?(?:<\/invoke>|<\/tool_calls>|$)/g, (m, name) => '\n🔧 调用工具:' + name + '\n')
    .replace(/<invoke name="([^"]+)"[\s\S]*?<\/invoke>/g, (m, name) => '\n🔧 调用工具:' + name + '\n')
    .replace(/<tool_calls>|<\/tool_calls>|<parameter[^>]*>|<\/parameter>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// 真实 DSH agent 任务执行（host 端，跑真 harness agent）
// 参考 dsh-headless：agents.create → followup(user) → whenIdle → session.events 收集过程
async function runRealAgentTask(ctx, task) {
  let taskAgentRef = null; // P1-3：超时时尽力中止（API 未确认暴露，防御式调用）
  try {
    const agents = ctx.get('agents');
    const defaultModel = ctx.get('agentDefaultModel');
    const sessions = ctx.get('sessions');
    if (!agents || !defaultModel || !sessions) return { error: 'agent services unavailable 1' };
    let dshSession, dshLlm, dshAgent;
    if (process.env.BWM_AGENT_MOCK === '1') {
      // 测试接缝（完成度批次4）：跳过真实 dsh 模块导入——挂起/超时路径需要到达 whenIdleCapped
      dshSession = { SessionId: (x) => x };
      dshLlm = { createUserMessage: (o) => o };
      dshAgent = { installModelSelection() {} };
    } else {
      dshSession = await import('@deepseek-ai/dsh-session');
      dshLlm = await import('@deepseek-ai/dsh-llm');
      dshAgent = await import('@deepseek-ai/dsh-agent');
    }
    const selection = defaultModel.currentSelection();
    const { agent } = await agents.create({
      sessionId: dshSession.SessionId('session-' + randomUUID()),
      meta: { cwd: DSH_WORK_DIR },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => { dshAgent.installModelSelection(agentCtx, { current: selection, assembled: undefined }); },
    });
    // 2026-09-03 发布加固：whenIdle 超时上限（此前任务可无限挂起占用连接——评审 P1）
    const taskTimeoutMs = Number(process.env.BWM_TASK_TIMEOUT_MS || 10 * 60_000);
    const whenIdleCapped = () => Promise.race([
      agent.whenIdle(),
      new Promise((_, reject) => {
        const t = setTimeout(() => reject(new Error('task-timeout')), taskTimeoutMs);
        if (typeof t.unref === 'function') t.unref();
      }),
    ]);
    taskAgentRef = agent;
    await whenIdleCapped();
    const firstSeq = agent.session.seq;
    agent.followup(dshLlm.createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } }));
    await whenIdleCapped();
    await sessions.flush(agent.session);
    // 收集 turn/step/tool 过程 → 任务过程 JSON（改名 procSteps：原与全局 process 同名成 TDZ 地雷）
    const procSteps = [];
    let text = '', started = false;
    for (const ev of agent.session.events) {
      if (typeof ev.seq === 'number' && ev.seq < firstSeq) continue;
      if (ev.type === 'turn/start') { started = true; procSteps.push({ type: 'turn/start' }); continue; }
      if (!started) continue;
      if (ev.type === 'assistant/message') {
        const joined = ((ev.data.message.content || []).filter(b => b.type === 'text').map(b => b.text).join(''));
        if (joined) { text = stripDSML(joined); procSteps.push({ type: 'assistant', text: stripDSML(joined) }); }
      } else if (ev.type === 'tool/call') {
        procSteps.push({ type: 'tool/call', tool: ev.data.toolName || ev.data.tool, args: ev.data.args });
      } else if (ev.type === 'tool/result') {
        procSteps.push({ type: 'tool/result', tool: ev.data.toolName || ev.data.tool, ok: ev.data.ok });
      } else if (ev.type === 'step/start' || ev.type === 'step/end') {
        procSteps.push({ type: ev.type });
      } else if (ev.type === 'turn/end') {
        procSteps.push({ type: 'turn/end', reason: ev.data.reason });
      }
    }
    // 2026-09-26：成功路径同样 dispose（原仅 catch 分支回收——任务完成后 agent 挂在内存）
    const result = { text, process: procSteps.slice(0, 200), sessionId: String(agent.session.id || '') };
    try { if (taskAgentRef && typeof taskAgentRef.dispose === 'function') taskAgentRef.dispose(); } catch { /* noop */ }
    return result;
  } catch (e) {
    // P1-3：超时/异常时尽力中止 agent（不再"已失败却仍在跑"）；API 未暴露时静默跳过
    try { if (taskAgentRef && typeof taskAgentRef.dispose === 'function') taskAgentRef.dispose(); } catch { /* noop */ }
    return { error: 'real agent failed: ' + (e instanceof Error ? e.message : String(e)) };
  }
}

// 工作区枚举：列出真实 DSH 会话作为「工作区」条目
async function listWorkspaces(ctx) {
  try {
    const sessions = ctx.get('sessions');
    if (!sessions || typeof sessions.list !== 'function') return { items: [], note: 'sessions unavailable' };
    const items = sessions.list().map((s) => {
      let title = '';
      for (const ev of (s.events || [])) {
        if (ev.type === 'user/message') {
          const d = ev.data || {};
          const msg = d.message || d;
          const blocks = Array.isArray(msg?.content) ? msg.content : (Array.isArray(msg) ? msg : []);
          let joined = '';
          for (const b of blocks) {
            if (typeof b === 'string') joined += b;
            else if (b && b.type === 'text' && b.text !== undefined) joined += b.text;
          }
          joined = joined.trim();
          if (joined) { title = joined.slice(0, 40); break; }
        }
      }
      const cwd = s.header?.meta?.cwd || '';
      return { id: String(s.id), title: title || cwd || '未命名任务', cwd };
    });
    return { items };
  } catch (e) {
    return { items: [], error: String(e instanceof Error ? e.message : e) };
  }
}

// 干活人设（DeepSeek 工作助手）
const WORK_PERSONA = '你是 DeepSeek 工作助手，帮用户高效完成任务：分析、编码、写作、资料研究等。回复专业、结构化、可直接执行。用中文，先给结论再给步骤。';

// 陪伴聊天：POST {message, history} → DeepSeek(Mira) → {reply}
// P2-Proactive：message 为空 + proactive={reason} → Mira 主动开场白（数字人主动行为）
// recentRequests：requestId 幂等去重表（60s 窗口，防多端/快速连点重复提交）
const recentRequests = new Map();

// 主动行为开场白上下文（Mira 主动关心用户的不同理由）
const PROACTIVE_CONTEXT = {
  greeting: '现在是空闲时段，主动用自然、温暖的一句话向用户问好，可以结合记得的用户偏好，不超过 2 句。',
  checkin: '用户可能有点累或忙，主动关心一下（结合记得的记忆），简短自然，不超过 2 句。',
  memory: '想起一件与用户有关的事情（结合记忆），主动提起来聊聊，不超过 2 句。',
};

async function companionChat(parsed) {
  // P1-1（对抗评审）：载荷解析移至路由层 readJsonBody（1MB 上限）——原手工累加无界可 OOM 打崩宿主
  let message = String(parsed.message || '').trim();
  const history = Array.isArray(parsed.history) ? parsed.history.slice(-10) : [];
  // P3 修复（2026-09-26）：Object.hasOwn 白名单——原 PROACTIVE_CONTEXT[reason] 走原型链，
  // reason='constructor'/'__proto__' 命中继承属性（truthy）→ prompt 序列化丢失 → 上游 400
  const reason = parsed.proactive && typeof parsed.proactive.reason === 'string' ? parsed.proactive.reason : '';
  const isProactive = !message && Object.hasOwn(PROACTIVE_CONTEXT, reason);
  if (!message && !isProactive) return { reply: '嗯？我在这儿呢，想聊什么？' };
  // Runtime v1.1：requestId 幂等（多端/快速连点去重——60s 窗口）
  const requestId = String(parsed.requestId || '');
  if (requestId) {
    const now = Date.now();
    for (const [k, t] of recentRequests) if (now - t > 60_000) recentRequests.delete(k);
    if (recentRequests.has(requestId)) return { reply: null, duplicate: true };
    recentRequests.set(requestId, now);
  }
  const key = readDeepseekKey();
  if (!key) return { reply: '（未配置 DEEPSEEK_API_KEY，暂时只能陪你发呆）' };
  // 2026-09-26 发布硬化：入口截断——事实抽取正则回溯成本与长度成正比（ReDoS 防线的第二层，
  // 第一层是 memory.js 有界正则），超长消息对记忆/人格注入也无价值
  message = message.slice(0, 2000);
  // P2-Memory：记住用户说的（偏好/自称/关键陈述）——不阻断聊天（主动行为不记忆——无用户输入）
  if (!isProactive) await rememberUserMessage(message);
  // P2-Persona + Memory：system prompt = 人格（单一来源）+ 记忆注入
  // P0：config.avatar.persona（设置页可编辑）作为人格覆盖注入
  // 2026-09-03 P2：人格按主题（与 wirePersona/__bwmReloadPersona 同一条规则）：
  // personas[当前主题] 优先，缺失回退 legacy avatar.persona（升级零迁移）
  const cfgNow = await readConfig();
  const av = (cfgNow && cfgNow.avatar) || {};
  const personasMap = av.personas && typeof av.personas === 'object' ? av.personas : {};
  const theme = av.theme || '';
  const legacyPersona = typeof av.persona === 'string' ? av.persona : '';
  const personaOverride = typeof personasMap[theme] === 'string' && personasMap[theme] ? personasMap[theme] : legacyPersona;
  const persona = buildPersonaSystem(personaOverride || undefined);
  const memory = await memoryPrompt();
  // 阶段三：云端记忆注入（登录后拉 Hub memory/permanent + persona——三端数据源统一）
  const cloudPart = [];
  if (authSession.isLoggedIn()) {
    const cm = await cloudMemory().catch(() => null);
    if (cm && cm.ok && (cm.persona || cm.permanent)) {
      if (cm.persona) cloudPart.push(`【云端人格】${cm.persona}`);
      if (cm.permanent) cloudPart.push(`【云端记忆】${cm.permanent}`);
    }
  }
  const parts = [persona, ...cloudPart, memory].filter(Boolean);
  const system = parts.join('\n');
  const prompt = isProactive ? PROACTIVE_CONTEXT[reason] : message;
  try {
    const res = await fetch(`${process.env.BWM_CHAT_BASE_URL || 'https://api.deepseek.com'}/chat/completions`, { // env 接缝：测试用 Mock DeepSeek 注入
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: prompt }],
        max_tokens: 200,
      }),
      // 2026-09-26 发布硬化：全文件最后一处无超时 fetch——客户端中止不传播时 undici 默认
      // ~300s 才释放，chat 曾无并发守卫，可堆积数百在途连接（对齐其余 5 处 fetch）
      signal: AbortSignal.timeout(60_000),
    });
    const data = await res.json();
    const reply = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content : '(Mira 走神了，再说一遍？)';
    return { reply };
  } catch (e) {
    return { reply: '（连接不上，等一下再找我）' };
  }
}

/* ── P2-Voice：MiMo ASR / TTS 代理（host 端，key 从环境变量读，不进 git）──
 * 调用形态与 bwm-electron mimo_asr_client.py / mimo_tts_client.py 一致（2026-08-05 实测打通）：
 *   ASR: POST https://api.xiaomimimo.com/v1/chat/completions, model=mimo-v2.5-asr,
 *        messages[user].content=[{type:'input_audio', input_audio:{data: base64, format}}]
 *        → choices[0].message.content = 识别文本
 *   TTS: POST .../chat/completions, model=mimo-v2.5-tts,
 *        messages=[{role:'assistant', content: text}], audio:{voice, format:'mp3'}
 *        → choices[0].message.audio.data = base64 MP3
 */
const MIMO_API_URL = process.env.BWM_MIMO_BASE_URL || 'https://api.xiaomimimo.com/v1/chat/completions'; // env 接缝：测试用 Mock MiMo 注入（完成度批次2）
const MIMO_ASR_MODEL = 'mimo-v2.5-asr';
const MIMO_TTS_MODEL = 'mimo-v2.5-tts';
const MIMO_VOICES = ['茉莉', '冰糖', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'];

function mimoKey() {
  return process.env.XIAOMI_MIMO_API_KEY || '';
}

async function mimoTranscribe(audioBase64, { format = 'mp3' } = {}) {
  const key = mimoKey();
  if (!key || !audioBase64) return { ok: false, error: 'missing-key-or-audio' };
  const payload = {
    model: MIMO_ASR_MODEL,
    messages: [
      { role: 'user', content: [{ type: 'input_audio', input_audio: { data: audioBase64, format } }] },
    ],
  };
  try {
    const resp = await fetch(MIMO_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) return { ok: false, error: `http-${resp.status}` };
    const data = await resp.json();
    const text = ((data.choices || [{}])[0] || {}).message?.content || '';
    if (!text) return { ok: false, error: 'empty-transcript' };
    return { ok: true, text: String(text).trim() };
  } catch (e) {
    return { ok: false, error: `transcribe-failed:${e.name || 'unknown'}` };
  }
}

async function mimoTTS(text, { voice = '冰糖' } = {}) {
  const key = mimoKey();
  if (!key || !text || !text.trim()) return { ok: false, error: 'missing-key-or-text' };
  const safeVoice = MIMO_VOICES.includes(voice) ? voice : '冰糖';
  const payload = {
    model: MIMO_TTS_MODEL,
    messages: [{ role: 'assistant', content: String(text).slice(0, 2000) }],
    audio: { voice: safeVoice, format: 'mp3' },
    stream: false,
  };
  try {
    const resp = await fetch(MIMO_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) return { ok: false, error: `http-${resp.status}` };
    const data = await resp.json();
    const audio = ((data.choices || [{}])[0] || {}).message?.audio || {};
    if (!audio.data) return { ok: false, error: 'empty-audio' };
    return { ok: true, audioBase64: audio.data };
  } catch (e) {
    return { ok: false, error: `tts-failed:${e.name || 'unknown'}` };
  }
}

async function readJsonBody(req, maxBytes = 1_000_000, { strictJson = false } = {}) {
  // 发布加固：请求体上限（默认 1MB）——防失控客户端把进程内存打爆；
  // 超限抛错走 webServer 框架 catch 兜底（与 settings PUT invalid json 同路径）。
  // 2026-09-26 发布硬化：Buffer 收集后一次性 toString——原逐 chunk 字符串拼接在
  // chunk 边界切断 UTF-8 多字节字符（汉字静默变 U+FFFD 入库），且 body.length 按
  // UTF-16 计数使 CJK 实际字节上限放大 ~3 倍；统一按字节限额。
  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(buf);
    received += buf.length;
    if (received > maxBytes) {
      // 必须先排空请求流：提前返回而不消费完 body 会破坏 keep-alive 连接状态，
      // 该连接上的下一个请求直接 ECONNRESET（实测回归）。
      req.removeAllListeners('data');
      req.removeAllListeners('end');
      req.resume();
      const err = new Error('payload too large');
      err.statusCode = 413;
      throw err;
    }
  }
  const body = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(body || '{}'); }
  catch {
    if (strictJson) { const err = new Error('invalid json'); err.statusCode = 400; throw err; }
    return {};
  }
}

// 陪伴模式：伺服 bwm friend 聊天页（index.html + styles.css + 品牌图 + init shim）
// 外观完全复刻原版；视频由 shim 指向本插件 idle 资产；不加载 app.js（避免无后端时大量 /api 失败报错）
const COMPANION_SHIM = [
  '(async function(){',
  '  try {',
  '    const inv = await (await fetch("/bwm-friend/inventory")).json();',
  '    const idle = (inv.items||[]).filter(i=>i.type==="idle");',
  '    // 按 config theme 选待机视频（优先皮肤包 source=skin，其次任意匹配）；无匹配取第一个',
  '    let theme = "";',
  '    try { const cfg = await (await fetch("/bwm-friend/settings")).json(); theme = (cfg && cfg.avatar && cfg.avatar.theme) || ""; } catch (e) {}',
  '    const pick = idle.find(i=>i.theme===theme && i.source==="skin") || idle.find(i=>i.theme===theme) || idle[0] || (inv.items||[])[0];',
  '    if (pick) {',
  '      const v = document.getElementById("avatarVideo");',
  '      if (v) {',
  '        // bwm CSS: avatar-video 默认 opacity:0，须加 ready 类才可见（原 app.js 的职责，这里补上）',
  '        const show = () => v.classList.add("ready");',
  '        v.addEventListener("loadeddata", show);',
  '        v.addEventListener("canplay", show);',
  '        v.src = pick.url;',
  '        const tryPlay = () => { if (v.paused) v.play().catch(()=>{}); };',
  '        tryPlay();',
  '        document.addEventListener("pointerdown", tryPlay, { once: true }); // 自动播放被拦时首点恢复',
  '        setTimeout(show, 3000); // 兜底：事件未触发也显示',
  '      }',
  '      const ph = document.getElementById("avatarPlaceholder");',
  '      if (ph) ph.style.display = "none";',
  '    }',
  '  } catch(e) { console.error("companion init:", e); }',
  '  // 设置面板：居中模态由 CSS 控制（opacity + translate(-50%,-50%)），无需内联 transform',
  '})();',
].join('\n');

// desktop-shim.js — 仅在 iframe 内生效的桥接脚本（桌面壳覆盖层用）
// 背景：桌面壳以 `dsh-app://app/bwm-friend/companion/` 加载本页，自定义 scheme 让两边
// 互为 opaque origin——父文档读不到这里的 DOM（contentDocument 抛 SecurityError），
// 页内原设计 postMessage(..., location.origin) 也因 targetOrigin='null' 被丢弃（实测）。
// 故：页内只负责把「关闭意图」用 '*' 发给父窗口，父侧按 e.source === iframe.contentWindow 校验。
// web 直连本页时 window.parent === window → 立即退出，行为零变化。
const DESKTOP_SHIM_JS = `(function(){
  if (window.parent === window) return;
  // 仅桌面壳（dsh-app://）生效：窗口用 hiddenInset，红黄绿交通灯浮在内容之上约 70px，
  // 而发布版 .topbar 是浏览器页的 padding: 0 34px → 品牌图标会被交通灯压住（桌面壳实测）。
  // 这段只在桌面壳注入，web 形态（含被网页 iframe 嵌入）一个字节都不改。
  if (location.protocol === 'dsh-app:') {
    var st = document.createElement('style');
    st.id = 'bwm-desktop-topbar-chrome';
    st.textContent = '.topbar{padding-left:92px !important;}';
    document.head.appendChild(st);
  }
  function post(msg){ try { window.parent.postMessage(msg, '*'); } catch (e) {} }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') post({ type: 'bwm-desktop-close' });
  }, true);
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t && t.closest && t.closest('#bwm-switch-work')) post({ type: 'bwm-desktop-close' });
  }, true);
})();`;

// companion-chat.js — 陪伴聊天：把 bwm 页面的 composer 接到插件聊天接口
// 1:1 复刻布局不动；只让聊天真正能收发（Mira 人设走 DeepSeek，语音= M3）
const COMPANION_CHAT_JS = `(function(){
  // 顶部加"切换到干活"按钮（陪伴页 → 干活页）；embedded 时通知父页，独立时跳转 /
  var actions = document.querySelector('.topbar-actions');
  if (actions && !document.getElementById('bwm-switch-work')) {
    var work = document.createElement('button');
    work.id = 'bwm-switch-work';
    work.type = 'button';
    work.title = '切换到干活页';
    work.setAttribute('aria-label', '切换到干活页');
    work.textContent = '干活';
    work.style.cssText = 'height:32px; padding:0 14px; border-radius:999px; border:1px solid rgba(123,242,210,.5); background:rgba(8,13,22,.6); color:#7bf2d2; font-size:12px; font-weight:600; cursor:pointer; display:flex; align-items:center; letter-spacing:.05em;';
    work.addEventListener('click', function () {
      if (window.parent !== window) {
        window.parent.postMessage({ type: 'bwm-switch-mode', mode: 'work' }, window.location.origin);
      } else {
        window.location.href = '/bwm-friend/work/';
      }
    });
    actions.insertBefore(work, actions.firstChild);
  }
  // P2-Proactive 演示：手动触发 Mira 主动行为（默认关闭、用户点击才触发——符合偏好）
  if (actions && !document.getElementById('bwm-proactive-btn')) {
    var pro = document.createElement('button');
    pro.id = 'bwm-proactive-btn';
    pro.type = 'button';
    pro.title = '让 Mira 主动说点什么（演示主动行为）';
    pro.setAttribute('aria-label', 'Mira 主动');
    pro.textContent = '✨ 主动';
    pro.style.cssText = 'height:32px; padding:0 14px; border-radius:999px; border:1px solid rgba(123,242,210,.5); background:rgba(8,13,22,.6); color:#7bf2d2; font-size:12px; font-weight:600; cursor:pointer; display:flex; align-items:center; letter-spacing:.05em; margin-left:6px;';
    pro.addEventListener('click', async function () {
      if (pro.disabled) return;
      pro.disabled = true;
      var wait = replyBubble('…');
      try {
        var res = await fetch('/bwm-friend/companion/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: '', history: [], requestId: 'pro-ui-' + Date.now(), proactive: { reason: 'greeting' } }),
          signal: AbortSignal.timeout(30_000),
        });
        var data = await res.json();
        var reply = (data && data.reply) || '（她没想好说什么）';
        wait.querySelector('.reply-text').textContent = reply;
        replies.scrollTop = replies.scrollHeight; // 2026-08-25 fix：主动回复后滚到底
        speakReply(reply);
      } catch (err) {
        wait.querySelector('.reply-text').textContent = '（连接失败，稍后再试）';
      } finally {
        pro.disabled = false;
      }
    });
    actions.appendChild(pro);
  }
  // ── P2 状态同步批修（2026-09-03）：主题相关 UI 单一真相源 = 服务端 config ──
  // 此前：初始高亮读从未写入的 localStorage、皮肤卡无高亮联动、"当前模板"标签不跟随
  // 点击、点击后只同步单处高亮 → 同屏多个状态互相矛盾（用户实测三连报障）。
  // 所有主题 UI 的写入/刷新统一走这里；'(root)' 在 UI 上显示为"默认"。
  window.__bwmThemeLabel = function (t) { return t === '(root)' ? '默认' : t; };
  // 2026-09-03 发布加固：模板卡 innerHTML 统一转义（云端模板名是远端输入——此前
  // 直接拼接，XSS 落在 DSH 同源即可驱动 /work/task；皮肤目录名/主题名同型加固）
  window.__bwmEsc = function (t) {
    return String(t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  window.__bwmPickIdle = function (items, theme) {
    var exact = null, exactSkin = null, root = null;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || it.type !== 'idle') continue;
      if (it.theme === theme) { if (!exact) exact = it; if (it.source === 'skin' && !exactSkin) exactSkin = it; }
      if (it.theme === '(root)' && !root) root = it;
    }
    return exactSkin || exact || root || null; /* 皮肤优先 → 精确匹配 → 根目录兜底（与加载期选片一致） */
  };
  window.__bwmApplyTheme = function (theme) {
    var label = window.__bwmThemeLabel(theme);
    Array.prototype.forEach.call(document.querySelectorAll('#templateGrid .template-card'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-template') === theme);
    });
    Array.prototype.forEach.call(document.querySelectorAll('#customTemplateGrid .template-card'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-skin') === theme);
    });
    var pn = document.getElementById('personaTemplateName');
    if (pn) pn.textContent = label ? ('当前模板：' + label) : '当前模板';
  };
  window.__bwmHotSwapIdle = function (items, theme) {
    var pick = window.__bwmPickIdle(items, theme);
    var v = document.getElementById('avatarVideo');
    if (pick && v && pick.url) { v.src = pick.url; v.load(); v.play().catch(function () {}); }
  };
  // 2026-09-03 P1：模板⇒音色绑定。桌面版语义 = 切换模板音色随模板变（applyTemplateSwitch
  // 里 data.voice 随模板返回、主路径 reload 后 loadVoices 载新模板音色）；插件免刷新切换
  // 此前丢了这个联动（用户报告"切模板声音和音色没有变化"）。未知主题（本地自定义目录）
  // 返回 ''=保持当前音色，避免用户克隆音被盲改。
  window.__bwmThemeVoice = function (t) {
    return ({ '甜心女孩': '茉莉', '电竞男孩': 'Milo', '可爱孙女HD': '冰糖', '迷人少妇': 'Chloe', '霸道女总裁': 'Mia' })[t] || '';
  };
  window.__bwmSyncVoiceUi = function (voice) {
    if (!voice) return;
    var vs = document.getElementById('voiceSelect');
    if (vs) {
      var has = false;
      for (var i = 0; i < vs.options.length; i++) { if (vs.options[i].value === voice) { has = true; break; } }
      if (!has) { var o = document.createElement('option'); o.value = voice; o.textContent = voice; vs.appendChild(o); }
      vs.value = voice;
    }
    var vst = document.getElementById('voiceStatus');
    if (vst) vst.textContent = '当前音色：' + voice + ' · 随模板切换';
  };
  // 2026-09-03 P2：人格按主题（对齐桌面版 per-template persona）。读取规则（与
  // 服务端 personaOverride 同一条）：personas[theme] 优先，缺失回退 legacy avatar.persona。
  window.__bwmReloadPersona = function () {
    var pInput = document.getElementById('personaInput');
    if (!pInput) return;
    fetch('/bwm-friend/settings').then(function (r) { return r.json(); }).then(function (cfg) {
      var av = (cfg && cfg.avatar) || {};
      var ps = av.personas && typeof av.personas === 'object' ? av.personas : {};
      var t = av.theme || '';
      pInput.value = typeof ps[t] === 'string' ? ps[t] : (typeof av.persona === 'string' ? av.persona : '');
    }).catch(function () {});
  };
  /* 模板切换唯一入口（此前两处点击各自 PUT 只存 theme，漏音色/人格联动）：
     一次 PUT 原子持久化 theme+voice，再同步高亮/视频/音色UI/人格输入框 */
  window.__bwmSwitchTheme = function (theme, items) {
    var voice = window.__bwmThemeVoice(theme);
    var body = { avatar: { theme: theme } };
    if (voice) body.voice = { voice: voice };
    fetch('/bwm-friend/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function () {
      window.__bwmApplyTheme(theme); /* 高亮+皮肤卡+当前模板标签 */
      window.__bwmHotSwapIdle(items, theme); /* 热切 idle：皮肤优先规则与加载期一致 */
      window.__bwmSyncVoiceUi(voice);
      window.__bwmReloadPersona();
    }).catch(function () { /* 保存失败保留现状 */ });
  };
  // P1：自定义模板（皮肤包列表展示——source=skin 的主题；生成走桌面/手机端）
  (function fillCustomTemplates() {
    var grid = document.getElementById('customTemplateGrid');
    if (!grid) return;
    fetch('/bwm-friend/inventory').then(function (r) { return r.json(); }).then(function (d) {
      var items = (d && d.items) || [];
      var skins = [];
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (it.source === 'skin' && it.theme && skins.indexOf(it.theme) === -1) skins.push(it.theme);
      }
      var status = document.getElementById('customTemplateStatus');
      if (skins.length === 0) {
        if (status) status.textContent = '无皮肤包（npm i @laikaton/bwm-skin-*）';
        return;
      }
      grid.innerHTML = '';
      for (var k = 0; k < skins.length; k++) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'template-card custom-tpl-card';
        btn.setAttribute('data-skin', skins[k]);
        btn.innerHTML = '<b>' + window.__bwmEsc(skins[k]) + '</b><small>皮肤包</small>';
        btn.addEventListener('click', (function (theme) {
          return function () { window.__bwmSwitchTheme(theme, items); /* 主题+音色+人格一次联动 */ };
        })(skins[k]));
        grid.appendChild(btn);
      }
      if (status) status.textContent = '点击应用皮肤';
      // 阶段三：云端模板（登录后拉 Hub /custom-templates 展示）
      fetch('/bwm-friend/auth/status').then(function (r) { return r.json(); }).then(function (s) {
        if (!s || !s.loggedIn) return;
        fetch('/bwm-friend/cloud/templates').then(function (r) { return r.json(); }).then(function (d) {
          var items2 = (d && d.ok && Array.isArray(d.templates)) ? d.templates : [];
          if (items2.length === 0) return;
          for (var m = 0; m < items2.length; m++) {
            var name = items2[m].name || items2[m].template_name || ('云端模板 ' + (m + 1));
            // 2026-09-03 发布收敛：云端模板应用未实现 → 展示为非交互条目（原 alert 占位）
            var card = document.createElement('div');
            card.className = 'template-card custom-tpl-card';
            card.style.cursor = 'default';
            card.style.opacity = '0.6';
            card.innerHTML = '<b>' + window.__bwmEsc(name) + '</b><small>云端 · 手机端生成并同步</small>';
            grid.appendChild(card);
          }
          if (status) status.textContent = '点击应用皮肤 · 云端 ' + items2.length + ' 个';
        }).catch(function () {});
      }).catch(function () {});
    }).catch(function () {});
  })();

  // P1：更新检查（app.js 移除后补回）——查询 /update/check
  (function wireUpdateCheck() {
    var btn = document.getElementById('checkUpdateBtn');
    var box = document.getElementById('updateInfoBox');
    var verEl = document.getElementById('appVersionText');
    if (!btn) return;
    fetch('/bwm-friend/update/check').then(function (r) { return r.json(); }).then(function (d) {
      if (verEl) verEl.textContent = d.current || '-';
      if (d && d.latest && box) {
        box.classList.remove('hidden');
        box.textContent = d.hasUpdate
          ? '发现新版本 ' + d.latest + '（当前 ' + d.current + '）——请 npm i dsh-plugin-bwm-friend@latest'
          : '已是最新版本 ' + d.current;
      }
    }).catch(function () {});
    btn.addEventListener('click', function () {
      if (box) { box.classList.remove('hidden'); box.textContent = '检查中…'; }
      fetch('/bwm-friend/update/check').then(function (r) { return r.json(); }).then(function (d) {
        if (!box) return;
        if (d && d.latest) {
          box.textContent = d.hasUpdate
            ? '发现新版本 ' + d.latest + '（当前 ' + d.current + '）——请 npm i dsh-plugin-bwm-friend@latest'
            : '已是最新版本 ' + d.current;
        } else {
          box.textContent = '当前版本 ' + (d && d.current || '-') + '（dev 模式，未配置更新源）';
        }
      }).catch(function () { if (box) box.textContent = '检查失败'; });
    });
  })();

  // P1：隐藏桌面特有设置项（口型方案/上传视频/LLM 配置/服务状态——插件端固定 DeepSeek/MiMo）
  (function hideDesktopOnlySettings() {
    var sels = [
      '.driver-setting',            // 口型方案
      'input#avatarInput',          // 驱动视频上传
      'input#idleVideoInput',       // 待机视频上传
      '.llm-provider-setting',      // 语言模型配置
      '.service-detail',            // 本地服务状态
    ];
    for (var i = 0; i < sels.length; i++) {
      var el = document.querySelector(sels[i]);
      if (el) {
        var block = el.closest('.setting-block') || el;
        block.style.display = 'none';
      }
    }
  })();

  // P0：账号登录（app.js 移除后补回）——状态加载 + 登录/退出
  (function wireAccount() {
    var statusEl = document.getElementById('accountStatus');
    var loggedOut = document.getElementById('accountLoggedOut');
    var loggedIn = document.getElementById('accountLoggedIn');
    var loginBtn = document.getElementById('loginButton');
    var logoutBtn = document.getElementById('logoutButton');
    var phone = document.getElementById('loginPhone');
    var password = document.getElementById('loginPassword');
    var subjectEl = document.getElementById('accountSubject');
    function applyState(s) {
      if (!loggedOut || !loggedIn) return;
      if (s && s.loggedIn) {
        loggedOut.classList.add('hidden');
        loggedIn.classList.remove('hidden');
        if (statusEl) statusEl.textContent = '已登录';
        if (subjectEl) subjectEl.textContent = s.subject || '-';
      } else {
        loggedOut.classList.remove('hidden');
        loggedIn.classList.add('hidden');
        if (statusEl) statusEl.textContent = '未登录';
      }
    }
    fetch('/bwm-friend/auth/status').then(function (r) { return r.json(); }).then(applyState).catch(function () {});
    if (loginBtn) loginBtn.addEventListener('click', function () {
      loginBtn.disabled = true;
      loginBtn.textContent = '登录中…';
      fetch('/bwm-friend/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone ? phone.value : '', password: password ? password.value : '' }),
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (d && d.ok) {
          applyState({ loggedIn: true, subject: d.subject });
          if (password) password.value = '';
        } else {
          alert((d && d.error === 'empty-credentials') ? '请输入手机号和密码' : (d && d.error) || '登录失败');
        }
      }).catch(function () { alert('登录失败，请重试'); }).finally(function () {
        loginBtn.disabled = false;
        loginBtn.textContent = '登 录';
      });
    });
    if (logoutBtn) logoutBtn.addEventListener('click', function () {
      fetch('/bwm-friend/auth/logout', { method: 'POST' }).then(function () { applyState({ loggedIn: false }); });
    });
  })();

  // P0：人格设定（app.js 移除后补回）——加载当前主题人格 + 保存生效
  // 2026-09-03 P2：人格按主题存储（avatar.personas，对齐桌面版 per-template persona——
  // 此前砍成全局单值但标签仍写"当前模板"，切模板后输入框内容不随动、误导用户）。
  // 读取规则：personas[当前主题] 优先，缺失回退 legacy avatar.persona（零迁移）。
  (function wirePersona() {
    var pInput = document.getElementById('personaInput');
    var pSave = document.getElementById('personaSaveBtn');
    var pName = document.getElementById('personaTemplateName');
    if (!pInput || !pSave) return;
    fetch('/bwm-friend/settings').then(function (r) { return r.json(); }).then(function (cfg) {
      var av = (cfg && cfg.avatar) || {};
      var ps = av.personas && typeof av.personas === 'object' ? av.personas : {};
      var t = av.theme || '';
      pInput.value = typeof ps[t] === 'string' ? ps[t] : (typeof av.persona === 'string' ? av.persona : '');
      if (pName) pName.textContent = t ? ('当前模板：' + (window.__bwmThemeLabel ? window.__bwmThemeLabel(t) : t)) : '当前模板';
    }).catch(function () {});
    pSave.addEventListener('click', function () {
      pSave.disabled = true;
      var text = pInput.value.trim();
      // 保存写 personas[当前主题]：先读后写（客户端合并整张 map，规避服务端浅合并整表覆盖）
      fetch('/bwm-friend/settings').then(function (r) { return r.json(); }).catch(function () { return null; }).then(function (cfg) {
        var av = (cfg && cfg.avatar) || {};
        var ps = av.personas && typeof av.personas === 'object' ? av.personas : {};
        ps[av.theme || ''] = text;
        return fetch('/bwm-friend/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ avatar: { personas: ps } }),
        });
      }).then(function (r) { return r.json(); }).then(function () {
        pSave.textContent = '已保存 ✓';
        setTimeout(function () { pSave.textContent = '保存人格'; pSave.disabled = false; }, 1500);
      }).catch(function () {
        pSave.textContent = '保存失败';
        setTimeout(function () { pSave.textContent = '保存人格'; pSave.disabled = false; }, 1500);
      });
    });
  })();

  // 设置面板开关（对齐桌面 App：panel + scrim 一起开，open 类控制显示）
  (function wireSettingsPanel() {
    var sBtn = document.getElementById('settingsButton');
    var sPanel = document.getElementById('settingsPanel');
    var sScrim = document.getElementById('settingsScrim');
    var sClose = document.getElementById('settingsClose');
    function openSettings() {
      // 2026-09-02 fix：与 ☰ 工作区弹窗互斥（同右侧滑入层，重叠时 z80 弹窗盖住 z40 面板右半）。
      // ⚠️ popOpen/closePop 在另一个闭包——直接引用会 ReferenceError（实测把设置面板搞坏）；
      // 经 window.__bwmClosePop 桥接（closePop 幂等：未开时调用无副作用）。
      if (typeof window.__bwmClosePop === 'function') window.__bwmClosePop();
      if (sPanel) {
        sPanel.classList.add('open');
        sPanel.style.transform = ''; // 清除 COMPANION_SHIM 初始"推出屏幕外"内联样式（内联优先级 > .open 类）
        sPanel.setAttribute('aria-hidden', 'false');
      }
      if (sScrim) { sScrim.classList.add('open'); sScrim.setAttribute('aria-hidden', 'false'); }
    }
    function closeSettings() {
      if (sPanel) { sPanel.classList.remove('open'); sPanel.setAttribute('aria-hidden', 'true'); }
      if (sScrim) { sScrim.classList.remove('open'); sScrim.setAttribute('aria-hidden', 'true'); }
    }
    if (sBtn) sBtn.addEventListener('click', openSettings);
    if (sClose) sClose.addEventListener('click', closeSettings);
    if (sScrim) sScrim.addEventListener('click', closeSettings);
  })();

  // P2-UI：模板切换（app.js 移除后补回）——从 inventory 动态填充主题网格 + 点击热切（对齐桌面 App：免刷新）
  // 2026-09-03 批修：初始高亮改为读服务端 config（原读从未写入的 localStorage → 永远无高亮）；
  // 主题枚举只取 idle/talk 资产（custom_uploads 等上传杂物不是可选模板）；'(root)' 卡值与
  // 真实主题名对齐（此前把"默认"字面量存进 config，加载期选片必失配回退）；点击后 __bwmApplyTheme 全量同步。
  (function fillTemplates() {
    var grid = document.getElementById('templateGrid');
    if (!grid) return;
    Promise.all([
      fetch('/bwm-friend/inventory').then(function (r) { return r.json(); }),
      fetch('/bwm-friend/settings').then(function (r) { return r.json(); }).catch(function () { return null; }),
    ]).then(function (out) {
      var d = out[0] || {}, cfg = out[1] || null;
      var items = (d && d.items) || [];
      var themes = [];
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if ((it.type === 'idle' || it.type === 'talk') && it.theme && it.theme !== '(root)' && themes.indexOf(it.theme) === -1) themes.push(it.theme);
      }
      // 补默认（根目录资产也算一个主题入口；值为 '(root)'，UI 显示"默认"）
      if (themes.indexOf('(root)') === -1) themes.unshift('(root)');
      var status = document.getElementById('templateStatus');
      // 清空骨架按钮（原生"默认"占位），改为真实主题列表
      grid.innerHTML = '';
      var current = (cfg && cfg.avatar && cfg.avatar.theme) || '(root)';
      for (var k = 0; k < themes.length; k++) {
        var theme = themes[k];
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'template-card';
        btn.setAttribute('data-template', theme); /* 值=真实主题名；显示名用 __bwmThemeLabel */
        btn.innerHTML = '<b>' + window.__bwmEsc(window.__bwmThemeLabel(theme)) + '</b><small>' + (theme === '(root)' ? '根目录资产' : '数字人主题') + '</small>';
        btn.addEventListener('click', (function (theme) {
          return function () { window.__bwmSwitchTheme(theme, items); /* 持久化+高亮+热切+音色+人格 唯一入口 */ };
        })(theme));
        grid.appendChild(btn);
      }
      window.__bwmApplyTheme(current); /* 初始高亮：与服务端配置一致 */
      if (status) status.textContent = '点击切换数字人';
    }).catch(function () { /* inventory 不可用则保留骨架 */ });
  })();

  // P2-Voice：填充音色选择（app.js 被去掉后由本脚本填充 MiMo 8 音色）
  // 2026-09-03 批修：回显服务端配置音色（原硬编码'冰糖'）+ change 即持久化（原从不保存，
  // 刷新即回显错值——"声音信息不对齐"根因）。配置里的自定义音色（如克隆音）追加为选项。
  (function fillVoices() {
    var vs = document.getElementById('voiceSelect');
    if (!vs || vs.options.length > 1) return;
    var voices = ['茉莉', '冰糖', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'];
    vs.innerHTML = '';
    voices.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v; o.textContent = v;
      vs.appendChild(o);
    });
    var vst = document.getElementById('voiceStatus');
    fetch('/bwm-friend/settings').then(function (r) { return r.json(); }).then(function (cfg) {
      var cur = (cfg && cfg.voice && cfg.voice.voice) || '冰糖';
      if (voices.indexOf(cur) === -1) {
        var o = document.createElement('option');
        o.value = cur; o.textContent = cur + '（自定义）';
        vs.appendChild(o);
      }
      vs.value = cur;
      if (vst) vst.textContent = '当前音色：' + cur + ' · 选择即保存';
    }).catch(function () {
      vs.value = '冰糖';
      if (vst) vst.textContent = '已加载 8 个音色（未读到配置，暂用默认）';
    });
    vs.addEventListener('change', function () {
      var val = vs.value;
      fetch('/bwm-friend/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice: { voice: val } }),
      }).then(function () { if (vst) vst.textContent = '当前音色：' + val + ' · 已保存'; })
        .catch(function () { if (vst) vst.textContent = '音色保存失败：' + val; });
    });
  })();
  const form = document.getElementById('composer');
  const input = document.getElementById('messageInput');
  const replies = document.getElementById('assistantReplies');
  const turn = document.getElementById('turnLabel');
  if (!form || !input || !replies) return;
  const history = [];
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const replyBubble = (text) => {
    const el = document.createElement('div');
    el.className = 'assistant-reply';
    el.innerHTML = '<span class="reply-text">' + esc(text) + '</span>';
    replies.appendChild(el);
    replies.scrollTop = replies.scrollHeight;
    return el;
  };
  // Runtime v1.1：发送锁（防快速连点重复提交）+ requestId 幂等 + 30s 超时兜底
  var sending = false;
  var seq = 0;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (sending) return; // 防重复
    const text = input.value.trim();
    if (!text) return;
    sending = true;
    input.disabled = true; // 等待期禁用输入
    input.value = '';
    const requestId = 'c' + (++seq) + '-' + Date.now();
    // bwm 结构：用户的话 = turn label（mint user-turn），回复 = replies 区
    if (turn) { turn.textContent = text; turn.classList.add('user-turn'); }
    history.push({ role: 'user', content: text });
    const wait = replyBubble('…');
    try {
      const res = await fetch('/bwm-friend/companion/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history, requestId }),
        signal: AbortSignal.timeout(30_000), // 超时兜底（网络差不无限转圈）
      });
      const data = await res.json();
      if (data && data.duplicate) { wait.remove(); return; } // 服务端幂等拒绝（多端场景）
      const reply = (data && data.reply) || '（她没听清，再说一遍？）';
      wait.querySelector('.reply-text').textContent = reply;
      replies.scrollTop = replies.scrollHeight; // 2026-08-25 fix：占位后真实回复更长 → 再滚到底
      history.push({ role: 'assistant', content: reply });
      speakReply(reply); // P2-Voice：AI 回复自动朗读（MiMo TTS）
    } catch (err) {
      wait.querySelector('.reply-text').textContent =
        err && err.name === 'TimeoutError' ? '（她思考太久了，再说一遍？）' : '（连接失败，稍后再试）';
    } finally {
      sending = false;
      input.disabled = false;
    }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });

  // ── P2-Voice：AI 回复 → TTS 朗读（MiMo，音色取 #voiceSelect）──
  // S7：复用单个 Audio 实例（避免每条回复 new Audio 堆积）
  var replyAudio = new Audio();
  function speakReply(text) {
    try {
      var vsel = document.getElementById('voiceSelect');
      var voice = (vsel && vsel.value) || '冰糖';
      fetch('/bwm-friend/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text, voice: voice }),
      }).then(function (r) { return r.json(); }).then(function (data) {
        if (data.ok && data.audioBase64) {
          replyAudio.src = 'data:audio/mp3;base64,' + data.audioBase64;
          replyAudio.play().catch(function () {});
        }
      }).catch(function () { /* TTS 失败静默（文本已显示） */ });
    } catch (e) { /* noop */ }
  }

  // ── P2-Voice：按住说话 → MiMo ASR → 填入输入框并发送 ──
  var voiceBtn = document.getElementById('voiceButton');
  var voiceHint = document.getElementById('voiceHint');
  var mediaRecorder = null;
  var audioChunks = [];
  var recording = false;
  function setVoiceHint(t) { if (voiceHint) voiceHint.textContent = t; }
  if (voiceBtn && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    voiceBtn.addEventListener('pointerdown', async function (e) {
      e.preventDefault();
      if (recording) return;
      try {
        var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        var mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4';
        mediaRecorder = new MediaRecorder(stream, { mimeType: mime });
        audioChunks = [];
        mediaRecorder.ondataavailable = function (ev) { if (ev.data.size > 0) audioChunks.push(ev.data); };
        mediaRecorder.onstop = function () {
          stream.getTracks().forEach(function (t) { t.stop(); });
          var blob = new Blob(audioChunks, { type: mime });
          if (blob.size < 1000) { setVoiceHint('没听到声音，再说一次'); return; }
          setVoiceHint('识别中…');
          var reader = new FileReader();
          reader.onload = async function () {
            var audioBase64 = String(reader.result).split(',')[1] || '';
            try {
              var res = await fetch('/bwm-friend/transcribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ audioBase64: audioBase64, format: mime.indexOf('webm') >= 0 ? 'webm' : 'mp4' }),
              });
              var data = await res.json();
              if (data.ok && data.text) {
                input.value = data.text;
                setVoiceHint('已识别：' + data.text.slice(0, 20) + (data.text.length > 20 ? '…' : ''));
                form.requestSubmit(); // 直接发送（走上面的聊天链路）
              } else {
                setVoiceHint('识别失败，请打字或重试');
              }
            } catch (err) { setVoiceHint('识别失败：' + (err.message || '')); }
          };
          reader.readAsDataURL(blob);
        };
        recording = true;
        mediaRecorder.start();
        setVoiceHint('正在听…松开发送');
      } catch (err) {
        setVoiceHint('无法录音（需麦克风权限）');
      }
    });
    function stopRecording(e) {
      e.preventDefault();
      if (recording && mediaRecorder) { mediaRecorder.stop(); recording = false; }
    }
    voiceBtn.addEventListener('pointerup', stopRecording);
    voiceBtn.addEventListener('pointerleave', stopRecording);
  }
})();`;

// work-init：标记 work 模式（布局与 companion 完全一致，仅内容/按钮不同）
const WORK_INIT_JS = `document.body.setAttribute('data-bwm-mode','work');`;

// work-chat：左窗口 = iframe 内嵌原生 DSH 会话视图（业务流原生）；右上按钮（陪伴 / ☰工作区）
const WORK_CHAT_JS = `(function(){
  document.body.setAttribute('data-bwm-mode','work');
  // 右上控制区加按钮：陪伴切换、☰ 工作区（弹出 iframe 内侧栏抽屉）
  var actions = document.querySelector('.topbar-actions');
  function mkBtn(id, label, title, fn) {
    var b = document.createElement('button');
    b.id = id; b.type = 'button'; b.title = title; b.setAttribute('aria-label', title); b.textContent = label;
    b.style.cssText = 'height:32px; padding:0 14px; border-radius:999px; border:1px solid rgba(123,242,210,.5); background:rgba(8,13,22,.6); color:#7bf2d2; font-size:12px; font-weight:600; cursor:pointer; display:flex; align-items:center; letter-spacing:.05em;';
    b.addEventListener('click', fn);
    return b;
  }
  function openHarness(msg) {
    var f = document.getElementById('bwm-harness-frame');
    if (f && f.contentWindow) f.contentWindow.postMessage(msg, window.location.origin);
  }
  // ☰ 工作区：屏幕最右透明毛玻璃弹窗（会话选择窗口），替代 iframe 内抽屉
  // 弹窗 = 父页面 fixed 层（right:0 全高 320px，rgba 半透明 + backdrop-blur），
  // 内嵌 iframe（/?bwm=embedded&pop=1）只显示原生侧栏会话树。
  var popEl = null, maskEl = null, popOpen = false;
  function ensurePop() {
    if (popEl) return;
    popEl = document.createElement('div');
    popEl.id = 'bwm-workspace-pop';
    popEl.style.cssText = 'position:fixed; right:0; top:0; height:100vh; width:min(320px,85vw); z-index:80; background:rgba(10,16,26,.55); backdrop-filter:blur(18px) saturate(.9); -webkit-backdrop-filter:blur(18px) saturate(.9); border-left:1px solid rgba(123,242,210,.25); box-shadow:-10px 0 30px rgba(0,0,0,.35); transform:translateX(100%); transition:transform .3s cubic-bezier(.22,1,.36,1);';
    var fi = document.createElement('iframe');
    fi.id = 'bwm-workspace-frame';
    fi.src = window.location.origin + '/?bwm=embedded&pop=1';
    fi.style.cssText = 'width:100%; height:100%; border:0; background:transparent;';
    // P2.5-UI：pop 弹窗只显示侧栏会话树（DSH 不认 pop 参数，注入 CSS 隐藏主对话区）
    // 立即注入 + MutationObserver 持续守护：DSH SPA 渲染完成后 main 也不会闪现
    function injectPopCss(idoc) {
      if (!idoc || !idoc.head) return;
      var existing = idoc.getElementById('bwm-pop-css');
      if (existing) return;
      var pst = idoc.createElement('style');
      pst.id = 'bwm-pop-css';
      pst.textContent = [
        '.RnFLRG_main{display:none!important;}',
        '.RnFLRG_sidebar{width:100%!important;max-width:100%!important;height:100%!important;}',
        '.RnFLRG_sidebar [class*="_regionArea"]{display:block!important;}',
        '.RnFLRG_sidebar [role="tree"]{max-height:calc(100vh - 190px)!important;overflow-y:auto!important;}',
        '.RnFLRG_logoRow{display:none!important;}'
      ].join('\\n');
      idoc.head.appendChild(pst);
    }
    fi.addEventListener('load', function () {
      try { injectPopCss(fi.contentDocument); } catch (e) {}
      // 轻量：加载后再补一次（DSH SPA 渲染完成后 CSS 已在 head，无需持续观察）
      setTimeout(function () {
        try { injectPopCss(fi.contentDocument); } catch (e2) {}
      }, 1200);
    });
    // 立即尝试（若 iframe 已同源就绪）
    fi.addEventListener('readystatechange', function () {
      try { injectPopCss(fi.contentDocument); } catch (e) {}
    });
    popEl.appendChild(fi);
    // 关闭按钮（右上角 ✕）：显式关闭会话列表；遮罩点击 / ☰ 按钮同样可关
    var cb = document.createElement('button');
    cb.id = 'bwm-workspace-close';
    cb.type = 'button';
    cb.title = '关闭会话列表';
    cb.setAttribute('aria-label', '关闭会话列表');
    cb.textContent = '✕';
    cb.style.cssText = 'position:absolute; top:12px; right:12px; z-index:7; width:26px; height:26px; border-radius:50%; border:1px solid rgba(123,242,210,.35); background:rgba(123,242,210,.1); color:#7bf2d2; font-size:12px; line-height:1; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:background .2s;';
    cb.addEventListener('click', function (e) { e.stopPropagation(); closePop(); });
    popEl.appendChild(cb);
    document.body.appendChild(popEl);
    maskEl = document.createElement('div');
    maskEl.id = 'bwm-workspace-mask';
    maskEl.style.cssText = 'position:fixed; inset:0; z-index:75; background:rgba(8,13,22,.35); opacity:0; transition:opacity .3s; pointer-events:none; cursor:pointer;';
    maskEl.title = '点击空白处关闭会话列表（Esc 也可关闭）';
    maskEl.addEventListener('click', closePop);
    document.body.appendChild(maskEl);
    // 遮罩首次出现时提示一次关闭方式（用户反馈：遮罩罩住对话区像"页面坏了"，不知如何关）
    try {
      if (!localStorage.getItem('bwm-mask-hint-shown')) {
        localStorage.setItem('bwm-mask-hint-shown', '1');
        var hintEl = document.createElement('div');
        hintEl.id = 'bwm-mask-hint';
        hintEl.style.cssText = 'position:fixed; top:74px; left:50%; transform:translateX(-50%); z-index:81; padding:8px 18px; border-radius:999px; border:1px solid rgba(123,242,210,.4); background:rgba(10,16,26,.92); color:#7bf2d2; font-size:12.5px; letter-spacing:.05em; pointer-events:none; transition:opacity .4s;';
        hintEl.textContent = '已打开会话列表：选择会话切换，点击空白处或按 Esc 关闭';
        document.body.appendChild(hintEl);
        setTimeout(function () { hintEl.style.opacity = '0'; }, 3800);
        setTimeout(function () { if (hintEl.parentNode) hintEl.parentNode.removeChild(hintEl); }, 4400);
      }
    } catch (eHint) { /* localStorage 不可用时静默 */ }
    // Esc 关闭弹层（此前只有 ✕/遮罩/☰ 三种方式）
    window.addEventListener('keydown', function (eKey) {
      if (eKey.key === 'Escape' && popOpen) closePop();
    });
    // 弹窗 iframe 选择会话 → 转发主 iframe 切换（弹窗保持打开，便于连续切换；关闭由 ✕/遮罩/☰ 负责）
    window.addEventListener('message', function (e) {
      if (!e || e.origin !== window.location.origin) return; // P0 安全：仅接受同源消息
      if (e.data && e.data.type === 'bwm-pop-select') {
        var f = document.getElementById('bwm-harness-frame');
        if (f && f.contentWindow) f.contentWindow.postMessage({ type: 'bwm-switch-session', title: e.data.title, folders: e.data.folders }, window.location.origin);
      }
      // 弹层内点「新会话」→ 转发主 iframe 原生新建+切换（修复：弹层创建后主窗口不跟随）
      if (e.data && e.data.type === 'bwm-pop-new-session') {
        var f2 = document.getElementById('bwm-harness-frame');
        if (f2 && f2.contentWindow) f2.contentWindow.postMessage({ type: 'bwm-new-session' }, window.location.origin);
      }
    });
  }
  function openPop() {
    ensurePop();
    // 2026-09-02 fix：与设置面板互斥（同右侧滑入层；settings z40 < pop z80，重叠会盖住面板右半）
    var spNow = document.getElementById('settingsPanel');
    if (spNow && spNow.classList.contains('open')) {
      spNow.classList.remove('open');
      spNow.setAttribute('aria-hidden', 'true');
      var ssNow = document.getElementById('settingsScrim');
      if (ssNow) { ssNow.classList.remove('open'); ssNow.setAttribute('aria-hidden', 'true'); }
    }
    // 立即滑入 + loading 层盖住 iframe（轮询会话树 + 超时失败态，杜绝无限 loading）
    popOpen = true;
    popEl.style.transform = 'translateX(0px)';
    maskEl.style.opacity = '1';
    maskEl.style.pointerEvents = 'auto';
    var fi = document.getElementById('bwm-workspace-frame');
    if (fi) {
      var wl = document.getElementById('bwm-workspace-loading');
      if (!wl) {
        wl = document.createElement('div');
        wl.id = 'bwm-workspace-loading';
        wl.style.cssText = 'position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; color:rgba(123,242,210,.85); font-size:13px; letter-spacing:.08em; background:rgba(10,16,26,.92); z-index:5;';
        var wlt = document.createElement('div');
        wlt.id = 'bwm-workspace-loading-text';
        wlt.textContent = '加载会话列表…';
        wl.appendChild(wlt);
        var rb = document.createElement('button');
        rb.id = 'bwm-workspace-retry';
        rb.type = 'button';
        rb.textContent = '重试';
        rb.style.cssText = 'display:none; padding:6px 18px; border-radius:999px; border:1px solid rgba(123,242,210,.5); background:rgba(123,242,210,.08); color:#7bf2d2; font-size:12px; cursor:pointer;';
        rb.addEventListener('click', function () {
          var rl = document.getElementById('bwm-workspace-loading-text');
          var rr = document.getElementById('bwm-workspace-retry');
          if (rl) rl.textContent = '加载会话列表…';
          if (rr) rr.style.display = 'none';
          var rf = document.getElementById('bwm-workspace-frame');
          if (rf) {
            try { rf.src = window.location.origin + '/?bwm=embedded&pop=1&r=' + Date.now(); }
            catch (e2) { if (rf.contentWindow) rf.contentWindow.location.reload(); }
          }
          startPopWait(fi);
        });
        wl.appendChild(rb);
        popEl.appendChild(wl);
      } else {
        var rl0 = document.getElementById('bwm-workspace-loading-text');
        var rr0 = document.getElementById('bwm-workspace-retry');
        if (rl0) rl0.textContent = '加载会话列表…';
        if (rr0) rr0.style.display = 'none';
      }
      // 轮询会话树：渲染成功即移除；10s 超时显示失败态+重试（读不到就明确告诉用户，绝不无限 loading）
      var startPopWait = function (frm) {
        var tw = 0;
        var waitLoop = function () {
          tw += 500;
          var done = false;
          try {
            var pd = frm.contentDocument;
            done = pd && pd.querySelectorAll('[role="treeitem"]').length > 0;
          } catch (e) { done = false; }
          if (done) {
            var w5 = document.getElementById('bwm-workspace-loading');
            if (w5 && w5.parentNode) w5.parentNode.removeChild(w5);
            return;
          }
          if (tw >= 10000) {
            var w6 = document.getElementById('bwm-workspace-loading-text');
            var r6 = document.getElementById('bwm-workspace-retry');
            if (w6) w6.textContent = '会话列表加载失败或为空';
            if (r6) r6.style.display = 'inline-block';
            return;
          }
          setTimeout(waitLoop, 500);
        };
        setTimeout(waitLoop, 300);
      };
      startPopWait(fi);
    }
  }
  function closePop() {
    if (!popEl) return;
    popOpen = false;
    popEl.style.transform = 'translateX(100%)';
    maskEl.style.opacity = '0';
    maskEl.style.pointerEvents = 'none';
  }
  // 2026-09-02 fix：跨闭包桥接（设置面板 openSettings 与 ☰ 弹窗互斥用；closePop 幂等）
  window.__bwmClosePop = closePop;
  function toggleHarnessSidebar() {
    if (popOpen) closePop();
    else openPop();
  }
  // P2-8 presence 联动：iframe 通知 → 数字人视频视觉状态（thinking 模糊/executing 提亮）
  var pwStyle = document.createElement('style');
  pwStyle.textContent = '#avatarVideo.bwm-thinking { filter: blur(2px) saturate(.9) brightness(1.06) !important; transform: scale(1.02) !important; } #avatarVideo.bwm-executing { filter: saturate(1.15) brightness(1.03) !important; } #avatarVideo.bwm-idle { filter: none !important; transform: none !important; } #avatarVideo { transition: filter .6s ease, transform .6s ease; }';
  document.head.appendChild(pwStyle);
  window.addEventListener('message', function (e) {
    if (!e || e.origin !== window.location.origin) return;
    if (e.data && e.data.type === 'bwm-presence') {
      var v = document.getElementById('avatarVideo');
      if (!v) return;
      v.classList.remove('bwm-thinking', 'bwm-executing', 'bwm-idle');
      v.classList.add('bwm-' + (e.data.state || 'idle'));
    }
  });
  if (actions) {
    if (!document.getElementById('bwm-switch-companion')) {
      actions.insertBefore(mkBtn('bwm-switch-companion','陪伴','切换到陪伴', function(){ window.location.href='/bwm-friend/companion/'; }), actions.firstChild);
    }
    if (!document.getElementById('bwm-sidebar-drawer-btn')) {
      actions.appendChild(mkBtn('bwm-sidebar-drawer-btn','☰ 工作区','工作区/会话', function(){ toggleHarnessSidebar(); }));
    }
  }
  // 左窗口 = iframe 内嵌原生 DSH 会话视图（内容列宽 = bwm 589px，撑满面板内容区）
  var panel = document.querySelector('.dialogue-panel');
  if (panel) {
    while (panel.firstChild) panel.removeChild(panel.firstChild);
    // P2 宽度对齐：对话窗口与陪伴模式一致（dialogue-panel 742px 全宽）。
    // ⚠️ 只清左右 padding（撑满宽度）；顶部 padding 必须保留 clamp(118px,14vh,154px)——
    // 否则 iframe 顶到 0 被 fixed topbar(78px) 遮挡（用户实测 bug：信息栏不显示）
    panel.style.padding = 'clamp(118px, 14vh, 154px) 0 42px';
    // 2026-09-02 fix：幕布（dialogue-panel）宽度与 iframe 同步——CSS 类是 clamp(620,58vw,940)，
    // 742 时代幕布比对话区宽 198px、响应式后差值随视口漂移（用户知识库 bug 模式：遮罩/视频层
    // 与内容层错位）→ 同一 clamp，幕布毛玻璃渐变右缘精确贴合对话区右缘。
    panel.style.width = 'clamp(620px, 48vw, 1080px)';
    var f = document.createElement('iframe');
    f.id = 'bwm-harness-frame';
    f.src = window.location.origin + '/?bwm=embedded';
    f.setAttribute('allow', 'clipboard-read; clipboard-write');
    // 2026-08-24：620→540 收窄后太小回退 620 → 600（用户指定）→ P2 与陪伴一致 742px 全宽
    // 2026-09-02：742 固定宽在大屏（≥1600）下对话区仅占 ~43%，且 ask/choice 卡片（内容需 ~802px）
    // 被横向截断（用户实测 bug）→ 改响应式：小屏保持 620 下限，大屏随 48vw 放宽、上限 1080。
    f.style.cssText = 'flex:1 1 auto; min-height:0; width:clamp(620px, 48vw, 1080px); max-width:100%; border:0; background:transparent;';
    panel.appendChild(f);
    // Runtime v1.1：加载占位（DSH boot 白屏期给用户反馈，load 后移除）
    var ph = document.createElement('div');
    ph.id = 'bwm-harness-loading';
    ph.textContent = '正在加载工作台…';
    ph.style.cssText = 'position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:rgba(189,198,195,.7); font-size:14px; letter-spacing:.08em; background:rgba(8,13,22,.35); z-index:1; transition:opacity .3s;';
    panel.appendChild(ph);
    f.addEventListener('load', function () {
      ph.style.opacity = '0';
      setTimeout(function () { if (ph.parentNode) ph.parentNode.removeChild(ph); }, 350);
      // P2.5-UI：修复 iframe 内 DSH 原生设置弹窗宽度（embedded 模式下被侧栏约束成 320px，内容挤压）
      try {
        var idoc = f.contentDocument;
        if (idoc && idoc.head) {
          var fst = idoc.createElement('style');
          fst.textContent = [
            '.Ep6gBG_overlay{width:100vw!important;max-width:100vw!important;left:0!important;}',
            '.Ep6gBG_panel{width:800px!important;max-width:calc(100vw - 48px)!important;}',
            '.Ep6gBG_panel [class*="_content"]{min-width:480px!important;}'
          ].join('\\n');
          idoc.head.appendChild(fst);
        }
      } catch (e) { /* iframe 跨域或未就绪时静默 */ }
    });
    // 兜底（load 事件异常时）：15s 后若仍显示占位 → 转失败态 + 重试，绝不无限 loading
    setTimeout(function () {
      var ph2 = document.getElementById('bwm-harness-loading');
      if (!ph2 || !ph2.parentNode) return;
      ph2.style.opacity = '1';
      ph2.style.flexDirection = 'column';
      ph2.style.gap = '12px';
      var pt = ph2.firstChild;
      if (pt) pt.textContent = '工作台加载超时';
      if (!document.getElementById('bwm-harness-retry')) {
        var rb2 = document.createElement('button');
        rb2.id = 'bwm-harness-retry';
        rb2.type = 'button';
        rb2.textContent = '重试';
        rb2.style.cssText = 'padding:6px 18px; border-radius:999px; border:1px solid rgba(123,242,210,.5); background:rgba(123,242,210,.08); color:#7bf2d2; font-size:12px; cursor:pointer;';
        rb2.addEventListener('click', function () {
          var f2 = document.getElementById('bwm-harness-frame');
          if (f2) {
            try { f2.src = window.location.origin + '/?bwm=embedded&r=' + Date.now(); }
            catch (e3) { if (f2.contentWindow) f2.contentWindow.location.reload(); }
          }
          var ph3 = document.getElementById('bwm-harness-loading');
          if (ph3) {
            ph3.style.opacity = '0';
            setTimeout(function () { if (ph3.parentNode) ph3.parentNode.removeChild(ph3); }, 350);
          }
        });
        ph2.appendChild(rb2);
      }
    }, 15000);
  }

  // 动态加载 companion-chat.js（0.7.4：引擎设置已整体移除，原注释里的共享逻辑不复存在）
  var sc = document.createElement('script');
  sc.src = 'companion-chat.js';
  document.body.appendChild(sc);
})();`;

async function serveCompanion(pathname, res) {
  // work /companion 共用同一 bwm 页面（像素一致），仅注入内容脚本不同
  const isWork = pathname.startsWith('/bwm-friend/work');
  const base = isWork ? '/bwm-friend/work' : '/bwm-friend/companion';
  const rel = pathname.replace(base, '');
  const file = rel === '' || rel === '/' ? 'index.html' : rel.slice(1);
  // 🔴 安全（review 修复）：防路径穿越——resolve 后必须仍在 BWM_STATIC 内（. 保持原目录）
  const abs = resolve(BWM_STATIC, file);
  const staticRoot = resolve(BWM_STATIC);
  if (abs !== staticRoot && !abs.startsWith(staticRoot + '/')) {
    return serveJson(res, { error: 'forbidden' }, 403);
  }
  try {
    if (file === 'index.html') {
      let html = await readFile(abs, 'utf8');
      // 将 root 绝对路径改为相对（在 /bwm-friend/companion/ 前缀下可解析）
      html = html
        .replace(/href="\/styles\.css\?v=([^"]*)"/g, 'href="styles.css?v=$1"')
        .replace(/href="\/favicon\.png"/g, 'href="favicon.png"')
        .replace(/src="\/brand-mark-54\.png"/g, 'src="brand-mark-54.png"')
        .replace(/srcset="\/brand-mark-54\.png 1x, \/brand-mark-108\.png 2x"/g, 'srcset="brand-mark-54.png 1x, brand-mark-108.png 2x"')
        .replace(/<script[^>]*src="\/app\.js[^>]*><\/script>/, '') // 去掉 app.js（无后端时省掉一堆 /api 失败）
        .replace('</body>', isWork
          ? '<script src="work-init.js"></script><script src="work-chat.js"></script><script src="companion-init.js"></script><script src="desktop-shim.js"></script></body>'
          : '<script src="companion-chat.js"></script><script src="companion-init.js"></script><script src="desktop-shim.js"></script></body>');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    if (file === 'work-init.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
      return res.end(WORK_INIT_JS);
    }
    if (file === 'work-chat.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
      return res.end(WORK_CHAT_JS);
    }
    if (file === 'companion-chat.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
      return res.end(COMPANION_CHAT_JS);
    }
    if (file === 'companion-init.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
      return res.end(COMPANION_SHIM);
    }
    if (file === 'desktop-shim.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
      return res.end(DESKTOP_SHIM_JS);
    }
    const mime = file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'application/octet-stream';
    // 🔴 安全（review 修复）：stat 预检存在性——createReadStream 对不存在文件的 error 事件是
    // 异步的、逃出 try/catch → 任意 404 静态资源请求都能崩进程（实测 DoS）
    const st = await stat(abs);
    if (!st.isFile()) return serveJson(res, { error: 'not found' }, 404);
    res.writeHead(200, { 'Content-Type': mime });
    const stream = createReadStream(abs);
    stream.on('error', () => { try { res.destroy(); } catch { /* noop */ } });
    return stream.pipe(res);
  } catch (e) {
    return serveJson(res, { error: 'companion asset not found' }, 404);
  }
}

function serveJson(res, obj, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

// 媒体流（支持 Range，供 <video> 拖动/循环；仅白名单 token）
function serveMedia(absPath, req, res) {
  stat(absPath)
    .then((st) => {
      const total = st.size;
      const range = req.headers.range;
      let start = 0;
      let end = total - 1;
      if (range) {
        // 🔴 review 修复：按 RFC 7233 解析——支持 suffix-range（bytes=-N 取末尾 N 字节）
        const suffix = /^bytes=-(\d+)$/.exec(range.trim());
        if (suffix) {
          const n = Number(suffix[1]);
          if (n > 0) {
            start = Math.max(0, total - n);
            end = total - 1;
          } else {
            // 2026-09-26：bytes=-0 非法（RFC 7233），此前落入 n>0 假分支返回 206 全量
            res.writeHead(416, { 'Content-Range': `bytes */${total}` });
            return res.end();
          }
        } else {
          const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
          if (m) {
            if (m[1]) start = Number(m[1]);
            if (m[2]) end = Number(m[2]);
          }
        }
      }
      if (start > end || start >= total) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        return res.end();
      }
      end = Math.min(end, total - 1);
      res.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Content-Length': String(end - start + 1),
      });
      createReadStream(absPath, { start, end }).on('error', () => { try { res.destroy(); } catch { /* noop */ } }).pipe(res);
    })
    .catch(() => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'media not found' }));
    })
    // 2026-09-26：最终兜底——404 分支内再抛（headers 已发）曾是 unhandledRejection（Node≥15 默认崩进程）
    .catch(() => { try { res.destroy(); } catch { /* noop */ } });
}

// 🔴 CSRF 防护（review 修复）：/bwm-friend/* 全端点校验同源。
// 恶意网页可用 text/plain body（CORS 简单请求无 preflight）跨源 POST 触发真实 agent
// 任务（RCE 级）/刷 API 配额/覆写配置。现代浏览器发 Sec-Fetch-Site；旧客户端发 Origin。
// P1-2：Host 信任判定——回环默认可信；扩展走 BWM_TRUSTED_HOSTS（含端口精确匹配，fail-closed）
function isTrustedHost(host) {
  const h = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0];
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '::ffff:127.0.0.1') return true;
  const trusted = String(process.env.BWM_TRUSTED_HOSTS || '').split(',').map((x) => x.trim()).filter(Boolean);
  return trusted.includes(host);
}
function isSameOriginRequest(req) {
  /* 威胁模型（2026-09-03 发布评审加固）：本插件暴露可写/可执行端点，防御目标是
     "浏览器载入的任何非本应用页面不得驱动写端点"。非浏览器客户端（curl 类，无
     Origin/Sec-Fetch 头）不构成 CSRF 面，放行。DNS rebinding 残余风险：恶意域
     解析到本机时 origin host === Host header，浏览器视为同源——设 BWM_TRUSTED_HOSTS
     （逗号分隔 host:port 白名单）钉死可服务的主机名后彻底关闭。 */
  const fetchSite = String(req.headers['sec-fetch-site'] || '');
  const dest = String(req.headers['sec-fetch-dest'] || '');
  const origin = String(req.headers.origin || '');
  const host = String(req.headers.host || '');
  const trusted = String(process.env.BWM_TRUSTED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (trusted.length && !trusted.includes(host)) return false;
  // 0) 顶层文档 GET 导航（地址栏/外链跳转/file:// 打开）：读安全，恒放行
  if (dest === 'document' && (req.method === 'GET' || req.method === 'HEAD')) return true;
  // 1) Origin 可解析时：origin/Host 不一致先拒（早于一切放行短路）
  if (origin && origin !== 'null' && !origin.startsWith('file://')) {
    try {
      if (new URL(origin).host !== host) return false;
    } catch { return false; }
  }
  // 2) 浏览器 Sec-Fetch 信号：cross-site 一票拒（必须在"无 Origin 放行"之前——
  //    此前 dest==='document' 无条件放行，顶层表单 text/plain 伪造 JSON 即可打到
  //    /work/task，评审定为 RCE 级 P0；首版重排误将 !origin 短路提前，红灯抓回）
  if (fetchSite === 'cross-site') return false;
  if (fetchSite === 'same-origin' || fetchSite === 'none' || fetchSite === 'same-site') {
    // P1-2（对抗评审）：Origin==Host 等值锚挡不住 DNS rebinding/别名域——rebind 后浏览器视为
    // 同源，Origin 与 Host 同为攻击域。浏览器路径的 Host 必须落在默认回环白名单或
    // BWM_TRUSTED_HOSTS 扩展内（LAN 访问需显式配置 env，属安全默认的取舍）。
    if (!isTrustedHost(host)) return false;
    return true;
  }
  // 3) 顶层文档写导航（表单 POST）与 file:///null-origin 页面请求：一律只读
  if (dest === 'document') return false;
  if (origin === 'null' || origin === 'file://' || origin.startsWith('file://')) return req.method === 'GET' || req.method === 'HEAD';
  // 4) 无 Origin 无 Sec-Fetch（curl/SDK 类非浏览器客户端）——不在 CSRF 威胁模型内
  if (!origin) return true;
  return false;
}

export function apply(ctx) {
  const webServer = ctx.webServer;
  if (!webServer || typeof webServer.register !== 'function') {
    return () => {}; // headless/TUI 无 webServer 时安全退出
  }

  const disposers = [];
  disposers.push(
    webServer.register({
      kind: 'prefix',
      path: '/bwm-friend',
      handler: async (req, res) => {
        const obsT0 = Date.now();
        res.on('finish', () => {
          try {
            const route = routeNameOf(req.method, new URL(req.url || '/', 'http://x').pathname);
            const ms = Date.now() - obsT0;
            recordRequest(route, res.statusCode, ms);
            audit('req', { route, status: res.statusCode, ms });
          } catch { /* 观测不破坏业务 */ }
        });
        if (!isSameOriginRequest(req)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'forbidden' }));
        }
        const pathname = new URL(req.url || '/', 'http://x').pathname;
        if (pathname === '/bwm-friend/settings' && req.method === 'GET') {
          return serveJson(res, await readConfig());
        }
        if (pathname === '/bwm-friend/settings' && req.method === 'PUT') {
          // 🔴 review 修复：JSON.parse 失败返回结构化 400（不再依赖框架 catch 转 400+告警）
          // 2026-09-26：改走 readJsonBody（Buffer 收集修 UTF-8 chunk 断裂 + 字节限额），消重
          let next;
          try { next = await readJsonBody(req, 1_000_000, { strictJson: true }); }
          catch (e) { return serveJson(res, { error: e.statusCode === 413 ? 'payload too large' : 'invalid json' }, e.statusCode || 400); }
          try {
            // 2026-09-03 发布加固（串行化 + schema 校验 + 白名单/version 保护）：
            // 深层合并子对象（schema v1：account/avatar/voice/llm/ui/power）——避免单字段保存覆盖其他字段
            const cfg = await withConfigLock(async () => {
              const base = await readConfig();
              const patch = {};
              // wireLedger：0.6.0 账本落盘通道（createLedgerStore 唯一持久路径）——必须放行，
              // 否则账本链路（persist→reload→Agent 可用）在生产形状下静默断裂（host 红灯实证）
              for (const key of ['version', 'account', 'avatar', 'voice', 'llm', 'ui', 'power', 'layout', 'wireLedger', 'factgate']) {
                if (next[key] !== undefined) patch[key] = next[key]; // 未知顶层 key 不落盘
              }
              patch.version = base.version; // version 服务端管辖（schema 版本，客户端不得覆写）
              // 顶层对象键类型守卫：字符串/数组/null 载荷直接 400（不静默破坏结构）
              for (const key of ['account', 'avatar', 'voice', 'llm', 'ui', 'power', 'layout', 'factgate']) {
                if (patch[key] !== undefined && (typeof patch[key] !== 'object' || patch[key] === null || Array.isArray(patch[key]))) {
                  return { __invalid: [`${key}: must be object`] };
                }
              }
              // wireLedger 形状守卫：仅接受数组（账本事件序列）；整体替换、不参与深层合并
              if (patch.wireLedger !== undefined && !Array.isArray(patch.wireLedger)) {
                return { __invalid: ['wireLedger: must be array'] };
              }
              const merged = { ...base, ...patch };
              for (const key of ['account', 'avatar', 'voice', 'llm', 'ui', 'power', 'layout', 'factgate']) {
                if (patch[key] && typeof patch[key] === 'object' && base[key] && typeof base[key] === 'object') {
                  merged[key] = { ...base[key], ...patch[key] };
                }
              }
              let v;
              if (settingsValidator) {
                v = settingsValidator(merged);
              } else {
                // 2026-09-26：校验器缺席降级显式化（原静默 {valid:true} 放行）
                obsMetrics.totals.settingsValidatorDegraded = (obsMetrics.totals.settingsValidatorDegraded || 0) + 1;
                audit('settings.validator_unavailable', {});
                v = { valid: true, errors: [] };
              }
              if (!v.valid) return { __invalid: v.errors };
              await writeConfig(merged);
              obsMetrics.totals.configWrites += 1;
              audit('config.write', {});
              return merged;
            });
            if (cfg && cfg.__invalid) {
              obsMetrics.totals.configRejected += 1;
              audit('config.write_rejected', { errors: cfg.__invalid });
              return serveJson(res, { error: 'invalid settings', details: cfg.__invalid }, 400);
            }
            return serveJson(res, cfg);
          } catch { return serveJson(res, { error: 'write failed' }, 500); }
        }
        if (pathname === '/bwm-friend/inventory') {
          return serveJson(res, { items: await buildInventoryCached() });
        }
        if (pathname === '/bwm-friend/status') {
          const cfg = await readConfig();
          return serveJson(res, {
            version: cfg.version,
            mode: cfg.ui && cfg.ui.mode ? cfg.ui.mode : cfg.mode, // 阶段二：ui.mode（兼容旧 cfg.mode）
            // 2026-09-26：avatar 手改 null 时（HTTP 路径被类型守卫挡住，仅手改文件触发）不再 TypeError
            theme: (cfg.avatar && cfg.avatar.theme) || '',
            bwmOnline: await probeBwm(),
          });
        }
        const mediaMatch = /^\/bwm-friend\/media\/([A-Za-z0-9_-]+)$/.exec(pathname);
        if (mediaMatch && req.method === 'GET') {
          const abs = mediaMap.get(mediaMatch[1]);
          if (abs) return serveMedia(abs, req, res);
          return serveJson(res, { error: 'unknown token' }, 404);
        }
        if (pathname === '/bwm-friend/_diag' && req.method === 'POST') {
          // 桌面壳渲染进程诊断上报（定位包含块/选择器适配）——只落日志，不参与业务
          const body = await readJsonBody(req, 64 * 1024).catch(() => null);
          if (body) audit('desktop.diag', body);
          return serveJson(res, { ok: !!body });
        }
        if (pathname === '/bwm-friend/health') {
          // 2026-09-03 完成度地图：health 深度化（版本/uptime/组件状态；轻量——清单用缓存值）
          const items = inventoryCache && !inventoryDirty ? inventoryCache : null;
          return serveJson(res, {
            ok: true,
            version: PLUGIN_VERSION,
            uptimeSec: Math.round((Date.now() - obsMetrics.startedAt) / 1000),
            components: {
              assets: { roots: ASSET_ROOTS.length, itemCount: items ? items.length : null, themes: items ? new Set(items.map((i) => i.theme)).size : null },
              skins: SKIN_ROOTS.size,
              voice: { configured: !!process.env.XIAOMI_MIMO_API_KEY },
              auth: { mode: AUTH_BASE ? 'hub' : 'dev' },
              config: { exists: existsSync(CONFIG_PATH) },
              // 2026-09-26：校验器降级状态显式暴露（观测点）
              settings: { validator: !!settingsValidator },
            },
          });
        }
        if (pathname === '/bwm-friend/metrics' && req.method === 'GET') {
          // 2026-09-03 完成度地图：指标端点（路由计数/错误/延迟分位 + 业务总量）
          const routes = {};
          for (const [k, v] of Object.entries(obsMetrics.routes)) {
            routes[k] = { count: v.count, errors: v.errors, p50Ms: obsPercentile(v.latencies, 50), p95Ms: obsPercentile(v.latencies, 95) };
          }
          return serveJson(res, {
            version: PLUGIN_VERSION,
            uptimeSec: Math.round((Date.now() - obsMetrics.startedAt) / 1000),
            rssBytes: process.memoryUsage().rss,
            totals: obsMetrics.totals,
            requests: routes,
          });
        }
        if (pathname === '/bwm-friend/update/check' && req.method === 'GET') {
          return serveJson(res, await runUpdateCheck());
        }
        if (pathname === '/bwm-friend/cloud/templates' && req.method === 'GET') {
          return serveJson(res, await cloudTemplates());
        }
        if (pathname === '/bwm-friend/auth/status' && req.method === 'GET') {
          // 2026-09-03 发布加固：掩码回显（原始手机号此前可被任意同源脚本读取）
          audit('auth.status', { loggedIn: authSession.isLoggedIn() });
          return serveJson(res, { loggedIn: authSession.isLoggedIn(), subject: maskSubject(authSession.subject()) });
        }
        if (pathname === '/bwm-friend/auth/login' && req.method === 'POST') {
          // P2-5：失败限速（60s 窗口 5 次 → 429）——防本机脚本借插件固定出口爆破 Hub
          const { phone, password } = await readJsonBody(req);
          const nowLogin = Date.now();
          if (nowLogin - loginFailWindow > 60_000) { loginAttempts.clear(); loginFailWindow = nowLogin; }
          const key = String(phone || '');
          // 按尝试计数（2026-09-26 评审后裁决维持原契约：dev 模式任意凭据皆成功，改按失败计数
          // 会使限速在 dev 下永不可触发也无法测试；60s 窗口自愈，正常用户连续 6 次登录的
          // 误杀属可接受取舍——威胁模型 P2-5 原始裁决）
          const attempts = (loginAttempts.get(key) || 0) + 1;
          loginAttempts.set(key, attempts);
          if (attempts > 5) { req.resume(); return serveJson(res, { error: 'too many attempts' }, 429); }
          const loginRes = await authLoginLocal({ phone, password });
          audit('auth.login', { ok: !!loginRes.ok, mode: AUTH_BASE ? 'hub' : 'dev', subject: loginRes.subject ? maskSubject(loginRes.subject) : undefined });
          return serveJson(res, loginRes);
        }
        if (pathname === '/bwm-friend/auth/logout' && req.method === 'POST') {
          authSession.logout();
          return serveJson(res, { ok: true });
        }
        if (pathname === '/bwm-friend/companion/chat' && req.method === 'POST') {
          obsMetrics.totals.chats += 1;
          // 2026-09-26 发布硬化：chat 并发守卫（对齐 transcribe/task）——此前唯一无守卫重端点，
          // 与上游 LLM 60s 超时叠加可堆积大量在途请求
          if (chatInFlight >= 4) { req.resume(); return serveJson(res, { error: 'busy' }, 429); }
          chatInFlight += 1;
          try {
            let chatReq;
            try { chatReq = await readJsonBody(req, 1_000_000); } catch (e) {
              return serveJson(res, { error: 'payload too large' }, e.statusCode || 400);
            }
            const chatRes = await companionChat(chatReq);
            audit('chat', { ok: !chatRes.error });
            return serveJson(res, chatRes);
          } finally { chatInFlight -= 1; }
        }
        if (pathname === '/bwm-friend/transcribe' && req.method === 'POST') {
          // 音频 base64 合法超 1MB（长语音）→ 上限放宽到 25MB（MiMo ASR 服务上限内）
          // 2026-09-03 发布加固：并发守卫（25MB 字符串累积 × 无限并发 = 内存 DoS——评审 P1）
          if (transcribeInFlight >= 2) { req.resume(); return serveJson(res, { error: 'busy' }, 429); }
          transcribeInFlight += 1;
          try {
            const { audioBase64, format } = await readJsonBody(req, 25_000_000);
            const trRes = await mimoTranscribe(audioBase64, { format });
            obsMetrics.totals.transcribes += 1;
            audit('transcribe', { bytes: String(audioBase64 || '').length });
            return serveJson(res, trRes);
          } finally { transcribeInFlight -= 1; }
        }
        if (pathname === '/bwm-friend/tts' && req.method === 'POST') {
          const { text, voice } = await readJsonBody(req);
          return serveJson(res, await mimoTTS(text, { voice }));
        }
        if (pathname === '/bwm-friend/work/task' && req.method === 'POST') {
          // 2026-09-26：并发守卫前置（对齐 transcribe：先限流再读体，429 排空流防 keep-alive 断裂）
          if (taskInFlight >= 2) { req.resume(); return serveJson(res, { error: 'busy' }, 429); }
          const parsed = await readJsonBody(req); // 发布加固：走 readJsonBody（1MB 上限；解析失败返 {}，与原行为一致）
          const msg = String(parsed.message || '').trim();
          if (!msg) return serveJson(res, { reply: '有什么任务？', process: [] });
          taskInFlight += 1;
          try {
            obsMetrics.totals.tasks += 1;
            audit('task.start', {});
            if (TASK_MIN_MS > 0) await new Promise((r) => setTimeout(r, TASK_MIN_MS));
            const taskRes = await runRealAgentTask(ctx, msg);
            audit(taskRes.error ? (/task-timeout/.test(taskRes.error) ? 'task.timeout' : 'task.error') : 'task.done', {});
            if (taskRes.error && /task-timeout/.test(taskRes.error)) obsMetrics.totals.taskTimeouts += 1;
            // P3 事件协议（BWM-EVENTS-1.0）：任务终态上报驾驶舱 Timeline——fire-and-forget，
            // 失败静默（驾驶舱离线绝不阻断任务路径）；目标地址从本请求 Host 推导（同进程同源）
            {
              const outcome = taskRes.error
                ? (/task-timeout/.test(taskRes.error) ? 'task.timeout' : 'task.failed')
                : 'task.completed';
              const host = req.headers.host || '127.0.0.1';
              const ev = {
                protocol_version: '1.0',
                agent: 'dsh-work',
                action: outcome,
                impact: taskRes.error ? undefined : { skill: 1 },
                payload: { summary: String(msg).slice(0, 120), sessionId: taskRes.sessionId || '', error: taskRes.error || undefined },
              };
              fetch(`http://${host}/bwm-dashboard/api/events`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(ev),
                signal: AbortSignal.timeout(3000),
              }).catch(() => { /* 显式静默：事件通道不阻断任务 */ });
            }
            return serveJson(res, taskRes);
          } finally { taskInFlight -= 1; }
        }
        if (pathname === '/bwm-friend/work/workspaces' && req.method === 'GET') {
          return serveJson(res, await listWorkspaces(ctx));
        }
        if (pathname.startsWith('/bwm-friend/companion') || pathname.startsWith('/bwm-friend/work')) {
          return serveCompanion(pathname, res);
        }
        return serveJson(res, { error: 'not found' }, 404);
      },
    }),
  );

  disposers.push(() => {
    // 2026-09-03 发布加固：inventory watcher 随 dispose 回收（此前热重载累积泄漏）
    for (const w of inventoryWatchers) { try { w.close(); } catch { /* noop */ } }
    inventoryWatchers.length = 0;
  });
  return () => {
    for (const d of disposers) d();
  };
}
