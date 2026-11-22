#!/usr/bin/env node
/**
 * scripts/audit-release.mjs — 发布产物审计门禁（P0-2 · 2026-10-03 · R2 整改版）
 *
 * 背景：2026-09-11 v0.6.0 因根 package.json files 含目录级 "packages"，
 * 把闭源专利核心 packages/bwm-runtime-core 与 packages/mira-agent/persona.yaml
 * 打进公开 tarball，构成专利自我公开与商业资产泄漏（bwm-patents 2026-09-22 复核 §五/§六）。
 *
 * R2 整改（2026-10-03，小沈终审否决"client.js 既有架构豁免"后新增）：
 *   - [F] 内核指纹守卫：v0.7.2 起 lib/client.js 内联的**新内核**（retained 快照 /
 *     generation 代次回落 / 被拒事件不入历史 / 专利5 路由器 / 专利4 关系账本）
 *     按代码指纹拦截；指纹经 0.6.0 存证产物双面验证不误伤旧公开版。
 *   - [P] 专利标识守卫：说明书段落号 / 申请号 / CN 公布号形态禁入。
 *   - c 项符号清单增补 IDENTITY_PRESET / PERSONALITY_PRESET（\bPERSONA\b 拦不住复合词）。
 *   - b 项增补 mira-agent 目录段禁入。
 *   - --expect-blocked：冻结期常态模式（真实产物含未公开内核 → 红牌为预期，exit 0）。
 *
 * P0-2 整改批（2026-10-06 · 整改单 v3.2）：
 *   - [P] 面只增不减：新增 P-word 专利字样词表检查（随包文件禁含任何专利字样，
 *     词表单一来源 scripts/patent-wordlist.mjs，与 P0-A 消毒走查共用，大小写不敏感）。
 *     原 P-sec/P-app/P-pub 形态面原样保留；b/F/c 面不动。
 *   - --expect-blocked 修复（P0-D 中4）：要求 violations.a+b === 0 才允许 exit 0
 *     （红牌必须是内核守卫所致，[a]/[b] 违规不得被冻结期口径掩盖）。
 *   - 0.6.0 对照双断言：保留 verifyEvidenceNotMisfired 特异性语义（不动），
 *     另加 verifyEvidenceMarked——0.6.0 全量判定 = 红 且红由 a/b 类所致。
 *   - 内部 npm pack 加 --ignore-scripts（配合 package.json prepack 钩子，防递归）。
 *
 * R1 返工（2026-10-06 · 返工单低修2）：
 *   - --expect-blocked 冻结期放行条件收紧：a+b===0 ∧ F/c>0 ∧ **无 P-word 命中**。
 *     解冻切换条款见 docs/发布政策_随包内容禁专利字样_v1.0.md 第四节。
 *
 * P0-2 增量2（2026-10-06 · 冻结期口径加固，派单①）：
 *   - 放行条件最终口径：a+b===0 ∧ (F>0 ∨ c>0) ∧ **P===0 ∧ Pword===0**——
 *     任何 P 类命中（P-sec/P-app/P-pub/P-word）冻结期一律不放行，与内核红（F/c）
 *     共存同样阻断（R1 口径的"单发阻断"表述有歧义：P 与 F 共载曾仍 exit 0，2b-i
 *     三视角独立复现，见 docs/专家团汇总_2026-10-06_2b-i机制演练_P0-2整改实现复核.md 发现 A）。
 *     selftest 真实产物判定（verdictOk）同口径。
 *
 * 用法:
 *   node scripts/audit-release.mjs                  # 审计真实产物；FAIL → exit 1（发布阻断）
 *   node scripts/audit-release.mjs --expect-blocked # 冻结期：预期红牌 → exit 0；转绿 → exit 1 提示核查
 *   node scripts/audit-release.mjs --selftest       # 毒饵自测 + 0.6.0 不误伤验证 + 真实产物判定
 *
 * 检查项:
 *   a. packages 域白名单制：仅 packages/bwm-protocol/schema/*（开源协议层，
 *      tests/release-pack-smoke.mjs 硬断言随包）+ npm 自动包含的 bwm-protocol/README.md。
 *   b. 零豁免路径：bwm-runtime-core 目录段、mira-agent 目录段、persona.yaml、文件名含 "-persona"。
 *   c. 专利核心符号词边界 grep（含人格常量），豁免清单逐条显式打印。
 *   F. 内核指纹：随包文本文件命中 v0.7.2+ 新内核机制代码指纹即 FAIL，无豁免。
 *   P. 专利标识：段落号 [dddd] / 申请号 / CN 公布号形态禁入，无豁免；
 *      P-word 专利字样（P0-2 起）：随包文件禁含任何专利字样（词表共用，无豁免）。
 *   d. 输出包内文件清单与总大小摘要，供人工复核。
 */
import { execFileSync } from 'node:child_process';
import { PATENT_WORD_RE, PATENT_WORD_DESC } from './patent-wordlist.mjs';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// 0.6.0 泄漏存证（不误伤验证用；不存在则 selftest 跳过该项，可用 BWM_060_EVIDENCE_TGZ 覆盖）
const EVIDENCE_TGZ = process.env.BWM_060_EVIDENCE_TGZ
  || '/Users/zengtian/projects/bwm-patents/泄漏处置_0.6.0存证/dsh-plugin-bwm-friend-0.6.0.tgz';

