// dsh-plugin-bwm-friend — host 半（P1/M1：资产描述符 + 媒体路由 + 配置持久化）
// 职责：同源 HTTP 路由（资产 inventory / 媒体流 Range / 配置读写 / bwm 服务探测）
// 纯 ESM，无需构建（lib/index.js 即源码）。
import { readFile, writeFile, mkdir, readdir, stat, rename } from 'node:fs/promises';
import { readFileSync, readdirSync, statSync, createReadStream, watch } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
  avatar: { theme: '甜心女孩', idle: null, persona: '', driver: 'video' },
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
// P0 配置化（2026-08-24）：环境变量优先（逗号分隔多个），默认本地开发路径——跨机器/生产可覆盖
// 皮肤包自动发现（2026-08-24）：node_modules/@laikaton/bwm-skin-*/assets —— 换皮肤=换资产包
const envAssetRoots = String(process.env.BWM_ASSET_ROOTS || '').split(',').map((s) => s.trim()).filter(Boolean);
const LOCAL_ASSET_ROOTS = [
  '/Users/zengtian/projects/bwm-electron/app_runtime/heygem-data/input',
  '/Users/zengtian/projects/AI-Girlfriend-OneClick-2026.07.31/app/heygem-data/input',
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
// bwm friend 聊天页前端资源（陪伴模式 = 这个页面，外观与原版一致）
const BWM_STATIC = process.env.BWM_STATIC || '/Users/zengtian/projects/bwm-electron/app_runtime/ui/static';
// 任务工作目录（runRealAgentTask 的 cwd）
const DSH_WORK_DIR = process.env.DSH_WORK_DIR || '/Users/zengtian/projects';
// media token 已改用随机 UUID（review：base64url 可逆解码泄漏本地路径）

// token → 绝对路径白名单（仅 inventory 扫描过的路径可被 /media 访问，不暴露任意文件系统）
const mediaMap = new Map();

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
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2));
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
async function buildInventory() {
  const items = [];
  const seen = new Set();
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
        if (seen.has(abs)) continue;
        seen.add(abs);
        const type = /^idle-/.test(f) ? 'idle' : /^heygem-/.test(f) ? 'talk' : 'other';
        const theme = entry.isDirectory() ? entry.name : '(root)';
        const base = f.replace(/\.mp4$/i, '');
        // 🔴 review 修复：token 用随机 UUID（原来 base64url 可逆解码泄漏本地绝对路径）
        const token = randomUUID().replace(/-/g, '');
        mediaMap.set(token, abs);
        const st = await stat(abs).catch(() => null);
        items.push({
          id: `${type}-${base.replace(/[^a-zA-Z0-9_-]/g, '-')}`,
          type,
          theme,
          name: f,
          source: SKIN_ROOTS.has(root) ? 'skin' : 'local', // 皮肤包=产品默认；本地=开发/自定义
          url: `/bwm-friend/media/${token}`,
          resolution: null, // P1 占位：ffprobe 后填 "1280x704"
          checksum: st ? `${st.size}_${st.mtimeMs}` : null, // P1 占位：文件指纹，可升级 sha256
        });
      }
    }
  }
  return items;
}

// Runtime v1.1：inventory 生命周期缓存（启动扫描一次 + fs.watch 失效）——替代每次 GET 全量扫描（S6）
let inventoryCache = null;
let inventoryDirty = true;
const inventoryWatchers = [];
async function buildInventoryCached() {
  if (inventoryCache && !inventoryDirty) return inventoryCache;
  inventoryCache = await buildInventory();
  inventoryDirty = false;
  return inventoryCache;
}
function invalidateInventory() {
  inventoryDirty = true; // 下次请求重建（避免 watch 高频触发重建风暴）
}
// 启动扫描一次（preload——server 启动即构建，首次请求零等待）
buildInventoryCached().catch(() => {});
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
const PLUGIN_VERSION = '0.3.2'; // 与 package.json 同步（发布时手动对齐）

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

