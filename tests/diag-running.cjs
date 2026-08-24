// 临时诊断：真实任务运行时 primary 按钮状态 + video class
const { chromium } = require('/Users/zengtian/projects/dsh-sandbox/checkout/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright');
const CHROME = '/Users/zengtian/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell';

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto('http://127.0.0.1:3200/bwm-friend/work/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const frame = page.frameLocator('#bwm-harness-frame');

  // 输入并发送
  const ta = frame.locator('textarea');
  await ta.click();
  await ta.fill('列出当前目录文件');
  await page.waitForTimeout(500);
  const primaryBefore = await frame.locator('.p7GS4W_primary').getAttribute('aria-label').catch(() => null);
  await frame.locator('.p7GS4W_primary').click().catch(() => {});
  await page.waitForTimeout(2500); // 任务进行中

  const primaryRunning = await frame.locator('.p7GS4W_primary').getAttribute('aria-label').catch(() => null);
  const primaryDisabled = await frame.locator('.p7GS4W_primary').isDisabled().catch(() => null);
  const videoClass = await page.locator('#avatarVideo').getAttribute('class').catch(() => null);
  // 对话流是否有 Think/工具节点
  const thinkCount = await frame.locator('[class*=bubble]').filter({ hasText: /^Think/ }).count().catch(() => 0);

  console.log(JSON.stringify({
    primaryBefore,
    primaryRunning,
    primaryDisabled,
    videoClass,
    thinkCount
  }, null, 1));

  await page.waitForTimeout(20000); // 等任务完成
  const primaryAfter = await frame.locator('.p7GS4W_primary').getAttribute('aria-label').catch(() => null);
  const videoAfter = await page.locator('#avatarVideo').getAttribute('class').catch(() => null);
  console.log(JSON.stringify({ primaryAfter, videoAfter }, null, 1));
  await browser.close();
})();
