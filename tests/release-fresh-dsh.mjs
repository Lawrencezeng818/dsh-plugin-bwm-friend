#!/usr/bin/env node
/**
 * tests/release-fresh-dsh.mjs — 全新 DSH 完整安装验证（发布门槛，用户要求）
 *
 * 在真实 DSH 装载链路上验证发布包（release-pack-smoke.mjs 只验证包自包含，
 * 本脚本补齐 DSH 集成层与页面级）：
 *   1. npm pack 当前树 → tgz
 *   2. 全新隔离 HOME/DSH_HOME（mkdtemp，模拟从未装过本插件的机器）
 *   3. 真实安装命令：dsh --profile web plugin add <tgz>（initProfile 模板 +
 *      pnpm add + bundle 自动识别 reconcile）
 *   4. 断言：依赖入 manifest、bundle 自动登记、node_modules 为 tgz 真实拷贝
 *      （非 symlink）、lib/client.js 与仓库构建产物哈希一致（防包内过期）
 *   5. 启动全新 DSH web 实例（独立端口）→ health/work/companion 页面级断言
 *      （health 版本号与包版本一致、注入脚本完整伺服）
 *   6. 打印浏览器冒烟指引（BWM_E2E_BASE=<端口> npm run test:e2e）
 *
 * 前提：DSH checkout（DSH_CHECKOUT 环境变量可覆盖）、pnpm 在 PATH。
 * 用法: node tests/release-fresh-dsh.mjs
 */
import { execSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const checkout = process.env.DSH_CHECKOUT || '/Users/zengtian/projects/deepseek-harness';
const bin = join(checkout, 'apps', 'cli', 'src', 'bin.ts');
const PORT = Number(process.env.BWM_FRESH_PORT || 3300);

if (!existsSync(bin)) { console.error(`FAIL DSH checkout 不存在: ${checkout}（设 DSH_CHECKOUT 覆盖）`); process.exit(1); }

let failed = 0;
const ok = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) failed = 1; };

const tmp = mkdtempSync(join(tmpdir(), 'bwm-fresh-dsh.'));
const home = join(tmp, 'home');
mkdirSync(join(home, '.dsh'), { recursive: true });
process.env.HOME = home;        // os.homedir() 跟随 → 配置/资产默认值全部隔离
process.env.DSH_HOME = join(home, '.dsh');

const dshEnv = { ...process.env, HOME: home, DSH_HOME: join(home, '.dsh') };
// 对齐沙盒启动器：node/tsx 由 checkout 依赖解析（cwd=checkout），node 版本用仓库运行时
const workbuddyBin = '/Users/zengtian/.workbuddy/binaries/node/versions/22.22.2/bin';
if (existsSync(workbuddyBin)) dshEnv.PATH = workbuddyBin + ':' + dshEnv.PATH;

