# Client-Side Desktop Audio Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render song downloads (WAV/MP3/stems) in the user's own desktop browser instead of on the server, gate downloads off on mobile, and delete the server's headless-Chrome audio-render path.

**Architecture:** A hidden `<iframe src="/export-render.html">` runs the existing `export-render.js` render protocol in an isolated JS realm (so it never disturbs live playback) and posts the rendered `Blob` back to the page via `postMessage`. A small client (`src/export-client.js`) drives that iframe; a device gate (`src/device.js`) shows buttons only on desktop. The server audio route + renderer + cache are removed (puppeteer stays for OG cards).

**Tech Stack:** Vanilla-JS client + `@instantdb/core`, existing `@strudel/webaudio` `OfflineAudioContext` render (`src/render.js`/`src/export-render.js`), `vitest` (environment: `node`), Express server.

## Global Constraints

- **Worktree required.** `src/app.js` and `src/song.js` have concurrent edits from another session. Implement on an isolated git worktree (invoke `superpowers:using-git-worktrees`), then merge into the live worktree at `/home/builder/apps/crate` and `sudo systemctl restart vimsical-crate` to deploy. A worktree branch is NOT live.
- **Test env is `node`** (`vitest.config.js`): no `document`/`window`. Pure logic and the iframe protocol are unit-tested by injecting fakes; DOM wiring (`src/export-buttons.js`, the page edits) is verified manually. Do not add jsdom.
- **Desktop gate query (verbatim):** `(min-width: 768px) and (pointer: fine)`.
- **Mobile copy (verbatim):** `downloads available on desktop`.
- **Keep puppeteer + `server/render-card.mjs`/`og.mjs`** (OG cards still render server-side). Only the *audio* render path is removed.
- **Reuse, don't rewrite the render.** `src/render.js`, `src/export-render.js`, `export-render.html`, `shared/sample-banks.json` stay; the iframe loads them.
- **Render track shape:** the render needs `{ id, code, meta }` where `id` is the **slug** (client rows carry `id = row.slug`, `entityId = row.id`).
- **Download filenames:** `<slug>.wav`, `<slug>.mp3`, `<slug>.zip` (matches prior server names).
- Run a single test file with `npx vitest run test/<file>`.

---

## File Structure

**New:**
- `src/device.js` — `isDesktop()` device gate. One responsibility: "may this device render downloads?"
- `src/export-client.js` — `createExportClient`/`getExportClient` (hidden-iframe render driver + in-session Blob cache), `exportFilename`, `triggerBlobDownload`.
- `src/export-buttons.js` — `wireExports(...)` builds the format buttons (desktop) or the desktop-only note (mobile) and handles click → render → download with button states. Shared by both pages.

**Modified:**
- `src/render.js` — `renderStemsZip(track, onProgress)` reports per-stem progress.
- `src/export-render.js` — forward stem progress as `{type:'progress'}` postMessages.
- `src/song.js` — replace the inline export-button loop with `wireExports`.
- `src/app.js` — same, preserving the share/remix buttons.

**Removed:**
- `server/audio-export.mjs`, `server/render-audio.mjs`, `server/audio-cache.mjs` and their tests (`test/audio-export.test.mjs`, `test/audio-cache.test.mjs`, `test/render-audio.test.mjs`).
- The `/api/:ns/:id/audio.:fmt` route + `audioRoutes` in `server/app.mjs`; `audioExport` wiring in `server/index.mjs`; the MP3 prewarm in `server/runner.mjs`.

---

## Task 1: Device gate (`isDesktop`)

**Files:**
- Create: `src/device.js`
- Test: `test/device.test.mjs`

**Interfaces:**
- Produces: `isDesktop(): boolean` — `true` iff `matchMedia('(min-width: 768px) and (pointer: fine)').matches`; `false` when `matchMedia` is unavailable.

- [ ] **Step 1: Write the failing test**

```javascript
// test/device.test.mjs
import { describe, it, expect, afterEach } from 'vitest';
import { isDesktop } from '../src/device.js';

afterEach(() => { delete globalThis.matchMedia; });

describe('isDesktop', () => {
  it('is true when the desktop media query matches', () => {
    globalThis.matchMedia = (q) => ({ matches: q.includes('pointer: fine') });
    expect(isDesktop()).toBe(true);
  });
  it('is false when the query does not match', () => {
    globalThis.matchMedia = () => ({ matches: false });
    expect(isDesktop()).toBe(false);
  });
  it('is false when matchMedia is unavailable', () => {
    expect(isDesktop()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/device.test.mjs`
