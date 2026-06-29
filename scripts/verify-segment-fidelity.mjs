// Segment-render fidelity harness.
//
// Validates that splitting a track into time-segments (with a warm-up lead-in)
// and stitching the PCM back together produces audio indistinguishable — within
// Web Audio's inherent non-determinism — from a single whole-track render.
//
// WHY THIS SHAPE: the render path is browser-only (OfflineAudioContext, superdough)
// and Web Audio output is non-deterministic between identical renders, so there is
// no Node/vitest assertion that can cover it. The gate is therefore a browser
// measurement with a tolerance keyed to the inherent single-vs-single noise floor.
// Fidelity depends only on the segmentation/warm-up math, NOT on the iframe-pool
// parallelism, so we render segments sequentially in ONE realm here — each
// renderSegment() is independent of which realm runs it.
//
// HOW TO RUN (no extra npm deps; uses the project's Vite dev server + a browser):
//   1. From this worktree:  npx vite --port 5180 --strictPort
//   2. Open http://localhost:5180/export-render.html in a browser (or drive it
//      with the Playwright MCP) and evaluate `measureSegmentFidelity` below in the
//      page context. It dynamically imports the real src modules from the dev
//      server, so it exercises the exact production code path.
//
// PASS CRITERIA: segmentedRms <= FIDELITY_FACTOR * baselineRms + ABS_FLOOR, and
// the segmented output length equals the single-render length exactly (sample-exact
// tiling). If it fails: raise WARMUP_SECONDS in src/segment.js callers, reduce the
// segment count, and re-measure — do NOT ship a failing gate.
//
// RECORDED RESULT (2026-06-29, 4-way split, RolandTR909 + sawtooth w/ room(0.4)+delay(0.35)):
//   baselineRms 0.008864 | segmentedRms 0.009054 | ratio 1.02 | lengths match → PASS

export const FIDELITY_FACTOR = 6;   // segmented may deviate up to 6x the single-vs-single baseline
export const ABS_FLOOR = 0.02;      // ...plus an absolute floor for near-silent baselines

// A representative track that stresses the boundary case: a long reverb (room) and
// a feedback delay whose tails cross segment boundaries.
export const FIDELITY_TRACK = {
  id: 'fidelity',
  code: 'setcpm(130/4)\nstack(\n  s("bd*4").bank("RolandTR909").gain(1.1),\n  s("~ cp ~ cp").bank("RolandTR909").room(0.4),\n  note("<c2 c2 eb2 g1>*8").s("sawtooth").lpf(sine.slow(4).range(200,1800)).resonance(12).decay(0.12).sustain(0).gain(0.8).delay(0.35)\n)',
  meta: { bpm: 130 },
};

// Run inside the export-render.html page context (parent === self). Resolves to a
// metrics object; throws if the segmented output deviates beyond tolerance.
export async function measureSegmentFidelity(track = FIDELITY_TRACK, segmentCount = 4, origin = '') {
  // Wait for export-render.js to finish registering sample banks.
  await new Promise((resolve) => {
    let done = false;
    const h = (e) => { if (e.data?.type === 'ready') { done = true; removeEventListener('message', h); resolve(); } };
    addEventListener('message', h);
    setTimeout(() => { if (!done) resolve(); }, 15000);
  });
  const { renderSegment } = await import(`${origin}/src/render.js`);
  const { segmentPlan, concatSegmentPCM } = await import(`${origin}/src/segment.js`);
  const { exportSpec } = await import(`${origin}/src/export-spec.js`);
  const spec = exportSpec(track);

  const renderWhole = async () => {
    const plan = segmentPlan(spec, 1, 4);
    return concatSegmentPCM([await renderSegment(track, plan.segments[0])], plan).getChannelData(0);
  };
  const renderSegmented = async (n) => {
    const plan = segmentPlan(spec, n, 4);
    const parts = [];
    for (const seg of plan.segments) parts.push(await renderSegment(track, seg)); // sequential, one realm
    parts.sort((a, b) => a.index - b.index);
    return concatSegmentPCM(parts, plan).getChannelData(0);
  };
  const rms = (a, b) => { const n = Math.min(a.length, b.length); let s = 0; for (let i = 0; i < n; i++) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s / n); };

  const A = await renderWhole();
  const B = await renderWhole();              // single-vs-single baseline
  const S = await renderSegmented(segmentCount);
  const baselineRms = rms(A, B);
  const segmentedRms = rms(A, S);
  const threshold = FIDELITY_FACTOR * baselineRms + ABS_FLOOR;
  const ok = A.length === S.length && segmentedRms <= threshold;
  const result = { lenMatch: A.length === S.length, baselineRms, segmentedRms, ratio: segmentedRms / (baselineRms || 1e-9), threshold, ok };
  if (!ok) throw new Error(`segment fidelity FAIL: ${JSON.stringify(result)} — DO NOT SHIP`);
  return result;
}
