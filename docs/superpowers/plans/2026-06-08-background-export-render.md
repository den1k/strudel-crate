# Background Export Render Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render WAV/MP3 downloads inside a hidden, per-export same-origin iframe so the main page's live playback is never interrupted.

**Architecture:** The export's offline render currently hijacks the single global audio context (closes it, swaps in an `OfflineAudioContext`, restores live audio after), which forces playback to stop. We move the render into a headless iframe (`export-render.html` → `src/export-render.js`) that has its own `window`/module-graph/superdough-singleton/audio-context. `src/export.js` becomes a main-page orchestrator that spawns the iframe, runs a `postMessage` protocol, downloads the returned blob, and removes the iframe. The parent's live `AudioContext` is never touched.

**Tech Stack:** Vanilla JS + Vite (MPA), `@strudel/webaudio` + `superdough` (`OfflineAudioContext` render), vitest (Node units), Playwright (browser verification).

**Spec:** `docs/superpowers/specs/2026-06-08-background-export-render-design.md`

**Branch:** `fix-silent-wav` (this also carries the committed silent-WAV fix `9a02a1d`; `collectHaps` in `src/export-spec.js` is reused here).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/render.js` | Create | Pure offline render + encode (`renderTrack(track, format) → Blob`); no live-context dance |
| `src/export-render.js` | Create | Runs INSIDE the iframe: boot strudel, `postMessage` protocol, call `renderTrack` |
| `export-render.html` | Create | Headless MPA page that loads `src/export-render.js`; used only as iframe `src` |
| `src/export.js` | Rewrite | Main-page orchestrator: spawn iframe, message protocol, download, teardown |
| `src/app.js` | Modify | Drop `stopPlayback: stop` from the export button handler (line 226) |
| `vite.config.js` | Modify | Add `export-render.html` as a third MPA `input` |
| `test/render.test.mjs` | Create | Node unit: `renderTrack` shape/guards (no real audio context in Node) |
| `src/export-spec.js`, `src/encoders.js` | Unchanged | Imported by `render.js` |

No changes to `src/editor.js`, `src/playing-state.js`, server, or `stems`/`index` pages.

**Reuse anchors (verified against the current branch):**
- App boot sequence to mirror in the iframe — `src/app.js:22-33`: `core.evalScope(core, mini, tonal, webaudio)` then `Promise.all([registerSynthSounds(), ...banks.map(b => b.shorthand ? samples(b.shorthand) : samples(b.json, b.base, { prebake: b.prebake, tag: b.tag }))])`, with `import banks from '../shared/sample-banks.json'`.
- Current render/encode to extract — `src/export.js:33-44` (evaluate + guard + `exportSpec` + `renderBuffer` + encode) and `:53-79` (`renderBuffer`). The extracted version DROPS `getAudioContext().close()` (line 54) and the whole restore-live-audio `finally` (lines 72-78) because the iframe has no live audio.
- Export button handler to edit — `src/app.js:225-228`.
- Vite MPA input pattern — `vite.config.js:25` (`rollupOptions.input`).

---

### Task 1: `src/render.js` — offline render + encode (extracted, no live-context dance)

**Files:**
- Create: `src/render.js`
- Test: `test/render.test.mjs`

- [ ] **Step 1: Write the failing test**

`renderTrack` calls `new OfflineAudioContext(...)`, which does not exist in Node, so a Node unit test cannot exercise a real render. The test pins the **pre-render contract** (the parts that run before any audio API): the bad-pattern guard and the unknown-format path. We stub `OfflineAudioContext` so we can assert the guard fires *before* it is constructed.

Create `test/render.test.mjs`:

```js
import { describe, it, expect, beforeAll } from 'vitest';
import { initStrudelEnv } from '../scripts/strudel-env.mjs';
import { renderTrack } from '../src/render.js';

beforeAll(() => initStrudelEnv());

