# Background Export Render — Design

**Date:** 2026-06-08
**Status:** Approved (brainstorming)
**Branch:** `fix-silent-wav` (ships alongside the silent-WAV fix, commit `9a02a1d`)

## Problem

Clicking the `↓ wav` / `↓ mp3` download button on a track card **stops live
playback**. The cause is architectural: `exportTrack` renders by closing the
single **global** audio context (`getAudioContext().close()`), swapping in an
`OfflineAudioContext`, rendering, then re-initializing live audio. superdough is
a module singleton bound to one global audio context, so the export must hijack
that context — and the button handler explicitly calls `stopPlayback` first.

**Goal:** A download renders without interrupting whatever is currently playing.

## Decisions (confirmed with user)

- **Uninterrupted playback** — the playing track keeps playing with no glitch
  while the export renders in the background. (Not "auto-resume after.")
- **Isolated render via a hidden same-origin iframe** — the only feasible
  isolation mechanism (see "Alternatives rejected").
- **Per-export iframe** — created on each download, torn down when the blob is
  returned ("terminates upon completion"). Accepts a short (~1–2s) strudel /
  sample-registry warm-up per export.
- Ships on the **same branch** as the already-committed silent-WAV fix.

## Alternatives rejected

- **Web Worker.** `OfflineAudioContext` is **not available in Web Workers** in
  Chromium (verified headlessly: `typeof OfflineAudioContext === 'undefined'`
  inside a worker). The Web Audio API is main-thread/document-only. Infeasible.
- **Two contexts on the main thread.** superdough's render path is keyed to one
  global context via `setAudioContext`/`setSuperdoughAudioController`. While the
  export render `await`s sample loads, the live scheduler would read the swapped
  global context and break. The singleton makes coexistence infeasible.
- **A hidden same-origin iframe** has its own `window`, ES module graph,
  superdough singleton, and `OfflineAudioContext` (verified: `contentWindow !==
  window` and `contentWindow.OfflineAudioContext` exists). It is the browser's
  real "disposable, isolated render context." Chosen.

## Architecture

```
 MAIN PAGE (live AudioContext untouched)            HIDDEN IFRAME (own context)
 ┌───────────────────────────────┐                 ┌────────────────────────────┐
 │ app.js button click           │  create iframe  │ export-render.html          │
 │ src/export.js (orchestrator)  │ ───────────────▶│   loads src/export-render.js│
 │   spawn iframe(/export-       │                 │   boots strudel             │
 │     render.html)              │ ◀── 'ready' ────│   (evalScope+samples)       │
 │   postMessage{render,track,   │ ──{render}─────▶│   renderBuffer (offline)    │
 │     format}                   │                 │   encode wav/mp3            │
 │   await {done, blob}          │ ◀──{done,blob}──│                             │
 │   download(blob); remove iframe                 │ (or {error, message})       │
 └───────────────────────────────┘                 └────────────────────────────┘
```

The parent's live `AudioContext` is **never** closed or swapped, so the
scheduler/cyclist keeps running and audio keeps playing.

## Components

### `export-render.html` (new — vite MPA input)
A headless, UI-less page (mirrors how `stems.html` is a second MPA entry). Body
is empty except `<script type="module" src="/src/export-render.js">`. Loaded
only as an iframe `src` (`/export-render.html`) — not user-facing, so no nav and
no clean-URL rewrite. Added to `vite.config.js` `rollupOptions.input` as a third
entry (`exportRender`).

### `src/export-render.js` (new — runs INSIDE the iframe)
The render engine. On module load it initializes strudel identically to the app
boot, then signals readiness:

