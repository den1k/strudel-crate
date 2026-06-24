# Server-Side Pre-Rendered Export Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make WAV/MP3 (and stems-zip) downloads on crate fast and timeout-proof by rendering them once on the server (headless Chromium driving the existing render bundle), caching to disk under a hard 3 GB LRU cap, and serving cached files directly.

**Architecture:** The render DSP already lives in the built `/export-render.html` bundle (superdough + `OfflineAudioContext`). We reuse it verbatim by launching the **system Chrome** (`/opt/google/chrome/chrome`) with `puppeteer-core`, navigating to the app's own `/export-render.html`, posting the existing `render` postMessage, and capturing the returned blob as a Buffer server-side. Buffers are cached at `data/audio-cache/<ns>/<id>.<ext>` behind a single LRU evictor capped at 3 GB. A new endpoint `GET /api/:ns/:id/audio.:fmt` serves cache hits instantly and renders-on-miss (lazy, for WAV). MP3 is pre-warmed in the background when a generate job finishes (the runner already knows the new items). The client download buttons switch from the in-iframe render to a plain link to that endpoint.

**Tech Stack:** Node ESM, Express, `puppeteer-core` + system Chrome, InstantDB admin SDK, Vitest + supertest. Reuses `src/render.js` / `src/export-render.js` / `src/export-spec.js` (now driven server-side via the built bundle).

## Global Constraints

- Node ESM throughout (`.mjs`, import/export). No TypeScript in `server/`.
- **Disk cap is for the audio export cache only:** `CRATE_AUDIO_CACHE_MAX_BYTES`, default **3221225472** (3 × 1024³ = 3 GB). The pre-existing `data/sample-cache/` (~222 MB) is separate and not governed by this cap.
- Render trigger is **hybrid**: MP3 is pre-warmed in the background after a generate/revise/remix job; WAV is rendered lazily on first request. Both formats live in **one** cache directory under **one** 3 GB LRU (least-recently-served evicted first; access time is bumped on every serve).
- Chrome is the **system binary** at `/opt/google/chrome/chrome` (override with `CRATE_CHROME`). Do **not** download a bundled Chromium — depend on `puppeteer-core`, never `puppeteer`.
- Only **one** headless render runs at a time (serial), to bound RAM/CPU on this 4-core/15 GB host. Identical concurrent requests for the same `(ns,id,fmt)` share one in-flight render.
- Cache key is the entity **id** (UUID); the user-facing download filename is `<slug>.<ext>`. `ext`: `wav→.wav`, `mp3→.mp3`, `stems→.zip`.
- Tests must not hit the network or launch Chrome by default. The one real render test is gated behind `CRATE_RENDER_IT=1` and excluded from `npm test`.
- End every commit message with this trailer (blank line before it):

  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```
- This is code-modifying work on a git repo with a **concurrent session active in the main checkout** — execute in an isolated git worktree (the execution sub-skill handles this). A build + redeploy is required at the end; coordinate so the live `dist/` isn't rebuilt mid-flight.

## File Structure

| File | Change | Responsibility |
|------|--------|----------------|
| `server/audio-cache.mjs` | Create | Disk cache: path lookup (bumps atime), write, 3 GB LRU prune. |
| `server/render-audio.mjs` | Create | Headless-Chrome renderer: drive `/export-render.html`, return a Buffer. Serial + lazy-launch + idle-close. |
| `server/audio-export.mjs` | Create | Glue: resolve item, cache-or-render, in-flight dedup, `prewarm`. |
| `server/app.mjs` | Modify | New `audioRoutes` mounting `GET /api/:ns/:id/audio.:fmt`; `createApp` accepts `audioExport`. |
| `server/runner.mjs` | Modify | After a successful job, background-prewarm MP3 for `newItems`. |
| `server/index.mjs` | Modify | Compose cache + renderer + export service; pass to `createApp` and `createRunner`. |
| `src/song.js`, `src/app.js` | Modify | Download buttons link to the endpoint instead of the iframe render. |
| `src/export.js` | Delete | The in-iframe download orchestrator is replaced by the endpoint. |
| `package.json` | Modify | Add `puppeteer-core` dependency. |
| `test/audio-cache.test.mjs`, `test/audio-export.test.mjs`, `test/render-audio.test.mjs` | Create | Unit + gated integration tests. |
| `test/api.test.mjs` | Modify | Endpoint hit/miss/404 tests. |
| `test/runner.test.mjs` | Modify | Prewarm-hook test. |

**Unchanged on purpose:** `src/render.js`, `src/export-render.js`, `src/export-spec.js`, `src/encoders.js`, `src/zip.js`, `export-render.html` — these ARE the render engine; the server now drives the built bundle they compile into. `scripts/save-*.mjs` are untouched (pre-warm is triggered server-side by the runner, which already computes `newItems`).

---

## Task 1: Disk cache with 3 GB LRU eviction

**Files:**
- Create: `server/audio-cache.mjs`
- Test: `test/audio-cache.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `createAudioCache({ dir, maxBytes = 3221225472 }) => { EXT, cachedPath, store, prune }`
  - `EXT = { wav: 'wav', mp3: 'mp3', stems: 'zip' }`
  - `async cachedPath(ns, id, fmt) => string | null` — absolute path if the file exists (and bumps its atime+mtime to now), else null.
  - `async store(ns, id, fmt, buffer) => string` — writes `<dir>/<ns>/<id>.<EXT[fmt]>`, runs `prune()`, returns the path.
  - `async prune() => number` — if total bytes > `maxBytes`, deletes files in ascending atime order until ≤ `maxBytes`; returns bytes freed.

