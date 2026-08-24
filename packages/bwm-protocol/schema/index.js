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
