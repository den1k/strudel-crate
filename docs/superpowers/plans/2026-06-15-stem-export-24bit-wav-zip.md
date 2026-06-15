# Per-Sound Stem Export (24-bit aligned WAVs, zipped) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `↓ stems` download to crate track cards that renders each distinct sound of a track as its own full-length, time-aligned **24-bit WAV**, bundled into a single `.zip` ready to drop into Ableton (all stems share length and start at bar 1, so they line up on import).

**Architecture:** Reuse the existing hidden-iframe render engine (so live playback is never interrupted). In the iframe, query the whole track's haps once (`collectHaps`), group them by `s()` sound name, and render each group in its own full-length `OfflineAudioContext` (identical length ⇒ automatic alignment). Encode each rendered buffer as 24-bit PCM WAV, pack them with a dependency-free store-only ZIP writer, and return the zip blob to the page for download.

**Tech Stack:** Vanilla JS + Vite (MPA), `@strudel/webaudio` (OfflineAudioContext render — single superdough instance, per the 2026-06-15 fix), vitest (Node units), Playwright (browser verification), `unzip` CLI (zip validity check).

**Design decisions (confirmed with user):**
- Split **crate tracks** (not the /stems page — those are already single sounds).
- **24-bit** WAV, full-length, all aligned to t=0, zipped.
- Group by **sound name** (`hap.value.s`): one stem per distinct sound (e.g. `bd`, `sd`, `hh`, `sawtooth`, `sine`, `amencutup`). Works for `stack` and `arrange` tracks alike. Known limitation: two layers using the *same* sound (e.g. two `sawtooth` parts) merge into one stem — acceptable.