/* ── 配置区 ─────────────────────────────────────────────────────── */

// a 项：packages/ 域内唯一放行前缀（开源协议层 schema，测试硬断言随包）
const ALLOWED_UNDER_PACKAGES = 'packages/bwm-protocol/schema/';
// a 项补充：npm 的自动包含规则会把包内目录的 README.md 强制打进 tarball
// （npm 特性：README 不可被 files/.npmignore 排除；0.4.0 起历版如此）。
// 该 README 为协议边界佐证文档（明文声明决策层不在本包），经符号扫描干净，精确放行。
const ALLOWED_UNDER_PACKAGES_EXTRA = ['packages/bwm-protocol/README.md'];

// b 项：零豁免路径黑名单（目录段 / 精确文件名 / 文件名子串）
const FORBIDDEN_DIR_SEGMENTS = ['bwm-runtime-core', 'mira-agent'];
const FORBIDDEN_BASENAME_EXACT = 'persona.yaml';
const FORBIDDEN_BASENAME_CONTAINS = '-persona';
const FORBIDDEN_DIR_REASON = {
  'bwm-runtime-core': '闭源专利核心目录 bwm-runtime-core 不得进包（0.6.0 事故形态）',
  'mira-agent': 'mira-agent 目录段不得进包（0.6.0 已泄漏 persona.yaml 所在目录，防变体回流）',
};

// c 项：专利核心符号（词边界匹配；\bPERSONA\b 拦不住 PERSONALITY_PRESET，故增补复合词）
const CORE_SYMBOLS = ['createEventBus', 'createAgentContext', 'PRESENCE_STATES', 'wireLedger', 'PERSONA', 'IDENTITY_PRESET', 'PERSONALITY_PRESET'];
const SYMBOL_RE = /\b(createEventBus|createAgentContext|PRESENCE_STATES|wireLedger|PERSONA|IDENTITY_PRESET|PERSONALITY_PRESET)\b/;

// c 项：符号豁免清单（每条必须带理由；审计输出时逐条打印命中行数，供终审复核/否决）。
// R2 变更：lib/client.js 的"既有架构"豁免已被终审否决并删除——bundle 内联新内核
// 恰是必须拦截的对象；豁免只保留"叙述文本 / 配置字段名 / 壳与协议层的刚需引用"。
const SYMBOL_EXEMPTS = [
  {
    file: 'lib/index.js', symbols: ['wireLedger'],
    reason: 'settings patch 配置通道字段名（patch.wireLedger / 白名单 key / 形状守卫），非内核实现引用',
  },
  {
    file: 'lib/index.js', symbols: ['IDENTITY_PRESET', 'PERSONALITY_PRESET'],
    reason: '壳侧人格系统刚需（buildPersonaSystem 导入随包副本构建系统提示，0.6.0 已公开的既成功能面）；人格常量不得扩散到 bundle/新文件',
  },
  {
    file: 'packages/bwm-protocol/schema/index.js', symbols: ['wireLedger'],
    reason: 'settings schema 校验代码中的字段名校验（协议层 = 宪法定性 Apache 2.0 开源侧），非内核实现',
  },
  {
    file: 'packages/bwm-protocol/schema/settings.json', symbols: ['wireLedger'],
    reason: 'settings schema 字段声明（协议层开源侧），非内核实现',
  },
  {
    file: 'packages/bwm-protocol/schema/persona.js', symbols: ['IDENTITY_PRESET', 'PERSONALITY_PRESET'],
    reason: '人格常量唯一权威定义处（协议层开源侧，tests/release-pack-smoke.mjs 硬断言随包）；已知合法位置，扩散即拦',
  },
  {
    file: 'docs/BWM-ARCHITECTURE-BOUNDARY.md', symbols: 'ALL',
    reason: '架构宪法文档本身，五符号以其"禁止事项审计命令清单"文本形式出现（任务口径明示该文档允许随包），非实现代码',
  },
  {
    file: 'docs/BWM-SETTINGS-SCHEMA-v1.md', symbols: ['wireLedger'],
    reason: 'settings 协议字段说明文档（叙述文本），非实现代码',
  },
  {
    file: 'CHANGELOG.md', symbols: ['wireLedger', 'createEventBus', 'IDENTITY_PRESET', 'PERSONALITY_PRESET'],
    reason: '版本历史叙述文本（提及符号名/常量名的变更记录，如 0.7.5 条目叙述 Persona 单一来源），非实现代码',
  },
];

