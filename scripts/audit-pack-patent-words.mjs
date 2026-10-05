#!/usr/bin/env node
/**
 * scripts/audit-pack-patent-words.mjs — P0-A 消毒走查（可复跑 · 复验义务判据）
 *
 * 生成方法（逐字，与整改单 v3.2 P0-A 逐字命令同口径）：
 *   node scripts/audit-pack-patent-words.mjs
 *
 * 语义：对根 package.json 的 files 白名单全量枚举（目录递归、排除 node_modules，
 * 支持 P0-D 引入的 "!" 负模式——被负模式排除的 docs 内部类文件不计入随包面），
 * 逐行匹配词表（scripts/patent-wordlist.mjs 单一来源，大小写不敏感）。
 *
 * 输出：命中行 `相对路径:行号`（与整改单逐字命令同格式）+ 汇总。
 * 退出码：0 处命中 → exit 0；≥1 处 → exit 1（可作门禁）。
 * 消毒完成后重跑本脚本应得 0 处——验收①「随包内『专利』命中=0」的判据来源。
 */
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATENT_WORD_RE, PATENT_WORD_DESC } from './patent-wordlist.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).files;
const positives = files.filter((e) => !e.startsWith('!'));
const negatives = files.filter((e) => e.startsWith('!')).map((e) => e.slice(1));

function walk(p, out = []) {
  const st = statSync(p);
  if (st.isFile()) { out.push(p); return out; }
  for (const name of readdirSync(p)) {
    if (name === 'node_modules') continue;
    walk(join(p, name), out);
  }
  return out;
}

const covered = (rel) => negatives.some((n) => rel === n || rel.startsWith(`${n}/`));

const hits = [];
let scanned = 0;
for (const entry of positives) {
  const absFiles = walk(join(repo, entry));
  for (const abs of absFiles) {
    const rel = abs.slice(repo.length + 1);
    if (covered(rel)) continue;
    scanned++;
    const lines = readFileSync(abs, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (PATENT_WORD_RE.test(line)) hits.push(`${rel}:${i + 1}`);
    });
  }
}

hits.sort();
for (const h of hits) console.log(h);
console.log(`── 走查完成：files 白名单内 ${scanned} 个文件 · 词表 ${PATENT_WORD_DESC}`);
console.log(`命中 ${hits.length} 处${hits.length ? ' → ❌ 随包内容含专利相关字样，须消毒后重跑' : ' → ✅ 随包内容零专利字样（验收①判据）'}`);
process.exit(hits.length ? 1 : 0);
