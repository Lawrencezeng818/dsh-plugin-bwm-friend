#!/usr/bin/env node
/**
 * scripts/audit-pack-patent-words.mjs — P0-A 消毒走查（可复跑 · 复验义务判据）
 *
 * 生成方法（逐字，与整改单 v3.2 P0-A 逐字命令同口径）：
 *   node scripts/audit-pack-patent-words.mjs
 *
 * 语义：对**真实随包清单**全量枚举（P0-2 增量2 · 派单②——扫描面补全＋路径判据）：
 *   扫描面 = `npm pack --dry-run --json --ignore-scripts` 文件清单
 *          ∪ npm 强制包含件（readme* / license* / licence* / copying* / package.json，
 *            任意层级，取超集——防本地 npm 版本与发布侧规则差异造成盲区）。
 *   实现依据（npm-packlist 源码 + 本机实证 2026-10-06）：
 *     · npm-packlist 严格规则强制包含根级 package.json 与 readme / copying / license
 *       / licence 前缀文件（/opt/homebrew/lib/node_modules/npm/node_modules/npm-packlist/lib/index.js
 *       strict 数组 `!/package.json`、`!/readme{,.*[^~$]}` 等 5 条，:289-293）——
 *       实证：根级 LICENSE 不在 files 白名单仍随包；
 *     · files 条目按 gitignore 语义匹配——无斜杠条目（如 "README.md"）在**任意层级**
 *       同名命中——实证：docs/README.md、packages/bwm-protocol/README.md 均随包
 *       （docs/ 目录本身非目录级白名单）；
 *     · 故本走查对上述五类文件名做**任意层级**超集扫描（license/copying 实证仅根级
 *       随包，超集扫描是保守方向：只可能多拦、不可能漏）。
 *   路径判据（新增）：对每个随包文件的**相对路径**应用词表（大小写不敏感）——
 *     路径命中即违约（防"内容干净、文件名泄漏"形态，如 lib/专利样本.md）。
 *   词表单一来源 scripts/patent-wordlist.mjs，大小写不敏感；
 *   负模式（"!"）语义由 npm pack 自然生效。
 *
 * 输出：命中行 `相对路径:行号`（内容命中）/ `相对路径（路径命中）`（路径判据）+ 汇总。
 * 退出码：0 处命中 → exit 0；≥1 处 → exit 1（可作门禁）。
 * 消毒完成后重跑本脚本应得 0 处——验收①「随包内『专利』命中=0」的判据来源。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATENT_WORD_RE, PATENT_WORD_DESC } from './patent-wordlist.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const packed = JSON.parse(execFileSync(
  'npm',
  ['pack', '--dry-run', '--json', '--ignore-scripts'],
  { cwd: repo, encoding: 'utf8' },
));

// 随包清单（npm pack 真实产物面）
const packPaths = new Set(packed[0].files.map((e) => e.path.replace(/^package\//, '')));

// npm 强制包含件：任意层级 readme*/license*/licence*/copying* + package.json（超集，见件首依据）
const FORCED_NAME_RE = /^(readme|license|licence|copying)/i;
const NEVER_PACKED_DIRS = new Set(['node_modules', '.git']); // npm-packlist defaults：永不随包
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (NEVER_PACKED_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (FORCED_NAME_RE.test(basename(name)) || basename(name) === 'package.json') out.push(p);
  }
  return out;
}
for (const abs of walk(repo)) packPaths.add(abs.slice(repo.length + 1));

const hits = [];
let scanned = 0;
for (const rel of [...packPaths].sort()) {
  const abs = join(repo, rel);
  scanned++;
  // 路径判据：相对路径本身命中词表即违约（与内容无关）
  if (PATENT_WORD_RE.test(rel)) hits.push(`${rel}（路径命中）`);
  const lines = readFileSync(abs, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (PATENT_WORD_RE.test(line)) hits.push(`${rel}:${i + 1}`);
  });
}

hits.sort();
for (const h of hits) console.log(h);
console.log(`── 走查完成：真实随包清单（pack ∪ npm 强制包含件超集）${scanned} 个文件 · 词表 ${PATENT_WORD_DESC}`);
console.log(`命中 ${hits.length} 处${hits.length ? ' → ❌ 随包内容含专利相关字样，须消毒后重跑' : ' → ✅ 随包内容零专利字样（验收①判据）'}`);
process.exit(hits.length ? 1 : 0);
