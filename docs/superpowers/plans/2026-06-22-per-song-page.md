# Per-song page (/song/<slug>) + share links — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shareable dedicated page at `/song/<slug>` with a big player, seek scrubber, expanded Strudel code, metadata, and version history — plus a share button on every list card.

**Architecture:** New `song.html` vite entry backed by `src/song.js`, which reuses the existing Strudel runtime, `StrudelMirror` editor, and pure transport helpers. The inline Strudel bootstrap in `app.js` is extracted to `src/strudel-boot.js` and shared. Routing for the clean `/song/<slug>` URL mirrors the existing `/stems` handling in both `vite.config.js` (dev) and `server/app.mjs` (prod).

**Tech Stack:** Vanilla JS ES modules, Vite (MPA), Express (static serve), `@instantdb/core`, `@strudel/*`, Vitest.

## Global Constraints

- All items are public (`isPublic: true`); no new permissions. Reads use the existing `db` client from `src/db.js`.
- Item identity in render code is the **slug** (`mapRow` sets `id: row.slug`). `versionOf` points at the **root slug**.
- Pure helpers live in their own module and are unit-tested (vitest `.mjs` in `test/`); DOM/audio glue is verified by `npm run build` + manual checks (consistent with `app.js`/`stems.js`, which have no unit tests).
- Slugs match `/^[A-Za-z0-9_-]+$/` in practice (date-prefixed).
- Strudel must run on the **same module instances** `editor.js` plays through — only ever boot via the shared `bootStrudel()` (never `@strudel/web`).
- Commit after each task. End commit messages with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.

---

### Task 1: Pure URL helpers (`src/song-url.js`)

**Files:**
- Create: `src/song-url.js`
- Test: `test/song-url.test.mjs`

**Interfaces:**
- Produces:
  - `songUrl(slug: string): string` → absolute path `/song/<encoded-slug>`
  - `slugFromPath(pathname: string): string` → decoded slug from a `/song/<slug>` path, or `''` when absent

- [ ] **Step 1: Write the failing test**

Create `test/song-url.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { songUrl, slugFromPath } from '../src/song-url.js';

describe('songUrl', () => {
  it('builds a /song/<slug> path', () => {
    expect(songUrl('2026-06-16-uk-garage-dubstep-09')).toBe('/song/2026-06-16-uk-garage-dubstep-09');
  });
  it('encodes characters that need escaping', () => {
    expect(songUrl('a b')).toBe('/song/a%20b');
  });
});

describe('slugFromPath', () => {
  it('extracts the slug from a /song/<slug> path', () => {
    expect(slugFromPath('/song/demo-01')).toBe('demo-01');
  });
  it('tolerates a trailing slash', () => {
    expect(slugFromPath('/song/demo-01/')).toBe('demo-01');
  });
  it('decodes percent-encoding', () => {
    expect(slugFromPath('/song/a%20b')).toBe('a b');
  });
  it('returns empty string when no slug present', () => {
    expect(slugFromPath('/song/')).toBe('');
    expect(slugFromPath('/')).toBe('');
    expect(slugFromPath('/stems')).toBe('');
  });
  it('round-trips with songUrl', () => {
    const slug = '2026-06-16-uk-garage-dubstep-09';
    expect(slugFromPath(songUrl(slug))).toBe(slug);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/song-url.test.mjs`
Expected: FAIL — cannot resolve `../src/song-url.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/song-url.js`:

```js
// Pure helpers for the /song/<slug> route — no DOM, no Instant — so they
// unit-test directly and are shared by app.js (share button) and song.js.

// Absolute path to a song's page. Slugs are [A-Za-z0-9_-] in practice so the
// encode is usually a no-op, but it keeps the URL valid for any input.
export function songUrl(slug) {
  return `/song/${encodeURIComponent(slug)}`;
}

// Decoded slug from a /song/<slug> pathname, or '' when there is none
// (tolerates a trailing slash).
export function slugFromPath(pathname) {
  const m = /^\/song\/([^/]+)\/?$/.exec(pathname);
  return m ? decodeURIComponent(m[1]) : '';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/song-url.test.mjs`
