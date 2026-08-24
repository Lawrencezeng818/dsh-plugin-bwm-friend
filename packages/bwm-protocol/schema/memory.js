// BWM Protocol v1 — Memory 工具（公开：事实抽取是通用记忆能力，非核心决策）
// 冻结 v1.0.0（2026-08-24）。host 与 SDK 共享同一抽取逻辑（单一来源）。

// 轻量事实抽取：用户消息里的偏好/自称/关键陈述（规则启发式；决策层未来上移 Memory Runtime）
export const FACT_PATTERNS = [
  /(?:我喜欢|我爱|我最喜欢|超喜欢|很喜欢)\s*([^，。！？]{2,20})/,
  /(?:我是|我叫|我的名字是)\s*([^，。！？]{2,20})/,
  /(?:我在|我住在|我来自|我家在|我是.*的)\s*([^，。！？]{2,24})/,
  /(?:我想要|我想买|我想去|我希望|我想学)\s*([^，。！？]{2,24})/,
  /(?:我最近|昨天|今天|上周)\s*([^，。！？]{2,24})/,
];

export const MEMORY_DEFAULTS = { userFacts: [], recentTopics: [], updatedAt: null };
export const USER_FACTS_MAX = 30;
export const RECENT_TOPICS_MAX = 10;

/**
 * 从文本抽取记忆事实（问句/无实质内容过滤）。
 * @param {string} text 用户消息
 * @returns {string[]} 事实列表（去重由调用方负责）
 */
export function extractFacts(text) {
  const facts = [];
  for (const re of FACT_PATTERNS) {
    const m = String(text).match(re);
    if (m && m[1] && m[1].length >= 2) {
      const f = m[1].trim();
      if (/[吗呢么？?]$/.test(f)) continue; // 问句尾词过滤
      if (/(怎么|什么|干嘛|为啥|如何)/.test(f)) continue; // 疑问词过滤（"怎么样/怎么办"）
      facts.push(f);
    }
  }
  return facts;
}

/**
 * 把一条消息并入记忆快照（幂等追加 + 上限裁剪）。
 * @param {object} mem {userFacts:[], recentTopics:[]}
 * @param {string} message 用户消息
 * @returns {object} 更新后的记忆快照（不落盘——落盘由调用方/持久化策略决定）
 */
export function mergeMemory(mem, message) {
  const next = {
    userFacts: Array.isArray(mem.userFacts) ? [...mem.userFacts] : [],
    recentTopics: Array.isArray(mem.recentTopics) ? [...mem.recentTopics] : [],
    updatedAt: new Date().toISOString(),
  };
  for (const f of extractFacts(message)) {
    if (!next.userFacts.includes(f)) next.userFacts.push(f);
  }
  next.userFacts = next.userFacts.slice(-USER_FACTS_MAX);
  next.recentTopics.unshift(String(message).slice(0, 80));
  next.recentTopics = next.recentTopics.slice(-RECENT_TOPICS_MAX);
  return next;
}

/**
 * 生成记忆提示（注入 system prompt）。
 * @param {object} mem
 * @returns {string} 空则 ''（无记忆时不注入）
 */
export function memoryPrompt(mem) {
  const facts = Array.isArray(mem.userFacts) ? mem.userFacts : [];
  const topics = Array.isArray(mem.recentTopics) ? mem.recentTopics : [];
  if (facts.length === 0 && topics.length === 0) return '';
  const f = facts.length > 0 ? `关于用户记得：${facts.join('；')}。` : '';
  const r = topics.length > 0 ? `最近聊过：${topics.slice(0, 3).join(' | ')}。` : '';
  return `${f}${r}`;
}
