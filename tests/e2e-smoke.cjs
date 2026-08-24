/**
 * E2E Smoke — dsh-plugin-bwm-friend（复用已有 Playwright，不重复下载）
 *
 * 运行前提：
 *   1. 沙盒已启动：cd /Users/zengtian/projects/dsh-sandbox && ./start.sh 3200
 *   2. Playwright 可用（复用 dsh-sandbox checkout 或 hermes-agent-upstream 的安装）
 *      PLAYWRIGHT_PATH 环境变量可覆盖；默认探测已有安装。
 *
 * 固化回归点（2026-08-24 修复）：
 *   1. 输入框按钮行可见（模型/发送/命令/Workspace——曾透明不可见）
 *   2. 模型菜单真实点击弹出（曾因 overflow 裁剪不弹）
 *   3. 会话 header 紧凑单行（任务信息条上移顶栏）
 *   4. ☰ 工作区弹窗屏幕最右 + 会话树（曾无会话树/遮挡）
 *   5. 侧栏宽度 320px
 *
 * 运行：node tests/e2e-smoke.js
 */
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/Users/zengtian/projects/dsh-sandbox/checkout/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright');

const BASE = process.env.BWM_E2E_BASE || 'http://127.0.0.1:3200';
// 复用已下载浏览器（不重复下载）：chromium_headless_shell-1223 可执行文件
const CHROME_EXEC = process.env.BWM_E2E_CHROME || '/Users/zengtian/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell';

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: CHROME_EXEC });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const results = [];
  const check = (name, ok, detail = '') => results.push({ name, ok, detail });

  try {
    await page.goto(`${BASE}/bwm-friend/work/`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(4000); // DSH client 加载渲染

    const frame = page.frameLocator('#bwm-harness-frame');

    // 1. 按钮行可见（回归：曾透明/裁剪不可见）
    check('模型按钮可见', await frame.locator('.PNUCKq_trigger').isVisible().catch(() => false));
    check('发送键可见', await frame.locator('.p7GS4W_primary').isVisible().catch(() => false));
    check('命令按钮可见', await frame.locator('.p7GS4W_add').isVisible().catch(() => false));
    check('Workspace 按钮可见', await frame.locator('.eLe3jW_trigger').isVisible().catch(() => false));

    // 2. 模型菜单真实点击弹出（回归：overflow 裁剪不弹）
    await frame.locator('.PNUCKq_trigger').click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(600);
    const menuVisible = await frame.locator('.PNUCKq_menu').isVisible().catch(() => false);
    const menuText = menuVisible ? (await frame.locator('.PNUCKq_menu').innerText().catch(() => '')) : '';
    // 双语兼容：中文「推理等级」/ 英文「Effort」（headless chromium 默认英文 locale）
    const menuOk = menuVisible && (/推理等级|Effort/.test(menuText));
    check('模型菜单点击弹出', menuOk, menuText.slice(0, 40).replace(/\n/g, '|'));

    // 3. 会话 header 紧凑单行（任务信息条上移顶栏）
    const header = frame.locator('[class*=centerCol] header');
    const headerCount = await header.count();
    check('会话 header 存在', headerCount > 0);
    if (headerCount > 0) {
      const h = await header.first().boundingBox().catch(() => null);
      check('header 高度 ≤48px（紧凑单行）', h ? h.height <= 48 : false, h ? `h=${Math.round(h.height)}` : 'n/a');
    }

    // 4. ☰ 工作区弹窗（屏幕最右 + 会话树）
    await page.locator('button:has-text("工作区")').first().click().catch(() => {});
    await page.waitForTimeout(2000);
    const pop = page.locator('#bwm-workspace-pop');
    const popCount = await pop.count();
    check('工作区弹窗存在', popCount > 0);
    if (popCount > 0) {
      const pr = await pop.boundingBox().catch(() => null);
      check('弹窗贴屏幕最右', pr ? Math.abs(pr.x + pr.width - 1280) < 3 : false, pr ? `right=${Math.round(pr.x + pr.width)}` : '');
      const pf = page.frameLocator('#bwm-workspace-frame');
      await page.waitForTimeout(1500);
      const treeCount = await pf.locator('[role=treeitem]').count().catch(() => 0);
      check('弹窗内会话树 ≥1', treeCount > 0, `tree=${treeCount}`);
      // 点会话 → 弹窗关闭
      if (treeCount > 0) {
        await pf.locator('[role=treeitem]').nth(1).click().catch(() => {});
        await page.waitForTimeout(1200);
        const popTransform = await pop.evaluate((el) => el.style.transform).catch(() => '');
        check('点会话后弹窗关闭', popTransform.includes('100%'), popTransform);
      }
    }

    // 5. 侧栏宽度 320px
    const sb = frame.locator('[class*=sidebarCol]');
    const sbCount = await sb.count();
    if (sbCount > 0) {
      const sbr = await sb.first().boundingBox().catch(() => null);
      check('侧栏宽度 320px（容差3px）', sbr ? Math.abs(sbr.width - 320) <= 3 : false, sbr ? `w=${Math.round(sbr.width)}` : '');
    } else {
      check('侧栏宽度 320px', false, 'sidebarCol 未找到');
    }
  } catch (e) {
    check('脚本异常', false, String(e).slice(0, 200));
  }

  await browser.close();

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n=== E2E Smoke: ${pass}/${results.length} PASS ===`);
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  process.exit(pass === results.length ? 0 : 1);
})();
