# Transport Timeline + Seek Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a click/drag-seekable progress bar to the `#transport` footer that shows elapsed/total time for the currently-playing track and lets you jump to any point.

**Architecture:** All pure logic (time formatting, fraction↔cycle math, and the scheduler-poking glue) lives in a new `src/transport.js` so it unit-tests without a DOM or AudioContext. `src/editor.js` gains two thin wrappers that resolve a track id to its live `Cyclist` and delegate to the pure glue. `src/app.js` owns the DOM: a `requestAnimationFrame` loop drives the bar while playing, and pointer handlers on the rail seek by re-anchoring the Cyclist in place (set `lastEnd`, reset the tick counter — no stop/re-eval). Total length comes from the existing `exportSpec()`.

**Tech Stack:** Vanilla ES modules, Vitest (`test/*.test.mjs`), Strudel `@strudel/codemirror` + `@strudel/core` `Cyclist`.

**Spec:** `docs/superpowers/specs/2026-06-15-transport-timeline-seek-design.md`

---

### Task 1: Pure transport helpers (`src/transport.js`)

**Files:**
- Create: `src/transport.js`
- Test: `test/transport.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/transport.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import {
  mmss,
  hasTimeline,
  fractionToCycle,
  progressFraction,
  readCycle,
  applySeek,
} from '../src/transport.js';

describe('mmss', () => {
  it('formats whole minutes and seconds', () => {
    expect(mmss(72)).toBe('1:12');
    expect(mmss(5)).toBe('0:05');
    expect(mmss(605)).toBe('10:05');
    expect(mmss(0)).toBe('0:00');
  });
  it('clamps non-finite and negative to 0:00', () => {
    expect(mmss(-3)).toBe('0:00');
    expect(mmss(NaN)).toBe('0:00');
    expect(mmss(Infinity)).toBe('0:00');
  });
});

describe('hasTimeline', () => {
  it('is true only for a finite positive total', () => {
    expect(hasTimeline({ seconds: 228 })).toBe(true);
    expect(hasTimeline({ seconds: 0 })).toBe(false);
    expect(hasTimeline({ seconds: NaN })).toBe(false);
    expect(hasTimeline(null)).toBe(false);
  });
});

describe('fractionToCycle', () => {
  it('maps a 0..1 position onto cycles, clamping the fraction', () => {
    expect(fractionToCycle(0.5, 32)).toBe(16);
    expect(fractionToCycle(1.5, 32)).toBe(32);
    expect(fractionToCycle(-1, 32)).toBe(0);
  });
});

describe('progressFraction', () => {
  it('is cycle/cycles clamped to [0,1]', () => {
    expect(progressFraction(16, 32)).toBe(0.5);
    expect(progressFraction(40, 32)).toBe(1);
    expect(progressFraction(-4, 32)).toBe(0);
  });
  it('returns 0 for a degenerate total', () => {
    expect(progressFraction(4, 0)).toBe(0);
  });
});

describe('readCycle', () => {
  it('returns the cycle of a running scheduler', () => {
    expect(readCycle({ started: true, now: () => 4.2 })).toBe(4.2);
  });
  it('returns null when stopped or unavailable', () => {
    expect(readCycle({ started: false, now: () => 4.2 })).toBe(null);
    expect(readCycle({ started: true })).toBe(null);
    expect(readCycle(null)).toBe(null);
  });
});

describe('applySeek', () => {
  it('re-anchors a Cyclist-like scheduler in place', () => {
    const s = { lastEnd: 3, num_ticks_since_cps_change: 5 };
    expect(applySeek(s, 10)).toBe(true);
    expect(s.lastEnd).toBe(10);
    expect(s.num_ticks_since_cps_change).toBe(0);
  });
  it('clamps a negative target to 0', () => {
    const s = { lastEnd: 3, num_ticks_since_cps_change: 5 };
    applySeek(s, -2);
    expect(s.lastEnd).toBe(0);
  });
  it('no-ops on a non-Cyclist scheduler', () => {
    expect(applySeek({}, 10)).toBe(false);
    expect(applySeek(null, 10)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/transport.test.mjs`