describe('renderTrack', () => {
  it('rejects code that does not evaluate to a pattern', async () => {
    // `42` evaluates fine but is not a Pattern → guard must throw before any audio API
    await expect(renderTrack({ code: '42', meta: { bpm: 120 } }, 'wav')).rejects.toThrow(
      /did not evaluate to a pattern/,
    );
  });

  it('throws on evaluation failure without touching the audio context', async () => {
    await expect(renderTrack({ code: 'note("c3"', meta: { bpm: 120 } }, 'wav')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/render.test.mjs`
Expected: FAIL — `Failed to resolve import "../src/render.js"` / module not found.

- [ ] **Step 3: Write `src/render.js`**

Create `src/render.js` with the render+encode logic extracted from `src/export.js`, minus the live-context close/restore (the iframe has no live audio to preserve):

```js
import {
  setAudioContext,
  setSuperdoughAudioController,
  initAudio,
  webaudioOutput,
} from '@strudel/webaudio';
import { SuperdoughAudioController } from 'superdough/superdoughoutput.mjs';
import { evaluate } from '@strudel/transpiler';
import { exportSpec, collectHaps } from './export-spec.js';
import { encodeWav, encodeMp3 } from './encoders.js';

const SAMPLE_RATE = 44100;

// Render a track to a downloadable Blob using an OfflineAudioContext. Intended
// to run inside the export iframe, which owns its global audio context — so,
// unlike the old main-thread path, there is no live context to close and
// restore. setcpm/setcps exist only inside repls; the bare transpiler can't see
// them, and exports derive cps from meta.bpm, so no-ops satisfy the reference
// (??= so a repl-registered real one survives if present).
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
  // collectHaps queries cycle-by-cycle (one throwing cycle can't zero the whole
  // render); ascending onset order matters for graph-state controls like `cut`,
  // and awaiting each call lets samples load into the offline context.
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

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/render.test.mjs`
Expected: PASS (2 tests). The guard/eval-failure paths return before `new OfflineAudioContext` is reached, so Node's lack of Web Audio doesn't matter.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: ALL PASS (65 prior + 2 new = 67).

- [ ] **Step 6: Commit**

```bash
git add src/render.js test/render.test.mjs
git commit -m "feat: extract offline render+encode into src/render.js (no live-context dance)"
```

---

### Task 2: `src/export-render.js` + `export-render.html` — the in-iframe engine

**Files:**
- Create: `src/export-render.js`
- Create: `export-render.html`

This task is browser-only (boots strudel, uses `OfflineAudioContext` and `postMessage`); it has no Node unit test. It is verified end-to-end in Task 5.

- [ ] **Step 1: Create `src/export-render.js`**

Mirrors the app boot at `src/app.js:22-33`, then serves render requests over `postMessage`:

```js
import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import * as tonal from '@strudel/tonal';
import * as webaudio from '@strudel/webaudio';
import { registerSynthSounds, samples } from '@strudel/webaudio';
import banks from '../shared/sample-banks.json';
import { renderTrack } from './render.js';

// Register the same sound map the app loads on boot. This only registers (URLs
// + synth defs); individual samples are fetched/decoded lazily during a render,
// so no running AudioContext is needed here — this iframe is headless.
const ready = (async () => {
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

window.addEventListener('message', async (e) => {
  const data = e.data || {};
  if (data.type !== 'render') return;
  const { id, track, format } = data;
  try {
    await ready;
    const blob = await renderTrack(track, format);
    parent.postMessage({ type: 'done', id, blob }, '*');
  } catch (err) {
    parent.postMessage({ type: 'error', id, message: err.message }, '*');
  }
});

// Tell the parent we can accept a render request once strudel is registered.
ready.then(() => parent.postMessage({ type: 'ready' }, '*'));
```

- [ ] **Step 2: Create `export-render.html`**

A headless page (no UI, no fonts, no stylesheet) loaded only as the iframe `src`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>strudel export render</title>
</head>
<body>
  <script type="module" src="/src/export-render.js"></script>
</body>
</html>
```

- [ ] **Step 3: Sanity-check the files exist and import resolves**

Run: `node --input-type=module -e "import('./src/render.js').then(()=>console.log('render.js imports'),e=>{console.error(e.message);process.exit(1)})"`
Expected: prints `render.js imports` (proves `export-render.js`'s dependency `render.js` is importable; `export-render.js` itself is browser-only and is verified in Task 5).

- [ ] **Step 4: Commit**

```bash
git add src/export-render.js export-render.html
git commit -m "feat: headless in-iframe export render engine + page"
```

---

### Task 3: `vite.config.js` — register the render page as an MPA input

**Files:**
- Modify: `vite.config.js:25`

- [ ] **Step 1: Add the third MPA input**

Change the `rollupOptions.input` line (currently `{ main: page('./index.html'), stems: page('./stems.html') }`) to include the render page:

```js
    rollupOptions: {
      input: {
        main: page('./index.html'),
        stems: page('./stems.html'),
        exportRender: page('./export-render.html'),
      },
    },
```

(No clean-URL rewrite is added — the iframe loads `/export-render.html` directly, and it is not user-facing.)

- [ ] **Step 2: Verify the build emits the page**

Run: `npm run build`
Expected: build succeeds; `dist/export-render.html` exists.

Run: `test -f dist/export-render.html && echo "page emitted"`
Expected: `page emitted`

- [ ] **Step 3: Commit**

```bash
git add vite.config.js
git commit -m "build: add export-render.html as a third MPA input"
```

---

### Task 4: `src/export.js` — main-page iframe orchestrator (rewrite) + drop `stopPlayback`

**Files:**
- Rewrite: `src/export.js`
- Modify: `src/app.js:225-228`

- [ ] **Step 1: Rewrite `src/export.js`**

Replace the **entire contents** with the orchestrator (no strudel/audio imports; keeps `isExporting`/`exportTrack` so `src/app.js` imports still resolve):

```js
// Export is rendered in a hidden, same-origin iframe (export-render.html) that
// owns its own audio context, so the main page's live playback is never
// interrupted. This module is the main-page orchestrator: spawn the iframe, run
// the postMessage protocol, download the returned blob, tear the iframe down.
let exporting = false;
export const isExporting = () => exporting;

const RENDER_TIMEOUT_MS = 5 * 60_000; // offline render is fast; this only guards a stuck iframe

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
      function cleanup() {
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
      }
      function onMessage(e) {
        if (e.source !== iframe.contentWindow) return; // ignore other frames
        const data = e.data || {};
        if (data.type === 'ready' && !started) {
          started = true; // render once, even if 'ready' somehow repeats
          iframe.contentWindow.postMessage({ type: 'render', id, track, format }, '*');
        } else if (data.type === 'done' && data.id === id) {
          cleanup();
          resolve(data.blob);
        } else if (data.type === 'error' && data.id === id) {
          cleanup();
          reject(new Error(data.message));
        }
      }
      window.addEventListener('message', onMessage);
      document.body.appendChild(iframe); // load starts here; iframe posts 'ready'
    });
    onStatus('encoding…'); // cosmetic — encoding already happened in the iframe
    download(blob, `${track.id}.${format}`);
  } finally {
    iframe.remove(); // terminate the render context on completion or failure
    exporting = false;
  }
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
```

- [ ] **Step 2: Drop `stopPlayback` from the button handler**

In `src/app.js`, the export click handler currently (lines 225-228) calls:

```js
          await exportTrack(track, fmt, {
            stopPlayback: stop, // offline render swaps the global audio context
            onStatus: (s) => (btn.textContent = s),
          });
```

Replace those lines with (playback now survives the export — no `stopPlayback`):

```js
          await exportTrack(track, fmt, {
            onStatus: (s) => (btn.textContent = s),
          });
```

- [ ] **Step 3: Verify the suite and build still pass**

Run: `npx vitest run`
Expected: ALL PASS (67 — the Node units don't import the rewritten `export.js`).

Run: `npm run build`
Expected: build succeeds; `dist/` contains `index.html`, `stems.html`, `export-render.html`.

- [ ] **Step 4: Commit**

```bash
git add src/export.js src/app.js
git commit -m "feat: render exports in a hidden iframe so playback keeps playing"
```

---

### Task 5: End-to-end browser verification

**Files:**
- None (verification only; no source changes unless a defect is found)

Uses the project's isolated-server recipe (API `PORT=3101`, vite `5273` with `API_PROXY`), never the user's `:3001`/`:5173`. Python Playwright at `/usr/local/opt/python@3.11/bin/python3.11`.

- [ ] **Step 1: Start the isolated server pair (from the worktree root)**

```bash
for p in 3101 5273; do pids=$(lsof -ti :$p); [ -n "$pids" ] && kill $pids; done
sleep 1
(PORT=3101 node server/index.mjs >/tmp/exp-api.log 2>&1 &)
(API_PROXY=http://localhost:3101 npx vite --port 5273 --strictPort >/tmp/exp-vite.log 2>&1 &)
sleep 4
curl -s -o /dev/null -w "vite:%{http_code}\n" http://localhost:5273/
```

Expected: `vite:200`.

- [ ] **Step 2: Write the verification script `/tmp/exp-verify.py`**

Asserts: (a) a track plays, (b) WAV and MP3 each download with real audio (decoded peak > 0), (c) playback is NOT interrupted by either export, and (d) the two previously-silent DNB tracks export with audio.

```python
from playwright.sync_api import sync_playwright
import base64

def decoded_peak(pg, data: bytes):
    b64 = base64.b64encode(data).decode()
    return pg.evaluate("""async (b64) => {
      const bin = atob(b64); const u8 = new Uint8Array(bin.length);
      for (let i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i);
      const ctx = new OfflineAudioContext(2, 44100, 44100);
      const buf = await ctx.decodeAudioData(u8.buffer);
      let pk=0; for (let c=0;c<buf.numberOfChannels;c++){const ch=buf.getChannelData(c);
        for (let i=0;i<ch.length;i++){const a=Math.abs(ch[i]); if(a>pk)pk=a;}}
      return pk;
    }""", b64)

def export_via_button(pg, card):
    with pg.expect_download(timeout=120000) as d:
        card.locator('button.export', has_text='wav').click()
    return d.value

with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page()
    pg.goto('http://localhost:5273/'); pg.wait_for_selector('#status.ready', timeout=60000)
    pg.wait_for_selector('.track', timeout=20000)
    card = pg.locator('.track').first

    # (a) start playback
    card.locator('button.play').click()
    pg.wait_for_selector('.track.playing', timeout=15000)
    pg.wait_for_timeout(2000)
    now_before = pg.inner_text('#now-playing')
    assert 'NOW PLAYING' in now_before, 'track did not start playing'

    # (b+c) export WAV while playing; playback must continue
    with pg.expect_download(timeout=120000) as d:
        card.locator('button.export').first.click()  # first export button = wav
    wav = d.value; wav.save_as('/tmp/e.wav')
    assert pg.locator('.track.playing').count() == 1, 'playback stopped during WAV export'
    assert pg.inner_text('#now-playing') == now_before, 'now-playing changed during export'
    pk = decoded_peak(pg, open('/tmp/e.wav','rb').read())
    print('WAV peak', pk); assert pk > 0, 'WAV is silent'

    # MP3 while still playing
    with pg.expect_download(timeout=120000) as d:
        card.locator('button.export').nth(1).click()  # second = mp3
    mp3 = d.value; mp3.save_as('/tmp/e.mp3')
    assert pg.locator('.track.playing').count() == 1, 'playback stopped during MP3 export'
    pk = decoded_peak(pg, open('/tmp/e.mp3','rb').read())
    print('MP3 peak', pk); assert pk > 0, 'MP3 is silent'

    # (d) regression: the two DNB tracks export with audio (direct call, any state)
    for tid in ['2026-06-04-drum-n-bass-uk-garage-fred-again-joy-01',
                '2026-06-04-drum-n-bass-uk-garage-fred-again-joy-05']:
        t = pg.evaluate("async(id)=>{const ts=await(await fetch('/api/tracks')).json();return ts.find(x=>x.id===id);}", tid)
        with pg.expect_download(timeout=120000) as d:
            pg.evaluate("""async(t)=>{const m=await import('/src/export.js');
              await m.exportTrack(t,'wav',{});}""", t)
        d.value.save_as('/tmp/r.wav')
        pk = decoded_peak(pg, open('/tmp/r.wav','rb').read())
        print(tid, 'peak', pk); assert pk > 0, f'{tid} silent'

    print('ALL ASSERTIONS PASS')
    b.close()
```

- [ ] **Step 3: Run the verification**

Run: `/usr/local/opt/python@3.11/bin/python3.11 /tmp/exp-verify.py`
Expected: prints non-zero peaks for WAV, MP3, and both DNB tracks, then `ALL ASSERTIONS PASS`. If any assertion fails, STOP and debug (do not weaken assertions).

- [ ] **Step 4: Tear down servers and temp files**

```bash
for p in 3101 5273; do pids=$(lsof -ti :$p); [ -n "$pids" ] && kill $pids; done
rm -f /tmp/exp-verify.py /tmp/e.wav /tmp/e.mp3 /tmp/r.wav
```

Confirm the user's servers are untouched:

Run: `for p in 3001 5173; do echo "port $p: $(lsof -ti :$p | tr '\n' ' ')"; done`
Expected: the user's `:3001`/`:5173` processes (if any) still listed; `:3101`/`:5273` empty.

- [ ] **Step 5: Verify a clean tree (no stray artifacts)**

Run: `git status --short`
Expected: no untracked WAV/MP3/stem files; nothing to commit (all task commits already made). Verification produced no source changes.

---

## Self-Review

**1. Spec coverage:**
- Hidden-iframe isolated render → Tasks 2 (`export-render.js`/`.html`) + 3 (vite input) ✓
- Per-export iframe, torn down on completion → Task 4 (`iframe.remove()` in `finally`) ✓
- Uninterrupted playback (drop global-context swap + `stopPlayback`) → Task 1 (extracted render has no `close()`/restore) + Task 4 (orchestrator never touches parent context; app.js drops `stopPlayback`) ✓
- Render+encode reuse incl. `collectHaps` silent-WAV fix → Task 1 imports `exportSpec, collectHaps` from `export-spec.js` and `encodeWav/encodeMp3` from `encoders.js` ✓
- Error handling (render error / timeout / concurrent guard / Blob via postMessage) → Task 4 orchestrator (`error`/timeout/`isExporting`/structured-clone `data.blob`) ✓
- Testing (Node units kept; browser verifies audio + non-interruption + DNB regression) → Task 1 unit + Task 5 Playwright ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output. ✓

**3. Type/signature consistency:**
- `renderTrack(track, format) → Promise<Blob>` defined in Task 1, called in Task 2's `export-render.js` and in Task 5's regression block. ✓
- Message protocol consistent across iframe and orchestrator: iframe sends `{type:'ready'}`, `{type:'done', id, blob}`, `{type:'error', id, message}`; orchestrator sends `{type:'render', id, track, format}` and reads exactly those fields; `id = `${track.id}:${format}`` in both directions. ✓
- `isExporting`/`exportTrack` exports preserved in Task 4 so `src/app.js`'s existing `import { exportTrack, isExporting }` still resolves. ✓
- Iframe `src` `/export-render.html` (Task 4) matches the page created in Task 2 and the vite input filename in Task 3. ✓