Expected: FAIL — `Cannot find module '../src/device.js'`.

- [ ] **Step 3: Implement `src/device.js`**

```javascript
// Single source of truth for "may this device render downloads?". Desktop =
// a wide viewport AND a fine pointer (mouse/trackpad). Phones/tablets report a
// coarse pointer and are excluded — long OfflineAudioContext renders are gated
// to capable desktops by product decision.
const DESKTOP_QUERY = '(min-width: 768px) and (pointer: fine)';

export function isDesktop() {
  if (typeof matchMedia !== 'function') return false;
  return matchMedia(DESKTOP_QUERY).matches;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/device.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/device.js test/device.test.mjs
git commit -m "feat(client): isDesktop device gate"
```

---

## Task 2: Export client (iframe render driver)

**Files:**
- Create: `src/export-client.js`
- Test: `test/export-client.test.mjs`

**Interfaces:**
- Produces:
  - `exportFilename(slug, fmt) => string` — `<slug>.wav|mp3|zip`.
  - `createExportClient({ src?, connect? }) => { render, destroy }` where:
    - `render(track, fmt, { onProgress? }) => Promise<Blob>` — posts `{type:'render', id:'<slug>:<fmt>', track, format:fmt}` to the iframe, resolves the `Blob` from `{type:'done', id, blob}`, rejects on `{type:'error', id, message}`, forwards `{type:'progress', id, done, total}` to `onProgress({done,total})`. Caches the Blob by `id` for the session and dedupes in-flight calls.
    - `connect(src) => { post(msg), onMessage(handler)=>unsub, destroy() }` is the injectable transport (default builds the hidden iframe). The render protocol mirrors `server/render-audio.mjs`.
  - `getExportClient()` — lazily-created singleton (one iframe per page).
  - `triggerBlobDownload(blob, filename)` — DOM helper that downloads a Blob.

- [ ] **Step 1: Write the failing test**

```javascript
// test/export-client.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { createExportClient, exportFilename } from '../src/export-client.js';

function fakeConnect() {
  const ctx = { posts: [], handler: null, destroyed: false };
  ctx.transport = {
    post: (m) => ctx.posts.push(m),
    onMessage: (h) => { ctx.handler = h; return () => { ctx.handler = null; }; },
    destroy: () => { ctx.destroyed = true; },
  };
  ctx.emit = (d) => ctx.handler?.(d);
  ctx.renders = () => ctx.posts.filter((m) => m.type === 'render');
  return ctx;
}
const track = { id: 'song-1', code: 'c', meta: { bpm: 120 } };

describe('exportFilename', () => {
  it('maps formats to extensions', () => {
    expect(exportFilename('song-1', 'wav')).toBe('song-1.wav');
    expect(exportFilename('song-1', 'mp3')).toBe('song-1.mp3');
    expect(exportFilename('song-1', 'stems')).toBe('song-1.zip');
  });
});

describe('createExportClient', () => {
  it('posts a render after ready and resolves with the blob', async () => {
    const f = fakeConnect();
    const client = createExportClient({ connect: () => f.transport });
    const promise = client.render(track, 'wav');
    f.emit({ type: 'ready' });
    await vi.waitFor(() => expect(f.renders().length).toBe(1));
    expect(f.renders()[0]).toEqual({ type: 'render', id: 'song-1:wav', track, format: 'wav' });
    const blob = new Blob(['x']);
    f.emit({ type: 'done', id: 'song-1:wav', blob });
    await expect(promise).resolves.toBe(blob);
  });

  it('rejects on an error message', async () => {
    const f = fakeConnect();
    const client = createExportClient({ connect: () => f.transport });
    const promise = client.render(track, 'mp3');
    f.emit({ type: 'ready' });
    await vi.waitFor(() => expect(f.renders().length).toBe(1));
    f.emit({ type: 'error', id: 'song-1:mp3', message: 'boom' });
    await expect(promise).rejects.toThrow('boom');
  });

  it('forwards progress to onProgress', async () => {
    const f = fakeConnect();
    const client = createExportClient({ connect: () => f.transport });
    const onProgress = vi.fn();
    const promise = client.render(track, 'stems', { onProgress });
    f.emit({ type: 'ready' });
    await vi.waitFor(() => expect(f.renders().length).toBe(1));
    f.emit({ type: 'progress', id: 'song-1:stems', done: 1, total: 3 });
    expect(onProgress).toHaveBeenCalledWith({ done: 1, total: 3 });
    f.emit({ type: 'done', id: 'song-1:stems', blob: new Blob(['z']) });
    await promise;
  });

  it('caches the blob: a second render returns it without posting again', async () => {
    const f = fakeConnect();
    const client = createExportClient({ connect: () => f.transport });
    const p1 = client.render(track, 'wav');
    f.emit({ type: 'ready' });
    await vi.waitFor(() => expect(f.renders().length).toBe(1));
    const blob = new Blob(['x']);
    f.emit({ type: 'done', id: 'song-1:wav', blob });
    await p1;
    const again = await client.render(track, 'wav');
    expect(again).toBe(blob);
    expect(f.renders().length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/export-client.test.mjs`