Expected: PASS (8 assertions across 2 suites).

- [ ] **Step 5: Commit**

```bash
git add src/song-url.js test/song-url.test.mjs
git commit -m "feat: pure song-url helpers (songUrl, slugFromPath)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Extract shared Strudel bootstrap (`src/strudel-boot.js`)

**Files:**
- Create: `src/strudel-boot.js`
- Modify: `src/app.js` (imports + boot block, lines 1–15 and 44–53)

**Interfaces:**
- Produces: `bootStrudel(): Promise<void>` — unlocks audio (first-gesture + iOS silent switch), registers synth + sample banks, resolves when samples are ready. Idempotent at the audio-unlock level but evaluates sample loading once per call, so **call it exactly once per page**.
- Consumes: nothing from prior tasks.

- [ ] **Step 1: Create the shared bootstrap module**

Create `src/strudel-boot.js`:

```js
// The one place the webapp boots Strudel. NOT @strudel/web: its dist inlines
// private copies of core/webaudio, so sounds registered through it are invisible
// to editor.js's webaudioOutput (two registries — silent playback). evalScope
// mirrors scripts/strudel-env.mjs but with real audio, keeping every page on the
// exact module instances the editors play through.
import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import * as tonal from '@strudel/tonal';
import * as webaudio from '@strudel/webaudio';
import { initAudioOnFirstClick, registerSynthSounds, samples } from '@strudel/webaudio';
import banks from '../shared/sample-banks.json';
import { enableSilentSwitchPlayback } from './ios-audio.js';

// Boot once per page. Returns a promise that resolves when the sample banks are
// loaded (pass it to mountEditor's `prebake`). Call exactly once.
export function bootStrudel() {
  initAudioOnFirstClick(); // resume the AudioContext on the first user gesture
  enableSilentSwitchPlayback(); // iOS: play through the hardware silent switch
  return (async () => {
    await core.evalScope(core, mini, tonal, webaudio);
    await Promise.all([
      registerSynthSounds(),
      ...banks.map((b) =>
        b.shorthand
          ? samples(b.shorthand)
          : samples(b.json, b.base, { prebake: b.prebake, tag: b.tag }),
      ),
    ]);
  })();
}
```

- [ ] **Step 2: Update `app.js` imports**

In `src/app.js`, replace the top import block (current lines 1–15):

```js
import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import * as tonal from '@strudel/tonal';
import * as webaudio from '@strudel/webaudio';
import { initAudioOnFirstClick, registerSynthSounds, samples, getAudioContext } from '@strudel/webaudio';
import { mountEditor, getEditor, isStarted, cyclePosition, seekEditor } from './editor.js';
import { nextPlayingId } from './playing-state.js';
import { exportTrack, isExporting } from './export.js';
import { groupVersions } from './versions.js';
import banks from '../shared/sample-banks.json';
import { exportSpec } from './export-spec.js';
import { mmss, hasTimeline, fractionToCycle, progressFraction, isFinished } from './transport.js';
import { db } from './db.js';
import { onUser } from './auth.js';
import { enableSilentSwitchPlayback } from './ios-audio.js';
```

with:

```js
import { getAudioContext } from '@strudel/webaudio';
import { mountEditor, getEditor, isStarted, cyclePosition, seekEditor } from './editor.js';
import { nextPlayingId } from './playing-state.js';
import { exportTrack, isExporting } from './export.js';
import { groupVersions } from './versions.js';
import { exportSpec } from './export-spec.js';
import { mmss, hasTimeline, fractionToCycle, progressFraction, isFinished } from './transport.js';
import { db } from './db.js';
import { onUser } from './auth.js';
import { bootStrudel } from './strudel-boot.js';
```

- [ ] **Step 3: Replace the inline boot block in `app.js`**

In `src/app.js`, replace the boot block (the comment starting `// --- strudel init` plus the `initAudioOnFirstClick()` / `enableSilentSwitchPlayback()` / `const ready = (async () => { ... })();` IIFE — current lines ~36–57) with:

