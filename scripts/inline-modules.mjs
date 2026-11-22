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
  // 2026-11-01 P1-lite：专利 4（关系账本）/ 专利 5（感知路由器）实现已迁出本仓公开包，
  // 迁往 @laikaton/bwm-cognitive-core（私有 · 永不发布 · 永不内联）。
  // 依据：取证报告_2026-11-01_P0 + R79 独立复核（B 维持 + --scope=patent）。
  // 🔴 禁止在此重新加入上述两条：audit [F] F7/F8 守卫会拦，且构成专利自我公开（R2）。
  { id: '@laikaton/bwm-runtime-core', entry: resolve(RUNTIME_SRC_DIR, 'index.js') },
];

/* ── 市场发布加固（0.8.47，决策：decisions/决策记录_2026-11-22_解除060发布冻结与DSH市场发布路径.md 风险1）──
 * 内联闭源核心随包分发时剥离「整行注释」（// 与 /* 开头的行，含块注释续行 *），
 * 去除中文设计注释的可读机制说明；行尾内联短注释保留（不触碰字符串内容，零功能风险）。
 * 构建侧与 parity 校验侧共用本函数（单一来源），校验侧先施加同一变换再比对。 */
export function stripReleaseComments(code) {
  return code
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('/*') || t.startsWith('*'));
    })
    .join('\n');
}
