/* P2-Voice smoke：companion 页聊天 → TTS 自动朗读链路验证（Playwright 真实浏览器） */
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/Users/zengtian/projects/dsh-sandbox/checkout/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright');

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.BWM_E2E_CHROME || '/Users/zengtian/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell',
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });

  // 记录 TTS/Audio 播放
  await page.exposeFunction('__p2log', (msg) => console.log('[P2]', msg));
  await page.addInitScript(() => {
    window.__audioPlays = [];
    window.__ttsFetches = 0;
    const origPlay = Audio.prototype.play;
    Audio.prototype.play = function () {
      window.__audioPlays.push({ src: (this.src || '').slice(0, 60) });
      return origPlay.apply(this, arguments);
    };
    const origFetch = window.fetch;
    window.fetch = function (url, opts) {
      if (String(url).indexOf('/bwm-friend/tts') >= 0) window.__ttsFetches++;
      return origFetch.apply(this, arguments);
    };
  });

  await page.goto('http://127.0.0.1:3200/bwm-friend/companion/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  // 1. 音色选择器填充
  const voices = await page.evaluate(() => [...document.getElementById('voiceSelect').options].map(o => o.value));
  console.log('voices:', JSON.stringify(voices));

  // 2. 发消息
  await page.fill('#messageInput', '今天心情怎么样');
  await page.click('#composer button[type="submit"], #composer .send-btn, button.send-btn');
  // 兜底：找发送按钮
  await page.waitForTimeout(3000);

  const reply = await page.evaluate(() => document.getElementById('assistantReplies').innerText);
  console.log('reply:', reply.slice(0, 100));

  // 3. 等 TTS
  await page.waitForTimeout(5000);
  const state = await page.evaluate(() => ({
    audioPlays: window.__audioPlays,
    ttsFetches: window.__ttsFetches,
  }));
  console.log('ttsFetches:', state.ttsFetches, 'audioPlays:', JSON.stringify(state.audioPlays));

  const pass = state.ttsFetches >= 1 && state.audioPlays.length >= 1;
  console.log(pass ? 'P2-VOICE PASS' : 'P2-VOICE FAIL');
  await browser.close();
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('E2E-ERR', e); process.exit(1); });