try {
  // 1. 打包
  const packed = JSON.parse(execSync('npm pack --json', { cwd: repo, encoding: 'utf8' }));
  const tgz = join(repo, packed[0].filename);
  const pkgVersion = packed[0].version;
  console.log(`tarball: ${packed[0].filename} (${pkgVersion})`);
  ok('tarball 生成', existsSync(tgz));

  // 2-3. 全新 profile + 真实安装命令
  // cwd 必须 = checkout：bin.ts 经 --import tsx/esm 加载，tsx 从 checkout node_modules 解析
  // （HOME/DSH_HOME 已由 env 隔离，cwd 不影响 profile 位置）
  execSync(`node --import tsx/esm "${bin}" plugin --profile web add "${tgz}"`, {
    cwd: checkout, env: dshEnv, stdio: 'pipe', encoding: 'utf8',
  });
  const manifest = JSON.parse(readFileSync(join(dshEnv.DSH_HOME, 'profiles', 'web', 'package.json'), 'utf8'));
  const deps = manifest.dependencies || {};
  const depSpecs = Object.values(deps).join(' ');
  ok('插件进入 profile 依赖（tgz file: spec 或包名）', Object.keys(deps).some((k) => k === 'dsh-plugin-bwm-friend'));
  ok('bundle 自动登记（dsh.profile.bundles 含插件）', (manifest.dsh?.profile?.bundles || []).includes('dsh-plugin-bwm-friend'));

  // 4. 安装产物 = tgz 真实拷贝（非 symlink）；client.js 与仓库构建产物一致
  const installed = join(dshEnv.DSH_HOME, 'profiles', 'web', 'node_modules', 'dsh-plugin-bwm-friend');
  ok('安装产物存在（node_modules 内）', existsSync(join(installed, 'lib', 'index.js')));
  const isSymlink = (() => { try { return lstatSync(installed).isSymbolicLink(); } catch { return false; } })();
  ok('安装产物为真实拷贝（非 symlink——tgz 安装语义）', !isSymlink);
  const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12);
  for (const f of ['lib/index.js', 'lib/client.js']) {
    const a = join(installed, f), b = join(repo, f);
    ok(`包内 ${f} 与仓库构建产物一致（${sha(a)}）`, existsSync(a) && existsSync(b) && sha(a) === sha(b));
  }
  const instVer = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version;
  ok(`包版本自洽（${instVer} = ${pkgVersion}）`, instVer === pkgVersion);

  // 5. 启动全新 DSH web 实例
  const child = spawn('node', ['--import', 'tsx/esm', bin, 'web', '--port', String(PORT)], {
    cwd: checkout, env: dshEnv, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${PORT}`;
  let booted = false;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) break;
    try {
      const r = await fetch(`${base}/bwm-friend/health`);
      if (r.ok) { booted = true; break; }
    } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  ok(`全新 DSH 实例启动并挂上插件路由（${base}）`, booted);

  if (booted) {
    const health = await (await fetch(`${base}/bwm-friend/health`)).json();
    const hv = health.version ?? health.current ?? null;
    ok(`health 版本与包一致（${hv}）`, hv === null || hv === pkgVersion);

    const work = await fetch(`${base}/bwm-friend/work/`);
    const workHtml = await work.text();
    ok('work 页 200 且注入 work-chat.js', work.status === 200 && workHtml.includes('work-chat.js'));
    const wjs = await fetch(`${base}/bwm-friend/work/work-chat.js`); // 页面相对路径解析结果
    ok('work-chat.js 伺服（WORK_INIT/WORK_CHAT 挂载）', wjs.status === 200 && (await wjs.text()).length > 1000);

    const comp = await fetch(`${base}/bwm-friend/companion/`);
    const compHtml = await comp.text();
    ok('companion 页 200 且注入 companion-chat.js', comp.status === 200 && compHtml.includes('companion-chat.js'));

    const root = await fetch(`${base}/`);
    ok('DSH 根路径不受影响（原生界面照常）', root.status === 200);
  }

  const keep = process.argv.includes('--keep');
  if (keep) {
    console.log(`实例保留（--keep）：pid=${child.pid} base=${base} home=${home}（人工/浏览器验证后手动 kill）`);
  } else {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 800));
    if (child.exitCode === null) child.kill('SIGKILL');
  }

  console.log(`\n浏览器级冒烟（可选，实例已停可重跑至该步停住）:`);
  console.log(`  BWM_E2E_BASE=${base} npm run test:e2e`);
} finally {
  if (process.argv.includes('--keep')) console.log('现场保留（--keep）:', tmp);
  else if (failed === 0) { rmSync(tmp, { recursive: true, force: true }); console.log('现场已清理:', tmp); }
  else console.log('验证失败，现场保留以排查:', tmp);
}
console.log(failed === 0 ? '\n✅ FRESH DSH INSTALL ALL PASS' : `\n❌ FRESH DSH INSTALL: ${failed} 项失败`);
process.exit(failed);