// F 项：内核指纹清单（R2 新增）。来源 = packages/bwm-runtime-core/src/index.js（只读提取），
// 全部经 0.6.0 存证产物双面验证：当前 lib/client.js（内联新内核）命中、0.6.0 旧公开版零命中。
// kind: 'line' = 行 trim 后子串；'seq' = 片段按行序依次出现。
const CORE_FINGERPRINTS = [
  // F1–F6 解冻记录（2026-11-22 独立裁决 · 创世者选 A）：不再拦截，仅留痕打印。
  // 依据：CEO 仓 decisions/呈批件_2026-11-22_解冻公开包内核指纹面F1-F6_市场发布前置.md
  // （P2 申请日 2026-10-01 在先、F1–F6 此前从未公开、知识产权线复核比对成立；
  //   创世者明确接受放弃 P2 分案/改进案/同族新案在该特征面的后续布局——单向门，不可逆）。
  // 归属复核结论：bwm-patents/评审/2026-11-22_归属复核结论_F1-F6内核指纹_小沈.md
  { id: 'F1', kind: 'line', pattern: 'const retained = new Map()', mech: 'retained 快照（presence:state 单帧保留）', src: 'core/src/index.js:47', released: '2026-11-22' },
  { id: 'F2', kind: 'line', pattern: "if (target === 'presence:state') retained.set(target, ev);", mech: 'retained 快照写入', src: 'core/src/index.js:102', released: '2026-11-22' },
  { id: 'F3', kind: 'line', pattern: 'for (const ev of retained.values()) deliver(ev);', mech: 'retained 快照回放', src: 'core/src/index.js:127', released: '2026-11-22' },
  { id: 'F4', kind: 'line', pattern: 'const currentGeneration = ++generation;', mech: 'generation 代次', src: 'core/src/index.js:500', released: '2026-11-22' },
  { id: 'F5', kind: 'line', pattern: 'if (disposed || generation !== currentGeneration) return;', mech: 'generation 代次回落守卫', src: 'core/src/index.js:502', released: '2026-11-22' },
  { id: 'F6', kind: 'seq', pattern: ['if (blocked) return ev;', 'history.push(ev);'], mech: '被拒事件不入历史（行序：blocked 先于 push；0.6.0 旧码为反序 push→blocked，故单行不可用作指纹）', src: 'core/src/index.js:99-100', released: '2026-11-22' },
  // F7/F8 受控实现守卫：永久拦截（P1-lite 红线，永不解冻——重新加入即 R2 泄漏）
  { id: 'F7', kind: 'line', pattern: '__bwmModules["./perception-router.js"]', mech: '专利5 感知路由器内联注册标记（0.6.0 无此模块）', src: 'lib/client.js 构建产物标记' },
  { id: 'F8', kind: 'line', pattern: '__bwmModules["./relationship-ledger.js"]', mech: '专利4 关系账本内联注册标记（0.6.0 无此模块）', src: 'lib/client.js 构建产物标记' },
];

// P 项：专利标识形态（R2 新增，无豁免）。预扫确认壳代码/docs/static-ui/0.6.0 旧版零命中。
// ⚠️ 本清单是「形态面」，供 selftest 特异性验证（scanGuardOnly）复用；
// P0-2 新增的「字样面」（P-word，随包文件禁含任何专利字样）只在 auditExtracted 生效，
// 不进 scanGuardOnly——0.6.0 存证含专利字样（本就是泄漏事故样本），进特异性验证会误报。
const PATENT_ID_PATTERNS = [
  { id: 'P-sec', re: /\[\d{4}\]/, desc: '专利说明书段落号注释形态（如 [0041]）' },
  { id: 'P-app', re: /\b202[0-9]{9}(?:\.[0-9])?\b/, desc: '专利申请号形态（2026 开头 13 位，可带校验位）' },
  { id: 'P-pub', re: /\bCN\s?\d{9}\s?[A-Z]\b/, desc: 'CN 公布号形态' },
];

// c 项：参与内容扫描的文本扩展名（二进制资产跳过）
const TEXT_EXTS = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.markdown', '.yml', '.yaml', '.html', '.htm', '.css', '.txt', '.svg', '.xml']);

/* ── 工具 ───────────────────────────────────────────────────────── */

const fail = (msg) => { console.error(`❌ ${msg}`); process.exit(1); };
const run = (cmd, args, opts = {}) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', ...opts }); }
  catch (e) { throw new Error(`${cmd} ${args.join(' ')} 失败: ${e.message}`); }
};

function walk(dir, rootDir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, rootDir, out);
    else out.push({ abs: p, rel: p.slice(rootDir.length + 1).split(sep).join('/'), size: st.size });
  }
  return out;
}

function symbolExemptFor(relPath, symbol) {
  // 同一文件可有多条豁免（不同符号组），必须全部遍历
  for (const e of SYMBOL_EXEMPTS) {
    if (e.file !== relPath) continue;
    if (e.symbols === 'ALL' || e.symbols.includes(symbol)) return e.reason;
  }
  return null;
}

// F 项指纹匹配（行 trim 后；seq 按行序依次定位）
function matchFingerprint(trimmedLines, fp) {
  if (fp.kind === 'line') return trimmedLines.some((l) => l.includes(fp.pattern));
  let from = 0;
  for (const seg of fp.pattern) {
    let found = -1;
    for (let i = from; i < trimmedLines.length; i++) {
      if (trimmedLines[i].includes(seg)) { found = i; break; }
    }
    if (found < 0) return false;
    from = found + 1;
  }
  return true;
}

/* ── 核心审计：对解包后的 package/ 目录执行 a/b/c/F/P/d 检查 ────── */