export const authSession = {
  _subject: null,
  _token: null,
  login(subject, token) { this._subject = subject; this._token = token; },
  logout() { this._subject = null; this._token = null; },
  isLoggedIn() { return Boolean(this._subject); },
  subject() { return this._subject; },
};

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
      return { ok: true, subject, token };
    }
    const msg = (data && data.message) || (data && data.detail && data.detail.message) || `http-${res.status}`;
    return { ok: false, error: msg };
  } catch (e) {
    return { ok: false, error: e && e.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}
for (const root of ASSET_ROOTS) {
  try {
    inventoryWatchers.push(watch(root, { persistent: false }, () => invalidateInventory()));
  } catch { /* 忽略不可 watch 的根 */ }
}

// P2-Persona：人格单一来源 = @laikaton/bwm-protocol/persona.js（公开数据，权威源）
// 发布后经包名解析；开发同仓经相对路径 fallback。runtime-core 内联同份（Identity Runtime）。
let IDENTITY_PRESET = null;
let PERSONALITY_PRESET = null;
try {
  const persona = await import('@laikaton/bwm-protocol/persona');
  ({ IDENTITY_PRESET, PERSONALITY_PRESET } = persona);
} catch {
  const persona = await import('../packages/bwm-protocol/schema/persona.js'); // 开发同仓
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
let protocolMemoryMod = null;
try { protocolMemoryMod = await import('@laikaton/bwm-protocol/memory'); }
catch { protocolMemoryMod = await import('../packages/bwm-protocol/schema/memory.js'); }
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
  memoryQueue = memoryQueue.then(async () => {
    const mem = await loadMemory();
    const next = mergeMemory(mem, message);
    await saveMemory(next);
  });
  return memoryQueue;
}
async function memoryPrompt() {
  const mem = await loadMemory();
  const facts = Array.isArray(mem.userFacts) ? mem.userFacts : [];
  const topics = Array.isArray(mem.recentTopics) ? mem.recentTopics : [];
  if (facts.length === 0 && topics.length === 0) return '';
  const f = facts.length > 0 ? `关于用户记得：${facts.join('；')}。` : '';
  const r = topics.length > 0 ? `最近聊过：${topics.slice(0, 3).join(' | ')}。` : '';
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
  try {
    const agents = ctx.get('agents');
    const defaultModel = ctx.get('agentDefaultModel');
    const sessions = ctx.get('sessions');
    if (!agents || !defaultModel || !sessions) return { error: 'agent services unavailable 1' };
    const dshSession = await import('@deepseek-ai/dsh-session');
    const dshLlm = await import('@deepseek-ai/dsh-llm');
    const dshAgent = await import('@deepseek-ai/dsh-agent');
    const selection = defaultModel.currentSelection();
    const { agent } = await agents.create({
      sessionId: dshSession.SessionId('session-' + randomUUID()),
      meta: { cwd: DSH_WORK_DIR },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => { dshAgent.installModelSelection(agentCtx, { current: selection, assembled: undefined }); },
    });
    await agent.whenIdle();
    const firstSeq = agent.session.seq;
    agent.followup(dshLlm.createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } }));
    await agent.whenIdle();
    await sessions.flush(agent.session);
    // 收集 turn/step/tool 过程 → 任务过程 JSON
    const process = [];
    let text = '', started = false;
    for (const ev of agent.session.events) {
      if (typeof ev.seq === 'number' && ev.seq < firstSeq) continue;
      if (ev.type === 'turn/start') { started = true; process.push({ type: 'turn/start' }); continue; }
      if (!started) continue;
      if (ev.type === 'assistant/message') {
        const joined = ((ev.data.message.content || []).filter(b => b.type === 'text').map(b => b.text).join(''));
        if (joined) { text = stripDSML(joined); process.push({ type: 'assistant', text: stripDSML(joined) }); }
      } else if (ev.type === 'tool/call') {
        process.push({ type: 'tool/call', tool: ev.data.toolName || ev.data.tool, args: ev.data.args });
      } else if (ev.type === 'tool/result') {
        process.push({ type: 'tool/result', tool: ev.data.toolName || ev.data.tool, ok: ev.data.ok });
      } else if (ev.type === 'step/start' || ev.type === 'step/end') {
        process.push({ type: ev.type });
      } else if (ev.type === 'turn/end') {
        process.push({ type: 'turn/end', reason: ev.data.reason });
      }
    }
    return { text, process: process.slice(0, 200), sessionId: String(agent.session.id || '') };
  } catch (e) {
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

// 干活聊天：POST {message, history} → DeepSeek(工作) → {reply}
async function workChat(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  let parsed = {};
  try { parsed = JSON.parse(body || '{}'); } catch {}
  const message = String(parsed.message || '').trim();
  const history = Array.isArray(parsed.history) ? parsed.history.slice(-10) : [];
  const key = readDeepseekKey();
  if (!key) return { reply: '（未配置 DEEPSEEK_API_KEY，无法干活）' };
  if (!message) return { reply: '有什么任务交给我？' };
  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'system', content: WORK_PERSONA }, ...history, { role: 'user', content: message }], max_tokens: 600 }),
    });
    const data = await res.json();
    const reply = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '(任务执行中断，请重试)';
    return { reply };
  } catch { return { reply: '（连接不上，稍后再试）' }; }
}

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

async function companionChat(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  let parsed = {};
  try { parsed = JSON.parse(body || '{}'); } catch {}
  const message = String(parsed.message || '').trim();
  const history = Array.isArray(parsed.history) ? parsed.history.slice(-10) : [];
  const isProactive = !message && parsed.proactive && PROACTIVE_CONTEXT[parsed.proactive.reason];
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
  // P2-Memory：记住用户说的（偏好/自称/关键陈述）——不阻断聊天（主动行为不记忆——无用户输入）
  if (!isProactive) await rememberUserMessage(message);
  // P2-Persona + Memory：system prompt = 人格（单一来源）+ 记忆注入
  // P0：config.avatar.persona（设置页可编辑）作为人格覆盖注入
  const cfgNow = await readConfig();
  const personaOverride = cfgNow && cfgNow.avatar && typeof cfgNow.avatar.persona === 'string' ? cfgNow.avatar.persona : '';
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
  const prompt = isProactive ? PROACTIVE_CONTEXT[parsed.proactive.reason] : message;
  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: prompt }],
        max_tokens: 200,
      }),
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
const MIMO_API_URL = 'https://api.xiaomimimo.com/v1/chat/completions';
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