- [ ] **Step 1: Write the failing tests**

Create `test/audio-cache.test.mjs`:

```javascript
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile, stat, utimes, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAudioCache } from '../server/audio-cache.mjs';

let dir;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'audio-cache-')); });

describe('createAudioCache', () => {
  it('store writes <dir>/<ns>/<id>.<ext> and cachedPath finds it', async () => {
    const cache = createAudioCache({ dir });
    const p = await cache.store('tracks', 't1', 'mp3', Buffer.from('abc'));
    expect(p).toBe(join(dir, 'tracks', 't1.mp3'));
    expect(await readFile(p, 'utf8')).toBe('abc');
    expect(await cache.cachedPath('tracks', 't1', 'mp3')).toBe(p);
  });

  it('maps stems format to a .zip extension', async () => {
    const cache = createAudioCache({ dir });
    const p = await cache.store('stems', 's1', 'stems', Buffer.from('zip'));
    expect(p).toBe(join(dir, 'stems', 's1.zip'));
  });

  it('cachedPath returns null for a miss', async () => {
    const cache = createAudioCache({ dir });
    expect(await cache.cachedPath('tracks', 'nope', 'wav')).toBeNull();
  });

  it('cachedPath bumps atime on a hit', async () => {
    const cache = createAudioCache({ dir });
    const p = await cache.store('tracks', 't1', 'mp3', Buffer.from('x'));
    const old = new Date('2020-01-01T00:00:00Z');
    await utimes(p, old, old);
    await cache.cachedPath('tracks', 't1', 'mp3');
    const after = (await stat(p)).atime.getTime();
    expect(after).toBeGreaterThan(old.getTime());
  });

  it('prune evicts least-recently-accessed files until under maxBytes', async () => {
    // three 100-byte files, cap at 250 bytes → one (the oldest atime) must go
    const cache = createAudioCache({ dir, maxBytes: 250 });
    const big = Buffer.alloc(100, 1);
    await cache.store('tracks', 'old', 'wav', big);
    await cache.store('tracks', 'mid', 'wav', big);
    await cache.store('tracks', 'new', 'wav', big);
    // make 'old' the least-recently-accessed
    const t0 = new Date('2020-01-01T00:00:00Z');
    await utimes(join(dir, 'tracks', 'old.wav'), t0, t0);
    const freed = await cache.prune();
    expect(freed).toBe(100);
    expect(await cache.cachedPath('tracks', 'old', 'wav')).toBeNull();
    expect(await cache.cachedPath('tracks', 'mid', 'wav')).not.toBeNull();
    expect(await cache.cachedPath('tracks', 'new', 'wav')).not.toBeNull();
  });

  it('store triggers prune automatically (cap enforced on write)', async () => {
    const cache = createAudioCache({ dir, maxBytes: 150 });
    await cache.store('tracks', 'a', 'wav', Buffer.alloc(100, 1));
    const ta = new Date('2020-01-01T00:00:00Z');
    await utimes(join(dir, 'tracks', 'a.wav'), ta, ta);
    await cache.store('tracks', 'b', 'wav', Buffer.alloc(100, 1)); // now 200 > 150 → evict 'a'
    expect(await cache.cachedPath('tracks', 'a', 'wav')).toBeNull();
    expect(await cache.cachedPath('tracks', 'b', 'wav')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/audio-cache.test.mjs`
Expected: FAIL — `createAudioCache` is not exported / module missing.

- [ ] **Step 3: Implement `server/audio-cache.mjs`**

