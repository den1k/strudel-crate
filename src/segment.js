// Pure, Node-testable segment planning + PCM stitching for parallel export.
// No Web Audio here — this only computes sample-exact windows and concatenates
// Float32 PCM produced elsewhere.

// Split a render spec into `segmentCount` contiguous segments aligned to sample
// boundaries. Each segment renders from `warmupSeconds` before its kept region
// (clamped to the track start) so reverb/delay tails are populated before the
// kept audio begins; the warm-up samples are discarded after rendering.
export function segmentPlan(spec, segmentCount, warmupSeconds = 4, sampleRate = 44100) {
  const { cps, cycles } = spec;
  const cycleToSample = (c) => Math.round((c / cps) * sampleRate);
  // Match the single-iframe path's length exactly: renderHapsToBuffer sizes its
  // context as Math.ceil(seconds * SAMPLE_RATE) where seconds = cycles / cps. Use
  // the same ceil here so a track exports to an identical sample count whether it
  // takes the single or parallel path. Interior cycle boundaries stay on the
  // round() grid; only the final boundary is pinned to totalSamples (below), which
  // keeps tiling exact (kept lengths still sum to totalSamples).
  const totalSamples = Math.ceil((cycles / cps) * sampleRate);
  const warmupSamples = Math.round(warmupSeconds * sampleRate);
  const n = Math.max(1, Math.min(segmentCount, cycles));
  const segments = [];
  for (let i = 0; i < n; i++) {
    const startCycle = Math.floor((i * cycles) / n);
    const endCycle = Math.floor(((i + 1) * cycles) / n);
    if (endCycle <= startCycle) continue;
    const keepStartSample = cycleToSample(startCycle);
    // The segment ending the track ends exactly at totalSamples (ceil grid); all
    // others end on the round() grid. Keeps cross-path length identical AND tiling exact.
    const keepEndSample = endCycle === cycles ? totalSamples : cycleToSample(endCycle);
    const renderStartSample = Math.max(0, keepStartSample - warmupSamples);
    segments.push({
      index: segments.length,
      queryEndCycle: endCycle,
      cps,
      renderStartSec: renderStartSample / sampleRate,
      renderLengthSamples: keepEndSample - renderStartSample,
      keepOffsetSamples: keepStartSample - renderStartSample,
      keepLengthSamples: keepEndSample - keepStartSample,
    });
  }
  return { sampleRate, totalSamples, segments };
}

// Stitch per-segment stereo PCM (sliced to keep regions, in index order) into a
// single AudioBuffer-like consumable by encodeWav/encodeMp3.
export function concatSegmentPCM(parts, { sampleRate, totalSamples }) {
  const numberOfChannels = 2;
  const channels = [new Float32Array(totalSamples), new Float32Array(totalSamples)];
  let off = 0;
  for (const part of parts) {
    for (let c = 0; c < numberOfChannels; c++) channels[c].set(part.channels[c], off);
    off += part.channels[0].length;
  }
  return { numberOfChannels, sampleRate, length: totalSamples, getChannelData: (c) => channels[c] };
}