Expected: FAIL — cannot resolve `../src/transport.js`.

- [ ] **Step 3: Write the implementation**

Create `src/transport.js`:

```js
// Pure transport/seek helpers — no DOM, no AudioContext — so they unit-test
// directly. The glue that resolves a track id to its live scheduler lives in
// editor.js; the rAF loop and pointer handling live in app.js.

const clamp01 = (n) => Math.min(1, Math.max(0, n));

// "m:ss" — e.g. mmss(72) === "1:12". Non-finite/negative collapses to "0:00".
export function mmss(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// A track has a seekable timeline only if exportSpec produced a real length.
export function hasTimeline(spec) {
  return !!spec && Number.isFinite(spec.seconds) && spec.seconds > 0;
}

// Map a 0..1 rail position to a cycle (fraction clamped first).
export function fractionToCycle(fraction, cycles) {
  return clamp01(fraction) * cycles;
}

// How far along the bar a cycle is, clamped to [0,1] — the bar pins at 100%
// once the pattern loops past `cycles`.
export function progressFraction(cycle, cycles) {
  if (!Number.isFinite(cycle) || !(cycles > 0)) return 0;
  return clamp01(cycle / cycles);
}

// --- scheduler-pure glue (operates on a Cyclist-like object) ----------------

// Current cycle of a running scheduler, or null when unavailable (stopped, or a
// scheduler without now()).
export function readCycle(scheduler) {
  return scheduler && scheduler.started && typeof scheduler.now === 'function'
    ? scheduler.now()
    : null;
}

// Re-anchor a Cyclist to `cycle` in place: the next tick treats `cycle` as now
// (cyclist.mjs sets num_cycles_at_cps_change = lastEnd on the first tick after
// num_ticks_since_cps_change resets). Feature-detects the Cyclist fields and
// no-ops (returns false) on any other scheduler.
export function applySeek(scheduler, cycle) {
  if (!scheduler || !('lastEnd' in scheduler)) return false;
  scheduler.lastEnd = Math.max(0, cycle);
  scheduler.num_ticks_since_cps_change = 0;
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/transport.test.mjs`
Expected: PASS — all describe blocks green.

- [ ] **Step 5: Commit**

```bash
git add src/transport.js test/transport.test.mjs
git commit -m "feat: pure transport/seek helpers with unit tests"
```

---

### Task 2: Seek primitive wrappers (`src/editor.js`)

**Files:**
- Modify: `src/editor.js` (add import + two exports)

- [ ] **Step 1: Add the import**

In `src/editor.js`, add after the existing imports (after line 3):

```js
import { readCycle, applySeek } from './transport.js';
```

- [ ] **Step 2: Add the two wrapper exports**

In `src/editor.js`, immediately after the `isStarted` export (lines 9-10), add:

```js
// Current cycle of a track's running scheduler, or null if unavailable.
export const cyclePosition = (trackId) =>
  readCycle(editors.get(trackId)?.repl.scheduler ?? null);

// Re-anchor a track's playback to `cycle` (forward or backward), in place.
export const seekEditor = (trackId, cycle) =>
  applySeek(editors.get(trackId)?.repl.scheduler ?? null, cycle);
```

These reach into `repl.scheduler`, the same private surface `isStarted` (`editor.js:10`) already uses.

- [ ] **Step 3: Verify the module still parses and existing tests pass**

Run: `npx vitest run`
Expected: PASS — no test imports `editor.js` (it needs `@strudel/codemirror`), but the full run must stay green.

- [ ] **Step 4: Commit**

```bash
git add src/editor.js
git commit -m "feat: cyclePosition + seekEditor wrappers in editor.js"
```

---

### Task 3: Scrubber markup + styling

**Files:**
- Modify: `index.html` (inside `#transport`, lines 40-44)
- Modify: `stems.html` (inside `#transport`, lines 40-44)
- Modify: `src/style.css` (after the transport block, after line 172)

