/**
 * theme-alias-parity.mjs — 覆写表对账回归测试（0.8.46 判例固化，P12 强制点）
 *
 * 背景：皮肤插件用手工维护的 `--dsw-alias-*` 覆写表模拟 DSH 官方深色主题。
 * 覆写表是第二真相源，随宿主升级必然漂移；漏项**静默回退官方浅色值**（近白），
 * 表现为「某控件白块 / 白底白字」且不报错——0.8.36（弹层白底白字）与
 * 0.8.46（文件变更卡白块）是同族事故的两次发作。判例：
 * 创世者知识库 01_Inbox/2026-11-21_判例_BWM插件覆写表漂移_文件变更卡白块与alias逐项对账法.md
 *
 * 本测试把「文档里的对账方法」变成会报错的闸门：
 *   从已安装 DSH 的 app.asar 提取官方深色块（body[data-ds-dark-theme]{…}）声明的
 *   alias 全集，与 src/client.js 覆写表求差；**差集非空即 fail**（验收线 diff=0）。
 *   反向多余项仅告警不拦（插件可能提前覆盖旧 token，无害）。
 *
 * 运行：node tests/theme-alias-parity.mjs（已挂 npm run test:theme → npm test）
 * 退出码：0 = 对账通过；1 = 有漏项 / asar 不可达。
 * asar 路径：默认 macOS Desktop 安装位，可用 env DSH_ASAR 覆盖。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcPath = join(repoRoot, 'src', 'client.js');

const asarPath = process.env.DSH_ASAR
  || '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';

/* 深色块锚点：一个只出现在深色主题块的专属值（file-diff-added 深绿底）。
 * 宿主升级若换肤值导致锚点失配，测试会以 exit 1 报出——那本身就是
 * 「官方主题变了，覆写表需要重新对账」的信号，属预期失败模式。 */
const DARK_ANCHOR = '--dsw-alias-file-diff-added-bg: rgb(31, 49, 36)';
const ALIAS_DECL_RE = /--dsw-alias-[a-z0-9-]+:/g;

function officialDarkAliases() {
  let txt;
  try {
    txt = readFileSync(asarPath).toString('latin1');
  } catch (error) {
    console.error(`✖ 无法读取 DSH asar（${asarPath}）：${error.message}`);
    console.error('  请确认 DSH Desktop 已安装，或用 env DSH_ASAR=<路径> 指定。');
    process.exit(1);
  }
  const anchor = txt.indexOf(DARK_ANCHOR);
  if (anchor === -1) {
    console.error('✖ 深色块锚点失配（官方主题值已变）——覆写表需要重新人工对账。');
    console.error('  处理：在 asar 里重新定位深色块专属值，更新本文件的 DARK_ANCHOR。');
    process.exit(1);
  }
  // 精确取锚点所在的声明块（前推最近 "{"，后推最近 "}"），不靠窗口猜测
  const start = txt.lastIndexOf('{', anchor);
  const end = txt.indexOf('}', anchor);
  const block = txt.slice(start, end);
  return new Set([...block.matchAll(ALIAS_DECL_RE)].map((m) => m[0].slice(0, -1)));
}

function overrideAliases() {
  const src = readFileSync(srcPath, 'utf8');
  /* 只认「带冒号的声明」——注释/文档里提到的 token 名不算覆写
   *（拦截实测教训：按裸名匹配时删掉声明行测试仍绿，闸门静默放行） */
  return new Set([...src.matchAll(/(--dsw-alias-[a-z0-9-]+):/g)].map((m) => m[1]));
}

const official = officialDarkAliases();
const overrides = overrideAliases();

const missing = [...official].filter((name) => !overrides.has(name)).sort();
const extra = [...overrides].filter((name) => !official.has(name)).sort();

console.log(`官方深色块 alias：${official.size} 个（${asarPath}）`);
console.log(`插件覆写表 alias：${overrides.size} 个（src/client.js）`);

if (missing.length > 0) {
  console.error(`\n✖ 对账失败：覆写表漏 ${missing.length} 项（会静默回退官方浅色值 → 白块/白底白字）：`);
  for (const name of missing) console.error(`  ${name}`);
  console.error('\n修复：从 asar 深色块抄官方深色原值补入 src/client.js 覆写表（判例 0.8.46）。');
  process.exit(1);
}

if (extra.length > 0) {
  console.warn(`⚠ 覆写表含官方深色块未声明的 ${extra.length} 项（仅告警，不拦）：`);
  for (const name of extra) console.warn(`  ${name}`);
}

console.log('✔ alias 对账通过：diff = 0（0.8.46 判例回归线）');
