#!/usr/bin/env node
/**
 * scripts/audit-pack-patent-words.mjs — P0-A 消毒走查（可复跑 · 复验义务判据）
 *
 * 生成方法（逐字，与整改单 v3.2 P0-A 逐字命令同口径）：
 *   node scripts/audit-pack-patent-words.mjs
 *
 * 语义：对**真实随包清单**全量枚举——以 `npm pack --dry-run --json --ignore-scripts`
 * 的文件清单为扫描面（R1 低修1：从「files 正面枚举」升级，补齐 package.json、
 * packages/bwm-protocol/README.md 等 npm 自动包含件的盲区；--ignore-scripts 防
 * prepack 审计输出混入 stdout），逐行匹配词表（scripts/patent-wordlist.mjs
 * 单一来源，大小写不敏感）。负模式（"!"）语义由 npm pack 自然生效。
 *
 * 输出：命中行 `相对路径:行号`（与整改单逐字命令同格式）+ 汇总。
 * 退出码：0 处命中 → exit 0；≥1 处 → exit 1（可作门禁）。
 * 消毒完成后重跑本脚本应得 0 处——验收①「随包内『专利』命中=0」的判据来源。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATENT_WORD_RE, PATENT_WORD_DESC } from './patent-wordlist.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const packed = JSON.parse(execFileSync(
  'npm',
  ['pack', '--dry-run', '--json', '--ignore-scripts'],
  { cwd: repo, encoding: 'utf8' },
));

const hits = [];
let scanned = 0;
for (const entry of packed[0].files) {
  const rel = entry.path.replace(/^package\//, '');
  const abs = join(repo, rel);
  scanned++;
  const lines = readFileSync(abs, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (PATENT_WORD_RE.test(line)) hits.push(`${rel}:${i + 1}`);
  });
}

hits.sort();
for (const h of hits) console.log(h);
console.log(`── 走查完成：真实随包清单 ${scanned} 个文件 · 词表 ${PATENT_WORD_DESC}`);
console.log(`命中 ${hits.length} 处${hits.length ? ' → ❌ 随包内容含专利相关字样，须消毒后重跑' : ' → ✅ 随包内容零专利字样（验收①判据）'}`);
process.exit(hits.length ? 1 : 0);
