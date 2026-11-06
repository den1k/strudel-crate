// server/render-card.mjs
// Renders an OG card JPEG by loading a self-contained HTML doc (server/og-card.mjs)
// in headless Chrome at 1200×630 and screenshotting it. Mirrors render-audio.mjs:
// lazy launch, serial render lock, idle-close. setContent (not a served URL)
// keeps the card template self-contained; we await document.fonts.ready so the
// display font is painted before the screenshot.
import puppeteer from 'puppeteer-core';

export const CARD_W = 1200;
export const CARD_H = 630;

export function createCardRenderer({
  chromePath = process.env.CRATE_CHROME ?? '/opt/google/chrome/chrome',
  idleMs = 60000,
  maxQueue = 16,
  launch = (opts) => puppeteer.launch(opts),
}) {
  let browser = null;
  let chain = Promise.resolve(); // serial lock: renders run one at a time
  let pending = 0; // renders running or waiting; cold cards are anonymous-triggered
  let idleTimer = null;

  function armIdleClose() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { close().catch(() => {}); }, idleMs);
    idleTimer.unref?.();
  }

  async function ensureBrowser() {
    if (browser) return browser;
    browser = await launch({
      executablePath: chromePath,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    browser.on('disconnected', () => { browser = null; });
    return browser;
  }

  async function renderOnce(html) {
    const b = await ensureBrowser();
    const page = await b.newPage();
    try {
      await page.setViewport({ width: CARD_W, height: CARD_H, deviceScaleFactor: 1 });
      await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
      await page.evaluate(() => document.fonts.ready);
      return await page.screenshot({
        type: 'jpeg',
        quality: 90,
        clip: { x: 0, y: 0, width: CARD_W, height: CARD_H },
      });
    } finally {
      await page.close().catch(() => {});
      armIdleClose();
    }
  }

  function render(html) {
    if (pending >= maxQueue) {
      return Promise.reject(Object.assign(new Error('card renderer busy'), { status: 503, expose: true }));
    }
    pending += 1;
    // Append to the serial chain; callers get their own result, errors isolated.
    const run = chain.then(() => renderOnce(html)).finally(() => { pending -= 1; });
    chain = run.catch(() => {}); // keep the lock alive past a failed render
    return run;
  }

  async function close() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    const b = browser;
    browser = null;
    if (b) await b.close().catch(() => {});
  }

  return { render, close, CARD_W, CARD_H };
}