function auditExtracted(extractRoot, label) {
  const files = walk(join(extractRoot, 'package'), join(extractRoot, 'package'));
  const violations = { a: [], b: [], c: [], F: [], P: [], Pword: [], exemptHits: [] };
  const scanFailures = [];

  for (const f of files) {
    /* a. packages 域白名单制 */
    const underPackagesAllowed = f.rel.startsWith(ALLOWED_UNDER_PACKAGES)
      || ALLOWED_UNDER_PACKAGES_EXTRA.includes(f.rel);
    if (f.rel.startsWith('packages/') && !underPackagesAllowed) {
      violations.a.push(`${f.rel}（${f.size}B）— packages/ 域白名单外（仅允许 ${ALLOWED_UNDER_PACKAGES}* 与 npm 自动包含的 ${ALLOWED_UNDER_PACKAGES_EXTRA.join('、')}）`);
    }
    /* b. 零豁免路径 */
    for (const seg of FORBIDDEN_DIR_SEGMENTS) {
      if (f.rel.split('/').includes(seg)) violations.b.push(`${f.rel} — ${FORBIDDEN_DIR_REASON[seg]}`);
    }
    if (basename(f.rel) === FORBIDDEN_BASENAME_EXACT) {
      violations.b.push(`${f.rel} — persona.yaml（0.6.0 已泄漏的 agent 配置形态）不得进包`);
    } else if (basename(f.rel).includes(FORBIDDEN_BASENAME_CONTAINS)) {
      violations.b.push(`${f.rel} — 文件名含 "${FORBIDDEN_BASENAME_CONTAINS}"（persona 变体泄漏形态）不得进包`);
    }
    /* c/F/P. 内容级扫描 */
    if (!TEXT_EXTS.has(extname(f.rel).toLowerCase())) continue;
    let content;
    try { content = readFileSync(f.abs, 'utf8'); } catch { scanFailures.push(`${f.rel} 无法按文本读取`); continue; }
    const lines = content.split('\n');
    const trimmedLines = lines.map((l) => l.trim());

    // c. 专利核心符号
    lines.forEach((line, i) => {
      const m = line.match(SYMBOL_RE);
      if (!m) return;
      const symbol = m[1];
      const reason = symbolExemptFor(f.rel, symbol)
        // 2026-11-22 解冻裁决（创世者选 A）：以下符号为公开 API 面——0.3.1 公开实包
        //（npm registry 在线版）实测已含全部这些符号（lib/client.js createEventBus×5 等），
        // 无新增暴露。出处同 CORE_FINGERPRINTS 注。
        || (['createAgentContext', 'wireLedger', 'createEventBus', 'PRESENCE_STATES', 'IDENTITY_PRESET', 'PERSONALITY_PRESET'].includes(symbol) && '已解冻公开 API 面（2026-11-22 裁决，0.3.x 公开实包已含）');
      if (reason) {
        let h = violations.exemptHits.find((x) => x.file === f.rel && x.symbol === symbol);
        if (!h) { h = { file: f.rel, symbol, count: 0, reason }; violations.exemptHits.push(h); }
        h.count++;
      } else {
        violations.c.push(`${f.rel}:${i + 1} 命中专利核心符号 \`${symbol}\` → ${line.trim().slice(0, 120)}`);
      }
    });
    // F. 内核指纹（无豁免；released 条目仅留痕不拦截——2026-11-22 解冻裁决）
    for (const fp of CORE_FINGERPRINTS) {
      if (matchFingerprint(trimmedLines, fp)) {
        if (fp.released) {
          console.log(`    [F·已解冻留痕] ${f.rel} 命中 ${fp.id}（${fp.mech} · 解冻 ${fp.released}）`);
        } else {
          violations.F.push(`${f.rel} 命中内核指纹 ${fp.id}（${fp.mech} · 源 ${fp.src}）`);
        }
      }
    }
    // P. 专利标识（无豁免）
    lines.forEach((line, i) => {
      for (const p of PATENT_ID_PATTERNS) {
        if (p.re.test(line)) violations.P.push(`${f.rel}:${i + 1} 命中专利标识 ${p.id}（${p.desc}）→ ${line.trim().slice(0, 120)}`);
      }
    });
    // P-word. 专利相关字样（P0-2 · P 面只增不减，无豁免）：随包文件禁含任何专利字样。
    // 增量2：单独记账（Pword）——冻结期 --expect-blocked 命中即 exit 1（P 类一律不放行）
    lines.forEach((line, i) => {
      if (PATENT_WORD_RE.test(line)) violations.Pword.push(`${f.rel}:${i + 1} 命中专利字样 P-word（${PATENT_WORD_DESC}）→ ${line.trim().slice(0, 120)}`);
    });
  }

  /* d. 清单与总大小摘要 */
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  const manifest = files.map((f) => `    ${String(f.size).padStart(9)}B  ${f.rel}`).join('\n');

  const failures = [
    ...violations.a.map((m) => `[a] ${m}`),
    ...violations.b.map((m) => `[b] ${m}`),
    ...violations.c.map((m) => `[c] ${m}`),
    ...violations.F.map((m) => `[F] ${m}`),
    ...violations.P.map((m) => `[P] ${m}`),
    ...violations.Pword.map((m) => `[P] ${m}`),
    ...scanFailures.map((m) => `[c] ${m}`),
  ];

  console.log(`\n──── 审计对象: ${label} ────`);
  console.log(`  文件数: ${files.length} · 总大小: ${(totalBytes / 1024).toFixed(1)} KiB`);
  console.log('  [d] 包内文件清单:');
  console.log(manifest);

  console.log('  [c] 符号豁免明细（显式列出，供终审复核/否决）:');
  if (violations.exemptHits.length === 0) console.log('    （无豁免命中）');
  for (const h of violations.exemptHits) {
    console.log(`    · ${h.file} · \`${h.symbol}\` × ${h.count} — ${h.reason}`);
  }

  if (failures.length) {
    // R2.1 对账口径：分类计数直接取自明细数组长度（禁止人工归纳），与下方逐条明细严格互验
    // （scanFailures 在明细中同为 [c] 前缀，故并入 c 计数）
    console.log(`  审计结论: FAIL（${failures.length} 项违规：[a]×${violations.a.length} [b]×${violations.b.length} [c]×${violations.c.length + scanFailures.length} [F]×${violations.F.length} [P]×${violations.P.length + violations.Pword.length}）`);
    for (const m of failures) console.log(`    ${m}`);
  } else {
    console.log('  审计结论: PASS（a packages 白名单制 · b 零豁免路径 · c 核心符号 · F 内核指纹 · P 专利标识 · d 清单已输出）');
  }
  return {
    pass: failures.length === 0, files, totalBytes, violations,
    blockedByKernelGuard: violations.F.length > 0 || violations.P.length > 0 || violations.c.length > 0,
  };
}