```js
import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import * as tonal from '@strudel/tonal';
import * as webaudio from '@strudel/webaudio';
import { registerSynthSounds, samples } from '@strudel/webaudio';
import banks from '../shared/sample-banks.json';
import { renderTrack } from './render.js';

const ready = (async () => {
  await core.evalScope(core, mini, tonal, webaudio);
  await Promise.all([
    registerSynthSounds(),
    ...banks.map((b) =>
      b.shorthand ? samples(b.shorthand)
                  : samples(b.json, b.base, { prebake: b.prebake, tag: b.tag })),
  ]);
})();

window.addEventListener('message', async (e) => {
  if (e.data?.type !== 'render') return;
  const { id, track, format } = e.data;
  try {
    await ready;
    const blob = await renderTrack(track, format); // offline render + encode
    parent.postMessage({ type: 'done', id, blob }, '*');
  } catch (err) {
    parent.postMessage({ type: 'error', id, message: err.message }, '*');
  }
});
ready.then(() => parent.postMessage({ type: 'ready' }, '*'));
```

> Note: `samples()`/`registerSynthSounds()` only **register** the sound map;
> individual samples are fetched + decoded lazily during the render. The iframe
> never needs a *running* AudioContext — perfect for a headless renderer.

### `src/render.js` (new — pure-ish render+encode, imported by the iframe)
Holds the offline render and encode, extracted from today's `export.js`. Because
the iframe has **no live audio to preserve**, this is *simpler* than the current
`renderBuffer` — no `getAudioContext().close()`, no restore-live-audio `finally`:

```js
import {
  setAudioContext, setSuperdoughAudioController, initAudio, webaudioOutput,
} from '@strudel/webaudio';
import { SuperdoughAudioController } from 'superdough/superdoughoutput.mjs';
import { evaluate } from '@strudel/transpiler';
import { exportSpec, collectHaps } from './export-spec.js';
import { encodeWav, encodeMp3 } from './encoders.js';

const SAMPLE_RATE = 44100;

export async function renderTrack(track, format) {
  globalThis.setcpm ??= () => {};
  globalThis.setcps ??= () => {};
  const { pattern } = await evaluate(track.code);
  if (typeof pattern?.queryArc !== 'function') {
    throw new Error('code did not evaluate to a pattern');
  }
  const { cps, cycles, seconds } = exportSpec(track);
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * SAMPLE_RATE), SAMPLE_RATE);
  setAudioContext(ctx);
  setSuperdoughAudioController(new SuperdoughAudioController(ctx));
  await initAudio();
  for (const hap of collectHaps(pattern, cycles, cps)) {
    try {
      await webaudioOutput(hap, null, hap.duration / cps, cps, hap.whole.begin.valueOf() / cps);
    } catch (err) {
      console.warn('[export] hap skipped:', err.message);
    }
  }
  const buffer = await ctx.startRendering();
  return format === 'wav'
    ? new Blob([encodeWav(buffer)], { type: 'audio/wav' })
    : new Blob(encodeMp3(buffer), { type: 'audio/mpeg' });
}
```

`collectHaps` (the per-cycle silent-WAV fix) and `encoders.js` are imported
unchanged — the fix carries over for free.

### `src/export.js` (rewritten — runs in MAIN page, orchestrator only)
No strudel/audio imports anymore. Spawns the iframe, runs the message protocol,
downloads, cleans up. Keeps the `isExporting` guard (one render iframe at a
time) and `onStatus`. **Drops `stopPlayback`.**

```js
let exporting = false;
export const isExporting = () => exporting;

const RENDER_TIMEOUT_MS = 5 * 60_000; // generous; multi-minute tracks render fast offline

export async function exportTrack(track, format, { onStatus = () => {} } = {}) {
  if (exporting) throw new Error('an export is already running');
  exporting = true;
  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  iframe.src = '/export-render.html';
  const id = `${track.id}:${format}`;
  try {
    onStatus('rendering…');
    const blob = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('export timed out')), RENDER_TIMEOUT_MS);
      let started = false;
      function onMsg(e) {
        if (e.source !== iframe.contentWindow) return;
        const d = e.data || {};
        if (d.type === 'ready' && !started) {
          started = true;
          iframe.contentWindow.postMessage({ type: 'render', id, track, format }, '*');
        } else if (d.type === 'done' && d.id === id) {
          cleanup(); resolve(d.blob);
        } else if (d.type === 'error' && d.id === id) {
          cleanup(); reject(new Error(d.message));
        }
      }
      function cleanup() { clearTimeout(timer); window.removeEventListener('message', onMsg); }
      window.addEventListener('message', onMsg);
      document.body.appendChild(iframe);
    });
    onStatus('encoding…'); // (encode already happened in-iframe; status is cosmetic)
    download(blob, `${track.id}.${format}`);
  } finally {
    iframe.remove();      // terminate the render context on completion/failure
    exporting = false;
  }
}
```

