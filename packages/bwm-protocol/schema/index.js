// BWM Protocol v1 — machine-readable constants (mirror of schema/*.json)
// 冻结 v1.0.0（2026-08-24）。Additive-only：新增 = minor；修改/删除 = major。
export const PROTOCOL_VERSION = '1.0';

export const EVENTS = [
  'agent.thinking.start', 'agent.thinking.end',
  'agent.tool.call', 'agent.tool.result',
  'agent.task.success', 'agent.task.failed',
  'memory.updated', 'emotion.changed',
  'presence:state', 'presence:mode',
];

export const PRESENCE = ['idle', 'attention', 'thinking', 'executing', 'speaking', 'success', 'error', 'offline', 'transition'];
export const MODES = ['work', 'companion', 'meeting'];
export const EMOTIONS = ['neutral', 'warm', 'curious', 'focused', 'concerned', 'playful', 'proud', 'empathetic', 'tired'];

export const SHELL_CAPABILITIES = ['video-layer', 'composer-skin', 'sidebar-drawer', 'pop-session', 'header-strip'];
export const RUNTIME_CAPABILITIES = ['presence-provide', 'context-govern', 'ledger-record', 'identity-hold', 'evolution-run'];

export const validPresence = (s) => (PRESENCE.includes(s) ? s : 'idle');
export const validMode = (m) => (MODES.includes(m) ? m : 'work');

// ═══ Settings Schema v1（阶段二：三端字段统一）═══
// 默认值 = 三端共用基线（桌面/插件 config.json；手机 SharedPreferences + 云端）
export const SETTINGS_VERSION = 1;

export const DEFAULT_SETTINGS = {
  version: 1,
  account: { subject: null, loggedIn: false },
  avatar: { theme: '甜心女孩', idle: null, persona: '', personas: {}, driver: 'video' },
  voice: { voice: '冰糖', volume: 1 },
  llm: { provider: 'local', baseUrl: '', model: 'deepseek-chat' },
  ui: { mode: 'work', type: 'stage', chatWidth: 720 },
  power: { pauseOnBlur: true, pauseOnBattery: false },
};

const VALID_MODES = MODES;
const VALID_DRIVERS = ['video', 'image'];
const VALID_LLM_PROVIDERS = ['local', 'external'];

// 校验设置对象（只校验已知字段类型/枚举；未知字段忽略——向前兼容）
export function validateSettings(s) {
  const errors = [];
  const o = s && typeof s === 'object' ? s : {};
  if (o.version !== undefined && o.version !== 1) errors.push('version: must be 1');
  if (o.avatar !== undefined) {
    if (typeof o.avatar.theme !== 'string' || !o.avatar.theme) errors.push('avatar.theme: non-empty string');
    if (o.avatar.persona !== undefined && typeof o.avatar.persona !== 'string') errors.push('avatar.persona: string');
    if (o.avatar.driver !== undefined && !VALID_DRIVERS.includes(o.avatar.driver)) errors.push('avatar.driver: video|image');
  }
  if (o.ui !== undefined && o.ui.mode !== undefined && !VALID_MODES.includes(o.ui.mode)) errors.push('ui.mode: work|companion|meeting');
  if (o.llm !== undefined && o.llm.provider !== undefined && !VALID_LLM_PROVIDERS.includes(o.llm.provider)) errors.push('llm.provider: local|external');
  if (o.power !== undefined) {
    if (o.power.pauseOnBlur !== undefined && typeof o.power.pauseOnBlur !== 'boolean') errors.push('power.pauseOnBlur: boolean');
    if (o.power.pauseOnBattery !== undefined && typeof o.power.pauseOnBattery !== 'boolean') errors.push('power.pauseOnBattery: boolean');
  }
  return { valid: errors.length === 0, errors };
}

// 归一化：给定设置与默认值合并（补齐缺失字段，保留合法值）
export function normalizeSettings(s) {
  const o = s && typeof s === 'object' ? s : {};
  const out = { ...DEFAULT_SETTINGS };
  for (const key of ['account', 'avatar', 'voice', 'llm', 'ui', 'power']) {
    if (o[key] && typeof o[key] === 'object') out[key] = { ...out[key], ...o[key] };
  }
  if (o.version !== undefined) out.version = o.version;
  return out;
}

// 版本对齐语义（协议级：SDK 消费者与 host 共用同一比较规则；lib/index.js 引用同源实现）
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