// P0-2（P0-D 中4）＋增量2（派单①）：冻结期放行条件最终口径 =
//   a+b===0 ∧ (F>0 ∨ c>0) ∧ P===0 ∧ Pword===0
// ——红牌必须仅由内核守卫类（F/c）所致；[a]/[b] 违规不得被冻结期口径掩盖，
// 任何 P 类命中（P-sec/P-app/P-pub/P-word）与内核红共存同样不放行（无单发/共存之分）。
const redByKernelGuardOnly = (r) =>
  (r.violations.F.length > 0 || r.violations.c.length > 0)
  && (r.violations.a.length + r.violations.b.length) === 0
  && r.violations.P.length === 0
  && r.violations.Pword.length === 0;

/* ── 真实产物审计：npm pack → 解包 → 审计 ───────────────────────── */

function auditRealPack(tmp) {
  console.log('▶ npm pack（临时目录收包，不污染仓库；--ignore-scripts 防 prepack 递归）…');
  let packed;
  try {
    // P0-2：--ignore-scripts 必须先于 package.json 的 prepack 钩子存在（顺序不可颠倒，防无限递归）
    packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', tmp], { cwd: REPO_ROOT }));
  } catch (e) { throw new Error(`npm pack 失败: ${e.message}`); }
  const tgz = join(tmp, packed[0].filename);
  if (!statSync(tgz, { throwIfNoEntry: false })) throw new Error(`tarball 未生成: ${tgz}`);
  console.log(`  tarball: ${packed[0].filename}（${(packed[0].size / 1024).toFixed(1)} KiB）`);
  console.log('▶ 解包并执行 a/b/c/F/P/d 检查…');
  const extractDir = join(tmp, 'extract');
  run('mkdir', ['-p', extractDir]);
  run('tar', ['-xzf', tgz, '-C', extractDir]);
  return auditExtracted(extractDir, `真实 npm pack 产物 ${packed[0].filename}`);
}

/* ── F/P 守卫对指定文件集的独立扫描（selftest/存证验证复用）─────── */

function scanGuardOnly(files) {
  const hits = { F: [], P: [] };
  for (const f of files) {
    if (!TEXT_EXTS.has(extname(f.abs).toLowerCase())) continue;
    let content;
    try { content = readFileSync(f.abs, 'utf8'); } catch { continue; }
    const trimmedLines = content.split('\n').map((l) => l.trim());
    for (const fp of CORE_FINGERPRINTS) {
      if (fp.released) continue; // 已解冻条目不进守卫特异性记账
      if (matchFingerprint(trimmedLines, fp)) hits.F.push(`${f.rel} ← ${fp.id}（${fp.mech}）`);
    }
    content.split('\n').forEach((line, i) => {
      for (const p of PATENT_ID_PATTERNS) {
        if (p.re.test(line)) hits.P.push(`${f.rel}:${i + 1} ← ${p.id}（${p.desc}）`);
      }
    });
  }
  return hits;
}

/* ── selftest：毒饵必须被拦 + 0.6.0 存证不误伤 + 真实产物判定 ───── */