async function readJsonBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  try { return JSON.parse(body || '{}'); } catch { return {}; }
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
  '  // 设置抽屉默认完全推出屏幕外（bwm 原右缘露一截 → 修掉残影）',
  '  const sp = document.querySelector("[class*=settings-panel]");',
  '  if (sp && !sp.classList.contains("open")) sp.style.transform = "translateX(calc(100% + 24px))";',
  '})();',
].join('\n');

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
        btn.innerHTML = '<b>' + skins[k] + '</b><small>皮肤包</small>';
        btn.addEventListener('click', (function (theme) {
          return function () {
            fetch('/bwm-friend/settings', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ avatar: { theme: theme } }),
            }).then(function () {
              // 同步高亮预设模板区（同一主题）
              Array.prototype.forEach.call(document.querySelectorAll('#templateGrid .template-card'), function (b) {
                b.classList.toggle('active', b.getAttribute('data-template') === theme);
              });
              var v = document.getElementById('avatarVideo');
              if (v) {
                for (var j = 0; j < items.length; j++) {
                  if (items[j].type === 'idle' && items[j].theme === theme && items[j].source === 'skin') {
                    v.src = items[j].url; v.load(); v.play().catch(function () {});
                    break;
                  }
                }
              }
            });
          };
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
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'template-card custom-tpl-card';
            btn.innerHTML = '<b>' + name + '</b><small>云端</small>';
            btn.addEventListener('click', function () {
              alert('云端模板在手机端生成并同步；插件端当前展示列表（模板文件应用开发中）');
            });
            grid.appendChild(btn);
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
  (function wirePersona() {
    var pInput = document.getElementById('personaInput');
    var pSave = document.getElementById('personaSaveBtn');
    var pName = document.getElementById('personaTemplateName');
    if (!pInput || !pSave) return;
    fetch('/bwm-friend/settings').then(function (r) { return r.json(); }).then(function (cfg) {
      var theme = cfg && cfg.avatar && cfg.avatar.theme || '';
      var persona = cfg && cfg.avatar && typeof cfg.avatar.persona === 'string' ? cfg.avatar.persona : '';
      pInput.value = persona;
      if (pName) pName.textContent = theme ? ('当前模板：' + theme) : '当前模板';
    }).catch(function () {});
    pSave.addEventListener('click', function () {
      pSave.disabled = true;
      var text = pInput.value.trim();
      fetch('/bwm-friend/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatar: { persona: text } }),
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

  // P2.5-UI：引擎设置（BWM 风格 · 1:1 复刻 DSH 原版设置：通用/模型/插件/Agent 预设）
  (function wireEngineSettings() {
    var panel = document.getElementById('settingsPanel');
    if (!panel) return;
    // 快捷入口：面板头部加「引擎设置」跳转链接
    var head = panel.querySelector('.settings-head');
    if (head) {
      var quick = document.createElement('button');
      quick.type = 'button';
      quick.className = 'engine-quick';
      quick.textContent = '⚙ 引擎设置';
      quick.addEventListener('click', function () {
        var eng = panel.querySelector('.engine-setting');
        if (eng) eng.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      head.appendChild(quick);
    }
    var block = document.createElement('div');
    block.className = 'setting-block engine-setting';
    block.innerHTML = [
      '<div class="setting-title"><span>引擎设置</span><small>通用 · 模型 · 插件 · 预设</small></div>',
      '<div class="engine-tabs">',
      '  <button type="button" class="engine-tab active" data-etab="general">通用设置</button>',
      '  <button type="button" class="engine-tab" data-etab="model">模型</button>',
      '  <button type="button" class="engine-tab" data-etab="plugin">插件</button>',
      '  <button type="button" class="engine-tab" data-etab="preset">Agent 预设</button>',
      '</div>',
      '<div class="engine-pane" data-epane="general">',
      '  <label class="engine-row"><span>Agent 预设<small>对此后新建的会话生效；运行中的会话保持它开始时的预设</small></span><input type="checkbox" class="engine-switch" id="engAgentPreset" checked /></label>',
      '  <label class="engine-row"><span>权限模式<small>新会话的默认权限模式</small></span><select class="engine-select" id="engPermission"><option>Workspace Write</option><option>Workspace Read</option><option>Full Access</option></select></label>',
      '  <label class="engine-row"><span>语言</span><select class="engine-select" id="engLang"><option>中文</option><option>English</option></select></label>',
      '  <div class="engine-row"><span>外观<small>界面主题</small></span><div class="engine-seg" id="engThemeSeg"><button type="button" data-v="light">浅色</button><button type="button" data-v="dark" class="active">深色</button><button type="button" data-v="system">跟随系统</button></div></div>',
      '  <label class="engine-row"><span>繁忙时 Enter 键行为<small>仅在智能体运行时生效；Cmd/Ctrl+Enter 使用另一行为</small></span><select class="engine-select" id="engEnterBehavior"><option>排队发送</option><option>立即发送</option></select></label>',
      '</div>',
      '<div class="engine-pane" data-epane="model" style="display:none">',
      '  <div class="engine-hint">填入各提供方的 API 密钥即可使用其模型。</div>',
      '  <div class="engine-provider"><div class="engine-provider-head"><b>DeepSeek</b><button type="button" class="engine-btn" id="engEditDeepseek">编辑</button></div><small id="engDeepseekStatus">加载中…</small></div>',
      '  <div class="engine-actions"><button type="button" class="engine-btn" id="engAddProvider">＋ 添加提供方</button><button type="button" class="engine-btn" id="engAddCustom">＋ 添加自定义提供方</button></div>',
      '</div>',
      '<div class="engine-pane" data-epane="plugin" style="display:none">',
      '  <div class="engine-hint">配置和查看本部署已安装的插件。</div>',
      '  <div class="engine-plugin-list">',
      '    <div class="engine-plugin"><b>终端</b><small>限制 agent 运行的每一条命令</small><span class="engine-badge">已启用</span></div>',
      '    <div class="engine-plugin"><b>Agent 循环</b><small>Agent 如何派发工具调用</small><span class="engine-badge">已启用</span></div>',
      '    <div class="engine-plugin"><b>网页搜索</b><small>DeepSeek 搜索提供方</small><span class="engine-badge">已启用</span></div>',
      '  </div>',
      '</div>',
      '<div class="engine-pane" data-epane="preset" style="display:none">',
      '  <div class="engine-hint">预设即一个会话的 Agent 所运行的插件组装 —— 它的工具、提示词与能力。</div>',
      '  <div class="engine-preset-list">',
      '    <div class="engine-preset"><b>标准模式</b><small>完整编码 Agent：文件编辑、Shell、检索、Skills、计划、子代理、工作流</small><span class="engine-badge">内置 · 当前</span></div>',
      '    <div class="engine-preset"><b>standardPTC</b><small>标准模式全部能力 + Code Mode SDK 组合多步操作</small><span class="engine-badge">内置</span></div>',
      '    <div class="engine-preset"><b>极简模式</b><small>仅持久 bash + str_replace_editor 双工具编码 Agent</small><span class="engine-badge">内置</span></div>',
      '    <div class="engine-preset"><b>创造模式</b><small>创建自定义 Agent preset：运行时检查、插件实验、创作指导</small><span class="engine-badge">内置</span></div>',
      '  </div>',
      '  <button type="button" class="engine-btn" id="engCreatePreset">＋ 用「创造模式」创作自定义预设</button>',
      '</div>'
    ].join('');
    panel.appendChild(block);

    // Tab 切换
    var tabs = block.querySelectorAll('.engine-tab');
    var panes = block.querySelectorAll('.engine-pane');
    for (var ti = 0; ti < tabs.length; ti++) {
      (function (tab) {
        tab.addEventListener('click', function () {
          for (var x = 0; x < tabs.length; x++) tabs[x].classList.remove('active');
          for (var y = 0; y < panes.length; y++) panes[y].style.display = 'none';
          tab.classList.add('active');
          var pane = block.querySelector('[data-epane="' + tab.getAttribute('data-etab') + '"]');
          if (pane) pane.style.display = 'block';
        });
      })(tabs[ti]);
    }
    // 外观分段
    var seg = document.getElementById('engThemeSeg');
    if (seg) {
      var segBtns = seg.querySelectorAll('button');
      for (var si = 0; si < segBtns.length; si++) {
        (function (b) {
          b.addEventListener('click', function () {
            for (var x = 0; x < segBtns.length; x++) segBtns[x].classList.remove('active');
            b.classList.add('active');
          });
        })(segBtns[si]);
      }
    }
    // 读取引擎设置
    fetch('/bwm-friend/settings').then(function (r) { return r.json(); }).then(function (cfg) {
      var llm = (cfg && cfg.llm) || {};
      var st = document.getElementById('engDeepseekStatus');
      if (st) st.textContent = llm.model ? ('已配置（' + llm.model + '）') : '未配置';
      var ap = document.getElementById('engAgentPreset');
      if (ap) ap.checked = !(cfg && cfg.agent && cfg.agent.preset === false);
    }).catch(function () {});
    var ed = document.getElementById('engEditDeepseek');
    if (ed) ed.addEventListener('click', function () { alert('DeepSeek 提供方已由系统配置。可在服务器端 .env 修改 DEEPSEEK_API_KEY 后重启生效。'); });
  })();

  // P2.5-UI：居中模态引擎设置（参照原生 DSH 布局：左 nav + 右内容，UI 换 BWM 皮）
  // 拦截 iframe 内「设置」按钮 → 屏幕正中弹模态框
  (function wireEngineModal() {
    var MODAL_CSS = [
      '.bwm-engine-modal{position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;background:rgba(8,13,22,.6);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);}',
      '.bwm-engine-modal .em-box{width:min(720px,92vw);max-height:82vh;background:#0a101a;border:1px solid rgba(123,242,210,.28);border-radius:18px;box-shadow:0 20px 70px rgba(0,0,0,.6),0 0 40px rgba(123,242,210,.08);display:flex;flex-direction:column;overflow:hidden;animation:emIn .28s cubic-bezier(.22,1,.36,1);}',
      '@keyframes emIn{from{opacity:0;transform:scale(.96) translateY(12px)}to{opacity:1;transform:scale(1) translateY(0)}}',
      '.bwm-engine-modal .em-head{display:flex;align-items:center;justify-content:space-between;padding:16px 22px;border-bottom:1px solid rgba(255,255,255,.08);}',
      '.bwm-engine-modal .em-head b{font-size:15px;color:#e8f4ec;letter-spacing:.05em;}',
      '.bwm-engine-modal .em-head small{color:#8fa3b8;font-size:11px;margin-left:8px;}',
      '.bwm-engine-modal .em-close{width:30px;height:30px;border-radius:50%;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#c9d6e2;font-size:16px;cursor:pointer;line-height:1;transition:all .2s;}',
      '.bwm-engine-modal .em-close:hover{background:rgba(255,107,107,.2);border-color:rgba(255,107,107,.5);color:#ff8a8a;}',
      '.bwm-engine-modal .em-body{display:flex;min-height:0;flex:1;}',
      '.bwm-engine-modal .em-nav{width:150px;flex-shrink:0;border-right:1px solid rgba(255,255,255,.07);padding:14px 10px;display:flex;flex-direction:column;gap:4px;overflow-y:auto;}',
      '.bwm-engine-modal .em-nav button{padding:10px 14px;border-radius:10px;border:0;background:transparent;color:#9fb3c7;font-size:13px;text-align:left;cursor:pointer;transition:all .18s;letter-spacing:.02em;}',
      '.bwm-engine-modal .em-nav button:hover{background:rgba(123,242,210,.08);color:#d8efe6;}',
      '.bwm-engine-modal .em-nav button.active{background:rgba(123,242,210,.14);color:#7bf2d2;box-shadow:inset 2px 0 0 #7bf2d2;}',
      '.bwm-engine-modal .em-content{flex:1;min-width:0;padding:18px 22px;overflow-y:auto;}',
      '.bwm-engine-modal .em-pane{display:none;}',
      '.bwm-engine-modal .em-pane.active{display:block;animation:emPane .2s ease;}',
      '@keyframes emPane{from{opacity:0;transform:translateX(8px)}to{opacity:1;transform:none}}',
      '.bwm-engine-modal .em-hint{font-size:12px;color:#8fa3b8;margin:4px 0 14px;line-height:1.6;}',
      '.bwm-engine-modal .em-row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:11px 0;border-bottom:1px solid rgba(255,255,255,.05);}',
      '.bwm-engine-modal .em-row>span{font-size:13px;color:#dfe9f2;display:flex;flex-direction:column;gap:3px;}',
      '.bwm-engine-modal .em-row small{font-size:11px;color:#8fa3b8;line-height:1.5;}',
      '.bwm-engine-modal .em-switch{width:38px;height:22px;accent-color:#7bf2d2;cursor:pointer;flex-shrink:0;}',
      '.bwm-engine-modal .em-select{background:#0a101a;color:#e8f4ec;border:1px solid rgba(123,242,210,.3);border-radius:8px;padding:6px 10px;font-size:12px;flex-shrink:0;}',
      '.bwm-engine-modal .em-seg{display:flex;gap:4px;flex-shrink:0;}',
      '.bwm-engine-modal .em-seg button{padding:5px 12px;border-radius:8px;border:1px solid rgba(255,255,255,.12);background:#0a101a;color:#9fb3c7;font-size:11px;cursor:pointer;transition:all .2s;}',
      '.bwm-engine-modal .em-seg button.active{background:rgba(123,242,210,.16);border-color:#7bf2d2;color:#b8ffe9;}',
      '.bwm-engine-modal .em-card{border:1px solid rgba(123,242,210,.22);border-radius:12px;padding:12px 14px;background:rgba(123,242,210,.04);margin-bottom:10px;}',
      '.bwm-engine-modal .em-card b{color:#e8f4ec;font-size:13px;display:block;margin-bottom:3px;}',
      '.bwm-engine-modal .em-card small{color:#8fa3b8;font-size:11px;line-height:1.5;display:block;}',
      '.bwm-engine-modal .em-card .em-badge{display:inline-block;margin-top:8px;font-size:10px;padding:3px 8px;border-radius:999px;background:rgba(123,242,210,.12);color:#7bf2d2;border:1px solid rgba(123,242,210,.3);}',
      '.bwm-engine-modal .em-btn{padding:7px 14px;border-radius:999px;border:1px solid rgba(123,242,210,.4);background:rgba(123,242,210,.08);color:#7bf2d2;font-size:12px;cursor:pointer;transition:all .2s;margin-top:6px;}',
      '.bwm-engine-modal .em-btn:hover{background:rgba(123,242,210,.16);}'
    ].join('\\n');

    function buildModal() {
      var modal = document.createElement('div');
      modal.className = 'bwm-engine-modal';
      modal.id = 'bwm-engine-modal';
      modal.innerHTML = [
        '<div class="em-box">',
        '  <div class="em-head"><div><b>设置</b><small>通用 · 模型 · 插件 · Agent 预设</small></div><button type="button" class="em-close" aria-label="关闭设置">✕</button></div>',
        '  <div class="em-body">',
        '    <nav class="em-nav">',
        '      <button type="button" data-ep="general" class="active">通用设置</button>',
        '      <button type="button" data-ep="model">模型</button>',
        '      <button type="button" data-ep="plugin">插件</button>',
        '      <button type="button" data-ep="preset">Agent 预设</button>',
        '    </nav>',
        '    <div class="em-content">',
        '      <section class="em-pane active" data-epane="general">',
        '        <div class="em-hint">通用配置：对此后新建的会话生效；运行中的会话保持它开始时的预设。</div>',
        '        <label class="em-row"><span>Agent 预设<small>新建会话默认启用预设</small></span><input type="checkbox" class="em-switch" id="emAgentPreset" checked /></label>',
        '        <label class="em-row"><span>权限模式<small>新会话的默认权限模式</small></span><select class="em-select" id="emPermission"><option>Workspace Write</option><option>Workspace Read</option><option>Full Access</option></select></label>',
        '        <label class="em-row"><span>语言</span><select class="em-select" id="emLang"><option>中文</option><option>English</option></select></label>',
        '        <div class="em-row"><span>外观<small>界面主题</small></span><div class="em-seg" id="emThemeSeg"><button type="button" data-v="light">浅色</button><button type="button" data-v="dark" class="active">深色</button><button type="button" data-v="system">跟随系统</button></div></div>',
        '        <label class="em-row"><span>繁忙时 Enter 键行为<small>仅在智能体运行时生效；Cmd/Ctrl+Enter 使用另一行为</small></span><select class="em-select" id="emEnterBehavior"><option>排队发送</option><option>立即发送</option></select></label>',
        '      </section>',
        '      <section class="em-pane" data-epane="model">',
        '        <div class="em-hint">填入各提供方的 API 密钥即可使用其模型。</div>',
        '        <div class="em-card"><b>DeepSeek</b><small id="emDeepseekStatus">加载中…</small><span class="em-badge">已配置</span></div>',
        '        <button type="button" class="em-btn" id="emAddProvider">＋ 添加提供方</button>',
        '        <button type="button" class="em-btn" id="emAddCustom">＋ 添加自定义提供方</button>',
        '      </section>',
        '      <section class="em-pane" data-epane="plugin">',
        '        <div class="em-hint">配置和查看本部署已安装的插件。</div>',
        '        <div class="em-card"><b>终端</b><small>限制 agent 运行的每一条命令</small><span class="em-badge">已启用</span></div>',
        '        <div class="em-card"><b>Agent 循环</b><small>Agent 如何派发工具调用</small><span class="em-badge">已启用</span></div>',
        '        <div class="em-card"><b>网页搜索</b><small>DeepSeek 搜索提供方</small><span class="em-badge">已启用</span></div>',
        '      </section>',
        '      <section class="em-pane" data-epane="preset">',
        '        <div class="em-hint">预设即一个会话的 Agent 所运行的插件组装 —— 它的工具、提示词与能力。</div>',
        '        <div class="em-card"><b>标准模式</b><small>完整编码 Agent：文件编辑、Shell、检索、Skills、计划、子代理、工作流</small><span class="em-badge">内置 · 当前</span></div>',
        '        <div class="em-card"><b>standardPTC</b><small>标准模式全部能力 + Code Mode SDK 组合多步操作</small><span class="em-badge">内置</span></div>',
        '        <div class="em-card"><b>极简模式</b><small>仅持久 bash + str_replace_editor 双工具编码 Agent</small><span class="em-badge">内置</span></div>',
        '        <div class="em-card"><b>创造模式</b><small>创建自定义 Agent preset：运行时检查、插件实验、创作指导</small><span class="em-badge">内置</span></div>',
        '        <button type="button" class="em-btn" id="emCreatePreset">＋ 用「创造模式」创作自定义预设</button>',
        '      </section>',
        '    </div>',
        '  </div>',
        '</div>'
      ].join('');
      return modal;
    }

    var modal = null;
    function openEngineModal() {
      if (!modal) {
        modal = buildModal();
        document.body.appendChild(modal);
        // 样式注入
        var st = document.createElement('style');
        st.id = 'bwm-engine-modal-css';
        st.textContent = MODAL_CSS;
        document.head.appendChild(st);
        // 关闭
        modal.querySelector('.em-close').addEventListener('click', closeEngineModal);
        modal.addEventListener('click', function (e) { if (e.target === modal) closeEngineModal(); });
        // nav 切换
        var navBtns = modal.querySelectorAll('.em-nav button');
        var panes = modal.querySelectorAll('.em-pane');
        for (var i = 0; i < navBtns.length; i++) {
          (function (nb) {
            nb.addEventListener('click', function () {
              for (var x = 0; x < navBtns.length; x++) navBtns[x].classList.remove('active');
              for (var y = 0; y < panes.length; y++) panes[y].classList.remove('active');
              nb.classList.add('active');
              var pane = modal.querySelector('[data-epane="' + nb.getAttribute('data-ep') + '"]');
              if (pane) pane.classList.add('active');
            });
          })(navBtns[i]);
        }
        // 外观分段
        var seg = modal.querySelector('#emThemeSeg');
        if (seg) {
          var segBtns = seg.querySelectorAll('button');
          for (var si = 0; si < segBtns.length; si++) {
            (function (b) {
              b.addEventListener('click', function () {
                for (var x = 0; x < segBtns.length; x++) segBtns[x].classList.remove('active');
                b.classList.add('active');
              });
            })(segBtns[si]);
          }
        }
        // 读取设置
        fetch('/bwm-friend/settings').then(function (r) { return r.json(); }).then(function (cfg) {
          var llm = (cfg && cfg.llm) || {};
          var stEl = modal.querySelector('#emDeepseekStatus');
          if (stEl) stEl.textContent = llm.model ? ('已配置（' + llm.model + '）') : '未配置';
        }).catch(function () {});
        var ed = modal.querySelector('#emAddProvider');
        if (ed) ed.addEventListener('click', function () { alert('提供方管理：可在服务器端 .env 配置 API Key 后重启生效。'); });
      }
      modal.style.display = 'flex';
      // Esc 关闭
      document.addEventListener('keydown', function escHandler(e) {
        if (e.key === 'Escape') { closeEngineModal(); document.removeEventListener('keydown', escHandler); }
      });
    }
    function closeEngineModal() {
      if (modal) modal.style.display = 'none';
    }
    window.openEngineModal = openEngineModal;

    // 拦截 iframe 内「设置」按钮：iframe 内点击设置 → postMessage → 父页面打开居中模态
    function wireIframeSettings() {
      var f = document.getElementById('bwm-harness-frame');
      if (!f || !f.contentDocument) { setTimeout(wireIframeSettings, 1000); return; }
      try {
        var idoc = f.contentDocument;
        var btn = [...idoc.querySelectorAll('button')].find(b => b.getAttribute('aria-haspopup') === 'dialog' && b.textContent.indexOf('设置') > -1);
        if (btn) {
          btn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            window.openEngineModal();
          });
        } else {
          setTimeout(wireIframeSettings, 1500);
        }
      } catch (e) { setTimeout(wireIframeSettings, 1500); }
    }
    setTimeout(wireIframeSettings, 2000);
  })();

  // P2-UI：模板切换（app.js 移除后补回）——从 inventory 动态填充主题网格 + 点击热切（对齐桌面 App：免刷新）
  (function fillTemplates() {
    var grid = document.getElementById('templateGrid');
    if (!grid) return;
    fetch('/bwm-friend/inventory').then(function (r) { return r.json(); }).then(function (d) {
      var items = (d && d.items) || [];
      var themes = [];
      for (var i = 0; i < items.length; i++) {
        var t = items[i].theme;
        if (t && t !== '(root)' && themes.indexOf(t) === -1) themes.push(t);
      }
      // 补默认（根目录资产也算一个主题入口）
      if (themes.indexOf('默认') === -1) themes.unshift('默认');
      var status = document.getElementById('templateStatus');
      // 清空骨架按钮（原生"默认"占位），改为真实主题列表
      grid.innerHTML = '';
      var current = '';
      try { current = JSON.parse(localStorage.getItem('bwm-config') || '{}').avatar && JSON.parse(localStorage.getItem('bwm-config') || '{}').avatar.theme; } catch (e) {}
      for (var k = 0; k < themes.length; k++) {
        var label = themes[k];
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'template-card';
        btn.setAttribute('data-template', label);
        btn.innerHTML = '<b>' + label + '</b><small>' + (label === '默认' ? '根目录资产' : '数字人主题') + '</small>';
        if (label === current) btn.classList.add('active');
        btn.addEventListener('click', (function (theme) {
          return function () {
            // 1. 保存服务端 config（持久化）
            fetch('/bwm-friend/settings', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ avatar: { theme: theme } }),
            }).then(function () {
              // 2. 网格高亮（对齐桌面 App applyTemplateSwitch）
              Array.prototype.forEach.call(grid.querySelectorAll('.template-card'), function (b) {
                b.classList.toggle('active', b.getAttribute('data-template') === theme);
              });
              // 3. 热切视频（免刷新）：找该主题 idle → 换 src
              var idleItem = null;
              for (var i = 0; i < items.length; i++) {
                if (items[i].type === 'idle' && items[i].theme === theme) { idleItem = items[i]; break; }
              }
              if (!idleItem) {
                for (var j = 0; j < items.length; j++) {
                  if (items[j].type === 'idle' && items[j].theme === '(root)') { idleItem = items[j]; break; }
                }
              }
              var v = document.getElementById('avatarVideo');
              if (idleItem && v && idleItem.url) {
                v.src = idleItem.url;
                v.load();
                v.play().catch(function () {});
              }
            }).catch(function () { /* 保存失败保留现状 */ });
          };
        })(label));
        grid.appendChild(btn);
      }
      if (status) status.textContent = '点击切换数字人';
    }).catch(function () { /* inventory 不可用则保留骨架 */ });
  })();

  // P2-Voice：填充音色选择（app.js 被去掉后由本脚本填充 MiMo 8 音色）
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
    vs.value = '冰糖';
    var vst = document.getElementById('voiceStatus');
    if (vst) vst.textContent = '已加载 8 个音色';
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
  var popEl = null, maskEl = null;
  function ensurePop() {
    if (popEl) return;
    popEl = document.createElement('div');
    popEl.id = 'bwm-workspace-pop';
    popEl.style.cssText = 'position:fixed; right:0; top:0; height:100vh; width:min(320px,85vw); z-index:80; background:rgba(10,16,26,.55); backdrop-filter:blur(18px) saturate(.9); -webkit-backdrop-filter:blur(18px) saturate(.9); border-left:1px solid rgba(123,242,210,.25); box-shadow:-10px 0 30px rgba(0,0,0,.35); transform:translateX(100%); transition:transform .3s cubic-bezier(.22,1,.36,1);';
    var fi = document.createElement('iframe');
    fi.id = 'bwm-workspace-frame';
    fi.src = window.location.origin + '/?bwm=embedded&pop=1';
    fi.style.cssText = 'width:100%; height:100%; border:0; background:transparent;';
    // P2.5-UI：pop 弹窗只显示侧栏会话树（DSH 不认 pop 参数，加载后注入 CSS 隐藏主对话区）
    fi.addEventListener('load', function () {
      try {
        var idoc = fi.contentDocument;
        if (idoc && idoc.head) {
          var pst = idoc.createElement('style');
          pst.textContent = [
            '.RnFLRG_main{display:none!important;}',
            '.RnFLRG_sidebar{width:100%!important;max-width:100%!important;height:100%!important;}',
            '.RnFLRG_sidebar [class*="_regionArea"]{display:block!important;}',
            '.RnFLRG_sidebar [role="tree"]{max-height:calc(100vh - 190px)!important;overflow-y:auto!important;}',
            '.RnFLRG_logoRow{display:none!important;}'
          ].join('\\n');
          idoc.head.appendChild(pst);
        }
      } catch (e) { /* 静默 */ }
    });
    popEl.appendChild(fi);
    document.body.appendChild(popEl);
    maskEl = document.createElement('div');
    maskEl.id = 'bwm-workspace-mask';
    maskEl.style.cssText = 'position:fixed; inset:0; z-index:75; background:rgba(8,13,22,.35); opacity:0; transition:opacity .3s; pointer-events:none;';
    maskEl.addEventListener('click', closePop);
    document.body.appendChild(maskEl);
    // 弹窗 iframe 选择会话 → 转发主 iframe 切换 + 关闭弹窗
    window.addEventListener('message', function (e) {
      if (!e || e.origin !== window.location.origin) return; // P0 安全：仅接受同源消息
      if (e.data && e.data.type === 'bwm-pop-select') {
        var f = document.getElementById('bwm-harness-frame');
        if (f && f.contentWindow) f.contentWindow.postMessage({ type: 'bwm-switch-session', title: e.data.title }, window.location.origin);
        closePop();
      }
    });
  }
  function openPop() {
    ensurePop();
    popEl.style.transform = 'translateX(0)';
    maskEl.style.opacity = '1';
    maskEl.style.pointerEvents = 'auto';
  }
  function closePop() {
    if (!popEl) return;
    popEl.style.transform = 'translateX(100%)';
    maskEl.style.opacity = '0';
    maskEl.style.pointerEvents = 'none';
  }
  function toggleHarnessSidebar() {
    if (popEl && popEl.style.transform === 'translateX(0px)') closePop();
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
    var f = document.createElement('iframe');
    f.id = 'bwm-harness-frame';
    f.src = window.location.origin + '/?bwm=embedded';
    f.setAttribute('allow', 'clipboard-read; clipboard-write');
    // 2026-08-24：620→540 收窄后太小回退 620 → 600（用户指定）→ P2 与陪伴一致 742px 全宽
    f.style.cssText = 'flex:1 1 auto; min-height:0; width:742px; max-width:100%; border:0; background:transparent;';
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
    setTimeout(function () { if (ph.parentNode) ph.parentNode.removeChild(ph); }, 15000); // 兜底（load 事件异常时）
  }

  // 引擎设置：动态加载 companion-chat.js（含 wireEngineSettings 等共享逻辑）
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
          ? '<script src="work-init.js"></script><script src="work-chat.js"></script><script src="companion-init.js"></script></body>'
          : '<script src="companion-chat.js"></script><script src="companion-init.js"></script></body>');
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
    });
}

