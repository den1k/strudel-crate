// Generate the PWA / homescreen icon set from the STRUDEL/CRATE brand.
// Renders an "S/C" monogram (cream S, acid slash, cream C) on the app's dark
// tile via headless Chrome — same font-loading approach as render-card.mjs
// (Google Fonts + document.fonts.ready) so the real Bricolage Grotesque is
// painted. Output PNGs are committed under public/icons/ and served statically;
// this script is a reproducible asset build, not a runtime dependency.
//
// Run: node scripts/build-icons.mjs
import puppeteer from 'puppeteer-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(repoRoot, 'public', 'icons');
const chromePath = process.env.CRATE_CHROME ?? '/opt/google/chrome/chrome';

const BG = '#0c0d0a';
const INK = '#e9edda';
const ACID = '#c8f53c';
const FONTS = 'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,300..800&display=swap';

// `pad` is the fraction of the tile kept clear around the glyph (maskable icons
// need their content inside the centre ~80% so platform masks don't clip it).
function html(size, pad = 0) {
  const glyph = Math.round(size * (0.46 - pad)); // glyph height
  return `<!doctype html><html><head><meta charset="utf-8" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="${FONTS}" rel="stylesheet" />
<style>
  html,body{margin:0}
  .tile{width:${size}px;height:${size}px;background:${BG};display:flex;
        align-items:center;justify-content:center;overflow:hidden}
  .mark{font-family:'Bricolage Grotesque',sans-serif;font-weight:800;
        font-size:${glyph}px;line-height:1;letter-spacing:-0.04em;color:${INK}}
  .mark .s{color:${ACID}}
</style></head>
<body><div class="tile"><div class="mark">S<span class="s">/</span>C</div></div></body></html>`;
}

const TARGETS = [
  { name: 'icon-512.png', size: 512, pad: 0 },
  { name: 'icon-192.png', size: 192, pad: 0 },
  { name: 'maskable-512.png', size: 512, pad: 0.07 },
  { name: 'apple-touch-icon.png', size: 180, pad: 0 }, // iOS rounds corners itself
  { name: 'favicon-32.png', size: 32, pad: 0 },
];

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  try {
    for (const t of TARGETS) {
      const page = await browser.newPage();
      await page.setViewport({ width: t.size, height: t.size, deviceScaleFactor: 1 });
      await page.setContent(html(t.size, t.pad), { waitUntil: 'networkidle0', timeout: 30000 });
      await page.evaluate(() => document.fonts.ready);
      const buf = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: t.size, height: t.size } });
      await writeFile(join(outDir, t.name), buf);
      await page.close();
      console.log(`wrote public/icons/${t.name} (${t.size}px)`);
    }
  } finally {
    await browser.close();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