- [ ] **Step 1: Add the scrubber markup to `index.html`**

In `index.html`, replace the `#transport` block (currently):

```html
  <footer id="transport">
    <span id="status" class="status">warming up samples…</span>
    <span id="now-playing"></span>
    <button id="stop" disabled>■ STOP</button>
  </footer>
```

with:

```html
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
```

- [ ] **Step 2: Make the identical change to `stems.html`**

Apply the exact same replacement to the `#transport` block in `stems.html` (it is identical to `index.html`'s).

- [ ] **Step 3: Add the styling to `src/style.css`**

In `src/style.css`, after the `#stop:disabled` rule (line 172), add:

```css
.seekbar { flex: 1; display: flex; align-items: center; gap: 10px; min-width: 0; }
.seekbar[hidden] { display: none; } /* override display:flex; [hidden] alone won't hide a flex box */
.time {
  color: var(--dim); font-size: 11px; min-width: 36px;
  font-variant-numeric: tabular-nums;
}
.time:last-child { text-align: right; }
.seek-rail {
  flex: 1; height: 6px; background: var(--line);
  position: relative; cursor: pointer; touch-action: none;
}
.seek-fill { height: 100%; width: 0; background: var(--hot); pointer-events: none; }
```

(`#now-playing` keeps its `flex: 1` so the STOP button stays right-aligned when nothing is playing and the hidden scrubber takes no space.)

- [ ] **Step 4: Verify the build serves**

Run: `npm run build`
Expected: build completes with no errors (confirms both HTML files and the CSS still parse).

- [ ] **Step 5: Commit**

```bash
git add index.html stems.html src/style.css
git commit -m "feat: transport scrubber markup + styling"
```

---

### Task 4: Wire the scrubber into the app (`src/app.js`)

**Files:**
- Modify: `src/app.js` (imports; element refs + loop state; `play`; `stop`; `onEditorToggle`; `onEditorError`; `renderTransport`; boot wiring)

- [ ] **Step 1: Extend the imports**

In `src/app.js`, change the editor import (line 6) and add two more imports below it:

```js
import { mountEditor, getEditor, isStarted, cyclePosition, seekEditor } from './editor.js';
```

Then add after line 10 (`import banks ...`):

```js
import { exportSpec } from './export-spec.js';
import { mmss, hasTimeline, fractionToCycle, progressFraction } from './transport.js';
```

- [ ] **Step 2: Add scrubber state + element refs**

In `src/app.js`, the state object (line 15) is:

```js
  const state = { tracks: [], playingId: null, samplesReady: false, batch: 'all', filter: 'all' };
```

Replace it with:

```js
  const state = { tracks: [], playingId: null, playingSpec: null, samplesReady: false, batch: 'all', filter: 'all' };

  // scrubber DOM + loop state (elements exist in the footer of both pages)
  const seekbar = $('#seekbar');
  const rail = $('#seek-rail');
  const fill = $('#seek-fill');
  const elapsedEl = $('#elapsed');
  const totalEl = $('#total');
  let rafId = null;
  let scrubbing = false;
```

- [ ] **Step 3: Add the seek loop, paint, and pointer helpers**

In `src/app.js`, immediately BEFORE the `async function play(track)` declaration (line 117), insert:

```js
  // --- scrubber: rAF position loop + pointer seeking ------------------------
  function paintSeek(fraction, elapsedSeconds) {
    fill.style.width = `${(fraction * 100).toFixed(2)}%`;
    elapsedEl.textContent = mmss(elapsedSeconds);
    rail.setAttribute('aria-valuenow', Math.round(fraction * 100));
  }

  function startSeekLoop() {
    if (rafId != null) return;
    const tick = () => {
      rafId = requestAnimationFrame(tick);
      if (scrubbing || !hasTimeline(state.playingSpec)) return;
      const cycle = cyclePosition(state.playingId);
      if (cycle == null) return;
      const spec = state.playingSpec;
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

  function seekToPointer(e) {
    const spec = state.playingSpec;
    if (!hasTimeline(spec) || !state.playingId) return;
    const rect = rail.getBoundingClientRect();
    const fraction = rect.width ? (e.clientX - rect.left) / rect.width : 0;
    const clamped = Math.min(1, Math.max(0, fraction));
    seekEditor(state.playingId, fractionToCycle(clamped, spec.cycles));
    paintSeek(clamped, clamped * spec.seconds); // immediate feedback; loop is paused while scrubbing
  }
```

- [ ] **Step 4: Capture the spec and start the loop in `play()`**

In `src/app.js`, the `play` function (lines 117-128) is:

```js
  async function play(track) {
    state.playingId = track.id;
    updatePlayingUi();
    renderTransport();
    await ready; // audio context unlocks via this click
    if (state.playingId !== track.id) return; // user moved on while samples loaded
    await getAudioContext().resume(); // post-export contexts start suspended
    // editor mounts hidden inside the closed <details>; the user opens it
    // explicitly when they want to watch the code (keeps cards compact)
    const editor = ensureEditor(track);
    editor.evaluate();
  }
```

Replace it with:

```js
  async function play(track) {
    state.playingId = track.id;
    // exportSpec assumes track.meta.bpm; a stem without it throws → no timeline
    state.playingSpec = (() => {
      try {
        return exportSpec(track);
      } catch {
        return null;
      }
    })();
    updatePlayingUi();
    renderTransport();
    await ready; // audio context unlocks via this click
    if (state.playingId !== track.id) return; // user moved on while samples loaded
    await getAudioContext().resume(); // post-export contexts start suspended
    // editor mounts hidden inside the closed <details>; the user opens it
    // explicitly when they want to watch the code (keeps cards compact)
    const editor = ensureEditor(track);
    editor.evaluate();
    startSeekLoop();
  }
```

- [ ] **Step 5: Clear spec + stop the loop in `stop()`**

In `src/app.js`, the `stop` function (lines 130-135) is:

```js
  function stop() {
    getEditor(state.playingId)?.stop(); // onToggle clears state; next line covers the not-yet-evaluated case
    state.playingId = null;
    updatePlayingUi();
    renderTransport();
  }
```

Replace it with:

```js
  function stop() {
    getEditor(state.playingId)?.stop(); // onToggle clears state; next line covers the not-yet-evaluated case
    state.playingId = null;
    state.playingSpec = null;
    stopSeekLoop();
    updatePlayingUi();
    renderTransport();
  }
```

- [ ] **Step 6: Clear scrubber state on solo-stop and on error**

In `src/app.js`, `onEditorToggle` (lines 80-86) is:

```js
  function onEditorToggle(trackId, started) {
    const next = nextPlayingId(state.playingId, trackId, started);
    if (next === state.playingId) return;
    state.playingId = next;
    updatePlayingUi();
    renderTransport();
  }
```

Replace it with:

```js
  function onEditorToggle(trackId, started) {
    const next = nextPlayingId(state.playingId, trackId, started);
    if (next === state.playingId) return;
    state.playingId = next;
    if (!next) {
      state.playingSpec = null;
      stopSeekLoop();
    }
    updatePlayingUi();
    renderTransport();
  }
```

Then in `onEditorError` (lines 88-102), the phantom-state cleanup block is:

```js
    if (err && state.playingId === trackId && !isStarted(trackId)) {
      state.playingId = null;
      updatePlayingUi();
      renderTransport();
    }
```

Replace it with:

```js
    if (err && state.playingId === trackId && !isStarted(trackId)) {
      state.playingId = null;
      state.playingSpec = null;
      stopSeekLoop();
      updatePlayingUi();
      renderTransport();
    }
```

- [ ] **Step 7: Toggle scrubber visibility + total in `renderTransport()`**

In `src/app.js`, `renderTransport` (lines 368-374) is:

```js
  function renderTransport() {
    $('#status').textContent = state.samplesReady ? '● samples loaded' : '◌ warming up samples…';
    $('#status').classList.toggle('ready', state.samplesReady);
    const playing = state.tracks.find((t) => t.id === state.playingId);
    $('#now-playing').textContent = playing ? `NOW PLAYING — ${playing.title}` : '';
    $('#stop').disabled = !playing;
  }
```

Replace it with:

```js
  function renderTransport() {
    $('#status').textContent = state.samplesReady ? '● samples loaded' : '◌ warming up samples…';
    $('#status').classList.toggle('ready', state.samplesReady);
    const playing = state.tracks.find((t) => t.id === state.playingId);
    $('#now-playing').textContent = playing ? `NOW PLAYING — ${playing.title}` : '';
    $('#stop').disabled = !playing;
    const showSeek = !!playing && hasTimeline(state.playingSpec);
    seekbar.hidden = !showSeek;
    if (showSeek) totalEl.textContent = mmss(state.playingSpec.seconds);
  }
```

- [ ] **Step 8: Wire the pointer handlers at boot**

In `src/app.js`, the boot section starts (line 389) with:

```js
  $('#stop').addEventListener('click', stop);
```

Immediately after that line, add:

```js
  rail.addEventListener('pointerdown', (e) => {
    if (!hasTimeline(state.playingSpec)) return;
    scrubbing = true;
    rail.setPointerCapture(e.pointerId);
    seekToPointer(e);
  });
  rail.addEventListener('pointermove', (e) => {
    if (scrubbing) seekToPointer(e);
  });
  rail.addEventListener('pointerup', (e) => {
    if (!scrubbing) return;
    scrubbing = false;
    try {
      rail.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  });
```

- [ ] **Step 9: Run the full test suite + build**

Run: `npx vitest run && npm run build`
Expected: all tests PASS and the build completes with no errors.

- [ ] **Step 10: Commit**

```bash
git add src/app.js
git commit -m "feat: wire transport scrubber (position loop + pointer seek)"
```

---

### Task 5: Browser integration verification

**Files:** none (verification only)

This exercises the parts unit tests can't: a live `Cyclist`, the rAF loop, and real pointer seeking. Uses the Playwright browser-verification recipe from project memory (strudel-ai dev environment). Confirm the dev server's port first — a squatting worktree server on :3001 is a known false-failure source.

- [ ] **Step 1: Start the dev server from this checkout**

Run: `npm run dev` (note the port it prints; verify no other process is squatting it).

- [ ] **Step 2: Verify the bar advances while playing**

In a browser at the dev URL: click ▶ on a track with a `bpm` (a normal track on `index.html`). Confirm the scrubber appears in the footer, `total` shows a sane mm:ss, and the fill + `elapsed` advance over a few seconds.

- [ ] **Step 3: Verify forward seek**

Click near the right end of the rail. Confirm the audio jumps ahead (later section of the arrangement) and `elapsed` snaps to roughly that fraction of `total`.

- [ ] **Step 4: Verify backward seek + drag**

Click near the left end and confirm playback jumps back. Then press and drag across the rail and confirm the fill tracks the pointer and audio follows on release.

- [ ] **Step 5: Verify the hidden cases**

Press STOP and confirm the scrubber disappears and the fill resets to 0. On `stems.html`, play a stem that has no `bpm` and confirm playback still works with NO scrubber shown (graceful hide).

- [ ] **Step 6: Record the result**

Note pass/fail for each check. If all pass, the feature is verified; proceed to finishing the branch.

---

## Notes for the implementer

- **TDD applies to Task 1 only.** Tasks 2–4 are DOM/scheduler glue that can't run under Vitest (no `@strudel/codemirror`, no AudioContext); they're covered by the full-suite green check plus Task 5's browser verification. Do not invent jsdom tests for the rAF loop — verify it in the browser.
- **Do not change `#now-playing`'s `flex: 1`** — it is what right-aligns STOP when the scrubber is hidden.
- **The seek caveat is by design:** reverb tails / held notes that began before the seek target won't retro-sound. Don't try to "fix" it by re-evaluating the pattern.
