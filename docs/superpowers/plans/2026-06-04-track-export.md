# Track Export (WAV + MP3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-track download buttons that export one full arrangement pass as lossless WAV or compressed MP3 (192kbps), rendered offline (faster than realtime) in the browser.

**Architecture:** A click on "↓ wav" / "↓ mp3" stops live playback, evaluates the track code to a Pattern (same `@strudel/transpiler` `evaluate` the validator uses — the page's evalScope is already initialized by `src/main.js`), renders it into an `OfflineAudioContext` by feeding haps to `webaudioOutput` in onset order (mirroring `renderPatternAudio` in `@strudel/webaudio`, which can't be used directly because it hard-codes WAV download and doesn't return the buffer), then encodes the buffer to WAV (own 40-line RIFF encoder) or MP3 (`@breezystack/lamejs`, pure JS) and triggers a download. Duration comes from summing the track's `arrange(` section weights (pure, unit-tested parser); cps comes from `meta.bpm` (the validator enforces the `setcpm(bpm/4)` convention).

**Tech Stack:** Vanilla JS + Vite, `@strudel/transpiler`/`@strudel/webaudio`/`superdough` (already pinned), `@breezystack/lamejs@1.2.7` (new dep), vitest, Python Playwright for browser verification.

**Execution environment:** Per user request, execute in a NEW worktree. At execution time use superpowers:using-git-worktrees. Known repo facts: `worktree.baseRef` is set to `origin/main` but NO remote exists, so EnterWorktree's fresh-create cannot resolve the base — create manually then enter:
```bash
git worktree add .claude/worktrees/track-export -b track-export main
# then EnterWorktree with path: .claude/worktrees/track-export
npm install   # worktree needs its own node_modules
```
`.claude/worktrees/` is already ignored via `.git/info/exclude`. ALSO: the user runs parallel Claude sessions against this repo's main checkout — never `git checkout` in the main repo; after the final merge, run `npm install` in the main checkout (new dependency) and verify `git branch --show-current` before any commit outside the worktree.

---

## Verified API facts (from pinned packages — do not re-derive)

- `@strudel/webaudio@1.3.0` exports `webaudioOutput(hap, _deadline, hapDuration, cps, t)` which calls `superdough(hap2value(hap), t, hapDuration, cps, hap.whole?.begin)`. Its `renderPatternAudio` (`node_modules/@strudel/webaudio/webaudio.mjs:40-104`) is the offline-render reference: close live ctx → `new OfflineAudioContext(2, frames, sampleRate)` → `setAudioContext(ctx)` → `setSuperdoughAudioController(new SuperdoughAudioController(ctx))` → `initAudio({...})` → query haps, sort by onset, `await superdough(...)` per onset hap (awaiting loads samples into the offline ctx) → `startRendering()` → finally `setAudioContext(null); setSuperdoughAudioController(null); resetGlobalEffects();`.
- `setAudioContext`, `getAudioContext`, `initAudio`, `resetGlobalEffects`, `setSuperdoughAudioController`, `webaudioOutput` are all importable from `@strudel/webaudio` (it re-exports `superdough`). `SuperdoughAudioController` is NOT in the main export — import it the way webaudio.mjs itself does: `import { SuperdoughAudioController } from 'superdough/superdoughoutput.mjs'`.
- `audioBufferToWav` in webaudio.mjs is **private** (line 120, not exported) — hence our own WAV encoder.
- `@strudel/transpiler`'s `evaluate(code)` returns `{ pattern }`; `scripts/validate.mjs` shows the usage pattern, including the "did it evaluate to a Pattern" check (`pattern.queryArc` presence).
- `src/main.js` initializes evalScope with core/mini/tonal/webaudio at startup (the `ready` promise) — `evaluate()` works in the page after `ready` resolves. **Important history:** `@strudel/web` is NOT used anymore (its dist inlines private module copies → dual sound registries, commit 28a3088). Do not reintroduce it.
- `arrange(...sections)` (`@strudel/core/pattern.mjs:1469`) does NOT expose total cycles on the pattern — hence parsing section weights from code text. Generated track code formats sections at line starts: `  [12, stack(`.
- Track schema (validator-enforced): `meta.bpm` required; code convention `setcpm(bpm/4)` cross-checked → `cps = bpm/240`.
- After an export, the live AudioContext was closed; `getAudioContext()` lazily creates a fresh one, but worklets/effects need `initAudio()` again, and the fresh context may start `suspended` (no user gesture) — the render helper re-inits in `finally`, and `play()` gets a defensive `resume()`.

## File structure

- `src/export-spec.js` — pure: parse arrange cycles from code, build `{ cps, cycles, seconds }` (unit-tested)
- `src/encoders.js` — pure: `encodeWav(buffer)` → ArrayBuffer, `encodeMp3(buffer)` → array of byte chunks (unit-tested with stub buffers)
- `src/export.js` — browser-only orchestration: evaluate → offline render → encode → download; single-export lock; audio re-init
- `src/main.js` — exports row on each card + defensive context resume in `play()`
- `src/style.css` — `.exports` / `.export` styles

---

### Task 1: Install @breezystack/lamejs

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install exact version**

Run: `npm install --save-exact @breezystack/lamejs@1.2.7`
Expected: clean install, `"@breezystack/lamejs": "1.2.7"` in dependencies (postinstall `fix-kabelsalat.mjs` runs — normal).

- [ ] **Step 2: Verify it imports in node (vitest will need this)**

Run: `node -e "import('@breezystack/lamejs').then(m => console.log(typeof m.Mp3Encoder))"`
Expected: `function`. (If it prints `undefined`, check `m.default.Mp3Encoder` and report DONE_WITH_CONCERNS noting the actual shape — Task 3's import must then be adjusted to match.)

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: vite build succeeds.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @breezystack/lamejs for mp3 export"
```

---

### Task 2: Export spec — duration/cps from track (TDD)

**Files:**
- Create: `src/export-spec.js`
- Test: `test/export-spec.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/export-spec.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { parseArrangeCycles, exportSpec } from '../src/export-spec.js';

const arrangeCode = `setcpm(124/4)
arrange(
  [12, stack(
    s("bd*4").bank("RolandTR909"),
    note("<[a2,c3,e3] [f2,a2,c3]>/2").s("sawtooth"),
  )],
  [16, stack(
    s("bd*4, [~ cp]*2"),
  )],
  [8, s("hh*8")],
)`;

describe('parseArrangeCycles', () => {
  it('sums section weights at line starts', () => {
    expect(parseArrangeCycles(arrangeCode)).toBe(36);
  });

  it('is not fooled by bracketed mini-notation chords', () => {
    // "[a2,c3,e3]" sits mid-line; only line-start "[N," counts
    expect(parseArrangeCycles(arrangeCode)).toBe(36);
  });

  it('returns null when there is no arrange call', () => {
    expect(parseArrangeCycles('setcpm(30)\nstack(s("bd*4"))')).toBe(null);
  });

  it('returns null for arrange with no parseable sections', () => {
    expect(parseArrangeCycles('arrange([a, s("bd")])')).toBe(null);
  });
});

describe('exportSpec', () => {
  const track = { meta: { bpm: 124 }, code: arrangeCode };

  it('derives cps from meta.bpm via the setcpm(bpm/4) convention', () => {
    expect(exportSpec(track).cps).toBeCloseTo(124 / 240);
  });

  it('uses parsed arrange cycles and computes seconds', () => {
    const spec = exportSpec(track);
    expect(spec.cycles).toBe(36);
    expect(spec.seconds).toBeCloseTo(36 / (124 / 240));
  });

  it('falls back to 32 cycles without arrange', () => {
    expect(exportSpec({ meta: { bpm: 120 }, code: 'stack(s("bd"))' }).cycles).toBe(32);
  });

  it('caps runaway cycle counts at 512', () => {
    const huge = 'arrange(\n  [9999, s("bd")],\n)';
    expect(exportSpec({ meta: { bpm: 120 }, code: huge }).cycles).toBe(512);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/export-spec.test.mjs`
Expected: FAIL — cannot resolve `../src/export-spec.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/export-spec.js`:

```js
const DEFAULT_CYCLES = 32; // tracks without arrange (rare) get a fixed-length export
const MAX_CYCLES = 512; // matches the validator's full-arrangement scan window

// Generated track code formats arrange sections at line starts: `  [12, stack(`.
// Mini-notation brackets ("[a2,c3,e3]") never start a line, so a line-anchored
// match on `[<digits>,` only sees section weights.
export function parseArrangeCycles(code) {
  if (!/\barrange\s*\(/.test(code)) return null;
  const weights = [...code.matchAll(/^\s*\[\s*(\d+)\s*,/gm)].map((m) => Number(m[1]));
  const total = weights.reduce((sum, w) => sum + w, 0);
  return total > 0 ? total : null;
}

// cps from metadata: the validator enforces the setcpm(bpm/4) convention,
// so cps = (bpm/4) cpm / 60 = bpm/240.
export function exportSpec(track) {
  const cps = track.meta.bpm / 240;
  const cycles = Math.min(parseArrangeCycles(track.code) ?? DEFAULT_CYCLES, MAX_CYCLES);
  return { cps, cycles, seconds: cycles / cps };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/export-spec.test.mjs`
Expected: PASS (8 tests).

- [ ] **Step 5: Full suite**

Run: `npm test`
Expected: all pass (48 pre-existing + 8 new).

- [ ] **Step 6: Commit**

```bash
git add src/export-spec.js test/export-spec.test.mjs
git commit -m "feat: export spec — arrange-length and cps derivation for track export"
```

---

### Task 3: Encoders — WAV and MP3 (TDD)

**Files:**
- Create: `src/encoders.js`
- Test: `test/encoders.test.mjs`

Both encoders take an "AudioBuffer-like" (`{ numberOfChannels, sampleRate, length, getChannelData(c) }`) so they're testable in node with stubs.

- [ ] **Step 1: Write the failing test**

Create `test/encoders.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { encodeWav, encodeMp3 } from '../src/encoders.js';

// 0.1s stereo sine stub, AudioBuffer-like
function stubBuffer(sampleRate = 44100, seconds = 0.1) {
  const length = Math.round(sampleRate * seconds);
  const mk = () => {
    const a = new Float32Array(length);
    for (let i = 0; i < length; i++) a[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.5;
    return a;
  };
  const channels = [mk(), mk()];
  return { numberOfChannels: 2, sampleRate, length, getChannelData: (c) => channels[c] };
}

describe('encodeWav', () => {
  it('produces a valid RIFF/WAVE header with correct sizes', () => {
    const buf = stubBuffer();
    const wav = encodeWav(buf);
    const view = new DataView(wav);
    const tag = (off) => String.fromCharCode(...new Uint8Array(wav, off, 4));
    expect(tag(0)).toBe('RIFF');
    expect(tag(8)).toBe('WAVE');
    expect(tag(36)).toBe('data');
    expect(view.getUint16(22, true)).toBe(2); // channels
    expect(view.getUint32(24, true)).toBe(44100); // sample rate
    expect(view.getUint32(40, true)).toBe(buf.length * 2 * 2); // data size
    expect(wav.byteLength).toBe(44 + buf.length * 2 * 2);
  });

  it('clamps samples outside [-1, 1]', () => {
    const loud = stubBuffer();
    loud.getChannelData(0)[0] = 2.0;
    loud.getChannelData(0)[1] = -2.0;
    const view = new DataView(encodeWav(loud));
    expect(view.getInt16(44, true)).toBe(0x7fff); // first frame, ch0
    expect(view.getInt16(48, true)).toBe(-0x8000); // second frame, ch0
  });
});

describe('encodeMp3', () => {
  it('produces non-empty mp3 chunks with a valid frame sync', () => {
    const chunks = encodeMp3(stubBuffer());
    expect(chunks.length).toBeGreaterThan(0);
    const total = chunks.reduce((n, c) => n + c.length, 0);
    expect(total).toBeGreaterThan(500); // 0.1s @192kbps ≈ 2.4KB
    expect(chunks[0][0] & 0xff).toBe(0xff); // MPEG frame sync byte
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/encoders.test.mjs`
Expected: FAIL — cannot resolve `../src/encoders.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/encoders.js`:

```js
import { Mp3Encoder } from '@breezystack/lamejs';

const toInt16 = (f32) => {
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return i16;
};

// 16-bit PCM RIFF/WAVE from an AudioBuffer-like. (@strudel/webaudio has the
// same encoder but keeps it private — see webaudio.mjs:120.)
export function encodeWav(buffer) {
  const { numberOfChannels, sampleRate, length } = buffer;
  const channels = Array.from({ length: numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const blockAlign = numberOfChannels * 2;
  const dataSize = length * blockAlign;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);
  const writeStr = (off, s) => [...s].forEach((ch, i) => view.setUint8(off + i, ch.charCodeAt(0)));
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numberOfChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  let off = 44;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < numberOfChannels; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return out;
}

// MP3 192kbps via lamejs. Returns an array of Int8Array chunks (Blob-ready).
export function encodeMp3(buffer, kbps = 192) {
  const stereo = buffer.numberOfChannels > 1;
  const encoder = new Mp3Encoder(stereo ? 2 : 1, buffer.sampleRate, kbps);
  const left = toInt16(buffer.getChannelData(0));
  const right = stereo ? toInt16(buffer.getChannelData(1)) : left;
  const chunks = [];
  const BLOCK = 1152; // one MPEG frame of samples
  for (let i = 0; i < left.length; i += BLOCK) {
    const chunk = encoder.encodeBuffer(left.subarray(i, i + BLOCK), right.subarray(i, i + BLOCK));
    if (chunk.length) chunks.push(chunk);
  }
  const tail = encoder.flush();
  if (tail.length) chunks.push(tail);
  return chunks;
}
```

(If Task 1 Step 2 reported a different module shape for lamejs, adjust the import accordingly — e.g. `import lame from '@breezystack/lamejs'` + `new lame.Mp3Encoder(...)`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/encoders.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Full suite**

Run: `npm test`
Expected: zero failures (previous total + the 3 new encoder tests).

- [ ] **Step 6: Commit**

```bash
git add src/encoders.js test/encoders.test.mjs
git commit -m "feat: WAV and MP3 encoders for track export"
```

---

### Task 4: Export orchestration (browser module)

**Files:**
- Create: `src/export.js`

Browser-only (OfflineAudioContext, downloads) — no unit tests; verified in Task 6.

- [ ] **Step 1: Create `src/export.js`**

```js
import { evaluate } from '@strudel/transpiler';
import {
  getAudioContext,
  setAudioContext,
  setSuperdoughAudioController,
  initAudio,
  resetGlobalEffects,
  webaudioOutput,
} from '@strudel/webaudio';
import { SuperdoughAudioController } from 'superdough/superdoughoutput.mjs';
import { exportSpec } from './export-spec.js';
import { encodeWav, encodeMp3 } from './encoders.js';

const SAMPLE_RATE = 44100;

// The offline render swaps the GLOBAL audio context, so exports are exclusive
// and live playback must be stopped by the caller first.
let exporting = false;
export const isExporting = () => exporting;

export async function exportTrack(track, format, { onStatus = () => {}, stopPlayback = () => {} } = {}) {
  if (exporting) throw new Error('an export is already running');
  exporting = true;
  try {
    stopPlayback();
    onStatus('rendering…');
    const { pattern } = await evaluate(track.code);
    if (typeof pattern?.queryArc !== 'function') {
      throw new Error('code did not evaluate to a pattern');
    }
    const spec = exportSpec(track);
    const buffer = await renderBuffer(pattern, spec);
    onStatus('encoding…');
    const { blob, ext } =
      format === 'wav'
        ? { blob: new Blob([encodeWav(buffer)], { type: 'audio/wav' }), ext: 'wav' }
        : { blob: new Blob(encodeMp3(buffer), { type: 'audio/mpeg' }), ext: 'mp3' };
    download(blob, `${track.id}.${ext}`);
  } finally {
    exporting = false;
  }
}

// Mirrors @strudel/webaudio's renderPatternAudio (webaudio.mjs:40) but returns
// the rendered AudioBuffer instead of force-downloading a WAV, and re-inits
// live audio afterwards so the editors keep playing.
async function renderBuffer(pattern, { cps, cycles, seconds }) {
  await getAudioContext().close(); // park the live context
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * SAMPLE_RATE), SAMPLE_RATE);
  setAudioContext(ctx);
  setSuperdoughAudioController(new SuperdoughAudioController(ctx));
  try {
    await initAudio();
    // ascending onset order matters for graph-state controls like `cut`;
    // awaiting each call lets samples load into the offline context
    const haps = pattern
      .queryArc(0, cycles, { _cps: cps })
      .sort((a, b) => a.whole.begin.valueOf() - b.whole.begin.valueOf());
    for (const hap of haps) {
      if (!hap.hasOnset()) continue;
      try {
        await webaudioOutput(hap, null, hap.duration / cps, cps, hap.whole.begin.valueOf() / cps);
      } catch (err) {
        console.warn('[export] hap skipped:', err.message); // one bad hap ≠ dead export
      }
    }
    return await ctx.startRendering();
  } finally {
    // restore live audio: fresh default context + worklets/effects re-init
    setAudioContext(null);
    setSuperdoughAudioController(null);
    resetGlobalEffects();
    await initAudio();
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

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: success (module not yet imported by main.js; the real check is Task 6).

- [ ] **Step 3: Commit**

```bash
git add src/export.js
git commit -m "feat: offline track render and export orchestration"
```

---

### Task 5: UI — export buttons on track cards

**Files:**
- Modify: `src/main.js` (imports; `play()`; `trackCard()` after the chips loop)
- Modify: `src/style.css` (after the `.chip` rule)

- [ ] **Step 1: Add imports to `src/main.js`**

The file currently has (top of file):

```js
import { initAudioOnFirstClick, registerSynthSounds, samples } from '@strudel/webaudio';
```

Change to:

```js
import { initAudioOnFirstClick, registerSynthSounds, samples, getAudioContext } from '@strudel/webaudio';
```

and add below the other local imports:

```js
import { exportTrack, isExporting } from './export.js';
```

- [ ] **Step 2: Defensive context resume in `play()`**

In `play(track)`, after `if (state.playingId !== track.id) return;` add:

```js
  await getAudioContext().resume(); // post-export contexts start suspended
```

- [ ] **Step 3: Export buttons in `trackCard()`**

In `trackCard()`, directly after the `for (const value of chipValues) { ... }` loop (still inside the function, before `const rate = ...`), insert:

```js
  const exportRow = document.createElement('div');
  exportRow.className = 'exports';
  for (const fmt of ['wav', 'mp3']) {
    const btn = document.createElement('button');
    btn.className = 'export';
    btn.textContent = `↓ ${fmt}`;
    btn.title = fmt === 'wav' ? 'download lossless wav' : 'download mp3 192kbps';
    btn.addEventListener('click', async () => {
      if (isExporting()) return;
      const all = document.querySelectorAll('button.export');
      all.forEach((el) => (el.disabled = true));
      const label = btn.textContent;
      try {
        await exportTrack(track, fmt, {
          stopPlayback: stop, // offline render swaps the global audio context
          onStatus: (s) => (btn.textContent = s),
        });
      } catch (err) {
        console.error(err);
        flashError(card);
      } finally {
        btn.textContent = label;
        document.querySelectorAll('button.export').forEach((el) => (el.disabled = false));
      }
    });
    exportRow.appendChild(btn);
  }
  meta.appendChild(exportRow);
```

(Note: the second `querySelectorAll` in `finally` is deliberate — `renderTracks()` may have rebuilt cards while the export ran, so the captured `all` NodeList can be stale.)

- [ ] **Step 4: Styles in `src/style.css`**

After the `.chip { ... }` rule, add:

```css
.exports { display: flex; gap: 6px; margin-top: 8px; }
.export {
  background: transparent; color: var(--dim);
  border: 1px solid var(--line); font-family: var(--mono); font-size: 11px;
  padding: 2px 8px; cursor: pointer;
}
.export:hover:not(:disabled) { color: var(--acid); border-color: var(--acid); }
.export:disabled { opacity: 0.5; cursor: default; }
```

- [ ] **Step 5: Build and test**

Run: `npm run build && npm test`
Expected: build succeeds, zero test failures.

- [ ] **Step 6: Commit**

```bash
git add src/main.js src/style.css
git commit -m "feat: wav/mp3 export buttons on track cards"
```

---

### Task 6: Browser verification

The export surface is downloads from a real browser. Verify with Python Playwright (`/usr/local/opt/python@3.11/bin/python3.11`, browsers cached). Ports 3001/5173 are usually occupied by the user's live dev servers — run an isolated vite (`npx vite --port 5274 --strictPort`; its `/api` proxy hits the live API on :3001 read-only).

- [ ] **Step 1: Start isolated vite from the worktree**

Run (background): `npx vite --port 5274 --strictPort`
Confirm: `curl -s http://localhost:5274/api/tracks | head -c 80` returns track JSON.

- [ ] **Step 2: Drive the export flow**

Write and run a Playwright script that (capture `console` messages throughout — headless is deaf; "sound … not found" in console is the only audio-failure signal):

1. Load the app, wait for `.track` cards and `#status.ready`.
2. Click the first card's `↓ wav` button; use `page.expect_download(timeout=300000)`; save the download, assert: filename `== <track-id>.wav`, first 4 bytes `RIFF`, size within ±10% of `44 + seconds*44100*4` for the track's parsed arrange length.
3. Click `↓ mp3` on the same card; expect download `<track-id>.mp3`; assert first byte `0xFF` (frame sync) and size roughly `seconds * 24000` bytes (192kbps) ±30%.
4. **Post-export playback:** click ▶ on a track; assert `.track.playing` appears AND (open its details) outline highlight spans appear within 20s AND zero "not found" console errors — this proves the live context + worklets were re-initialized after the offline render.
5. Probe: click `↓ wav`, then immediately click another card's `↓ mp3` — assert the second click no-ops (buttons disabled / single download only).
6. Probe: export while a track is playing — assert playback stops (transport clears) and the download still arrives.

- [ ] **Step 3: Judge results**

All steps green → done. Any failure → use superpowers:systematic-debugging before patching. Known risk areas:
- lamejs module shape under vite (Task 1 Step 2 noted the actual export shape)
- OfflineAudioContext + worklets in headless Chromium (if `initAudio()` rejects offline, check how `renderPatternAudio` is invoked upstream and mirror any option differences)
- Long renders: a 6-minute track is ~63M samples; if `expect_download` times out at 5 min, try the shortest track in the crate first (smallest arrange total) and note render throughput.

- [ ] **Step 4: Stop the vite server, commit any fixes**

```bash
git add -A src/
git commit -m "fix: export verification fixes"   # only if fixes were needed
```
