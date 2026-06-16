# Transport timeline + seek — design

Date: 2026-06-15
Status: approved, pre-implementation

## Problem

Playback today is play/stop only (`src/app.js:117-135`). You can't see how far into a
track you are, and you can't skip ahead to hear a later section — `stop()` always resets
to cycle 0. Strudel runs a generative `Cyclist` scheduler over an infinite cycle counter,
so there is no rendered timeline to scrub; but because a pattern is a deterministic
function of the cycle number, "jump to N seconds in" is well-defined as "re-anchor the
clock to cycle N".

## Goal

Add to the existing `#transport` footer a position readout + click/drag-seekable progress
bar, bound to the currently-playing track (solo model — only one track plays at a time).

Out of scope (v1): keyboard nudge, per-card scrubbers, scrubbing the rendered export
buffer, true DAW back/forward transport beyond the single seek primitive.

## Behavior

- Scrubber shows `elapsed ▕████░░░▏ total` (mm:ss either side) and seeks anywhere on the
  bar via pointer (click = degenerate drag). Forward and backward both work.
- Hidden when nothing is playing, and hidden for any playing track whose total length
  can't be computed (e.g. a stem with no `bpm`).
- On loop: the pattern repeats at `cycles`, but the bar **pins at 100%** and the elapsed
  time stops counting; audio keeps looping underneath. (Accepted desync — chosen over a
  looping bar.)
- Pointer-only. No keyboard interaction in v1.

## Mechanism

### Why seek is feasible

The `Cyclist` derives each query window from `lastEnd` plus a per-tick re-anchor: on the
first tick after `num_ticks_since_cps_change` resets to 0 it sets
`num_cycles_at_cps_change = lastEnd` and `seconds_at_cps_change = phase`
(`cyclist.mjs:38-49`). An onset's wall-clock time is
`(hap.whole.begin - num_cycles_at_cps_change)/cps + seconds_at_cps_change + latency`
(`cyclist.mjs:64-65`). So setting `lastEnd = N` and `num_ticks_since_cps_change = 0` makes
the next tick treat cycle N as "now" — playback re-anchors in place, no stop, no re-eval,
the AudioContext keeps running.

Confirmed the live scheduler is `Cyclist`, not `NeoCyclist`: `repl.mjs:76` only picks
`NeoCyclist` when `sync: true` **and** `SharedWorker` exists; `editor.js` passes neither.
The seek primitive still feature-detects the Cyclist fields and no-ops otherwise, so a
future scheduler swap degrades to display-only rather than breaking.

**Caveat (carried, not fixed):** events whose onset preceded the target cycle — long
reverb tails, held notes, slow envelopes spanning cycles — won't be retroactively audible
after a seek. Output is deterministic/correct for cycle N onward, just not "warmed up".

### Total length

Reuse `exportSpec(track)` (`src/export-spec.js:16-20`), already the source of truth for
export length: `cps = bpm/240`, `cycles` parsed from the `arrange()` weights (default 32),
`seconds = cycles/cps`. The live pattern loops at `cycles`, so the bar against
`spec.seconds` is exactly accurate. `export-spec.js` is a pure module (no DOM/audio deps),
safe to import into `app.js`.

## Components

### `src/editor.js` — seek primitive (2 new exports)

```js
export function cyclePosition(trackId) {        // current cycle, or null if unavailable
  const s = editors.get(trackId)?.repl.scheduler;
  return s?.started && typeof s.now === 'function' ? s.now() : null;
}

export function seekEditor(trackId, cycle) {     // re-anchor playback to `cycle`, in place
  const s = editors.get(trackId)?.repl.scheduler;
  if (!s || !('lastEnd' in s)) return false;     // feature-detect Cyclist
  s.lastEnd = Math.max(0, cycle);
  s.num_ticks_since_cps_change = 0;
  return true;
}
```

This reaches into `repl.scheduler`, the same private surface `isStarted` already uses
(`editor.js:10`).

### `src/app.js` — position loop, seek interaction, transport toggle

- On `play(track)`: `state.playingSpec = exportSpec(track)`. If `seconds` is not a finite
  positive number, leave the scrubber hidden (still plays, just no timeline).
- `requestAnimationFrame` loop runs only while `state.playingId` is set:
  `elapsed = cyclePosition(id) / spec.cps`, `fill = min(elapsed / spec.seconds, 1)`,
  update fill width + the two time labels. Cancel the rAF handle in `stop()` and whenever
  `playingId` clears (including the error path in `onEditorError`).
- Pointer handlers on the rail: `pointerdown` → set scrubbing flag + `setPointerCapture`;
  `pointermove` while down and `pointerup` → `fraction = clamp((clientX - rect.left)/rect.width, 0, 1)`,
  `targetCycle = fraction * spec.cycles`, `seekEditor(playingId, targetCycle)`, paint the
  bar to `fraction` immediately. While the scrubbing flag is set the rAF updater yields to
  the drag; it resumes on `pointerup`.
- `renderTransport()` toggles the scrubber's `hidden` next to the existing `#now-playing` /
  `#stop` updates: shown iff a track is playing AND `state.playingSpec.seconds` is finite > 0.

### `index.html` + `stems.html` — markup (both boot through `initApp`)

Inside `#transport`, namespaced classes to avoid colliding with the `.track` card class:

```html
<div id="seekbar" class="seekbar" hidden>
  <span id="elapsed">0:00</span>
  <div id="seek-rail" class="seek-rail" role="slider" aria-label="seek">
    <div id="seek-fill" class="seek-fill"></div>
  </div>
  <span id="total">0:00</span>
</div>
```

### `src/style.css`

Style `.seekbar` / `.seek-rail` / `.seek-fill` to match the existing transport footer.

## Testing

- Unit (pure functions, extracted so they're testable without a DOM/AudioContext):
  - `mmss(seconds)` formatter — including `0`, sub-minute, multi-minute.
  - `fractionToCycle(fraction, cycles)` and the `elapsed/seconds` clamp math (clamps to 1,
    never negative, NaN spec → hidden).
- Integration (browser, Playwright recipe from project memory — needs live AudioContext):
  play a track, assert the fill advances; click near the end of the rail and assert
  `cyclePosition` jumps forward; click near the start and assert it jumps back.

## Risk / coupling

- Depends on `repl.scheduler` private fields. Precedent: `isStarted` already does. Mitigated
  by feature-detection in `seekEditor`/`cyclePosition`.
- `exportSpec` assumes `track.meta.bpm`; missing/zero bpm → non-finite `seconds` → scrubber
  stays hidden (graceful). Stems may lack bpm; that is the expected hidden case.

## Files touched

`src/editor.js`, `src/app.js`, `src/export-spec.js` (import only), `index.html`,
`stems.html`, `src/style.css`, one new unit-test file.