```javascript
// Disk cache for rendered exports at <dir>/<ns>/<id>.<ext>, governed by a single
// LRU byte cap. "Recently used" = file access time (atime), which we bump on every
// hit (mounts often use noatime, so reads alone won't update it — we do it
// explicitly). prune() runs after each write so the cap is enforced eagerly.
import { mkdir, readdir, stat, writeFile, unlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';

const EXT = { wav: 'wav', mp3: 'mp3', stems: 'zip' };

export function createAudioCache({ dir, maxBytes = 3221225472 }) {
  const fileFor = (ns, id, fmt) => join(dir, ns, `${id}.${EXT[fmt]}`);

  async function cachedPath(ns, id, fmt) {
    const p = fileFor(ns, id, fmt);
    try {
      await stat(p);
    } catch {
      return null;
    }
    const now = new Date();
    try { await utimes(p, now, now); } catch { /* best effort */ }
    return p;
  }

  async function store(ns, id, fmt, buffer) {
    const p = fileFor(ns, id, fmt);
    await mkdir(join(dir, ns), { recursive: true });
    await writeFile(p, buffer);
    await prune();
    return p;
  }

  // List every cached file with size + atime (one level of ns subdirs).
  async function listFiles() {
    const out = [];
    let nss;
    try { nss = await readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const d of nss) {
      if (!d.isDirectory()) continue;
      const sub = join(dir, d.name);
      let files;
      try { files = await readdir(sub); } catch { continue; }
      for (const f of files) {
        const p = join(sub, f);
        try {
          const s = await stat(p);
          if (s.isFile()) out.push({ p, size: s.size, atime: s.atimeMs });
        } catch { /* vanished mid-scan */ }
      }
    }
    return out;
  }

  async function prune() {
    const files = await listFiles();
    let total = files.reduce((n, f) => n + f.size, 0);
    if (total <= maxBytes) return 0;
    files.sort((a, b) => a.atime - b.atime); // oldest access first
    let freed = 0;
    for (const f of files) {
      if (total <= maxBytes) break;
      try { await unlink(f.p); total -= f.size; freed += f.size; } catch { /* already gone */ }
    }
    return freed;
  }

  return { EXT, cachedPath, store, prune };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/audio-cache.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/audio-cache.mjs test/audio-cache.test.mjs
git commit -m "feat(export-cache): disk cache with 3GB LRU eviction"
```

---

## Task 2: Headless-Chrome render engine

**Files:**
- Create: `server/render-audio.mjs`
- Test: `test/render-audio.test.mjs`
- Modify: `package.json` (add `puppeteer-core`)

**Interfaces:**
- Consumes: a running server (or static server) that serves `/export-render.html`; system Chrome.
- Produces: `createRenderer({ pageUrl, chromePath = process.env.CRATE_CHROME ?? '/opt/google/chrome/chrome', idleMs = 60000, launch }) => { render, close }`
  - `async render(track, fmt) => Buffer` — `track` is `{ id: <slug>, code, meta }`; `fmt` ∈ `wav|mp3|stems`. Renders serially (one at a time); returns the file bytes. Throws if the in-page render posts an `error`.
  - `async close() => void` — closes the browser if open.
  - `b64ToBuffer(b64) => Buffer` and `renderId(track, fmt) => string` are exported for unit tests.

- [ ] **Step 1: Add the dependency**

```bash
npm install puppeteer-core@^23
```

Expected: `package.json` gains `"puppeteer-core"` under dependencies; no Chromium is downloaded (puppeteer-core ships none).

- [ ] **Step 2: Write the failing unit tests (pure helpers)**

Create `test/render-audio.test.mjs`:

```javascript
import { describe, it, expect } from 'vitest';
import { renderId, b64ToBuffer } from '../server/render-audio.mjs';

describe('render-audio helpers', () => {
  it('renderId combines slug and format the way export-render expects', () => {
    expect(renderId({ id: 'demo-01' }, 'wav')).toBe('demo-01:wav');
  });
  it('b64ToBuffer round-trips bytes', () => {
    const b = Buffer.from([0, 1, 2, 250, 255]);
    expect(b64ToBuffer(b.toString('base64')).equals(b)).toBe(true);
  });
});

// Real render: needs system Chrome + a server serving /export-render.html + CDN
// access. Gated so `npm test` never launches Chrome. Run manually:
//   CRATE_RENDER_IT=1 CRATE_RENDER_URL=http://localhost:3008/export-render.html \
//     npx vitest run test/render-audio.test.mjs
const IT = process.env.CRATE_RENDER_IT === '1';
describe.runIf(IT)('render-audio integration', () => {
  it('renders a tiny track to a non-empty RIFF/WAV', async () => {
    const { createRenderer } = await import('../server/render-audio.mjs');
    const renderer = createRenderer({ pageUrl: process.env.CRATE_RENDER_URL });
    try {
      // 2 cycles of a single synth note — fast to render.
      const track = { id: 'it-tiny', code: 'note("c3 e3").s("supersaw")', meta: { bpm: 120 } };
      const buf = await renderer.render(track, 'wav');
      expect(buf.length).toBeGreaterThan(1000);
      expect(buf.subarray(0, 4).toString('ascii')).toBe('RIFF');
    } finally {
      await renderer.close();
    }
  }, 120000);
});
```

- [ ] **Step 3: Run the unit tests to verify they fail**

Run: `npx vitest run test/render-audio.test.mjs`
Expected: FAIL — `renderId`/`b64ToBuffer` not exported. (The integration block is skipped because `CRATE_RENDER_IT` is unset.)

- [ ] **Step 4: Implement `server/render-audio.mjs`**

```javascript
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
```

- [ ] **Step 5: Run the unit tests to verify they pass**

Run: `npx vitest run test/render-audio.test.mjs`
Expected: PASS (2 unit tests; integration skipped).

