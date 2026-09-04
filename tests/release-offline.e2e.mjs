#!/usr/bin/env node
/**
 * tests/release-offline.e2e.mjs — 发布工程收尾（完成度批次8）
 * ① 离线可装性（最强干净环境）：npm pack → 临时目录只装本地 tgz（skin 先装本地包满足依赖，
 *    再 --offline 装插件——全程不查 registry）→ 对「装出来的产物」跑 health/version/路由/静态资产冒烟
 * ② 更新检查路径：BWM_UPDATE_URL 指向本地 mock——新版可检/同版不更/不可达 fail-open
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, cpSync, rm } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import http from 'node:http';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const ok = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) failed = 1; return cond; };

// ① 离线安装
const scratch = mkdtempSync(join(tmpdir(), 'bwm-offline.'));
let pkgDir = null;
try {
  execSync('npm pack --json', { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const packed = JSON.parse(execSync('npm pack --json', { cwd: repo, encoding: 'utf8' }));
  const pluginTgz = join(repo, packed[0].filename);
  ok(`npm pack（${packed[0].size}B）`, packed[0].size > 10000);
  const skinTgz = join(scratch, 'skin.tgz');
  execSync(`npm pack ${join(repo, 'node_modules', '@laikaton', 'bwm-skin-mira')} --pack-destination ${scratch}`, { encoding: 'utf8' });
  const skinFile = (await fsp.readdir(scratch)).find((f) => /^laikaton-bwm-skin-mira.*\.tgz$/.test(f));
  cpSync(join(scratch, skinFile), skinTgz);
  execSync('npm init -y', { cwd: scratch, encoding: 'utf8', stdio: 'ignore' });
  execSync(`npm install "${skinTgz}" --no-audit --no-fund --loglevel=error`, { cwd: scratch, encoding: 'utf8', stdio: 'ignore' });
  execSync(`npm install "${pluginTgz}" --offline --no-audit --no-fund --loglevel=error`, { cwd: scratch, encoding: 'utf8', stdio: 'ignore' });
  pkgDir = join(scratch, 'node_modules', 'dsh-plugin-bwm-friend');
  const installedPkg = JSON.parse(await fsp.readFile(join(pkgDir, 'package.json'), 'utf8'));
  ok('离线安装成功（零 registry 访问）', installedPkg.name === 'dsh-plugin-bwm-friend');
  await fsp.access(join(pkgDir, 'lib', 'index.js'));
  await fsp.access(join(pkgDir, 'static-ui', 'app.js'));
  ok('产物完整（lib + static-ui 随包）', true);
  const isolatedHome = join(scratch, 'home');
  mkdirSync(isolatedHome, { recursive: true });

  // ② 更新检查三态 + 装机冒烟（对安装产物起 shim）
  let mockVersion = '0.0.1'; // 由主进程按场景切换（shim env 传不到这里）
  const mockUpdate = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: mockVersion }));
  });
  await new Promise((r) => mockUpdate.listen(0, '127.0.0.1', r));
  const updatePort = mockUpdate.address().port;

  const runShim = async (env) => {
    const port = 8960 + Math.floor(Math.random() * 30);
    const shim = spawn(process.execPath, [join(repo, 'tests', 'verify-shim.mjs'), join(pkgDir, 'lib', 'index.js'), String(port)], {
      env: { ...process.env, HOME: isolatedHome, BWM_LOG_DISABLE: '1', ...env }, stdio: 'ignore',
    });
    let up = false;
    for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/bwm-friend/health`)).status === 200) { up = true; break; } } catch { /* retry */ } await new Promise((r) => setTimeout(r, 250)); }
    return { shim, port, up };
  };

  // 2a. 装机冒烟：version 单源一致 + 路由 + 静态壳
  mockVersion = '9.9.9';
  const a = await runShim({ BWM_UPDATE_URL: `http://127.0.0.1:${updatePort}/bwm-version.json` });
  try {
    ok('装产物 shim 启动', a.up);
    const health = JSON.parse(await (await fetch(`http://127.0.0.1:${a.port}/bwm-friend/health`)).text());
    ok('health.version 与 package.json 单源一致（防漂移）', health.version === installedPkg.version);
    const st = await fetch(`http://127.0.0.1:${a.port}/bwm-friend/settings`);
    ok('装产物路由可服务', st.status === 200);
    // 2b. 新版可检
    const up1 = JSON.parse(await (await fetch(`http://127.0.0.1:${a.port}/bwm-friend/update/check`)).text());
    ok('更新检查: 新版可检（9.9.9 → hasUpdate）', up1.hasUpdate === true && up1.latest === '9.9.9') || console.log('  [dbg up1]', JSON.stringify(up1));
  } finally { a.shim.kill(); }
  // 2c. 同版不更
  mockVersion = installedPkg.version;
  const b = await runShim({ BWM_UPDATE_URL: `http://127.0.0.1:${updatePort}/bwm-version.json` });
  try {
    const up2 = JSON.parse(await (await fetch(`http://127.0.0.1:${b.port}/bwm-friend/update/check`)).text());
    ok('更新检查: 同版不误报', up2.hasUpdate === false && up2.latest === installedPkg.version);
  } finally { b.shim.kill(); }
  // 2d. 不可达 fail-open（不崩、无更新、带 error 标记）
  const c = await runShim({ BWM_UPDATE_URL: 'http://127.0.0.1:1/nope.json' });
  try {
    const up3 = JSON.parse(await (await fetch(`http://127.0.0.1:${c.port}/bwm-friend/update/check`)).text());
    ok('更新检查: 不可达 fail-open（服务不崩）', up3.hasUpdate === false && up3.error === 'network');
  } finally { c.shim.kill(); mockUpdate.close(); }
} finally { rmSync(scratch, { recursive: true, force: true }); for (const f of (await fsp.readdir(repo)).filter((x) => x.endsWith('.tgz'))) await rm(join(repo, f)); }

console.log(failed ? '❌ RELEASE OFFLINE FAIL' : '✅ RELEASE OFFLINE ALL PASS');
process.exit(failed);