Expected: FAIL — `Cannot find module '../src/export-client.js'`.

- [ ] **Step 3: Implement `src/export-client.js`**

```javascript
// In-browser twin of server/render-audio.mjs: drives a hidden iframe running
// export-render.html (its own JS realm + audio context, so renders never touch
// live playback) over the same postMessage protocol, and downloads the Blob.
const EXT = { wav: 'wav', mp3: 'mp3', stems: 'zip' };

export function exportFilename(slug, fmt) {
  return `${slug}.${EXT[fmt] ?? fmt}`;
}

function defaultConnect(src) {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
  iframe.src = src;
  document.body.appendChild(iframe);
  const handlers = new Set();
  // export-render.js posts to `parent`; only accept messages from OUR iframe.
  const onWin = (e) => { if (e.source === iframe.contentWindow) for (const h of handlers) h(e.data); };
  window.addEventListener('message', onWin);
  return {
    post: (msg) => iframe.contentWindow?.postMessage(msg, '*'),
    onMessage: (h) => { handlers.add(h); return () => handlers.delete(h); },
    destroy: () => { window.removeEventListener('message', onWin); iframe.remove(); },
  };
}

export function createExportClient({ src = '/export-render.html', connect = defaultConnect } = {}) {
  let transport = null;
  let readyPromise = null;
  const cache = new Map();    // key -> Blob (session memo)
  const inflight = new Map(); // key -> Promise<Blob>
  const waiters = new Map();  // key -> { resolve, reject, onProgress }

  function ensure() {
    if (transport) return readyPromise;
    transport = connect(src);
    readyPromise = new Promise((resolve) => {
      transport.onMessage((data) => {
        if (!data || data.type == null) return;
        if (data.type === 'ready') { resolve(); return; }
        const w = waiters.get(data.id);
        if (!w) return;
        if (data.type === 'progress') { w.onProgress?.({ done: data.done, total: data.total }); return; }
        if (data.type === 'done') { waiters.delete(data.id); w.resolve(data.blob); return; }
        if (data.type === 'error') { waiters.delete(data.id); w.reject(new Error(data.message || 'render failed')); }
      });
    });
    return readyPromise;
  }

  function render(track, fmt, { onProgress } = {}) {
    const key = `${track.id}:${fmt}`;
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      await ensure();
      const blob = await new Promise((resolve, reject) => {
        waiters.set(key, { resolve, reject, onProgress });
        transport.post({ type: 'render', id: key, track, format: fmt });
      });
      cache.set(key, blob);
      return blob;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  return {
    render,
    destroy() { transport?.destroy(); transport = null; readyPromise = null; waiters.clear(); },
  };
}

let singleton = null;
export function getExportClient() { return (singleton ??= createExportClient()); }

export function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/export-client.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/export-client.js test/export-client.test.mjs
git commit -m "feat(client): export-client iframe render driver + filename/download helpers"
```

---

## Task 3: Per-stem render progress

**Files:**
- Modify: `src/render.js` (`renderStemsZip`)
- Modify: `src/export-render.js`
- Test: `test/render.test.mjs` (extend — backward-compat assertion only)

**Interfaces:**
- Consumes: nothing new.
- Produces: `renderStemsZip(track, onProgress?)` calls `onProgress(done, total)` after each stem WAV finishes (`done` 1-based, `total` = number of stems). `export-render.js` passes an `onProgress` that posts `{type:'progress', id, done, total}` to `parent`.