**Reuse anchors (verified on `main`, commit `0cf9fef`):**
- `src/export-spec.js` already exports `exportSpec(track)` and `collectHaps(pattern, cycles, cps)`.
- `src/encoders.js` `encodeWav(buffer)` currently writes **16-bit** PCM; we generalize it with a `bitDepth` arg (default 16, add 24).
- `src/render.js` (post-fix) sets up the offline context with `setAudioContext` + `resetGlobalEffects()` + `setSuperdoughAudioController(null)` + `initAudio()`, all imported from `@strudel/webaudio` (one superdough instance — do NOT import from `superdough/...`).
- `src/export.js` orchestrator posts `{type:'render', id, track, format}`; iframe replies `{type:'done', id, blob}`. Download name at `export.js:48`.
- `src/app.js` export buttons: `for (const fmt of ['wav', 'mp3'])` at line 253; `initApp({ apiBase, emptyHint })` at line 14.
- `src/export-render.js` dispatches render requests; `src/main.js`/`src/stems.js` are thin `initApp` wrappers.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/encoders.js` | Modify | `encodeWav(buffer, bitDepth = 16)` — add 24-bit PCM path |
| `src/zip.js` | Create | `zipStore(files)` — dependency-free store-only ZIP (CRC32 + headers) |
| `src/export-spec.js` | Modify | `groupHapsBySound(haps)` — pure grouping of haps by sound name |
| `src/render.js` | Modify | Extract `renderHapsToBuffer(haps, spec)`; add `renderStemsZip(track)` |
| `src/export-render.js` | Modify | Handle `format === 'stems'` → `renderStemsZip` |
| `src/export.js` | Modify | Download name for `stems` → `<id>-stems.zip` |
| `src/app.js` | Modify | `initApp({…, splitStems})`; add `↓ stems` button when `splitStems` |
| `src/main.js` | Modify | Pass `splitStems: true` (crate) |
| `test/encoders.test.mjs` | Modify | 24-bit header + sample-byte assertions |
| `test/zip.test.mjs` | Create | `zipStore` validity (via `unzip -t`) + entry contents |
| `test/export-haps.test.mjs` | Modify | `groupHapsBySound` grouping assertions |

No change to `src/stems.js` (defaults `splitStems` to false), `src/playing-state.js`, `src/editor.js`, server, or vite config.

---

### Task 1: 24-bit WAV encoding

**Files:**
- Modify: `src/encoders.js`
- Test: `test/encoders.test.mjs`

- [ ] **Step 1: Write the failing test**

Append this `describe` block to the END of `test/encoders.test.mjs` (it reuses the existing `stubBuffer` helper defined at the top of that file):

```js
describe('encodeWav 24-bit', () => {
  it('writes a 24-bit PCM header with correct sizes', () => {
    const buf = stubBuffer(); // 0.1s stereo @ 44100
    const view = new DataView(encodeWav(buf, 24));
    const tag = (off) => String.fromCharCode(...new Uint8Array(view.buffer, off, 4));
    expect(tag(0)).toBe('RIFF');
    expect(tag(8)).toBe('WAVE');
    expect(view.getUint16(22, true)).toBe(2); // channels
    expect(view.getUint16(34, true)).toBe(24); // bits per sample
    expect(view.getUint16(32, true)).toBe(2 * 3); // blockAlign = channels * 3 bytes
    expect(view.getUint32(40, true)).toBe(buf.length * 2 * 3); // data size
    expect(view.byteLength).toBe(44 + buf.length * 2 * 3);
  });

  it('encodes full-scale samples as 24-bit two’s-complement little-endian', () => {
    const buf = stubBuffer();
    buf.getChannelData(0)[0] = 1.0; // +full scale
    buf.getChannelData(0)[1] = -1.0; // -full scale (second frame, ch0)
    const view = new DataView(encodeWav(buf, 24));
    // frame 0, ch0 at offset 44: +full scale ≈ 0x7FFFFF
    expect(view.getUint8(44) | (view.getUint8(45) << 8) | (view.getUint8(46) << 16)).toBe(0x7fffff);
    // frame 1, ch0 at offset 44 + blockAlign(6): -full scale = 0x800000
    const o = 44 + 6;
    expect(view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getUint8(o + 2) << 16)).toBe(0x800000);
  });

  it('still defaults to 16-bit', () => {
    const view = new DataView(encodeWav(stubBuffer()));
    expect(view.getUint16(34, true)).toBe(16);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/encoders.test.mjs`
Expected: FAIL — 24-bit assertions fail (current `encodeWav` ignores the arg and writes 16-bit: `bits per sample` is 16, data size uses 2 bytes).

- [ ] **Step 3: Generalize `encodeWav` with a `bitDepth` arg**

In `src/encoders.js`, replace the entire `encodeWav` function with:

```js
// PCM RIFF/WAVE from an AudioBuffer-like. bitDepth 16 (default) or 24.
// (@strudel/webaudio has a 16-bit encoder but keeps it private — webaudio.mjs:120.)
export function encodeWav(buffer, bitDepth = 16) {
  const { numberOfChannels, sampleRate, length } = buffer;
  const channels = Array.from({ length: numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numberOfChannels * bytesPerSample;
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
  view.setUint16(34, bitDepth, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  let off = 44;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < numberOfChannels; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      if (bitDepth === 16) {
        view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        off += 2;
      } else {
        // 24-bit: no DataView.setInt24, so write 3 bytes little-endian two's-complement
        let v = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
        if (v < 0) v += 0x1000000;
        view.setUint8(off, v & 0xff);
        view.setUint8(off + 1, (v >> 8) & 0xff);
        view.setUint8(off + 2, (v >> 16) & 0xff);
        off += 3;
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/encoders.test.mjs`
Expected: PASS (existing 16-bit tests + 3 new 24-bit tests).

- [ ] **Step 5: Commit**

```bash
git add src/encoders.js test/encoders.test.mjs
git commit -m "feat: 24-bit PCM support in encodeWav (bitDepth arg)"
```

---

### Task 2: Dependency-free store-only ZIP writer

**Files:**
- Create: `src/zip.js`
- Test: `test/zip.test.mjs`

WAV audio barely compresses, so a STORE (uncompressed) zip is simplest and avoids a runtime dependency. Entries still need a correct CRC32 or unzip tools reject them.

- [ ] **Step 1: Write the failing test**

Create `test/zip.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipStore } from '../src/zip.js';

const bytes = (s) => new TextEncoder().encode(s);

describe('zipStore', () => {
  it('produces an archive that unzip validates and lists every entry', async () => {
    const zip = zipStore([
      { name: 'a.txt', data: bytes('hello stems') },
      { name: 'b.wav', data: new Uint8Array([0, 1, 2, 3, 255, 254]) },
    ]);
    expect(zip).toBeInstanceOf(Uint8Array);

    const dir = await mkdtemp(join(tmpdir(), 'zip-'));
    const path = join(dir, 'out.zip');
    await writeFile(path, zip);
    try {
      // `unzip -t` validates CRCs and structure; throws on a bad archive
      const test = execFileSync('unzip', ['-t', path], { encoding: 'utf8' });
      expect(test).toMatch(/No errors detected/);
      // extract and compare a member byte-for-byte
      execFileSync('unzip', ['-o', path, '-d', dir], { stdio: 'ignore' });
      expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('hello stems');
      expect([...(await readFile(join(dir, 'b.wav')))]).toEqual([0, 1, 2, 3, 255, 254]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/zip.test.mjs`
Expected: FAIL — cannot resolve `../src/zip.js`.

- [ ] **Step 3: Implement `src/zip.js`**

Create `src/zip.js`:

```js
// Minimal STORE-only ZIP writer (no compression) — enough to bundle WAV stems
// without a runtime dependency. Each entry carries a real CRC32 so standard
// unzip tools (and Ableton's import) accept the archive.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// files: Array<{ name: string, data: Uint8Array }> -> Uint8Array (the .zip)
export function zipStore(files) {
  const enc = new TextEncoder();
  const local = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of files) {
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const size = data.length;

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); // local file header signature
    lh.setUint16(4, 20, true); // version needed
    lh.setUint16(6, 0, true); // flags
    lh.setUint16(8, 0, true); // method 0 = store
    lh.setUint16(10, 0, true); // mod time
    lh.setUint16(12, 0x21, true); // mod date = 1980-01-01
    lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true); // compressed size
    lh.setUint32(22, size, true); // uncompressed size
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true); // extra length
    local.push(new Uint8Array(lh.buffer), nameBytes, data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); // central dir header signature
    cd.setUint16(4, 20, true); // version made by
    cd.setUint16(6, 20, true); // version needed
    cd.setUint16(8, 0, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, 0, true);
    cd.setUint16(14, 0x21, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, size, true);
    cd.setUint32(24, size, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint16(30, 0, true); // extra length
    cd.setUint16(32, 0, true); // comment length
    cd.setUint16(34, 0, true); // disk number
    cd.setUint16(36, 0, true); // internal attrs
    cd.setUint32(38, 0, true); // external attrs
    cd.setUint32(42, offset, true); // local header offset
    central.push(new Uint8Array(cd.buffer), nameBytes);

    offset += 30 + nameBytes.length + size;
  }

  const centralStart = offset;
  const centralSize = central.reduce((n, p) => n + p.length, 0);

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true); // end of central directory signature
  eocd.setUint16(4, 0, true); // disk number
  eocd.setUint16(6, 0, true); // central dir start disk
  eocd.setUint16(8, files.length, true); // entries on this disk
  eocd.setUint16(10, files.length, true); // total entries
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, centralStart, true);
  eocd.setUint16(20, 0, true); // comment length

  const parts = [...local, ...central, new Uint8Array(eocd.buffer)];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/zip.test.mjs`
Expected: PASS — `unzip -t` reports "No errors detected" and extracted members match byte-for-byte.

- [ ] **Step 5: Commit**

```bash
git add src/zip.js test/zip.test.mjs
git commit -m "feat: dependency-free store-only zip writer (src/zip.js)"
```

---

### Task 3: Group haps by sound name

**Files:**
- Modify: `src/export-spec.js`
- Test: `test/export-haps.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `test/export-haps.test.mjs` (it already imports `evaluate`, `initStrudelEnv`, and has `patternOf` + `beforeAll(initStrudelEnv)`). Add `groupHapsBySound` and `collectHaps` to the existing import from `../src/export-spec.js`, then add:

```js
describe('groupHapsBySound', () => {
  it('splits a multi-sound stack into one group per sound, sorted by name', async () => {
    const pattern = await patternOf('stack(s("bd*4"), s("hh*8"), note("c2 g1").s("sawtooth"))');
    const haps = collectHaps(pattern, 4, 0.5);
    const groups = groupHapsBySound(haps);
    expect(groups.map((g) => g.name)).toEqual(['bd', 'hh', 'sawtooth']);
    // every hap is accounted for, none duplicated
    expect(groups.reduce((n, g) => n + g.haps.length, 0)).toBe(haps.length);
    // each group only contains its own sound
    for (const g of groups) {
      expect(g.haps.every((h) => (h.value?.s ?? 'synth') === g.name)).toBe(true);
    }
  });

  it('merges layers that share a sound into one group', async () => {
    const pattern = await patternOf('stack(note("c2").s("sawtooth"), note("c4").s("sawtooth"))');
    const groups = groupHapsBySound(collectHaps(pattern, 2, 0.5));
    expect(groups.map((g) => g.name)).toEqual(['sawtooth']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/export-haps.test.mjs`
Expected: FAIL — `groupHapsBySound` is not exported.

- [ ] **Step 3: Implement `groupHapsBySound`**

Append to `src/export-spec.js`:

```js
// The stem key for a hap: its sound name (`s`), falling back to 'synth' for
// note-only haps with no explicit sound. A track normally uses one drum bank,
// so the bare sound name is a stable per-instrument key across the arrangement.
export function stemName(hap) {
  const v = hap.value;
  return v && typeof v === 'object' && typeof v.s === 'string' ? v.s : 'synth';
}

// Group onset haps by sound into [{ name, haps }], sorted by name for
// deterministic stem ordering/filenames. Used to render one WAV per sound.
export function groupHapsBySound(haps) {
  const groups = new Map();
  for (const hap of haps) {
    const key = stemName(hap);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(hap);
  }
  return [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, hs]) => ({ name, haps: hs }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/export-haps.test.mjs`
Expected: PASS (existing collectHaps tests + 2 new grouping tests).

- [ ] **Step 5: Commit**

```bash
git add src/export-spec.js test/export-haps.test.mjs
git commit -m "feat: groupHapsBySound — per-sound hap grouping for stem export"
```

---

### Task 4: `renderStemsZip` in the render engine

**Files:**
- Modify: `src/render.js`

Browser-only (uses `OfflineAudioContext`); verified end-to-end in Task 6. The existing Node tests in `test/render.test.mjs` (guards + the no-direct-superdough-import invariant) must still pass.

- [ ] **Step 1: Rewrite `src/render.js`**

Replace the **entire contents** of `src/render.js` with (keeps `renderTrack` behavior via a shared `renderHapsToBuffer`, adds `renderStemsZip`; still imports every superdough symbol only from `@strudel/webaudio`):

```js
import {
  setAudioContext,
  setSuperdoughAudioController,
  resetGlobalEffects,
  initAudio,
  webaudioOutput,
} from '@strudel/webaudio';
import { evaluate } from '@strudel/transpiler';
import { exportSpec, collectHaps, groupHapsBySound } from './export-spec.js';
import { encodeWav, encodeMp3 } from './encoders.js';
import { zipStore } from './zip.js';

const SAMPLE_RATE = 44100;
const sanitize = (s) => String(s).replace(/[^a-zA-Z0-9_-]+/g, '-');

async function evalPattern(track) {
  // setcpm/setcps exist only inside repls; the bare transpiler can't see them,
  // and exports derive cps from meta.bpm, so no-ops satisfy the reference
  // (??= so a repl-registered real one survives if present).
  globalThis.setcpm ??= () => {};
  globalThis.setcps ??= () => {};
  const { pattern } = await evaluate(track.code);
  if (typeof pattern?.queryArc !== 'function') {
    throw new Error('code did not evaluate to a pattern');
  }
  return pattern;
}

// Render a set of haps into a fresh, full-length OfflineAudioContext. Rebinds
// superdough to that context (null the controller so it rebuilds on `ctx`;
// everything imported from @strudel/webaudio keeps a SINGLE superdough instance
// — importing from `superdough/...` would create a second copy whose effect
// nodes live on a different context and fail to connect). Two renders of the
// same `seconds` produce time-aligned buffers (both start at t=0).
async function renderHapsToBuffer(haps, { cps, seconds }) {
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * SAMPLE_RATE), SAMPLE_RATE);
  setAudioContext(ctx);
  resetGlobalEffects();
  setSuperdoughAudioController(null);
  await initAudio();
  for (const hap of haps) {
    try {
      await webaudioOutput(hap, null, hap.duration / cps, cps, hap.whole.begin.valueOf() / cps);
    } catch (err) {
      console.warn('[export] hap skipped:', err.message);
    }
  }
  return ctx.startRendering();
}

// Render a track to a single mixed Blob (wav 16-bit or mp3).
export async function renderTrack(track, format) {
  const pattern = await evalPattern(track);
  const spec = exportSpec(track);
  const buffer = await renderHapsToBuffer(collectHaps(pattern, spec.cycles, spec.cps), spec);
  return format === 'wav'
    ? new Blob([encodeWav(buffer)], { type: 'audio/wav' })
    : new Blob(encodeMp3(buffer), { type: 'audio/mpeg' });
}

// Render one full-length, time-aligned 24-bit WAV per distinct sound, bundled
// into a single .zip. Each stem is the whole song length starting at bar 1, so
// dropping the folder into a DAW lines the parts up automatically.
export async function renderStemsZip(track) {
  const pattern = await evalPattern(track);
  const spec = exportSpec(track);
  const groups = groupHapsBySound(collectHaps(pattern, spec.cycles, spec.cps));
  const files = [];
  for (const { name, haps } of groups) {
    const buffer = await renderHapsToBuffer(haps, spec);
    files.push({
      name: `${sanitize(track.id)}-${sanitize(name)}.wav`,
      data: new Uint8Array(encodeWav(buffer, 24)),
    });
  }
  return new Blob([zipStore(files)], { type: 'application/zip' });
}
```

- [ ] **Step 2: Run the existing render + import-guard tests**

Run: `npx vitest run test/render.test.mjs`
Expected: PASS — the two guard tests still throw before any audio API, and the "never imports superdough directly" guard still holds (`render.js` imports superdough symbols only via `@strudel/webaudio`; `./zip.js` and `./export-spec.js` are local).

- [ ] **Step 3: Run the full suite**

Run: `npx vitest run`
Expected: ALL PASS.

- [ ] **Step 4: Commit**

```bash
git add src/render.js
git commit -m "feat: renderStemsZip — per-sound 24-bit aligned WAVs zipped"
```

---

### Task 5: Wire the `↓ stems` button (iframe dispatch, download name, crate-only button)

**Files:**
- Modify: `src/export-render.js`
- Modify: `src/export.js`
- Modify: `src/app.js`
- Modify: `src/main.js`

- [ ] **Step 1: Dispatch the `stems` format in the iframe**

In `src/export-render.js`, it imports `renderTrack` and calls it in the message handler. Update the import and the call.

Change the import line:
```js
import { renderTrack } from './render.js';
```
to:
```js
import { renderTrack, renderStemsZip } from './render.js';
```

In the `message` handler, replace the line that computes the blob:
```js
    const blob = await renderTrack(track, format);
```
with:
```js
    const blob = format === 'stems' ? await renderStemsZip(track) : await renderTrack(track, format);
```

(If `export-render.js` currently inlines `renderTrack(track, format)` directly inside `parent.postMessage`, hoist it to a `const blob = …` first; the surrounding `await ready` / try-catch / `postMessage({type:'done', id, blob})` stays unchanged.)

- [ ] **Step 2: Name the stems download `<id>-stems.zip`**

In `src/export.js`, replace line 48:
```js
    download(blob, `${track.id}.${format}`);
```
with:
```js
    download(blob, format === 'stems' ? `${track.id}-stems.zip` : `${track.id}.${format}`);
```

- [ ] **Step 3: Add the `splitStems` option + `↓ stems` button in `app.js`**

In `src/app.js`, change the `initApp` signature (line 14):
```js
export async function initApp({ apiBase, emptyHint }) {
```
to:
```js
export async function initApp({ apiBase, emptyHint, splitStems = false }) {
```

Then change the export-button format list (line 253):
```js
      for (const fmt of ['wav', 'mp3']) {
```
to:
```js
      for (const fmt of splitStems ? ['wav', 'mp3', 'stems'] : ['wav', 'mp3']) {
```

And update the button label + title so `stems` reads sensibly. Replace these two lines inside the loop:
```js
        btn.textContent = `↓ ${fmt}`;
        btn.title = fmt === 'wav' ? 'download lossless wav' : 'download mp3 192kbps';
```
with:
```js
        btn.textContent = `↓ ${fmt}`;
        btn.title =
          fmt === 'wav'
            ? 'download lossless wav'
            : fmt === 'mp3'
              ? 'download mp3 192kbps'
              : 'download per-sound 24-bit stems (zip)';
```

(The click handler already calls `exportTrack(track, fmt, { onStatus })`, which now carries `fmt === 'stems'` through to the iframe — no other change needed.)

- [ ] **Step 4: Enable stems on the crate page only**

In `src/main.js`, change the `initApp` call to pass `splitStems: true`:
```js
import { initApp } from './app.js';

initApp({
  apiBase: '/api/tracks',
  emptyHint: 'generate some tracks: <code>/generate-tracks "dark techno" 12</code>',
  splitStems: true,
}).catch((err) => console.error('initApp failed', err));
```

Leave `src/stems.js` unchanged (it omits `splitStems`, so it defaults to `false` — no stems button on the single-sound /stems page).

- [ ] **Step 5: Verify suite + build**

Run: `npx vitest run`
Expected: ALL PASS (no Node test imports the rewritten browser modules).

Run: `npm run build`
Expected: build succeeds; `dist/index.html`, `dist/stems.html`, `dist/export-render.html` all present.

- [ ] **Step 6: Commit**

```bash
git add src/export-render.js src/export.js src/app.js src/main.js
git commit -m "feat: ↓ stems button — per-sound 24-bit WAV zip on crate tracks"
```

---

### Task 6: End-to-end browser verification

**Files:**
- None (verification only)

Uses the isolated-server recipe (API `PORT=3105`, vite `5277` with `API_PROXY`), never the user's `:3001`/`:5173`. Python Playwright at `/usr/local/opt/python@3.11/bin/python3.11`; `unzip` CLI for archive validation.

- [ ] **Step 1: Start the isolated server pair (from the repo root)**

```bash
for p in 3105 5277; do pids=$(lsof -ti :$p); [ -n "$pids" ] && kill $pids; done
sleep 1
(PORT=3105 node server/index.mjs >/tmp/stem-api.log 2>&1 &)
(API_PROXY=http://localhost:3105 npx vite --port 5277 --strictPort >/tmp/stem-vite.log 2>&1 &)
sleep 4
curl -s -o /dev/null -w "vite:%{http_code}\n" http://localhost:5277/
```

Expected: `vite:200`.

- [ ] **Step 2: Write `/tmp/stem-verify.py`**

Splits a real multi-sound DNB track, downloads the zip, unzips it, and asserts: ≥2 stems, each a 24-bit WAV, every stem has audio, all stems share one length (aligned), and playback was not interrupted. Then confirms the /stems page shows NO stems button.

```python
from playwright.sync_api import sync_playwright
import base64, struct, subprocess, tempfile, os, glob

TRACK = '2026-04-... '  # replaced below with a real id fetched from the API

def wav_info(path):
    d = open(path, 'rb').read()
    assert d[:4] == b'RIFF' and d[8:12] == b'WAVE', 'not a WAV'
    bits = struct.unpack('<H', d[34:36])[0]
    i = d.find(b'data'); sz = struct.unpack('<I', d[i+4:i+8])[0]
    pcm = d[i+8:i+8+sz]
    # peak over 24- or 16-bit frames
    step = bits // 8
    peak = 0
    for off in range(0, len(pcm) - step + 1, step):
        if bits == 24:
            v = pcm[off] | (pcm[off+1] << 8) | (pcm[off+2] << 16)
            if v & 0x800000: v -= 0x1000000
            peak = max(peak, abs(v) / 0x800000)
        else:
            v = struct.unpack('<h', pcm[off:off+2])[0]
            peak = max(peak, abs(v) / 0x8000)
    return bits, sz, peak

with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page()
    pg.goto('http://localhost:5277/'); pg.wait_for_selector('#status.ready', timeout=60000)
    pg.wait_for_selector('.track', timeout=20000)
    # pick a real multi-sound track id from the API
    tid = pg.evaluate("""async()=>{const ts=await(await fetch('/api/tracks')).json();
      const t=ts.find(x=>/arrange/.test(x.code)) || ts[0]; return t.id;}""")
    card = pg.locator('.track', has=pg.locator(f'.id:text("{tid}")')).first

    # start playback to confirm it survives the export
    card.locator('button.play').click()
    pg.wait_for_selector('.track.playing', timeout=15000); pg.wait_for_timeout(1500)
    np = pg.inner_text('#now-playing')

    # click the stems button (3rd export button)
    with pg.expect_download(timeout=180000) as d:
        card.locator('button.export', has_text='stems').click()
    assert pg.locator('.track.playing').count() == 1, 'playback stopped during stem export'
    assert pg.inner_text('#now-playing') == np, 'now-playing changed during export'

    dl = tempfile.mkdtemp()
    zip_path = os.path.join(dl, 'stems.zip'); d.value.save_as(zip_path)
    test = subprocess.run(['unzip', '-t', zip_path], capture_output=True, text=True)
    assert 'No errors detected' in test.stdout, f'bad zip: {test.stdout}{test.stderr}'
    subprocess.run(['unzip', '-o', zip_path, '-d', dl], check=True, capture_output=True)
    wavs = sorted(glob.glob(os.path.join(dl, '*.wav')))
    assert len(wavs) >= 2, f'expected multiple stems, got {wavs}'
    infos = [wav_info(w) for w in wavs]
    for w, (bits, sz, peak) in zip(wavs, infos):
        print(f'{os.path.basename(w):40s} {bits}-bit peak={peak:.3f}')
        assert bits == 24, f'{w} not 24-bit'
        assert peak > 0.001, f'{w} is silent'
    lengths = {sz for _, sz, _ in infos}
    assert len(lengths) == 1, f'stems not aligned (differing lengths): {lengths}'

    # /stems page must NOT show a stems button
    pg.goto('http://localhost:5277/stems'); pg.wait_for_selector('.track', timeout=20000)
    assert pg.locator('button.export', has_text='stems').count() == 0, 'stems button leaked onto /stems page'

    print(f'STEMS OK — {len(wavs)} aligned 24-bit stems, playback uninterrupted')
    b.close()
```

- [ ] **Step 3: Run the verification**

Run: `/usr/local/opt/python@3.11/bin/python3.11 /tmp/stem-verify.py`
Expected: prints each stem (24-bit, peak > 0), then `STEMS OK — N aligned 24-bit stems, playback uninterrupted`. If any assertion fails, STOP and debug (do not weaken assertions).

- [ ] **Step 4: Tear down + confirm clean tree**

```bash
for p in 3105 5277; do pids=$(lsof -ti :$p); [ -n "$pids" ] && kill $pids; done
rm -f /tmp/stem-verify.py
```

Run: `for p in 3001 5173; do echo "port $p: $(lsof -ti :$p | tr '\n' ' ')"; done`
Expected: the user's `:3001`/`:5173` still listed; `:3105`/`:5277` empty.

Run: `git status --short`
Expected: no stray files; all task commits already made.

---

## Self-Review

**1. Spec coverage:**
- 24-bit WAV → Task 1 (`encodeWav(buffer, 24)`) ✓
- Per-sound grouping → Task 3 (`groupHapsBySound`) ✓
- Full-length + aligned stems → Task 4 (`renderHapsToBuffer` uses the same `spec.seconds` for every stem → identical buffer length from t=0) ✓
- Zip bundle → Task 2 (`zipStore`) + Task 4 (`renderStemsZip`) ✓
- Crate-only `↓ stems` button, not on /stems → Task 5 (`splitStems` flag; `main.js` true, `stems.js` default false) + Task 6 (asserts no button on /stems) ✓
- Playback uninterrupted → reuses the hidden-iframe engine; orchestrator/app paths never touch the live context; Task 6 asserts `.playing` survives ✓
- Single superdough instance preserved → Task 4 imports only from `@strudel/webaudio`; `render.test.mjs` import-guard still applies ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output. The `TRACK` placeholder in the Python script is explicitly replaced at runtime by fetching a real id from `/api/tracks` (the `tid = pg.evaluate(...)` line). ✓

**3. Type/signature consistency:**
- `encodeWav(buffer, bitDepth = 16)` — defined Task 1, called with `24` in Task 4 `renderStemsZip`, called with default in `renderTrack`. ✓
- `zipStore(files: {name, data}[])` — defined Task 2, called in Task 4 with `{ name, data: Uint8Array }`. ✓
- `groupHapsBySound(haps) → {name, haps}[]` — defined Task 3, consumed in Task 4. ✓
- `renderStemsZip(track) → Promise<Blob>` — defined Task 4, called in Task 5 `export-render.js`. ✓
- Format string `'stems'` consistent across `app.js` (button) → `exportTrack(track,'stems',…)` → `export.js` (download name) → iframe `{format}` → `export-render.js` dispatch. ✓
- `initApp({ apiBase, emptyHint, splitStems })` — defined Task 5, `main.js` passes `splitStems: true`, `stems.js` omits it (false). ✓