```js
  // --- strudel init: one shared runtime for every page (see strudel-boot.js) -
  const ready = bootStrudel();
  ready.then(() => {
    state.samplesReady = true;
    renderTransport();
  });
```

Leave the `ready.then(...)` semantics unchanged. Do NOT touch anything below this point.

- [ ] **Step 4: Verify nothing else references the removed imports**

Run: `grep -nE '\b(core|mini|tonal|webaudio|initAudioOnFirstClick|registerSynthSounds|samples|banks|enableSilentSwitchPlayback)\b' src/app.js`
Expected: no matches (every former user now lives in `strudel-boot.js`). `getAudioContext`, `mountEditor`, etc. remain.

- [ ] **Step 5: Build + run the full test suite**

Run: `npm run build && npm test`
Expected: build succeeds; all existing tests pass (the extraction is behavior-preserving — no test should change).

- [ ] **Step 6: Commit**

```bash
git add src/strudel-boot.js src/app.js
git commit -m "refactor: extract shared Strudel bootstrap into strudel-boot.js

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Route `/song/<slug>` (dev + prod)

**Files:**
- Modify: `vite.config.js` (add `song.html` input + a `/song/` dev rewrite)
- Modify: `server/app.mjs` (add the prod route, ~line 121)

**Interfaces:**
- Produces: requests to `/song/<anything>` serve `song.html` in dev (vite) and prod (Express). `song.html` is built as its own entry. (`song.html` itself is created in Task 4; this task wires the routing around it.)

- [ ] **Step 1: Add the `/song/` dev rewrite + entry in `vite.config.js`**

In `vite.config.js`, alongside `rewriteStems`, add a sibling rewrite. Replace:

```js
// /stems is a second MPA page (stems.html); rewrite the clean URL before the
// SPA fallback would serve index.html for it.
const rewriteStems = (server) => {
  server.middlewares.use((req, _res, next) => {
    if (req.url === '/stems' || req.url === '/stems/' || req.url?.startsWith('/stems?')) req.url = '/stems.html';
    next();
  });
};
```

with:

```js
// /stems is a second MPA page (stems.html); rewrite the clean URL before the
// SPA fallback would serve index.html for it.
const rewriteStems = (server) => {
  server.middlewares.use((req, _res, next) => {
    if (req.url === '/stems' || req.url === '/stems/' || req.url?.startsWith('/stems?')) req.url = '/stems.html';
    next();
  });
};

// /song/<slug> is the per-song page; any path under /song/ serves song.html
// (song.js reads the slug from location.pathname).
const rewriteSong = (server) => {
  server.middlewares.use((req, _res, next) => {
    if (req.url?.startsWith('/song/')) req.url = '/song.html';
    next();
  });
};
```

Then register the plugin and add the entry. Replace the `plugins` array entry and `input` block:

```js
    { name: 'stems-route', configureServer: rewriteStems, configurePreviewServer: rewriteStems },
```

with:

```js
    { name: 'stems-route', configureServer: rewriteStems, configurePreviewServer: rewriteStems },
    { name: 'song-route', configureServer: rewriteSong, configurePreviewServer: rewriteSong },
```

and replace:

```js
      input: {
        main: page('./index.html'),
        stems: page('./stems.html'),
        exportRender: page('./export-render.html'),
      },
```

with:

```js
      input: {
        main: page('./index.html'),
        stems: page('./stems.html'),
        song: page('./song.html'),
        exportRender: page('./export-render.html'),
      },