- [ ] **Step 6: Run the gated integration render (real proof it works)**

This needs the app serving the built bundle. In one shell: `npm run build && node server/index.mjs` (serves `dist/` on :3008). In another:

Run: `CRATE_RENDER_IT=1 CRATE_RENDER_URL=http://localhost:3008/export-render.html npx vitest run test/render-audio.test.mjs`
Expected: PASS — the integration test renders the tiny track and asserts a `RIFF` header, length > 1000. Paste the output into the task report. If Chrome fails to launch, confirm `/opt/google/chrome/chrome` exists and retry with `--no-sandbox` already set.

- [ ] **Step 7: Commit**

```bash
git add server/render-audio.mjs test/render-audio.test.mjs package.json package-lock.json
git commit -m "feat(export-cache): headless-Chrome render engine driving export-render.html"
```

---

## Task 3: Render-or-cache service with in-flight dedup + prewarm

**Files:**
- Create: `server/audio-export.mjs`
- Test: `test/audio-export.test.mjs`

**Interfaces:**
- Consumes: `createAudioCache` (Task 1); a renderer with `render(track, fmt) => Promise<Buffer>` (Task 2); `adminDb`.
- Produces: `createAudioExport({ adminDb, cache, renderer, namespaces = ['tracks','stems'] }) => { getOrRender, prewarm }`
  - `async getOrRender(ns, idOrSlug, fmt) => { path, filename } | null` — resolves the row (by entity id, then slug), keyed by `row.id`; serves a cache hit or renders+stores on miss. `filename = <slug>.<ext>`. Concurrent identical requests share one render. Returns `null` if `ns` is unknown or no row matches.
  - `async prewarm(ns, idOrSlug, fmt = 'mp3') => void` — fire-and-forget `getOrRender`, swallowing errors (background warming).

- [ ] **Step 1: Write the failing tests**

Create `test/audio-export.test.mjs`:

```javascript
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeAdmin } from './fake-admin.mjs';
import { createAudioCache } from '../server/audio-cache.mjs';
import { createAudioExport } from '../server/audio-export.mjs';

let dir, adminDb, cache;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'audio-export-'));
  adminDb = fakeAdmin({
    tracks: [{ id: 't1', slug: 'demo-01', code: 'note("c3")', meta: { bpm: 120 } }],
    stems: [],
  });
  cache = createAudioCache({ dir });
});

// A renderer that counts calls and returns deterministic bytes.
function fakeRenderer() {
  let calls = 0;
  return {
    get calls() { return calls; },
    render: async () => { calls += 1; await new Promise((r) => setTimeout(r, 10)); return Buffer.from('AUDIO'); },
  };
}

describe('createAudioExport.getOrRender', () => {
  it('renders + caches on miss, keyed by entity id, filename uses slug', async () => {
    const renderer = fakeRenderer();
    const ex = createAudioExport({ adminDb, cache, renderer });
    const out = await ex.getOrRender('tracks', 'demo-01', 'mp3');
    expect(out.path).toBe(join(dir, 'tracks', 't1.mp3'));
    expect(out.filename).toBe('demo-01.mp3');
    expect(await readFile(out.path, 'utf8')).toBe('AUDIO');
    expect(renderer.calls).toBe(1);
  });

  it('serves cache hit without re-rendering', async () => {
    const renderer = fakeRenderer();
    const ex = createAudioExport({ adminDb, cache, renderer });
    await ex.getOrRender('tracks', 't1', 'mp3'); // resolve by entity id too
    await ex.getOrRender('tracks', 'demo-01', 'mp3');
    expect(renderer.calls).toBe(1);
  });

  it('dedups concurrent identical requests into one render', async () => {
    const renderer = fakeRenderer();
    const ex = createAudioExport({ adminDb, cache, renderer });
    await Promise.all([
      ex.getOrRender('tracks', 'demo-01', 'wav'),
      ex.getOrRender('tracks', 'demo-01', 'wav'),
    ]);
    expect(renderer.calls).toBe(1);
  });

  it('returns null for an unknown item or namespace', async () => {
    const ex = createAudioExport({ adminDb, cache, renderer: fakeRenderer() });
    expect(await ex.getOrRender('tracks', 'nope', 'wav')).toBeNull();
    expect(await ex.getOrRender('widgets', 'demo-01', 'wav')).toBeNull();
  });

  it('prewarm renders in the background and swallows errors', async () => {
    const renderer = { render: async () => { throw new Error('boom'); } };
    const ex = createAudioExport({ adminDb, cache, renderer });
    await ex.prewarm('tracks', 'demo-01', 'mp3'); // must not throw
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/audio-export.test.mjs`
Expected: FAIL — `createAudioExport` missing.

- [ ] **Step 3: Implement `server/audio-export.mjs`**