// 🔴 CSRF 防护（review 修复）：/bwm-friend/* 全端点校验同源。
// 恶意网页可用 text/plain body（CORS 简单请求无 preflight）跨源 POST 触发真实 agent
// 任务（RCE 级）/刷 API 配额/覆写配置。现代浏览器发 Sec-Fetch-Site；旧客户端发 Origin。
function isSameOriginRequest(req) {
  const fetchSite = String(req.headers['sec-fetch-site'] || '');
  const dest = String(req.headers['sec-fetch-dest'] || '');
  const origin = String(req.headers.origin || '');
  // file:// 页面打开本地 bwm-friend 属正常使用场景（file origin 无凭证注入风险），放行
  if (origin === 'null' || origin === 'file://' || origin.startsWith('file://')) return true;
  // 顶层文档导航（window.open/地址栏/链接跳转）——浏览器不发 Origin，仅 sec-fetch-site: cross-site；
  // 这是用户主动跳转，无跨站请求伪造风险（不会携带敏感请求体/凭证），放行
  if (dest === 'document') return true;
  if (fetchSite === 'cross-site') return false;
  if (fetchSite === 'same-origin' || fetchSite === 'none' || fetchSite === 'same-site') return true;
  if (!origin) return true; // 无 Origin（curl/同源导航）——宽松放行
  try {
    const o = new URL(origin);
    return o.host === req.headers.host; // 同 host 视为同源
  } catch { return false; }
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
          let body = '';
          for await (const chunk of req) body += chunk;
          let next = {};
          try { next = JSON.parse(body || '{}'); } catch { return serveJson(res, { error: 'invalid json' }, 400); }
          try {
            // 深层合并子对象（schema v1：account/avatar/voice/llm/ui/power）——避免单字段保存覆盖其他字段
            const base = await readConfig();
            const cfg = { ...base, ...next };
            for (const key of ['account', 'avatar', 'voice', 'llm', 'ui', 'power', 'layout']) {
              if (next[key] && typeof next[key] === 'object' && base[key] && typeof base[key] === 'object') {
                cfg[key] = { ...base[key], ...next[key] };
              }
            }
            await writeConfig(cfg);
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
            theme: cfg.avatar.theme,
            bwmOnline: await probeBwm(),
          });
        }
        const mediaMatch = /^\/bwm-friend\/media\/([A-Za-z0-9_-]+)$/.exec(pathname);
        if (mediaMatch && req.method === 'GET') {
          const abs = mediaMap.get(mediaMatch[1]);
          if (abs) return serveMedia(abs, req, res);
          return serveJson(res, { error: 'unknown token' }, 404);
        }
        if (pathname === '/bwm-friend/health') {
          return serveJson(res, { ok: true });
        }
        if (pathname === '/bwm-friend/update/check' && req.method === 'GET') {
          return serveJson(res, await runUpdateCheck());
        }
        if (pathname === '/bwm-friend/cloud/templates' && req.method === 'GET') {
          return serveJson(res, await cloudTemplates());
        }
        if (pathname === '/bwm-friend/auth/status' && req.method === 'GET') {
          return serveJson(res, { loggedIn: authSession.isLoggedIn(), subject: authSession.subject() });
        }
        if (pathname === '/bwm-friend/auth/login' && req.method === 'POST') {
          const { phone, password } = await readJsonBody(req);
          return serveJson(res, await authLoginLocal({ phone, password }));
        }
        if (pathname === '/bwm-friend/auth/logout' && req.method === 'POST') {
          authSession.logout();
          return serveJson(res, { ok: true });
        }
        if (pathname === '/bwm-friend/companion/chat' && req.method === 'POST') {
          return serveJson(res, await companionChat(req));
        }
        if (pathname === '/bwm-friend/transcribe' && req.method === 'POST') {
          const { audioBase64, format } = await readJsonBody(req);
          return serveJson(res, await mimoTranscribe(audioBase64, { format }));
        }
        if (pathname === '/bwm-friend/tts' && req.method === 'POST') {
          const { text, voice } = await readJsonBody(req);
          return serveJson(res, await mimoTTS(text, { voice }));
        }
        if (pathname === '/bwm-friend/work/task' && req.method === 'POST') {
          let body = '';
          for await (const chunk of req) body += chunk;
          let parsed = {};
          try { parsed = JSON.parse(body || '{}'); } catch {}
          const msg = String(parsed.message || '').trim();
          if (!msg) return serveJson(res, { reply: '有什么任务？', process: [] });
          return serveJson(res, await runRealAgentTask(ctx, msg));
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

  return () => {
    for (const d of disposers) d();
  };
}
