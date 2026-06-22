// Pure transport/seek helpers — no DOM, no AudioContext — so they unit-test
// directly. The glue that resolves a track id to its live scheduler lives in
// editor.js; the rAF loop and pointer handling live in app.js.

const clamp01 = (n) => Math.min(1, Math.max(0, n));

// "m:ss" — e.g. mmss(72) === "1:12". Seconds are truncated (floor), not rounded. Non-finite/negative collapses to "0:00".
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

// The arrangement has played through once the playhead reaches its length.
// Strudel's Cyclist loops the pattern forever, so the seek loop uses this to
// stop playback at the end instead of letting the audio replay past the
// duration shown on the progress bar. False for a degenerate/unknown timeline.
export function isFinished(cycle, cycles) {
  return Number.isFinite(cycle) && cycles > 0 && cycle >= cycles;
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
// no-ops (returns false) on any other scheduler. A real Cyclist always carries
// both `lastEnd` and `num_ticks_since_cps_change` together (set in its
// constructor), so the single `lastEnd` check is sufficient to cover both.
export function applySeek(scheduler, cycle) {
  if (!scheduler || !('lastEnd' in scheduler)) return false;
  scheduler.lastEnd = Math.max(0, cycle);
  scheduler.num_ticks_since_cps_change = 0;
  return true;
}