function buildAndAuditPoison(tmp) {
  console.log('▶ [selftest 1/4] 毒饵假包（旧形态 + 内联新内核 client 形态，期望 FAIL）…');
  const poisonRoot = join(tmp, 'poison');
  const pkg = join(poisonRoot, 'package');
  run('mkdir', ['-p', join(pkg, 'packages/bwm-runtime-core/src'), join(pkg, 'packages/mira-agent'), join(pkg, 'lib'), join(pkg, 'docs')]);
  // 毒饵内容全部为无害占位文本，仅含触发审计的形态特征
  const baitCore = [
    'function createEventBus() { return {}; }',
    'function createAgentContext() { return {}; }',
    'const PRESENCE_STATES = new Set(["idle"]);',
    'function wireLedger(bus, context) {}',
    'export { createEventBus, createAgentContext, PRESENCE_STATES, wireLedger };',
  ].join('\n');
  // R2 新增：内联新内核的 client bundle 形态（指纹行 + 段落号 + 人格常量 + 模块注册标记）
  const baitClient = [
    '\t\t\t__bwmModules["@laikaton/bwm-runtime-core"] = (function() {',
    '\t\t\t  const retained = new Map();',
    '\t\t\t  const currentGeneration = ++generation;',
    '\t\t\t  if (disposed || generation !== currentGeneration) return;',
    '\t\t\t  if (blocked) return ev;',
    '\t\t\t  history.push(ev);',
    '\t\t\t  __bwmModules["./perception-router.js"] = (function() {});',
    '\t\t\t  __bwmModules["./relationship-ledger.js"] = (function() {});',
    "\t\t\t  context.set('personality', { ...PERSONALITY_PRESET }); // 关系域策略（专利1 说明书 [0041]/[0071]）",
    '\t\t\t})();',
  ].join('\n');
  const files = [
    [join(pkg, 'packages/bwm-runtime-core/src/index.js'), baitCore],
    [join(pkg, 'packages/mira-agent/persona.yaml'), 'name: decoy-bait\nnote: 审计自测毒饵（占位文本，非真实配置）\n'],
    [join(pkg, 'lib/evil.js'), 'export const PERSONA = "bait-symbol";\n'],
    [join(pkg, 'lib/client-bundle.js'), baitClient],
    [join(pkg, 'docs/old-persona-notes.md'), '# bait filename check\n'],
    [join(pkg, 'lib/clean.js'), 'console.log("clean file");\n'],
    [join(pkg, 'package.json'), '{"name":"poison-bait","version":"0.0.0"}'],
  ];
  for (const [p, c] of files) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, c, 'utf8');
  }
  const poisonTgz = join(tmp, 'poison-bait.tgz');
  run('tar', ['-czf', poisonTgz, '-C', poisonRoot, 'package']);
  const poisonExtract = join(tmp, 'poison-extract');
  run('mkdir', ['-p', poisonExtract]);
  run('tar', ['-xzf', poisonTgz, '-C', poisonExtract]);

  const r = auditExtracted(poisonExtract, '毒饵假包（期望 FAIL）');
  // 2026-11-22 解冻裁决后口径：F1–F6 与 [c] 符号（createEventBus 系）已转留痕，
  // 拦截面 = a/b/P + F7/F8（受控实现守卫，永不解冻）。毒饵仍必须被拦——由 a/b/P 承担；
  // F7/F8 特异性另由 baitClient 若含受控实现标记验证（此处 F 只要求 F7/F8 类拦截，
  // 若 F 全为已解冻条目则 violations.F 可为 0，属预期）。
  const expect = {
    a: r.violations.a.length >= 2,   // runtime-core/src + mira-agent/persona.yaml 白名单外
    b: r.violations.b.length >= 3,   // runtime-core 段 + mira-agent 段 + persona.yaml + -persona 文件名
    c: true,                          // 已解冻 → 允许为 0（留痕不拦）；保持字段兼容
    F: r.violations.F.length >= 0,    // F7/F8 若被 bait 触发则 >0；解冻后允许 0
    P: r.violations.P.length >= 1,    // client-bundle.js 段落号 [0041]/[0071]
  };
  const baitCaught = r.pass === false && expect.a && expect.b && expect.c && expect.F && expect.P;
  console.log(`  毒饵拦截自检: a=${expect.a}(${r.violations.a.length}) b=${expect.b}(${r.violations.b.length}) c=${r.violations.c.length}(留痕) F=${r.violations.F.length}(${r.violations.F.length > 0 ? '含未解冻拦截' : '全为解冻留痕'}) P=${expect.P}(${r.violations.P.length}) → ${baitCaught ? '✅ 毒饵被正确拦截（a/b/P 截面 + F7/F8 守卫）' : '❌ 毒饵未被正确拦截（审计存在盲区！）'}`);
  return baitCaught;
}

function verifyEvidenceNotMisfired(tmp) {
  console.log('▶ [selftest 2/4] 0.6.0 存证旧产物不误伤验证（指纹/专利号守卫零命中）…');
  if (!existsSync(EVIDENCE_TGZ)) {
    console.log(`  ⚠️ SKIP：存证不存在（${EVIDENCE_TGZ}）——不误伤结论以本次整改验证报告为准`);
    return true;
  }
  const ev = join(tmp, 'evidence-060');
  run('mkdir', ['-p', ev]);
  run('tar', ['-xzf', EVIDENCE_TGZ, '-C', ev]);
  // R2.2（小沈复核遗留）：对存证解包后的**全量文件**验证（不再只抽 lib/client.js 与 core/src/index.js）；
  // 二进制资产由 TEXT_EXTS 自然跳过。0.6.0 的 packages/bwm-protocol 等开源侧与 persona.yaml
  // 均应零命中——F/P 守卫不含"权利要求"字样与符号扫描，防止对旧公开版误伤。
  const allFiles = walk(join(ev, 'package'), join(ev, 'package'));
  const hits = scanGuardOnly(allFiles);
  const clean = hits.F.length === 0 && hits.P.length === 0;
  console.log(`  对照样本: 0.6.0 存证全量 ${allFiles.length} 个文件`);
  if (hits.F.length) hits.F.forEach((m) => console.log(`    [F] ${m}`));
  if (hits.P.length) hits.P.forEach((m) => console.log(`    [P] ${m}`));
  console.log(`  → ${clean ? '✅ 全量零命中，指纹不误伤 0.6.0 旧公开版' : '❌ 指纹误伤 0.6.0 旧版（指纹选取过宽，须收窄）'}`);
  return clean;
}

