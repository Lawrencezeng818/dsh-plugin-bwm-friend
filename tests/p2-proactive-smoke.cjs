/* P2-Proactive 验证：companion 页 ✨主动 按钮 → Mira 主动开场白 */
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/Users/zengtian/projects/dsh-sandbox/checkout/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright');

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.BWM_E2E_CHROME || '/Users/zengtian/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell',
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await page.goto('http://127.0.0.1:3200/bwm-friend/companion/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const hasBtn = await page.evaluate(() => !!document.getElementById('bwm-proactive-btn'));
  console.log('✨主动 按钮存在:', hasBtn);

  if (hasBtn) {
    await page.click('#bwm-proactive-btn');
    await page.waitForTimeout(4000);
    const replies = await page.evaluate(() => document.getElementById('assistantReplies').innerText);
    console.log('Mira 主动回复:', replies.slice(-120));
    const pass = replies.length > 0 && !replies.endsWith('…');
    console.log(pass ? 'P2-PROACTIVE PASS' : 'P2-PROACTIVE FAIL');
    await browser.close();
    process.exit(pass ? 0 : 1);
  }
  console.log('P2-PROACTIVE FAIL (no button)');
  await browser.close();
  process.exit(1);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
