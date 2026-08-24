/* S3 验证：presence MutationObserver 事件驱动（发任务 → thinking → idle） */
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/Users/zengtian/projects/dsh-sandbox/checkout/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright');

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.BWM_E2E_CHROME || '/Users/zengtian/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell',
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await page.goto('http://127.0.0.1:3200/bwm-friend/work/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  // 初始 idle
  const init = await page.evaluate(() => {
    const v = document.querySelector('video');
    return v ? v.className : 'no-video';
  });
  console.log('初始 video class:', init);

  // 发任务
  const frame = page.frame({ url: /bwm=embedded/ });
  if (!frame) { console.log('no frame'); await browser.close(); process.exit(1); }
  await frame.fill('textarea', '用一句话介绍你自己');
  await frame.press('textarea', 'Enter');
  console.log('已发送任务');

  // 轮询等待 thinking（MutationObserver 触发）
  let sawThinking = false;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(500);
    const cls = await page.evaluate(() => {
      const v = document.querySelector('video');
      return v ? v.className : '';
    });
    if (/bwm-thinking|bwm-executing/.test(cls)) { sawThinking = true; console.log(`[${i * 0.5}s] 运行中: ${cls.slice(0, 50)}`); break; }
  }
  console.log('sawThinking:', sawThinking);

  // 等待完成 → idle
  let sawIdle = false;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(1000);
    const cls = await page.evaluate(() => {
      const v = document.querySelector('video');
      return v ? v.className : '';
    });
    if (/bwm-idle/.test(cls) && sawThinking) { sawIdle = true; console.log(`完成 → idle (${i + 1}s)`); break; }
  }
  console.log('sawIdle:', sawIdle);
  const pass = sawThinking && sawIdle;
  console.log(pass ? 'S3-PRESENCE PASS' : 'S3-PRESENCE FAIL');
  await browser.close();
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