**Note:** `src/render.js`/`src/export-render.js` are browser-only (need a real `OfflineAudioContext`); they are not fully unit-tested. The change is additive and backward-compatible (the existing `renderTrack` guard tests still pass), and the progress *contract* is already unit-tested in Task 2 (`export-client` forwards `{type:'progress'}`). End-to-end progress is verified manually in Task 5.

- [ ] **Step 1: Verify the existing render tests still describe current behavior**

Run: `npx vitest run test/render.test.mjs`
Expected: PASS (baseline before the change).

- [ ] **Step 2: Add the `onProgress` parameter to `renderStemsZip`**

In `src/render.js`, change the stems loop (currently the `for (let i = 0; i < groups.length; i++)` block) to:

```javascript
export async function renderStemsZip(track, onProgress) {
  const pattern = await evalPattern(track);
  const spec = exportSpec(track);
  const groups = groupHapsBySound(collectHaps(pattern, spec.cycles, spec.cps));
  const names = stemFilenames(track.id, groups.map((g) => g.name));
  const files = [];
  for (let i = 0; i < groups.length; i++) {
    const buffer = await renderHapsToBuffer(groups[i].haps, spec);
    files.push({ name: names[i], data: new Uint8Array(encodeWav(buffer, 24)) });
    onProgress?.(i + 1, groups.length);
  }
  return new Blob([zipStore(files)], { type: 'application/zip' });
}
```

- [ ] **Step 3: Forward progress from `export-render.js`**

In `src/export-render.js`, change the render branch inside the message handler to:

```javascript
  try {
    await ready;
    const onProgress = (done, total) => parent.postMessage({ type: 'progress', id, done, total }, '*');
    const blob = format === 'stems' ? await renderStemsZip(track, onProgress) : await renderTrack(track, format);
    parent.postMessage({ type: 'done', id, blob }, '*');
  } catch (err) {
    parent.postMessage({ type: 'error', id, message: err.message }, '*');
  }
```

- [ ] **Step 4: Confirm the render tests still pass (backward compatibility)**

Run: `npx vitest run test/render.test.mjs`
Expected: PASS — `renderTrack` guard behavior unchanged; the new `onProgress` arg is optional.

- [ ] **Step 5: Commit**

```bash
git add src/render.js src/export-render.js
git commit -m "feat(render): per-stem progress callback forwarded as postMessage"
```

---

## Task 4: Shared export-button wiring

**Files:**
- Create: `src/export-buttons.js`

**Interfaces:**
- Consumes: `getExportClient`, `exportFilename`, `triggerBlobDownload` (Task 2); `isDesktop` (Task 1).
- Produces: `wireExports({ container, track, splitStems, client?, desktop? })` — on desktop appends one `button.export` per format (`wav`,`mp3`[,`stems` if `splitStems`]) wired to render-then-download with `rendering <fmt>…` / `stem k/N…` / `failed — retry` states; on non-desktop appends a single `span.export.export-note` reading `downloads available on desktop`. `track` must carry `{ id, code, meta }`. Appends only the download controls; callers add their own share/remix buttons.

**Note:** DOM-only (no `document` under the `node` test env), so this is verified manually in Task 5. The render/state logic it depends on is unit-tested in Tasks 1–2.

- [ ] **Step 1: Implement `src/export-buttons.js`**

```javascript
import { getExportClient, exportFilename, triggerBlobDownload } from './export-client.js';
import { isDesktop } from './device.js';

const TITLES = {
  wav: 'download lossless wav',
  mp3: 'download mp3 192kbps',
  stems: 'download per-sound 24-bit stems (zip)',
};

// Append download controls to `container`. Desktop → render buttons; mobile →
// a "downloads available on desktop" note (no render is ever attempted). The
// render runs in-browser via the hidden export iframe.
export function wireExports({ container, track, splitStems, client = getExportClient(), desktop = isDesktop() }) {
  if (!desktop) {
    const note = document.createElement('span');
    note.className = 'export export-note';
    note.textContent = 'downloads available on desktop';
    container.appendChild(note);
    return;
  }
  for (const fmt of splitStems ? ['wav', 'mp3', 'stems'] : ['wav', 'mp3']) {
    const btn = document.createElement('button');
    btn.className = 'export';
    const label = `↓︎ ${fmt}`;
    btn.textContent = label;
    btn.title = TITLES[fmt];
    btn.addEventListener('click', async () => {
      if (btn.dataset.busy) return;
      btn.dataset.busy = '1';
      btn.disabled = true;
      btn.textContent = `rendering ${fmt}…`;
      try {
        const blob = await client.render(
          { id: track.id, code: track.code, meta: track.meta },
          fmt,
          { onProgress: ({ done, total }) => { if (total) btn.textContent = `stem ${done}/${total}…`; } },
        );
        triggerBlobDownload(blob, exportFilename(track.id, fmt));
        btn.textContent = label;
      } catch {
        btn.textContent = 'failed — retry';
        setTimeout(() => { btn.textContent = label; }, 3000);
      } finally {
        btn.disabled = false;
        delete btn.dataset.busy;
      }
    });
    container.appendChild(btn);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/export-buttons.js
git commit -m "feat(client): shared wireExports button wiring (desktop render / mobile note)"
```

