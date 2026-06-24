// Server-side audio render by driving the SAME built bundle the browser uses.
// Launches the system Chrome (puppeteer-core, no bundled download), opens the
// app's /export-render.html, and runs its existing postMessage protocol: post a
// `render` message, await the `done` blob, return it as a Buffer. One render at a
// time (serial) to bound RAM/CPU; the browser is launched lazily and closed after
// idleMs so it doesn't hold memory between bursts.
import puppeteer from 'puppeteer-core';

export const renderId = (track, fmt) => `${track.id}:${fmt}`;
export const b64ToBuffer = (b64) => Buffer.from(b64, 'base64');

// Runs INSIDE the page. export-render.js awaits its own `ready` (sample banks)
// before rendering, so we can post immediately. Returns the blob as base64.
async function inPageRender({ track, format, id }) {
  const blob = await new Promise((resolve, reject) => {
    function onMsg(e) {
      const d = e.data || {};
      if (d.type === 'done' && d.id === id) { window.removeEventListener('message', onMsg); resolve(d.blob); }
      else if (d.type === 'error' && d.id === id) { window.removeEventListener('message', onMsg); reject(new Error(d.message)); }
    }
    window.addEventListener('message', onMsg);
    // export-render.js replies to `parent`; in a top-level page parent === window.
    window.postMessage({ type: 'render', id, track, format }, '*');
  });
  const ab = await blob.arrayBuffer();
  const bytes = new Uint8Array(ab);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

export function createRenderer({
  pageUrl,
  chromePath = process.env.CRATE_CHROME ?? '/opt/google/chrome/chrome',
  idleMs = 60000,
  launch = (opts) => puppeteer.launch(opts),
}) {
  let browser = null;
  let chain = Promise.resolve(); // serial lock: renders run one at a time
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
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    browser.on('disconnected', () => { browser = null; });
    return browser;
  }

  async function renderOnce(track, fmt) {
    const b = await ensureBrowser();
    const page = await b.newPage();
    try {
      await page.goto(pageUrl, { waitUntil: 'load', timeout: 60000 });
      const b64 = await page.evaluate(inPageRender, { track, format: fmt, id: renderId(track, fmt) });
      return b64ToBuffer(b64);
    } finally {
      await page.close().catch(() => {});
      armIdleClose();
    }
  }

  function render(track, fmt) {
    // Append to the serial chain; callers get their own result, errors isolated.
    const run = chain.then(() => renderOnce(track, fmt));
    chain = run.catch(() => {}); // keep the lock alive past a failed render
    return run;
  }

  async function close() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    const b = browser;
    browser = null;
    if (b) await b.close().catch(() => {});
  }

  return { render, close };
}