```javascript
// Glue between the HTTP layer, the disk cache, and the headless renderer.
// Resolves an item (by entity id, then slug), keys the cache by entity id, and
// names the download by slug. Identical concurrent renders share one promise so
// a burst of clicks renders once.
const FORMATS = new Set(['wav', 'mp3', 'stems']);

export function createAudioExport({ adminDb, cache, renderer, namespaces = ['tracks', 'stems'] }) {
  const inflight = new Map(); // `${ns}:${id}:${fmt}` -> Promise<path>

  async function resolveRow(ns, idOrSlug) {
    const byId = await adminDb.query({ [ns]: { $: { where: { id: idOrSlug } } } });
    if (byId[ns]?.[0]) return byId[ns][0];
    const bySlug = await adminDb.query({ [ns]: { $: { where: { slug: idOrSlug } } } });
    return bySlug[ns]?.[0] ?? null;
  }

  async function getOrRender(ns, idOrSlug, fmt) {
    if (!namespaces.includes(ns) || !FORMATS.has(fmt)) return null;
    const row = await resolveRow(ns, idOrSlug);
    if (!row) return null;
    const filename = `${row.slug}.${cache.EXT[fmt]}`;

    const hit = await cache.cachedPath(ns, row.id, fmt);
    if (hit) return { path: hit, filename };

    const key = `${ns}:${row.id}:${fmt}`;
    let job = inflight.get(key);
    if (!job) {
      job = (async () => {
        const track = { id: row.slug, code: row.code, meta: row.meta };
        const buffer = await renderer.render(track, fmt);
        return cache.store(ns, row.id, fmt, buffer);
      })().finally(() => inflight.delete(key));
      inflight.set(key, job);
    }
    const path = await job;
    return { path, filename };
  }

  async function prewarm(ns, idOrSlug, fmt = 'mp3') {
    try { await getOrRender(ns, idOrSlug, fmt); } catch { /* background; ignore */ }
  }

  return { getOrRender, prewarm };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/audio-export.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/audio-export.mjs test/audio-export.test.mjs
git commit -m "feat(export-cache): render-or-cache service with in-flight dedup + prewarm"
```

---

## Task 4: HTTP endpoint `GET /api/:ns/:id/audio.:fmt`

**Files:**
- Modify: `server/app.mjs` (add `audioRoutes`; wire into `createApp`)
- Test: `test/api.test.mjs`

**Interfaces:**
- Consumes: `audioExport.getOrRender` (Task 3).
- Produces: route `GET /api/:ns/:id/audio.:fmt` — 200 streams the cached/just-rendered file with `Content-Disposition: attachment; filename="<slug>.<ext>"` and the right `Content-Type`; 404 for unknown item/namespace/format. Mounted only when `createApp` receives `audioExport`.

- [ ] **Step 1: Write the failing tests**

Add to `test/api.test.mjs` (new `describe` block; it builds its own app with a stub `audioExport`):

```javascript
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';

describe('audio export API', () => {
  it('GET /api/:ns/:id/audio.:fmt streams the file with a download filename', async () => {
    const d = await mkdtemp(join(tmpdir(), 'audio-api-'));
    await mkdir(join(d, 'tracks'), { recursive: true });
    const p = join(d, 'tracks', 't1.mp3');
    await writeFile(p, 'MP3BYTES');
    const audioExport = {
      getOrRender: async (ns, id, fmt) =>
        ns === 'tracks' && id === 'demo-01' && fmt === 'mp3' ? { path: p, filename: 'demo-01.mp3' } : null,
    };
    const app2 = createApp({ adminDb, namespaces: ['tracks', 'stems'], requireAuth, requireUser, audioExport });
    const res = await request(app2).get('/api/tracks/demo-01/audio.mp3');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('audio/mpeg');
    expect(res.headers['content-disposition']).toContain('filename="demo-01.mp3"');
    expect(res.text).toBe('MP3BYTES');
  });

  it('404s when the item cannot be rendered/resolved', async () => {
    const audioExport = { getOrRender: async () => null };
    const app2 = createApp({ adminDb, namespaces: ['tracks', 'stems'], requireAuth, requireUser, audioExport });
    const res = await request(app2).get('/api/tracks/missing/audio.wav');
    expect(res.status).toBe(404);
  });

  it('404s an unsupported format', async () => {
    const audioExport = { getOrRender: async () => null };
    const app2 = createApp({ adminDb, namespaces: ['tracks', 'stems'], requireAuth, requireUser, audioExport });
    const res = await request(app2).get('/api/tracks/demo-01/audio.flac');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/api.test.mjs -t 'audio export API'`
Expected: FAIL — route returns 404/HTML for all (route not mounted yet).

- [ ] **Step 3: Add `audioRoutes` and wire `createApp`**

In `server/app.mjs`, add this function (near `jobRoutes`):