---

## Task 5: Wire the song page and list page to `wireExports`

**Files:**
- Modify: `src/song.js` (the export-button loop — currently builds `↓︎ <fmt>` buttons that hit `/api/.../audio.<fmt>`)
- Modify: `src/app.js` (the list-row export-button loop — same pattern, alongside share/remix)

**Note:** Both files are under concurrent edit. Locate the export loop by content — the `for (const fmt of splitStems ? ['wav', 'mp3', 'stems'] : ['wav', 'mp3'])` block that creates `btn.className = 'export'` and an `<a>` hitting `/api/${...}/audio.${fmt}` — not by line number.

**Interfaces:**
- Consumes: `wireExports` (Task 4).

- [ ] **Step 1: Update `src/song.js`**

Add the import near the other `./` imports:

```javascript
import { wireExports } from './export-buttons.js';
```

Replace the entire `for (const fmt of splitStems ? ...)` loop (the block from `for (const fmt` through its closing `}` that appends buttons to `exportRow`) with a single call. The surrounding `exportRow` creation and the `share` button that follow stay unchanged:

```javascript
  const exportRow = document.createElement('div');
  exportRow.className = 'exports song-exports';
  const splitStems = ns === 'tracks';
  wireExports({ container: exportRow, track: item, splitStems });
```

- [ ] **Step 2: Update `src/app.js`**

Add the import near the other `./` imports:

```javascript
import { wireExports } from './export-buttons.js';
```

Replace the list-row `for (const fmt of splitStems ? ...)` loop (the block appending format buttons to `exportRow`) with a single call. The `shareBtn` and `remixBtn` blocks that follow stay unchanged:

```javascript
      const exportRow = document.createElement('div');
      exportRow.className = 'exports';
      wireExports({ container: exportRow, track, splitStems });
```

- [ ] **Step 3: Build and manually verify (desktop)**

```bash
npm run build
```

On a desktop browser, on both the list page and a song page (record results in the PR):
- Click **wav** on an uncached track → button shows `rendering wav…`, the page stays responsive, then the WAV downloads. Live playback (if playing) is unaffected.
- Click **stems** on a tracks item → button shows `stem k/N…` advancing, then a `.zip` downloads.
- Click **mp3** → downloads an `.mp3`.
- Click the same format again → downloads instantly (session cache), no second render.
- Force a render error (e.g. temporarily point at a bad track) → button shows `failed — retry` then restores. *(Revert any temporary change.)*

- [ ] **Step 4: Manually verify (mobile)**

Using device emulation (narrow viewport + touch / coarse pointer), confirm the export row shows **`downloads available on desktop`** and no buttons, and that no render iframe work is triggered.

- [ ] **Step 5: Commit**

```bash
git add src/song.js src/app.js
git commit -m "feat(client): downloads render in-browser on desktop, gated note on mobile"
```

---

## Task 6: Remove the server audio-render path

**Files:**
- Delete: `server/audio-export.mjs`, `server/render-audio.mjs`, `server/audio-cache.mjs`
- Delete: `test/audio-export.test.mjs`, `test/audio-cache.test.mjs`, `test/render-audio.test.mjs`
- Modify: `server/app.mjs` (remove `audioRoutes` + its call + `AUDIO_TYPE`)
- Modify: `server/index.mjs` (remove audio imports + `audioCache`/`renderer`/`audioExport` + their use)
- Modify: `server/runner.mjs` (remove `audioExport` param + the MP3 prewarm loop)

**Interfaces:**
- Produces: server no longer exposes `/api/:ns/:id/audio.:fmt`; `createApp`/`createRunner` no longer accept `audioExport`. OG card routes and puppeteer are untouched.

