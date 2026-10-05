#!/usr/bin/env node
/**
 * scripts/classify-docs-release.mjs — P0-D · docs/ 出包全量脚本化枚举分类
 *
 * 生成方法（逐字）：
 *   node scripts/classify-docs-release.mjs
 *
 * 两条判据并行（整改单 v3.2 P0-D）：
 *   判据一（词表）：含专利相关字样者出包——词表单一来源 scripts/patent-wordlist.mjs
 *                  （与 P0-A 消毒 / P0-G 守卫同一张表，大小写不敏感）
 *   判据二（文档类别）：内部运维 / 威胁模型 / 评审口径 / 交接类 / 内部治理 一律出包——
 *                  不依赖词表（这类文件可以完全不含专利字样却仍泄漏防线）
 *
 * 出包机制（等效机制）：根 package.json files 对 docs/ 采用**显式入包枚举**
 * （不用 "!" 负模式——负模式条目须写内部文件名，会把专利字样/内部文件名写进必然
 * 随包的 package.json，被 P-word 守卫拦截）。脚本尾部做**双向一致性校验**：
 * 判据判出的出包文件不得被 files 覆盖、入包文件必须被 files 覆盖，失配 → exit 1
 * （解包断言可证性的机械保障）。
 * 产物清单：scripts/docs-release-manifest.md（scripts/ 不在 files 白名单 → 不入包）。
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATENT_WORD_RE } from './patent-wordlist.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = join(repo, 'docs');

// 判据二：文件名类别规则（内部类别文档一律出包，不看内容）
const CATEGORY_RULES = [
  { re: /THREAT-MODEL/i, cat: '威胁模型' },
  { re: /REVIEW-PROMPT/i, cat: '评审口径' },
  { re: /HANDOVER/i, cat: '交接类' },
  { re: /RELEASE-HARDENING/i, cat: '内部运维' },
  { re: /EMBEDDED-AUTOSCROLL-FIX/i, cat: '内部运维' },
  { re: /发布政策/, cat: '内部治理' },
];

const TEXT_EXTS = new Set(['.md', '.markdown', '.txt', '.html', '.js', '.json', '.yml', '.yaml']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const rows = [];
for (const abs of walk(docsDir)) {
  const rel = abs.slice(repo.length + 1);
  const reasons = [];
  const cat = CATEGORY_RULES.find((r) => r.re.test(rel));
  if (cat) reasons.push(`判据二（${cat.cat}）`);
  if (TEXT_EXTS.has(extname(rel).toLowerCase())) {
    const lines = readFileSync(abs, 'utf8').split('\n');
    const wordHits = [];
    lines.forEach((l, i) => { if (PATENT_WORD_RE.test(l)) wordHits.push(i + 1); });
    if (wordHits.length) reasons.push(`判据一（词表 ${wordHits.length} 处: 行 ${wordHits.slice(0, 10).join(',')}）`);
  }
  rows.push({ rel, exclude: reasons.length > 0, reasons: reasons.join('；') || '—（产品/协议/规格类，随包）' });
}

// 双向一致性校验：files 显式枚举 vs 两判据分类结果（防白名单与分类漂移）
const files = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).files;
const positives = files.filter((e) => !e.startsWith('!'));
const negatives = files.filter((e) => e.startsWith('!')).map((e) => e.slice(1));
const covered = (rel) =>
  positives.some((n) => rel === n || rel.startsWith(`${n}/`))
  && !negatives.some((n) => rel === n || rel.startsWith(`${n}/`));
const mismatches = [
  ...rows.filter((r) => r.exclude && covered(r.rel)).map((r) => `- ❌ 判出包但 files 仍覆盖：${r.rel}（${r.reasons}）`),
  ...rows.filter((r) => !r.exclude && !covered(r.rel)).map((r) => `- ❌ 判入包但 files 未覆盖：${r.rel}`),
];

const today = new Date().toLocaleDateString('sv-SE'); // 本地日期 YYYY-MM-DD
const manifest = [
  `# docs 出包分类清单（机器生成 · 勿手改）`,
  ``,
  `> 生成命令：\`node scripts/classify-docs-release.mjs\`（生成日期 ${today}）`,
  `> 判据见 scripts/classify-docs-release.mjs 件首；词表单一来源 scripts/patent-wordlist.mjs。`,
  `> 出包机制：files 显式入包枚举（docs/ 不做目录级白名单）。`,
  `> 本清单位于 scripts/（不在 files 白名单）→ 不入包。`,
  ``,
  `| 处置 | 文件 | 判定依据 |`,
  `|---|---|---|`,
  ...rows.map((r) => `| ${r.exclude ? '⛔ 出包' : '✅ 入包'} | ${r.rel} | ${r.reasons} |`),
  ``,
  `汇总：docs 全量 ${rows.length} 个文件 · 出包 ${rows.filter((r) => r.exclude).length} · 入包 ${rows.filter((r) => !r.exclude).length}`,
  mismatches.length ? `\n❌ files 白名单与分类失配 ${mismatches.length} 处：\n${mismatches.join('\n')}` : `\n✅ files 显式枚举与两判据分类双向一致（出包不覆盖 · 入包全覆盖）`,
  '',
].join('\n');

writeFileSync(join(repo, 'scripts/docs-release-manifest.md'), manifest, 'utf8');
console.log(manifest);
if (mismatches.length) process.exit(1);