```javascript
const AUDIO_TYPE = { wav: 'audio/wav', mp3: 'audio/mpeg', zip: 'application/zip' };

// GET /api/:ns/:id/audio.:fmt — serve a cached export, rendering on miss.
// Reads stay public (downloads mirror the public list/song pages).
function audioRoutes(app, audioExport, namespaces) {
  app.get('/api/:ns/:id/audio.:fmt', wrap(async (req, res) => {
    const { ns, id, fmt } = req.params;
    if (!namespaces.includes(ns)) return res.status(404).json({ error: 'not found' });
    const out = await audioExport.getOrRender(ns, id, fmt);
    if (!out) return res.status(404).json({ error: 'not found' });
    const ext = out.filename.split('.').pop();
    res.type(AUDIO_TYPE[ext] ?? 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.sendFile(out.path);
  }));
}
```

Then in `createApp`, mount it where the other optional routes are (next to the `sampleCacheDir` block):

```javascript
  if (opts.audioExport) audioRoutes(app, opts.audioExport, namespaces);
```

(Place this **before** the `opts.distDir` static/catch-all block so the API route wins over the SPA fallback.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/api.test.mjs`
Expected: PASS (whole file, including the 3 new cases).

- [ ] **Step 5: Commit**

```bash
git add server/app.mjs test/api.test.mjs
git commit -m "feat(export-cache): GET /api/:ns/:id/audio.:fmt endpoint"
```

---

## Task 5: Pre-warm MP3 after a successful job

**Files:**
- Modify: `server/runner.mjs` (`createRunner` accepts `audioExport`; `runOne` prewarms `newItems`)
- Test: `test/runner.test.mjs`

**Interfaces:**
- Consumes: `audioExport.prewarm(ns, idOrSlug, 'mp3')` (Task 3); the `newItems` (slugs) the runner already computes.
- Produces: after a job reaches `status: 'done'`, the runner calls `audioExport.prewarm(ns, slug, 'mp3')` for each new item (fire-and-forget). No prewarm on failure. `audioExport` is optional — when absent, the runner behaves exactly as before.

- [ ] **Step 1: Write the failing test**

Add to `test/runner.test.mjs` (inside the `describe2('createRunner worker', ...)` block):

```javascript
  it2('prewarms mp3 for each new item after a successful job', async () => {
    const { spawn, children } = fakeSpawnFactory();
    const admin = fakeAdmin({ profiles: [], stems: [], tracks: [] });
    const warmed = [];
    const audioExport = { prewarm: async (ns, slug, fmt) => { warmed.push(`${ns}:${slug}:${fmt}`); } };
    const runner = createRunner({ repoRoot, jobStore, adminDb: admin, spawn, now: ticks, audioExport });
    await jobStore.write(baseJob('j1'));
    await runner.enqueue(baseJob('j1'));
    await until(() => children.length === 1);
    admin._store.stems.push(
      { id: 's1', slug: 'a-01', batch: 'B', jobId: 'j1' },
      { id: 's2', slug: 'a-02', batch: 'B', jobId: 'j1' },
    );
    children[0].emit('close', 0);
    await until(async () => (await jobStore.get('j1')).status === 'done');
    await until(() => warmed.length === 2);
    expect2(warmed.sort()).toEqual(['stems:a-01:mp3', 'stems:a-02:mp3']);
  });

  it2('does not prewarm when the job failed', async () => {
    const { spawn, children } = fakeSpawnFactory();
    const admin = fakeAdmin({ profiles: [], stems: [], tracks: [] });
    const warmed = [];
    const audioExport = { prewarm: async (...a) => { warmed.push(a); } };
    const runner = createRunner({ repoRoot, jobStore, adminDb: admin, spawn, now: ticks, audioExport });
    await jobStore.write(baseJob('j1'));
    await runner.enqueue(baseJob('j1'));
    await until(() => children.length === 1);
    children[0].emit('close', 1); // failure
    await until(async () => (await jobStore.get('j1')).status === 'failed');
    expect2(warmed).toEqual([]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/runner.test.mjs -t 'prewarm'`
Expected: FAIL — runner never calls `prewarm` (option unused).

- [ ] **Step 3: Implement the prewarm hook in `server/runner.mjs`**

Add `audioExport` to the `createRunner` destructure:

```javascript
export function createRunner({
  repoRoot, jobStore, adminDb,
  spawn = nodeSpawn,
  now = () => new Date().toISOString(),
  maxConcurrent = 1,
  audioExport = null,
}) {
```

In `runOne`, right after the success branch sets `patch.status = 'done'` and before `await jobStore.update(id, patch);`, fire the prewarm for the new items. Concretely, replace the success branch:

```javascript
      if (code === 0) {
        patch.status = 'done';
        patch.summary = parseSummary(out);
        // Background-warm the small MP3 for each new item so the first download
        // is instant (WAV stays lazy). Fire-and-forget; never blocks the job.
        if (audioExport) for (const slug of newItems) audioExport.prewarm(ns, slug, 'mp3');
      } else {
```

(Keep the rest of the `else` failure branch unchanged.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/runner.test.mjs`
Expected: PASS (whole file).

- [ ] **Step 5: Commit**

```bash
git add server/runner.mjs test/runner.test.mjs
git commit -m "feat(export-cache): prewarm mp3 for new items after a successful job"
```

---

## Task 6: Compose everything in `server/index.mjs`

**Files:**
- Modify: `server/index.mjs`

**Interfaces:**
- Consumes: `createAudioCache` (T1), `createRenderer` (T2), `createAudioExport` (T3), and the new `createApp`/`createRunner` options (T4, T5).
- Produces: a running server that serves the audio endpoint and prewarms after jobs. Disk cap from `CRATE_AUDIO_CACHE_MAX_BYTES` (default 3 GB). Renderer points at the server's own `/export-render.html`.

- [ ] **Step 1: Wire the composition root**

In `server/index.mjs`, add imports near the others:

```javascript
import { createAudioCache } from './audio-cache.mjs';
import { createRenderer } from './render-audio.mjs';
import { createAudioExport } from './audio-export.mjs';
```

After `const port = process.env.PORT ?? 3001;` is known, build the export stack. (Move the `port` const up if needed so it's available here — define it before `createRunner`.) Replace the runner/app construction region so it reads:

```javascript
const port = process.env.PORT ?? 3001;

const audioCache = adminDb
  ? createAudioCache({
      dir: join(repoRoot, 'data', 'audio-cache'),
      maxBytes: Number(process.env.CRATE_AUDIO_CACHE_MAX_BYTES) || 3221225472,
    })
  : null;
const renderer = adminDb
  ? createRenderer({ pageUrl: `http://localhost:${port}/export-render.html` })
  : null;
const audioExport = audioCache && renderer
  ? createAudioExport({ adminDb, cache: audioCache, renderer, namespaces: ['tracks', 'stems'] })
  : null;

const runner = createRunner({
  repoRoot, jobStore, adminDb,
  maxConcurrent: Number(process.env.CRATE_MAX_JOBS) || 1,
  audioExport,
});
```

Add `audioExport` to the `createApp({ ... })` call options:

```javascript
const app = createApp({
  adminDb,
  namespaces: ['tracks', 'stems'],
  jobStore, runner, progressFor, requireAuth, resolveUser, requireUser, allowedEmails,
  distDir: existsSync(distDir) ? distDir : undefined,
  sampleCacheDir: join(repoRoot, 'data', 'sample-cache'),
  audioExport,
});
```

(Ensure `join` is already imported — it is, from `node:path`. Remove the now-duplicate later `const port` if one exists.)

- [ ] **Step 2: Static check + full suite**

Run: `node --check server/index.mjs && npm test`
Expected: `node --check` silent; `npm test` green (the gated render integration test stays skipped).

- [ ] **Step 3: Manual smoke (real endpoint, on a host with Chrome)**

```bash
npm run build
node server/index.mjs &      # serves dist on :3008
sleep 2
curl -s -D - -o /tmp/smoke.mp3 http://localhost:3008/api/stems/2026-06-23-dance-pop-uk-garage-bass-smooth-powerful-04/audio.mp3 | head -20
file /tmp/smoke.mp3
# second call should be instant (cache hit):
time curl -s -o /tmp/smoke2.mp3 http://localhost:3008/api/stems/2026-06-23-dance-pop-uk-garage-bass-smooth-powerful-04/audio.mp3
ls -la data/audio-cache/stems/
kill %1
```

Expected: first call returns 200 `audio/mpeg`, `/tmp/smoke.mp3` is an MPEG/Audio file; second call returns in well under a second (cache hit); `data/audio-cache/stems/<id>.mp3` exists. Paste output into the report.

- [ ] **Step 4: Commit**

```bash
git add server/index.mjs
git commit -m "feat(export-cache): compose cache+renderer+export service; CRATE_AUDIO_CACHE_MAX_BYTES"
```

---

## Task 7: Switch client downloads to the endpoint

**Files:**
- Modify: `src/song.js`, `src/app.js`
- Delete: `src/export.js`
- Test: manual (build + browser)

**Interfaces:**
- Consumes: `GET /api/:ns/:id/audio.:fmt`.
- Produces: download buttons that navigate to the endpoint URL (browser handles the download), with no client-side `OfflineAudioContext` render and no 5-minute iframe timeout.

- [ ] **Step 1: Find every caller of the old export path**

Run: `grep -rn "exportTrack\|isExporting\|from './export.js'\|from './export'" src/`
Expected: matches in `src/song.js` and `src/app.js` (the download button handlers). Note each call site.

- [ ] **Step 2: Replace the song-page download handler**

In `src/song.js`, the export buttons currently call `exportTrack(item, fmt, …)`. Replace the click handler body so it navigates to the endpoint. The namespace is `ns` (already known in `renderSong`), the id is `item.entityId`, and the formats are the same list. Replace the button's click listener with:

```javascript
    btn.addEventListener('click', () => {
      // Server renders+caches; the browser downloads the file. No client render.
      const url = `/api/${ns}/${item.entityId}/audio.${fmt}`;
      const a = document.createElement('a');
      a.href = url;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
```

Remove the now-unused `import { exportTrack, isExporting } from './export.js';` and any `isExporting()`/disable-all-buttons logic tied to it on this page.

- [ ] **Step 3: Replace the list-page download handler**

In `src/app.js`, the per-card export buttons also call `exportTrack`. Replace their click handler the same way, using the card's namespace (`collection`) and the track's entity id:

```javascript
      btn.addEventListener('click', () => {
        const url = `/api/${collection}/${track.entityId}/audio.${fmt}`;
        const a = document.createElement('a');
        a.href = url;
        a.download = '';
        document.body.appendChild(a);
        a.click();
        a.remove();
      });
```

Remove the `import { exportTrack, isExporting } from './export.js';` line and any `isExporting`-based button disabling.

- [ ] **Step 4: Delete the dead orchestrator**

```bash
git rm src/export.js
```

(`src/render.js`, `src/export-render.js`, `src/export-spec.js`, `src/encoders.js`, `src/zip.js` stay — they compile into the `export-render.html` bundle the server now drives.)

- [ ] **Step 5: Verify the build and no dangling imports**

Run: `grep -rn "export.js\|exportTrack\|isExporting" src/ && echo "STILL REFERENCED" || echo "clean"`
Expected: `clean`.

Run: `npm run build`
Expected: build succeeds with no "could not resolve ./export.js" error.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: green (no test imported `src/export.js`; if any did, it would have failed the build/grep above — fix by removing that test).

- [ ] **Step 7: Manual browser check**

Serve the build (`node server/index.mjs`), open a song page locally, click ↓ mp3 then ↓ wav. Expected: mp3 downloads quickly (prewarmed/cached); wav downloads after the server render (no "export timed out"). Confirm the downloaded files play.

- [ ] **Step 8: Commit**

```bash
git add src/song.js src/app.js
git commit -m "feat(export-cache): download via server endpoint; remove client iframe export"
```

---

## Deployment (after all tasks, before relying on it)

1. **Install the new dependency on the deploy host:** in `/home/builder/apps/crate`, `npm install` (picks up `puppeteer-core`; no Chromium download). Confirm `/opt/google/chrome/chrome` exists (it does on this box) or set `Environment=CRATE_CHROME=<path>` in the service.
2. **Build the frontend:** `npm run build` (the endpoint + client-link change need a fresh `dist/`). Coordinate so the concurrent session isn't rebuilding `dist/` at the same moment.
3. **Restart:** `sudo systemctl restart vimsical-crate`. Optionally set `Environment=CRATE_AUDIO_CACHE_MAX_BYTES=...` to tune the cap (default 3 GB).
4. **Verify:** `curl -D - http://localhost:3008/api/stems/<id>/audio.mp3` → 200 `audio/mpeg`; second call instant; `du -sh data/audio-cache` stays ≤ 3 GB after heavy use.

**Notes / accepted trade-offs (YAGNI for v1):**
- A lazy WAV miss holds the HTTP connection for the duration of the render (minutes for heavy songs). MP3 is pre-warmed so the common path is instant. If first-WAV latency becomes a problem, a `202 + poll` job flow is the follow-up — not built now.
- One render at a time (serial) bounds load on this RAM-tight box; pre-warm bursts after a big generate run will trickle through the single slot.
- The 3 GB cap governs `data/audio-cache/` only; `data/sample-cache/` (~222 MB) is separate.

---

## Self-Review

**Spec coverage:**
- Server-side render reusing the real DSP → Task 2 (headless Chrome drives the built `/export-render.html`). ✓
- Pre-render so downloads are fast → Task 5 (prewarm mp3 after jobs) + Task 4 (serve cache) + Task 7 (client uses endpoint). ✓
- Hybrid trigger (mp3 prewarm at save-time, wav lazy) → Task 5 prewarms mp3 only; Task 3/4 render wav on first request. ✓ (Save-time = job completion, the server-side moment that knows the new items.)
- One 3 GB LRU over both formats → Task 1 (`prune` by atime, single dir, 3 GB default) + Task 6 (`CRATE_AUDIO_CACHE_MAX_BYTES`). ✓
- "Don't take up too much disk, 3 GB tops" → cap default 3 GB, enforced on every write; documented that it covers the audio cache (sample-cache separate). ✓

**Placeholder scan:** No TBD/TODO/"handle errors" — every code step is complete; every run step has a command + expected output. The one non-unit test (real render) is full, runnable, and explicitly gated. ✓

**Type/name consistency:** `createAudioCache` → `{ EXT, cachedPath, store, prune }` used identically in Tasks 3 & 6. `createRenderer` → `{ render, close }` consumed in Tasks 3 & 6. `createAudioExport` → `{ getOrRender, prewarm }`; `getOrRender` returns `{ path, filename }|null` consumed by Task 4's route; `prewarm(ns, slug, 'mp3')` called by Task 5's runner. `audioExport` option threaded through `createApp` (T4), `createRunner` (T5), and `index.mjs` (T6) with the same name. `GET /api/:ns/:id/audio.:fmt` defined in T4 and called by T7. ✓
