// scripts/patent-wordlist.mjs — 随包内容禁专利字样 · 词表单一来源（P0-2 整改单 v3.2）
//
// 创世者政策：随包发布文件（files 白名单内任何文件）禁止出现任何专利相关字样。
// 「消毒（P0-A）与守卫（P0-G）必须共用同一张词表」（R35 高1：口径漂移 = docs 漏项根因）
// → 本文件是唯一词表定义处：
//   · scripts/audit-pack-patent-words.mjs（P0-A 消毒走查 / 复验义务）从这里取词表
//   · scripts/audit-release.mjs 的 P 面字样检查（P-word）从这里取词表
//   · scripts/classify-docs-release.mjs（P0-D 判据一）从这里取词表
// 词表内容与整改单 v3.2 P0-A 逐字命令一致：中文「专利/交底书/权利要求」+ 英文 patent，
// 一律大小写不敏感（涵盖 Patent / patent_role）。
export const PATENT_WORD_SOURCE = '(专利|交底书|权利要求|patent)';
export const PATENT_WORD_RE = new RegExp(PATENT_WORD_SOURCE, 'i');
export const PATENT_WORD_DESC = `随包禁专利字样词表 /${PATENT_WORD_SOURCE}/i（单一来源 scripts/patent-wordlist.mjs，与 P0-A 消毒走查共用）`;
