#!/usr/bin/env node
/**
 * tests/release-pack-smoke.mjs — 干净机发布冒烟（路径B 发布门槛）
 *
 * npm pack 当前树 → 隔离临时目录安装（HOME/cwd 全隔离，模拟无 /Users/zengtian 的机器）
 * → 加载安装产物 → apply() 挂路由 → 断言 work/companion/health 三端点 200 且注入 JS 完整。
 * 任何"本机能跑、发布包跑不了"的缺口（files 白名单漏目录、依赖不可装、绝对路径默认值）
 * 都会在这里爆。
 *
 * 用法: node tests/release-pack-smoke.mjs
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import http from 'node:http';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'bwm-pack-smoke.'));
process.env.HOME = tmp; // os.homedir() 跟随 HOME → 配置/资产默认值全部落在隔离目录

let failed = 0;
const ok = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) failed = 1; };

// 1. 打包（严格按 files 白名单；--ignore-scripts：prepack 审计输出会混入 stdout 破坏 --json 解析，
//    门禁本身由 audit:release / prepack / prepublishOnly 独立把守，此处验证的是产物可装性）
const packed = JSON.parse(execSync('npm pack --ignore-scripts --json', { cwd: repo, encoding: 'utf8' }));
const tgz = join(repo, packed[0].filename);
console.log('tarball:', packed[0].filename, packed[0].size + 'B');
// 自包含断言：协议副本与 UI 壳必须随包（异机不靠 registry/个人路径）
const fileList = (packed[0].files || []).map((f) => f.path);
ok('tarball 含 packages/bwm-protocol（协议随包，行为确定性）', fileList.some((p) => p.includes('packages/bwm-protocol/schema/persona.js')));
ok('tarball 含 static-ui 壳（BWM_STATIC 默认值自包含）', fileList.includes('static-ui/index.html'));
// 防回潮：部署级组件（factgate）不随包发布，出现即 FAIL
ok('tarball 不含 factgate.js（部署级组件不入包）', !fileList.some((p) => p.endsWith('factgate.js')));

// 5. 钩子回归断言（P0-2 增量2 · 派单⑤）：prepack/prepublishOnly 必须存在且指向 audit——
//    防钩子被摘或以 `||`（如 `|| true`）吞掉门禁退出码（本断言直接读 package.json，
//    不经 --ignore-scripts 旁路）
const pkgJson = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
ok(
  'scripts.prepack 存在且含 audit-release --expect-blocked（含 classify 前置，无 || 旁路）',
  typeof pkgJson.scripts?.prepack === 'string'
    && pkgJson.scripts.prepack.includes('audit-release.mjs')
    && pkgJson.scripts.prepack.includes('--expect-blocked')
    && pkgJson.scripts.prepack.includes('classify-docs-release.mjs')
    && !pkgJson.scripts.prepack.includes('||'),
);
ok(
  'scripts.prepublishOnly 存在且指向 audit:release（无 || 旁路）',
  typeof pkgJson.scripts?.prepublishOnly === 'string'
    && pkgJson.scripts.prepublishOnly.includes('audit:release')
    && !pkgJson.scripts.prepublishOnly.includes('||'),
);

// 6. 随包面与声明一致（P0-2 增量2 · 派单④ 路径B）：随包 cordis.patch.yml 的活跃 insert
//    条目，其 name 必须经 exports 解析到**随包文件**——随包面不得含指向包外文件的活引用
const patchYml = readFileSync(join(repo, 'cordis.patch.yml'), 'utf8');
const insertRows = [];
let curRow = null;
for (const line of patchYml.split('\n')) {
  const idm = line.match(/^\s*- id: (\S+)\s*$/);
  if (idm) { if (curRow) insertRows.push(curRow); curRow = { id: idm[1] }; continue; }
  if (!curRow) continue;
  const nm = line.match(/^\s+name: '?([^'\s]+)'?\s*$/);
  if (nm && curRow.name === undefined) { curRow.name = nm[1]; continue; }
  const dm = line.match(/^\s+disabled: (true|false)\s*$/);
  if (dm && curRow.disabled === undefined) curRow.disabled = dm[1] === 'true';
}
if (curRow) insertRows.push(curRow);
const pkgName = pkgJson.name;
for (const row of insertRows) {
  if (row.disabled === true || row.name === undefined) continue; // 停用条目不加载，无活引用
  const sub = row.name === pkgName ? '.' : row.name.startsWith(pkgName + '/') ? './' + row.name.slice(pkgName.length + 1) : null;
  const target = sub !== null ? pkgJson.exports[sub] : undefined;
  ok(
    `patch 活跃条目 ${row.id}（${row.name}）exports 目标随包`,
    Boolean(target) && fileList.includes(String(target).replace(/^\.\//, '')),
  );
}
// 部署级组件（factgate）必须显式 disabled——随包 patch 不得活跃引用不随包模块（P0-F 路径B）
const factgateRow = insertRows.find((r) => r.id === 'bwm-friend-factgate');
ok('patch 条目 bwm-friend-factgate 显式 disabled（部署级显式化）', factgateRow?.disabled === true);

// 2. 干净目录安装（依赖从 registry 拉；安装不了的依赖在这里爆）
execSync(`npm i --no-audit --no-fund --loglevel=error "${tgz}"`, { cwd: tmp, stdio: 'pipe' });
const installed = join(tmp, 'node_modules', 'dsh-plugin-bwm-friend');

// 3. 加载安装产物（相对导入/兜底导入/顶层 await 在这里验证）
let mod;
try {
  mod = await import(pathToFileURL(join(installed, 'lib', 'index.js')).href);
  ok('安装产物模块加载', true);
} catch (e) {
  ok('安装产物模块加载: ' + e.message, false);
  process.exit(1);
}

// 4. apply 挂路由 + 三端点断言
const handlers = [];
const webServer = { register: (o) => { handlers.push(o); return () => {}; } };
await mod.apply({ webServer });
const server = http.createServer((req, res) => {
  const u = new URL(req.url || '/', 'http://x');
  const h = handlers.find((x) => u.pathname.startsWith(x.path));
  if (h) return h.handler(req, res);
  res.writeHead(404); res.end('{}');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const get = async (p) => (await fetch(base + p, { headers: { Host: new URL(base).host } }));
for (const p of ['/bwm-friend/health', '/bwm-friend/work/', '/bwm-friend/companion/']) {
  const r = await get(p);
  ok(`端点 ${p} → 200`, r.status === 200);
}
const js = await (await get('/bwm-friend/work/companion-chat.js')).text();
ok('注入 JS 完整伺服（含模板⇒音色联动）', js.includes('__bwmSwitchTheme') && js.includes('__bwmThemeVoice'));
const html = await (await get('/bwm-friend/work/')).text();
ok('work 页为真实壳（非 404 兜底）', html.includes('templateGrid'));

server.close();
rmSync(tmp, { recursive: true, force: true });
rmSync(tgz, { force: true });
console.log(failed ? '❌ PACK SMOKE FAIL' : '✅ PACK SMOKE ALL PASS');
process.exit(failed);