`download(blob, filename)` is unchanged (object URL + anchor click).

### `src/app.js` (button handler change)
Remove `stopPlayback: stop` from the `exportTrack(...)` call — playback now
survives the export. Everything else (disable buttons during export, `↓ wav`
↔ `rendering…` label, `flashError` on failure) stays.

## Data flow

1. User clicks `↓ wav` (track may be playing).
2. `exportTrack` sets `exporting`, appends hidden `iframe[src=/export-render.html]`.
3. Iframe boots strudel, posts `{type:'ready'}`.
4. Main posts `{type:'render', id, track, format}`.
5. Iframe renders offline (audio render thread) + encodes, posts `{type:'done', id, blob}`.
6. Main downloads the blob, removes the iframe (`exporting=false`).
7. The whole time, the parent's live AudioContext was untouched → playback continued.

## Error handling

- **Iframe render error** → `{type:'error', id, message}` → reject → `finally`
  removes iframe → caller `flashError(card)` (as today).
- **Timeout** (`RENDER_TIMEOUT_MS`) → reject + cleanup. Guards against an iframe
  that never posts `ready`/`done`.
- **Concurrent guard** — `isExporting` rejects a second export while one runs
  (avoids two render iframes/contexts at once). Playback is independent of this.
- Blob crosses the boundary via structured-clone `postMessage` (Blobs are
  cloneable); no manual ArrayBuffer transfer needed.

## Testing

- **Unit (Node, existing):** `encoders.test.mjs`, `export-spec.test.mjs`
  (incl. `collectHaps`) keep passing — the render/encode logic they cover moves
  to `render.js` but the pure functions are unchanged and still imported from
  `export-spec.js`/`encoders.js`.
- **Browser (headless Playwright, new verification):**
  1. Start a track playing; assert its scheduler is running.
  2. Click `↓ wav`, capture the download; decode → assert peak > 0.
  3. Assert playback was **not interrupted**: the same track's
     `#now-playing` text is unchanged and its repl scheduler stayed `started`
     across the export (sample before, during, after).
  4. Repeat for `↓ mp3` (decode via `decodeAudioData`, assert peak > 0).
  5. **Regression:** the two DNB tracks
     (`…fred-again-joy-01`, `…-05`) export with audio (peak > 0).
- Run via the project's isolated-server recipe (API `PORT=3101`, vite `5273`
  with `API_PROXY`), never the user's `:3001`/`:5173`.

## Known minor

A same-origin iframe shares the parent's main thread, but
`OfflineAudioContext.startRendering()` runs on the audio **render thread**, and
the per-hap setup loop `await`s (yields), so live playback (driven from the
audio thread) won't stall. Strictly better than today's full stop.

## File summary

| File | Action |
|---|---|
| `export-render.html` | Create — headless iframe render page (vite MPA input) |
| `src/export-render.js` | Create — in-iframe engine: boot strudel, message protocol |
| `src/render.js` | Create — offline render + encode (extracted from `export.js`, no live-context dance) |
| `src/export.js` | Rewrite — main-page iframe orchestrator; drop `stopPlayback`/audio imports |
| `src/app.js` | Modify — drop `stopPlayback: stop` from the export button handler |
| `vite.config.js` | Modify — add `export-render.html` as a third MPA `input` |
| `src/export-spec.js`, `src/encoders.js` | Unchanged — imported by `render.js` |
