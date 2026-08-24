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

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const id = pkg.name;

const src = readFileSync(resolve(root, 'src', 'client.js'), 'utf8');
const body = stripHeader(src).replace(/\r\n/g, '\n').replace(/\n+$/, '');

// P1.1：内联注入 @laikaton/bwm-runtime-core（物理隔离 + 运行时自包含）
// Shell 源码 `require('@laikaton/bwm-runtime-core')` → build 时解析为内联模块；
// 未来 runtime 服务化/真依赖时，Shell 源码无需改动（__bwmRequire 换解析目标）。
const runtimeSrc = readFileSync(resolve(root, 'packages', 'bwm-runtime-core', 'src', 'index.js'), 'utf8');
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
  // ── runtime-core 内联模块注册表（P1.1）──
  "\t\tvar __bwmModules = {};",
  "\t\t__bwmModules['@laikaton/bwm-runtime-core'] = (function() {",
  '\t\t\tvar module = { exports: {} };',
  '\t\t\tvar exports = module.exports;',
];

// runtime 源码按三 tab 缩进
const runtimeIndented = runtimeSrc
  .split('\n')
  .map((line) => (line.trim() === '' ? '' : '\t\t\t' + line))
  .join('\n');
outline.push(runtimeIndented);
outline.push('\t\t\treturn module.exports;');
outline.push('\t\t})();');
outline.push("\t\tvar __bwmRequire = function(name) { return __bwmModules[name] || require(name); };");

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
