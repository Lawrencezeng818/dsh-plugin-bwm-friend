/**
 * inline-modules.mjs — 内联模块注册表（**单一来源**）
 *
 * 背景（2026-09-14）：该列表原先在 scripts/build-client.mjs（构建侧）与
 * tests/build-artifact-parity.mjs（校验侧）各维护一份。内核新增第二个兄弟依赖
 * `./relationship-ledger.js` 时只更新了构建侧一处，导致两侧口径不一致
 * （构建侧内联了新模块、校验侧未把 `require('./relationship-ledger.js')`
 * 改写为 `__bwmRequire(...)` 做归一化 → 假 FAIL）。
 * 现抽为单一来源：增删内联模块只需改本文件，构建与校验自动同步。
 *
 * 顺序 = 依赖顺序：被依赖者先注册（内核顶层立即 require 其依赖）。
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const RUNTIME_SRC_DIR = resolve(ROOT, 'packages', 'bwm-runtime-core', 'src');

export const INLINE_MODULES = [
  { id: './perception-router.js', entry: resolve(RUNTIME_SRC_DIR, 'perception-router.js') },
  // 2026-09-14：专利4 权1 六步机制链实现（关系账本）
  { id: './relationship-ledger.js', entry: resolve(RUNTIME_SRC_DIR, 'relationship-ledger.js') },
  { id: '@laikaton/bwm-runtime-core', entry: resolve(RUNTIME_SRC_DIR, 'index.js') },
];
