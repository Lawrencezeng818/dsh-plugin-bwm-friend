/**
 * build-client.mjs — minimal build for the browser half.
 *
 * Reproduces the exact artifact shape the DSH client module loader consumes,
 * the same shape `tsdown` emits for in-box client packages:
 *
 *     window.__ModuleLoader__.load({
 *       id: "<package-name>",
 *       factory: (require) => {
 *         var module = { exports: {} };
 *         var exports = module.exports;
 *         Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
 *         <src/client.js body, indent-normalized>
 *         return module.exports;
 *       }
 *     });
 *
 * The body must end I. `return module.exports` (it does). This script is a
 * deterministic, dependency-free stand-in for `tsdown bundle`: it produces the
 * same single-file `window.__ModuleLoader__.load(...)` envelope without a
 * bundler, which keeps the out-of-tree package buildable with plain Node.
 *
 * Usage:  node scripts/build-client.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INLINE_MODULES, stripReleaseComments } from './inline-modules.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const id = pkg.name;

const src = readFileSync(resolve(root, 'src', 'client.js'), 'utf8');
const body = stripHeader(src).replace(/\r\n/g, '\n').replace(/\n+$/, '');

// P1.1：内联注入 @laikaton/bwm-runtime-core（物理隔离 + 运行时自包含）
// Shell 源码 `require('@laikaton/bwm-runtime-core')` → build 时解析为内联模块；
// 未来 runtime 服务化/真依赖时，Shell 源码无需改动（__bwmRequire 换解析目标）。
//
// 2026-09-13 修复（F4）：内核自 v0.7.0 起在顶层 require 其兄弟模块 './perception-router.js'，
//   而本脚本原只内联 index.js 单文件 —— 重建产物执行到该 require 时解析不到（浏览器无此模块），
//   客户端半加载即抛错；已提交的旧产物只是"构建于该提交之前"才侥幸可用（即产物落后于源）。
//   现改为「内联模块按依赖顺序注册」：内核的兄弟依赖与内核自身一同内联，
//   且 __bwmRequire 必须在任何内联模块执行之前定义（内核顶层 require 立即求值）。
// 内联模块清单已抽至 ./inline-modules.mjs（单一来源）：构建侧与 parity 校验侧共用，防两处不同步。

// 读入各内联模块源码，并把「指向兄弟内联模块的 require」改写为 __bwmRequire
const inlined = INLINE_MODULES.map(({ id: modId, entry }) => {
  let code = stripReleaseComments(readFileSync(entry, 'utf8'));
  for (const dep of INLINE_MODULES) {
    code = code.replaceAll(`require('${dep.id}')`, `__bwmRequire('${dep.id}')`);
  }
  return { id: modId, code };
});

const bodyWithRuntime = body.replaceAll(
  "require('@laikaton/bwm-runtime-core')",
  "__bwmRequire('@laikaton/bwm-runtime-core')"
);

const outline = [
  'window.__ModuleLoader__.load({',
  `\tid: ${JSON.stringify(id)},`,
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
  '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
  // ── 内联模块注册表（P1.1 内核；2026-09-13 F4 扩展至内核的兄弟依赖）──
  "\t\tvar __bwmModules = {};",
  // __bwmRequire 先于任何内联模块定义：内联模块顶层可能立即 require 其兄弟模块
  "\t\tvar __bwmRequire = function(name) { return __bwmModules[name] || require(name); };",
];

// 逐个注册内联模块（注册即执行；依赖顺序由 INLINE_MODULES 保证）
for (const { id: modId, code } of inlined) {
  outline.push(`\t\t__bwmModules[${JSON.stringify(modId)}] = (function() {`);
  outline.push('\t\t\tvar module = { exports: {} };');
  outline.push('\t\t\tvar exports = module.exports;');
  outline.push(
    code
      .split('\n')
      .map((line) => (line.trim() === '' ? '' : '\t\t\t' + line))
      .join('\n')
  );
  outline.push('\t\t\treturn module.exports;');
  outline.push('\t\t})();');
}

// ── client body（require 已替换为 __bwmRequire）──
const indented = bodyWithRuntime
  .split('\n')
  .map((line) => (line.trim() === '' ? '' : '\t\t' + line))
  .join('\n');

outline.push(indented);
outline.push('\t},');
outline.push('});');
outline.push('');

const output = outline.join('\n');

const target = resolve(root, 'lib', 'client.js');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, output);
console.log(`built ${target} (${output.length} bytes)`);

// Header comments in the source are preserved inside the factory, which is
// harmless, but strip the leading "this is not the artifact / edit src" banner
// so the emitted bundle reads as a compiled artifact.
function stripHeader(srcText) {
  const lines = srcText.split('\n');
  let codeStart = 0;
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inBlock && /^\s*\/\*\*/.test(line)) inBlock = true;
    else if (inBlock && /\*\/\s*$/.test(line)) { codeStart = i + 1; break; }
  }
  return lines.slice(codeStart).join('\n');
}