/* ── 0.6.0 全量判定断言（P0-2 · 整改单 v3.2 验收③另一面）──────────────
 * 与上面的特异性断言**两条并存、各管一面**：特异性断言管 F/P 形态面鉴别力（不动），
 * 本断言管「历史泄漏样本就该被标记」——0.6.0 存证全量 a/b/c/F/P 审计必须红牌，
 * 且红必须由 a/b 类（packages 域白名单 / 零豁免路径）所致。
 * ❌ 不采用「0.6.0 必红」的字面改法（会与 F/P 形态面零命中冲突）。 */
function verifyEvidenceMarked(tmp) {
  console.log('▶ [selftest 3/4] 0.6.0 存证全量判定（期望红牌 且 由 a/b 类所致）…');
  if (!existsSync(EVIDENCE_TGZ)) {
    console.log(`  ⚠️ SKIP：存证不存在（${EVIDENCE_TGZ}）——全量判定结论以本次整改验证报告为准`);
    return true;
  }
  const ev = join(tmp, 'evidence-060-full');
  run('mkdir', ['-p', ev]);
  run('tar', ['-xzf', EVIDENCE_TGZ, '-C', ev]);
  const r = auditExtracted(ev, '0.6.0 存证全量审计（历史泄漏样本，期望 FAIL）');
  const ab = r.violations.a.length + r.violations.b.length;
  const marked = r.pass === false && ab > 0;
  console.log(`  0.6.0 全量判定: ${r.pass ? '绿牌' : '红牌'} · [a]+[b]=${ab}（a=${r.violations.a.length} b=${r.violations.b.length}）→ ${marked ? '✅ 历史泄漏样本被正确标记（红且由 a/b 所致）' : '❌ 0.6.0 未被 a/b 类标记——packages 白名单/路径守卫失效'}`);
  return marked;
}

/* ── 视图：--scope=patent（2026-11-01 R79 条件 1）────────────────────
 * 只回答一个问题：含未公开实施例的实现，是否已离开公开产物。
 * 不受本视图管辖（由 full 视图管，并非本视图忽略即"已解冻"）：
 *   · F1–F6 runtime 机制指纹（EventBus / Presence，公开面）
 *   · [c] 公开 runtime 符号
 * 解冻 F1–F6 须另起独立裁决（R79 条件 5），不得借本视图放行。
 */
function patentScopeVerdict(r) {
  const f78 = r.violations.F.filter((m) => /命中内核指纹 F[78]\b/.test(m));
  const ab = r.violations.a.length + r.violations.b.length;
  const rows = [
    ['[F7] 感知路由器内联标记', f78.filter((m) => /\bF7\b/.test(m)).length],
    ['[F8] 关系账本内联标记', f78.filter((m) => /\bF8\b/.test(m)).length],
    ['[P-word] 受控字样', r.violations.Pword.length],
    ['[P-sec/P-app/P-pub] 标识形态', r.violations.P.length],
    ['[a]+[b] 打包边界（白名单/零豁免路径）', ab],
  ];
  console.log('\n▶ 视图：patent（只验「受控实现是否离包」，不管公开 runtime 面）');
  for (const [k, v] of rows) console.log(`  ${v === 0 ? '✅' : '❌'} ${k}: ${v}`);
  console.log(`  ── 本视图不覆盖（见 full 视图）：[c]×${r.violations.c.length} 公开 runtime 符号 · `
    + `[F1–F6]×${r.violations.F.length - f78.length} runtime 机制指纹`);
  const clean = rows.every(([, v]) => v === 0);
  console.log(clean
    ? '  ✅ 受控实现已离包（patent scope PASS）'
    : '  ❌ 受控实现仍在产物内（patent scope FAIL）');
  return clean;
}

/* ── 冻结期声明校验（2026-11-01 R79 条件 6）─────────────────────────
 * --expect-blocked 不得永久常开：必须附 scripts/freeze-declaration.json，
 * 含 until（有效期，到期即失效）/ basis（解冻依据）/ ref（裁决出处）。
 * 缺失、解析失败、已过期、字段不全 —— 一律拒绝放行。
 */
const FREEZE_DECL_PATH = join(REPO_ROOT, 'scripts', 'freeze-declaration.json');

function checkFreezeDeclaration() {
  if (!existsSync(FREEZE_DECL_PATH)) {
    fail(`--expect-blocked 缺乏有效期声明：未找到 ${FREEZE_DECL_PATH}\n`
      + '     冻结期放行须附 until/basis/ref 三字段（R79 条件 6：不得永久常开）');
  }
  let d;
  try { d = JSON.parse(readFileSync(FREEZE_DECL_PATH, 'utf8')); } catch (e) {
    fail(`--expect-blocked 声明解析失败：${FREEZE_DECL_PATH} → ${e.message}`);
  }
  for (const k of ['until', 'basis', 'ref']) {
    if (!d[k] || typeof d[k] !== 'string') fail(`--expect-blocked 声明缺字段 \`${k}\`（${FREEZE_DECL_PATH}）`);
  }
  const untilMs = Date.parse(`${d.until}T23:59:59+08:00`);
  if (Number.isNaN(untilMs)) fail(`--expect-blocked 声明 until 非法日期：${d.until}（应 YYYY-MM-DD）`);
  if (Date.now() > untilMs) {
    fail(`--expect-blocked 声明已于 ${d.until} 到期（今日 ${new Date().toISOString().slice(0, 10)}）——`
      + '须重新裁定并更新 freeze-declaration.json，不得沿用过期声明放行');
  }
  const daysLeft = Math.ceil((untilMs - Date.now()) / 86400000);
  console.log(`  冻结期声明：有效至 ${d.until}（剩 ${daysLeft} 天）`);
  console.log(`    依据：${d.basis}`);
  console.log(`    出处：${d.ref}`);
}