```

- [ ] **Step 2: Add the prod route in `server/app.mjs`**

In `server/app.mjs`, inside the `if (opts.distDir) {` block, replace:

```js
  if (opts.distDir) {
    app.get(['/stems', '/stems/'], (_req, res) => res.sendFile(join(opts.distDir, 'stems.html')));
    app.use(express.static(opts.distDir));
  }
```

with:

```js
  if (opts.distDir) {
    app.get(['/stems', '/stems/'], (_req, res) => res.sendFile(join(opts.distDir, 'stems.html')));
    app.get('/song/:slug', (_req, res) => res.sendFile(join(opts.distDir, 'song.html')));
    app.use(express.static(opts.distDir));
  }
```

- [ ] **Step 3: Commit**

```bash
git add vite.config.js server/app.mjs
git commit -m "feat: route /song/<slug> to song.html in dev and prod

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

(`song.html` is added in Task 4; the build is verified end-to-end there.)

---

### Task 4: The song page (`song.html` + `src/song.js` + styles)

**Files:**
- Create: `song.html`
- Create: `src/song.js`
- Modify: `src/style.css` (append song-page styles)

**Interfaces:**
- Consumes: `bootStrudel` (Task 2), `slugFromPath`/`songUrl` (Task 1), `db` (`src/db.js`), `mountEditor`/`getEditor`/`cyclePosition`/`seekEditor` (`src/editor.js`), `exportSpec` (`src/export-spec.js`), `groupVersions` (`src/versions.js`), transport helpers (`src/transport.js`), `getAudioContext` (`@strudel/webaudio`).
- Produces: a working `/song/<slug>` page.

- [ ] **Step 1: Create `song.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>STRUDEL/SONG</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,300..800&family=IBM+Plex+Mono:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/src/style.css" />
</head>
<body>
  <header class="masthead">
    <div class="brand">
      <h1>STRUDEL<span>/</span>SONG</h1>
      <span class="sig">by Dennnis</span>
    </div>
    <nav class="nav" aria-label="sections">
      <a href="/">crate</a>
      <a href="/stems">stems</a>
    </nav>
  </header>
  <main id="song"><p class="empty">loading…</p></main>
  <footer id="transport">
    <span id="status" class="status">warming up samples…</span>
    <span id="now-playing"></span>
    <div id="seekbar" class="seekbar" hidden>
      <span id="elapsed" class="time">0:00</span>
      <div id="seek-rail" class="seek-rail" role="slider" aria-label="seek"
           aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
        <div id="seek-fill" class="seek-fill"></div>
      </div>
      <span id="total" class="time">0:00</span>
    </div>
    <button id="stop" disabled>■ STOP</button>
  </footer>
  <script type="module" src="/src/song.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `src/song.js`**

```js
// The dedicated single-song page at /song/<slug>. Reuses the shared Strudel
// runtime (strudel-boot), the StrudelMirror editor (editor.js) and the pure
// transport helpers (transport.js) so playback matches the list pages.
import { getAudioContext } from '@strudel/webaudio';
import { mountEditor, getEditor, cyclePosition, seekEditor } from './editor.js';
import { bootStrudel } from './strudel-boot.js';
import { exportSpec } from './export-spec.js';
import { groupVersions } from './versions.js';
import { mmss, hasTimeline, fractionToCycle, progressFraction, isFinished } from './transport.js';
import { slugFromPath, songUrl } from './song-url.js';
import { db } from './db.js';

const $ = (sel, el = document) => el.querySelector(sel);
const NAMESPACES = ['tracks', 'stems'];

function renderEmpty(message) {
  $('#song').innerHTML = `<p class="empty">${message}</p>`;
}

// Map an Instant row to the render shape ({ ...fields, id: slug, artistName }).
// Mirrors app.js's mapRow; the slug is the identity editor.js/exportSpec use.
function mapRow(row) {
  const author = Array.isArray(row.author) ? row.author[0] : row.author;
  return { ...row, id: row.slug, artistName: author?.artistName ?? null };
}

// Resolve a slug to { ns, item }. Tracks win over stems on a (rare) collision.
async function resolveItem(slug) {
  for (const ns of NAMESPACES) {
    const res = await db.queryOnce({ [ns]: { author: {}, $: { where: { slug } } } });
    const row = res.data?.[ns]?.[0];
    if (row) return { ns, item: mapRow(row) };
  }
  return null;
}

// The version family for an item: rows in the same namespace whose slug or
// versionOf equals the family root. Returns the matching family or null.
async function fetchFamily(ns, item) {
  const root = item.versionOf ?? item.id;
  const res = await db.queryOnce({
    [ns]: { $: { where: { or: [{ slug: root }, { versionOf: root }] } } },
  });
  const rows = (res.data?.[ns] ?? []).map((r) => ({ ...r, id: r.slug }));
  return groupVersions(rows).find((f) => f.versions.some((v) => v.id === item.id)) ?? null;
}

async function shareSong(item) {
  const url = location.origin + songUrl(item.id);
  if (navigator.share) {
    try { await navigator.share({ title: item.title, url }); } catch { /* user cancelled */ }
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    showToast('Link copied');
  } catch {
    showToast('Copy failed');
  }
}

let toastTimer = null;
function showToast(message) {
  let toast = $('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('on');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('on'), 1600);
}

function renderSong(item, ns, family, ready) {
  document.title = `${item.title} — STRUDEL`;
  const root = $('#song');
  root.innerHTML = '';

  const back = document.createElement('a');
  back.className = 'song-back';
  back.href = ns === 'stems' ? '/stems' : '/';
  back.textContent = '← back to crate';
  root.appendChild(back);

  const head = document.createElement('div');
  head.className = 'song-head';
  const playBtn = document.createElement('button');
  playBtn.className = 'play song-play';
  playBtn.innerHTML = '▶';
  playBtn.title = 'play';
  const title = document.createElement('div');
  title.className = 'song-title';
  const h2 = document.createElement('h2');
  h2.textContent = item.title;
  title.appendChild(h2);
  if (item.artistName) {
    const by = document.createElement('span');
    by.className = 'by';
    by.textContent = `by ${item.artistName}`;
    title.appendChild(by);
  }
  const share = document.createElement('button');
  share.className = 'export song-share';
  share.textContent = '⤴ share';
  share.title = 'copy link to this song';
  share.addEventListener('click', () => shareSong(item));
  head.append(playBtn, title, share);
  root.appendChild(head);

  const meta = document.createElement('div');
  meta.className = 'song-meta';
  const m = item.meta ?? {};
  const chipValues = [
    m.genre,
    m.bpm && `${m.bpm} bpm`,
    m.key,
    m.mood,
    m.energy && '▮'.repeat(Math.min(m.energy, 5)) + '▯'.repeat(Math.max(0, 5 - m.energy)),
    (m.instruments ?? []).join(' · ') || null,
  ].filter(Boolean);
  const chips = document.createElement('div');
  chips.className = 'chips';
  for (const v of chipValues) {
    const c = document.createElement('span');
    c.className = 'chip';
    c.textContent = v;
    chips.appendChild(c);
  }
  meta.appendChild(chips);
  if (item.description) {
    const d = document.createElement('p');
    d.className = 'desc';
    d.textContent = item.description;
    meta.appendChild(d);
  }
  if (item.prompt) {
    const p = document.createElement('p');
    p.className = 'song-prompt';
    p.textContent = `prompt: ${item.prompt}`;
    meta.appendChild(p);
  }
  root.appendChild(meta);

  const editorWrap = document.createElement('div');
  editorWrap.className = 'song-editor';
  editorWrap.innerHTML = `<p class="eval-error" hidden></p><div class="editor"></div>`;
  root.appendChild(editorWrap);

  if (family && family.versions.length > 1) {
    const vers = document.createElement('div');
    vers.className = 'song-versions';
    const label = document.createElement('span');
    label.className = 'song-versions-label';
    label.textContent = 'versions';
    vers.appendChild(label);
    for (const v of family.versions) {
      const a = document.createElement('a');
      a.className = 'version' + (v.id === item.id ? ' on' : '');
      a.href = songUrl(v.id);
      a.textContent = `v${v.version}`;
      a.title = `version ${v.version} — ${v.createdAt}`;
      vers.appendChild(a);
    }
    root.appendChild(vers);
  }

  wirePlayback(item, playBtn, editorWrap, ready);
}

// Play/stop + seek for the page's single track. Mirrors app.js's scrubber but
// against one editor (no multi-track switching).
function wirePlayback(item, playBtn, editorWrap, ready) {
  const rail = $('#seek-rail');
  const fill = $('#seek-fill');
  const elapsedEl = $('#elapsed');
  const totalEl = $('#total');
  const seekbar = $('#seekbar');
  const stopBtn = $('#stop');
  const nowPlaying = $('#now-playing');

  let spec = null;
  try { spec = exportSpec(item); } catch { spec = null; }
  let rafId = null;
  let scrubbing = false;

  function paintSeek(fraction, elapsedSeconds) {
    fill.style.width = `${(fraction * 100).toFixed(2)}%`;
    elapsedEl.textContent = mmss(elapsedSeconds);
    rail.setAttribute('aria-valuenow', Math.round(fraction * 100));
  }

  function showTransport(playing) {
    const seekable = playing && hasTimeline(spec);
    seekbar.hidden = !seekable;
    if (seekable) totalEl.textContent = mmss(spec.seconds);
    stopBtn.disabled = !playing;
    nowPlaying.textContent = playing ? `NOW PLAYING — ${item.title}` : '';
    playBtn.innerHTML = playing ? '<span class="eq"><i></i><i></i><i></i></span>' : '▶';
    playBtn.title = playing ? 'stop' : 'play';
  }

  function startSeekLoop() {
    if (rafId != null) return;
    const tick = () => {
      rafId = requestAnimationFrame(tick);
      if (scrubbing || !hasTimeline(spec)) return;
      const cycle = cyclePosition(item.id);
      if (cycle == null) return;
      if (isFinished(cycle, spec.cycles)) { stop(); return; }
      paintSeek(progressFraction(cycle, spec.cycles), cycle / spec.cps);
    };
    rafId = requestAnimationFrame(tick);
  }

  function stopSeekLoop() {
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = null;
    scrubbing = false;
    paintSeek(0, 0);
  }

  const editor = mountEditor({
    track: item,
    root: $('.editor', editorWrap),
    prebake: () => ready,
    onToggle: (_id, started) => {
      showTransport(started);
      if (started) startSeekLoop();
      else stopSeekLoop();
    },
    onError: (_id, err) => {
      const msg = $('.eval-error', editorWrap);
      msg.textContent = err ? `✖ ${err.message}` : '';
      msg.hidden = !err;
    },
  });

  async function play() {
    showTransport(true);
    await ready; // audio context unlocks via this click
    await getAudioContext().resume(); // post-export contexts start suspended
    editor.evaluate();
    startSeekLoop();
  }

  function stop() {
    getEditor(item.id)?.stop(); // onToggle clears UI; this covers not-yet-evaluated
    stopSeekLoop();
    showTransport(false);
  }

  playBtn.addEventListener('click', () => (stopBtn.disabled ? play() : stop()));
  stopBtn.addEventListener('click', stop);

  function seekToPointer(e) {
    if (!hasTimeline(spec)) return;
    const rect = rail.getBoundingClientRect();
    const fraction = rect.width ? (e.clientX - rect.left) / rect.width : 0;
    const clamped = Math.min(1, Math.max(0, fraction));
    seekEditor(item.id, fractionToCycle(clamped, spec.cycles));
    paintSeek(clamped, clamped * spec.seconds); // immediate feedback; loop paused while scrubbing
  }

  rail.addEventListener('pointerdown', (e) => {
    if (!hasTimeline(spec)) return;
    scrubbing = true;
    rail.setPointerCapture(e.pointerId);
    seekToPointer(e);
  });
  rail.addEventListener('pointermove', (e) => { if (scrubbing) seekToPointer(e); });
  const endScrub = (e) => {
    if (!scrubbing) return;
    scrubbing = false;
    try { rail.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };
  rail.addEventListener('pointerup', endScrub);
  rail.addEventListener('pointercancel', endScrub);
}

async function main() {
  if (!db) return renderEmpty('Instant not configured — set VITE_INSTANT_APP_ID');
  const slug = slugFromPath(location.pathname);
  if (!slug) return renderEmpty('no song specified');

  const ready = bootStrudel();
  ready.then(() => {
    $('#status').textContent = '● samples loaded';
    $('#status').classList.add('ready');
  });

  const found = await resolveItem(slug);
  if (!found) return renderEmpty('song not found');
  const family = await fetchFamily(found.ns, found.item);
  renderSong(found.item, found.ns, family, ready);
}

main().catch((err) => {
  console.error('song page failed', err);
  renderEmpty('could not load this song');
});
```

- [ ] **Step 3: Append song-page styles to `src/style.css`**

Append to the end of `src/style.css`:

```css
/* --- /song/<slug> page ---------------------------------------------------- */
#song { max-width: 900px; margin: 0 auto; padding: 24px 20px 96px; }
.song-back { color: var(--dim); text-decoration: none; font-size: 12px; }
.song-back:hover { color: var(--acid); }
.song-head { display: flex; align-items: center; gap: 16px; margin: 20px 0 8px; }
.song-play { width: 52px; height: 52px; font-size: 22px; flex: none; }
.song-title { min-width: 0; flex: 1; }
.song-title h2 { font-family: var(--display); font-weight: 700; font-size: 26px; line-height: 1.1; }
.song-title .by { color: var(--dim); font-size: 12px; }
.song-share { flex: none; }
.song-meta { margin: 4px 0 16px; }
.song-meta .chips { display: flex; flex-wrap: wrap; gap: 6px; }
.song-meta .desc { color: var(--dim); font-size: 13px; margin-top: 10px; max-width: 70ch; }
.song-prompt { color: var(--dim); font-size: 12px; margin-top: 8px; font-style: italic; max-width: 70ch; }
.song-editor { margin: 8px 0 20px; }
.song-editor .eval-error { color: var(--hot); font-size: 12px; margin: 0 0 6px; }
.song-versions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.song-versions-label { color: var(--dim); font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; }
.song-versions .version {
  color: var(--dim); text-decoration: none; font-size: 12px; padding: 3px 8px;
  border: 1px solid var(--line); font-family: var(--mono);
}
.song-versions .version:hover { color: var(--acid); border-color: var(--acid); }
.song-versions .version.on { background: var(--acid); color: var(--bg); border-color: var(--acid); }
.toast {
  position: fixed; bottom: 84px; left: 50%; transform: translateX(-50%) translateY(8px);
  background: var(--acid); color: var(--bg); font-family: var(--mono); font-size: 12px;
  font-weight: 600; padding: 8px 16px; border-radius: 2px; pointer-events: none;
  opacity: 0; transition: opacity 0.18s, transform 0.18s; z-index: 50;
}
.toast.on { opacity: 1; transform: translateX(-50%) translateY(0); }
```

- [ ] **Step 4: Build to confirm the new entry compiles**

Run: `npm run build`
Expected: build succeeds and `dist/song.html` exists.
Verify: `ls dist/song.html` → prints the path.

- [ ] **Step 5: Manual verification in dev**

Run: `npm run dev` (starts API + vite). In a browser open `http://localhost:5173/song/<a-known-slug>` (pick a slug from `git status` untracked files, e.g. `2026-06-16-uk-garage-dubstep-09`).
Confirm: title/artist render; press play → audio starts and the seek bar fills; drag the rail → playback seeks; the editor shows the code; metadata chips + description + prompt show; if the song has versions, the version links appear and navigate; the back link returns to `/` (or `/stems`). Then open `/song/does-not-exist` → "song not found".

- [ ] **Step 6: Commit**

```bash
git add song.html src/song.js src/style.css
git commit -m "feat: dedicated /song/<slug> page with player, code, metadata, versions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Share button on list cards (`src/app.js`)

**Files:**
- Modify: `src/app.js` (imports + card `exportRow`, ~line 347–377)

**Interfaces:**
- Consumes: `songUrl` (Task 1).
- Produces: a `⤴ share` button on every track/stem card; uses Web Share API with clipboard + toast fallback.

- [ ] **Step 1: Import the helper + add a toast in `app.js`**

In `src/app.js`, add to the import block (after the `bootStrudel` import added in Task 2):

```js
import { songUrl } from './song-url.js';
```

Then add a module-local toast helper. Place it next to the other small helpers near the top of `initApp` (e.g. right after the `const $ = ...` usage inside `initApp`, before `// --- strudel init`):

```js
  let toastTimer = null;
  function showToast(message) {
    let toast = document.querySelector('.toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('on');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('on'), 1600);
  }

  async function shareTrack(track) {
    const url = location.origin + songUrl(track.id);
    if (navigator.share) {
      try { await navigator.share({ title: track.title, url }); } catch { /* cancelled */ }
      return;
    }
    try { await navigator.clipboard.writeText(url); showToast('Link copied'); }
    catch { showToast('Copy failed'); }
  }
```

(The `.toast` CSS was added to `style.css` in Task 4, so it is available here too.)

- [ ] **Step 2: Append a share button to each card's `exportRow`**

In `src/app.js`, find where `exportRow` is finished and appended to `meta` (the line `meta.appendChild(exportRow);`). Immediately BEFORE that line, add:

```js
      const shareBtn = document.createElement('button');
      shareBtn.className = 'export share';
      shareBtn.textContent = '⤴ share';
      shareBtn.title = 'copy link to this song';
      shareBtn.addEventListener('click', () => shareTrack(track));
      exportRow.appendChild(shareBtn);
```

- [ ] **Step 3: Build + test**

Run: `npm run build && npm test`
Expected: build succeeds; all tests pass (no test depends on card internals).

- [ ] **Step 4: Manual verification**

Run: `npm run dev`. Open `http://localhost:5173/`, find a card, click `⤴ share`. On desktop: a "Link copied" toast appears and the clipboard holds `http://localhost:5173/song/<slug>`. Paste into a new tab → the song page loads. Repeat on `/stems`.

- [ ] **Step 5: Commit**

```bash
git add src/app.js
git commit -m "feat: share button on track/stem cards (Web Share + clipboard fallback)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Deployment note (after all tasks)

The live `vimsical-crate` service runs from the main worktree at `/home/builder/apps/crate` and serves the built `dist/`. To ship: merge this branch into the main worktree's branch, run `npm run build`, then `sudo systemctl restart vimsical-crate`. A branch in a separate worktree is not live.

## Self-Review

- **Spec coverage:** URL/routing (Task 3) ✓; song page big player + seek scrubber + expanded code + metadata + version history + back link + states (Task 4) ✓; shared `strudel-boot` refactor (Task 2) ✓; item resolution tracks-then-stems (Task 4 `resolveItem`) ✓; share affordance Web Share + clipboard fallback (Task 5) ✓; pure-helper tests + reused `groupVersions` (Task 1) ✓. Out-of-scope items (no OG tags, no autoplay) correctly omitted.
- **Placeholder scan:** none — every step carries full code/commands.
- **Type consistency:** `songUrl`/`slugFromPath` signatures match across Tasks 1/4/5; `bootStrudel(): Promise` consumed identically in Tasks 2/4; `mapRow` sets `id: slug` consistent with `app.js`; `exportSpec` returns `{ cps, cycles, seconds }` used by the seek loop.