- [ ] **Step 1: Confirm nothing else references the audio modules**

Run:
```bash
grep -rn "audio-export\|render-audio\|audio-cache\|audioExport\|/audio\." server src 2>/dev/null
```
Expected after edits: only the lines you are about to remove (none should remain in `src/` after Task 5). Anything unexpected must be handled before deleting.

- [ ] **Step 2: Delete the modules and their tests**

```bash
git rm server/audio-export.mjs server/render-audio.mjs server/audio-cache.mjs \
       test/audio-export.test.mjs test/audio-cache.test.mjs test/render-audio.test.mjs
```

- [ ] **Step 3: Remove the audio route from `server/app.mjs`**

Delete the `AUDIO_TYPE` constant, the entire `audioRoutes(app, audioExport, namespaces)` function, and its invocation (the `if (opts.audioExport) audioRoutes(app, opts.audioExport, namespaces);` line). Leave `cardRoutes` and everything else intact.

- [ ] **Step 4: Remove audio wiring from `server/index.mjs`**

Delete these imports:
```javascript
import { createAudioCache } from './audio-cache.mjs';
import { createRenderer } from './render-audio.mjs';
import { createAudioExport } from './audio-export.mjs';
```
Delete the `audioCache`, `renderer`, and `audioExport` declarations, and remove `audioExport` from both the `createRunner({...})` options and the `createApp({...})` options.

- [ ] **Step 5: Remove the prewarm from `server/runner.mjs`**

Remove `audioExport = null` from the `createRunner` options, and delete the prewarm lines in `runOne` (the comment + `if (audioExport) for (const slug of newItems) audioExport.prewarm(ns, slug, 'mp3');`).

- [ ] **Step 6: Run the affected server tests**

Run: `npx vitest run test/api.test.mjs test/runner.test.mjs test/og-routes.test.mjs`
Expected: PASS. (If `test/api.test.mjs` or `test/runner.test.mjs` reference `audioExport`, remove those cases/usages — the capability is gone.)

- [ ] **Step 7: Commit**

```bash
git add -A server test
git commit -m "refactor(server): remove headless-Chrome audio render path (downloads now client-side)"
```

---

## Task 7: Full verification + deploy

- [ ] **Step 1: Run the whole suite**

Run: `npx vitest run`
Expected: all green.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: clean build; `out/`/`dist/` produced, including `export-render.html`.

- [ ] **Step 3: Merge to the live worktree and deploy**

From the main worktree at `/home/builder/apps/crate`, after merging the branch:
```bash
sudo systemctl restart vimsical-crate
```

- [ ] **Step 4: Production smoke test**

- Open the originally-reported song on desktop, click **wav** → `rendering wav…` then a download, no hang.
- Click **stems** → `stem k/N…` then a `.zip`.
- Confirm OG card images still load (`/api/tracks/<id>/card.jpg`) — puppeteer path intact.
- Confirm server RAM dropped (no audio-render Chrome) and `data/audio-cache` is no longer written.
- On a phone, confirm the song page shows `downloads available on desktop`.

---

## Self-Review Notes

- **Spec coverage:** hidden-iframe render → Tasks 2/4/5; `export-render.js` reused unchanged except additive progress (Task 3); desktop gate + mobile copy → Tasks 1/4/5; progress UX (`rendering…`, `stem k/N`) → Tasks 2/3/4; session Blob cache → Task 2; server removal keeping puppeteer/cards → Task 6; filenames `<slug>.<ext>` → Task 2 (`exportFilename`).
- **Out of scope (per spec):** mobile downloads, chunked rendering, cancel button, IndexedDB cross-session cache, shared cross-user cache.
- **Type consistency:** message shape `{type, id, track, format, blob, message, done, total}` and the `id = '<slug>:<fmt>'` key match across `export-client.js` (Task 2), `export-render.js` (Task 3), and `wireExports` (Task 4). `render(track, fmt, {onProgress})`, `exportFilename(slug, fmt)`, `triggerBlobDownload(blob, filename)`, `isDesktop()`, and `wireExports({container, track, splitStems})` are used with identical signatures everywhere they appear.
- **Render input:** `wireExports` passes `{ id: track.id, code: track.code, meta: track.meta }` where `track.id` is the slug — matches what `render.js`/`export-spec.js` expect (the old server passed `{ id: row.slug, code, meta }`).
