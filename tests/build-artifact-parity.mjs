/**
 * 构建产物 ↔ 源码 一致性校验（build parity guard）
 *
 * 背景（2026-09-13 F4）：`lib/client.js` 由 scripts/build-client.mjs 生成，内联
 * packages/bwm-runtime-core 的内核源码。此前只内联 index.js 单文件，内核 v0.7.0 新增
 * 顶层 require('./perception-router.js') 后，产物一旦重建即加载失败；而已提交的产物
 * 只是"构建于该提交之前"才侥幸可用 —— 即**产物静默落后于源**，缺陷不报错、只潜伏。
 *
 * 本校验用两条硬断言把该缺陷类钉死：
 *   1. 产物可加载：以 DSH 客户端模块加载器的真实外壳求值（react 以桩替代），
 *      factory 必须执行成功，且不请求任何未内联的模块。
 *   2. 产物 ↔ 源码 逐字节一致：从产物中抽出每个内联模块体，去缩进后与对应源文件
 *      （施加 require → __bwmRequire 改写）做**精确比对**。一致即证明：跑在源文件上的
 *      测试结论同样适用于出货产物。
 *
 * 运行：node tests/build-artifact-parity.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INLINE_MODULES, stripReleaseComments } from '../scripts/inline-modules.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = resolve(root, 'lib', 'client.js');

// 内联模块清单由 ../scripts/inline-modules.mjs 提供（单一来源，与构建侧共用）。
// 2026-09-14：此前该列表在本文件与构建脚本各维护一份，内核新增兄弟依赖时漏改一侧会产出假 FAIL，
//   现抽为单一来源。

const failures = [];
const check = (cond, label, detail = '') => {
  if (cond) console.log(`[OK]   ${label}`);
  else { failures.push(label); console.log(`[FAIL] ${label}${detail ? `\n       ${detail}` : ''}`); }
};

/* ── 1. 加载探针（DSH 客户端模块加载器外壳）── */
const bundleText = readFileSync(BUNDLE, 'utf8');
let captured = null;
globalThis.window = { __ModuleLoader__: { load: (spec) => { captured = spec; } } };
try {
  new Function(bundleText)();
  check(!!captured, '产物外壳可求值，__ModuleLoader__.load 被调用');
} catch (e) {
  check(false, '产物外壳可求值', e.message);
}

const requested = [];
if (captured) {
  const stubReact = new Proxy({}, {
    get: (_t, k) => (k === '__esModule' ? true : stubReact),
    apply: () => stubReact,
  });
  const fakeRequire = (name) => {
    requested.push(name);
    if (name === 'react' || name.startsWith('react/') || name.startsWith('react-dom')) return stubReact;
    throw new Error(`unresolved module: ${name}`);
  };
  try {
    captured.factory(fakeRequire);
    check(true, 'factory 执行成功（全部内联模块已注册、无未解析依赖）');
  } catch (e) {
    check(false, 'factory 执行成功', `${e.message} · 已请求: ${JSON.stringify(requested)}`);
  }
  const unresolved = [...new Set(requested)].filter((n) => !n.startsWith('react'));
  check(unresolved.length === 0, '无未内联的运行时依赖', `未解析: ${JSON.stringify(unresolved)}`);
}

/* ── 2. 内联模块体 ↔ 源文件 逐字节比对 ── */
const lines = bundleText.split('\n');
for (const { id, entry } of INLINE_MODULES) {
  const marker = `__bwmModules[${JSON.stringify(id)}] = (function() {`;
  const start = lines.findIndex((l) => l.trim() === marker);
  if (start < 0) { check(false, `内联模块已注册: ${id}`, '产物中未找到注册标记'); continue; }

  // 收集 3 缩进层的模块体，直到 'return module.exports;' 收尾
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === 'return module.exports;') break;
    if (l === '') { body.push(''); continue; }
    if (!l.startsWith('\t\t\t')) continue;            // 跳过 (function(){ ... })(); 样板行
    if (l.trim() === 'var module = { exports: {} };') continue;
    if (l.trim() === 'var exports = module.exports;') continue;
    body.push(l.slice(3));                            // 去 3 tab 缩进，还原源缩进
  }

  let expected = stripReleaseComments(readFileSync(entry, 'utf8'));
  for (const dep of INLINE_MODULES) expected = expected.replaceAll(`require('${dep.id}')`, `__bwmRequire('${dep.id}')`);
  expected = expected.replace(/\n+$/, '');

  const actual = body.join('\n').replace(/\n+$/, '');
  const isSame = actual === expected;
  if (isSame) {
    check(true, `内联模块与源文件逐字节一致: ${id}（${expected.length} 字符）`);
  } else {
    // 定位首个差异行，便于修正
    const a = actual.split('\n'); const b = expected.split('\n');
    let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
    check(false, `内联模块与源文件逐字节一致: ${id}`,
      `首个差异 @ 行 ${i + 1}\n       产物: ${JSON.stringify(a[i])}\n       源  : ${JSON.stringify(b[i])}`);
  }
}

/* ── 3. 关键实现特征出现在产物中（防"内联了但内联的是旧版"）── */
for (const [label, needle] of [
  ['关系域初值（专利1 [0041]）', 'relationship: { stage: RELATIONSHIP_POLICY.stage'],
  ['关系事件接线（专利1 [0071]）', 'wireRelationship(bus, context)'],
  ['域计数单一来源', 'domains: CONTEXT_DOMAINS.length'],
]) {
  check(bundleText.includes(needle), `产物含实现特征：${label}`);
}

/* ── 3b. 专利 4/5 必须离包（2026-11-01 P1-lite · R79 条件 4）──
 * 这四条原先断言「必须存在」，现反转为「必须不存在」：
 * 存在即意味着专利实施例随公开包分发 → 专利自我公开（R2）。
 * 与 audit [F] F7/F8 互为双保险：audit 看构建标记，此处看产物全文。
 */
for (const [label, needle] of [
  ['专利5 感知路由器内联注册标记', '__bwmModules["./perception-router.js"]'],
  ['专利4 关系账本内联注册标记', '__bwmModules["./relationship-ledger.js"]'],
  ['专利4 六步桥接实现', 'bridgePerceptionToLedger'],
  ['专利4 确定性增量规则表', 'rules-v1.0'],
]) {
  check(!bundleText.includes(needle), `产物不含专利实现：${label}`);
}

console.log('');
if (failures.length) {
  console.log(`构建产物一致性校验：FAIL（${failures.length} 项）`);
  process.exit(1);
}
console.log('构建产物一致性校验：PASS（产物可加载 + 内联模块与源文件逐字节一致）');
