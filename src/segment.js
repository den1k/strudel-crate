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
  const totalSamples = cycleToSample(cycles);
  const warmupSamples = Math.round(warmupSeconds * sampleRate);
  const n = Math.max(1, Math.min(segmentCount, cycles));
  const segments = [];
  for (let i = 0; i < n; i++) {
    const startCycle = Math.floor((i * cycles) / n);
    const endCycle = Math.floor(((i + 1) * cycles) / n);
    if (endCycle <= startCycle) continue;
    const keepStartSample = cycleToSample(startCycle);
    const keepEndSample = cycleToSample(endCycle);
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