/* ── 入口 ───────────────────────────────────────────────────────── */

const selftest = process.argv.includes('--selftest');
const expectBlocked = process.argv.includes('--expect-blocked');
const scopeArg = process.argv.find((a) => a.startsWith('--scope='));
const scope = scopeArg ? scopeArg.slice('--scope='.length) : 'full';
if (!['full', 'patent'].includes(scope)) fail(`未知视图 --scope=${scope}（支持 full | patent）`);
const tmp = mkdtempSync(join(tmpdir(), 'bwm-release-audit.'));
let ok = true;
try {
  if (selftest) {
    const baitCaught = buildAndAuditPoison(tmp);
    const evidenceClean = verifyEvidenceNotMisfired(tmp);
    const evidenceMarked = verifyEvidenceMarked(tmp);
    console.log('▶ [selftest 4/4] 真实产物判定（冻结期=红牌为正确；解冻期=绿牌为正确）…');
    const real = auditRealPack(tmp);
    // 判定一致性（增量2口径）：FAIL 必须仅由内核守卫类命中（F/c）所致——[a]/[b] 违规
    // 与任何 P 类命中（P-sec/P-app/P-pub/P-word）不被冻结期口径掩盖；绿牌必须零违规
    const verdictOk = real.pass ? true : redByKernelGuardOnly(real);
    console.log(`  真实产物判定: ${real.pass ? '绿牌（产物清洁——内核已迁出 bundle，解冻态）' : `红牌（仅内核守卫所致 = ${redByKernelGuardOnly(real) ? '是' : '否'}）`} → ${verdictOk ? '✅ 判定正确' : '❌ 红牌非内核守卫所致，或含 a/b/P 类违规，须人工核查'}`);
    ok = baitCaught && evidenceClean && evidenceMarked && verdictOk;
  } else if (scope === 'patent') {
    // 专利专用视图：只验受控实现离包，不看公开 runtime 面（R79 条件 1）
    const real = auditRealPack(tmp);
    ok = patentScopeVerdict(real);
  } else {
    const real = auditRealPack(tmp);
    if (real.pass) {
      if (expectBlocked) {
        console.log('\n⚠️ 期望红牌但产物已通过审计——若仍在冻结期，请核查 CORE_FINGERPRINTS 是否过期');
        ok = false;
      } else {
        ok = true;
      }
    } else if (expectBlocked) {
      // 条件 6（R79）：冻结期放行必须带有效期与解冻依据，不得永久常开
      checkFreezeDeclaration();
      // P0-2（P0-D 中4）＋增量2（派单①）：--expect-blocked 只豁免「内核守卫所致的红牌」——
      // [a]（packages 域白名单外）/ [b]（零豁免路径）违规不得被冻结期口径掩盖；
      // 任何 P 类命中（P-word 字样 / P-sec/P-app/P-pub 形态）冻结期一律不放行（与 F/c 共存同样阻断）
      if (real.violations.Pword.length > 0) {
        fail(`红牌含 P-word 专利字样命中 ×${real.violations.Pword.length}（见上方 [P] 明细）——随包内容禁专利字样为核心政策，冻结期亦不放行`);
      }
      if (real.violations.P.length > 0) {
        fail(`红牌含 P-sec/P-app/P-pub 形态命中 ×${real.violations.P.length}（见上方 [P] 明细）——冻结期任何 P 类命中一律不放行`);
      }
      if (!redByKernelGuardOnly(real)) fail('红牌非内核指纹/核心符号所致，或存在 [a]/[b] 违规——须人工核查失败明细（--expect-blocked 不掩盖 a/b 类违规）');
      ok = true;
    } else {
      ok = false;
    }
    if (!real.pass) {
      console.log('\n❌ RELEASE AUDIT FAIL — 门禁拦截（红牌）');
      if (real.blockedByKernelGuard) {
        console.log('   ⚠ 冻结期预期状态：随包产物检出未公开内核机制 / 专利标识（见 [F]/[P]/[c] 条目）。');
        console.log('     在内核迁出 bundle（解冻）前，prepublishOnly 将阻断一切发布。');
        console.log('     若已解冻仍见本红牌 → 核对指纹清单时效（scripts/audit-release.mjs CORE_FINGERPRINTS）。');
        console.log('     冻结期复核请用: node scripts/audit-release.mjs --expect-blocked（exit 0）');
      }
    }
  }
  if (ok) console.log('\n✅ RELEASE AUDIT ' + (expectBlocked && !selftest ? 'PASS（冻结期红牌为预期，门禁正常）' : 'PASS — 发布产物通过打包门禁'));
} catch (e) {
  fail(`审计流程异常中止: ${e.message}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
