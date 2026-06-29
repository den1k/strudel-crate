import {
  setAudioContext,
  setSuperdoughAudioController,
  resetGlobalEffects,
  initAudio,
  webaudioOutput,
  getSound,
  getSampleInfo,
  loadBuffer,
} from '@strudel/webaudio';
import { evaluate } from '@strudel/transpiler';
import { exportSpec, collectHaps, groupHapsBySound, stemFilenames } from './export-spec.js';
import { encodeWav, encodeMp3 } from './encoders.js';
import { zipStore } from './zip.js';
import { segmentPlan } from './segment.js';

const SAMPLE_RATE = 44100;

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

// Preload all unique sample buffers in parallel before the sequential hap-scheduling loop.
//
// Why this matters: superdough fetches sample audio lazily when the first hap that
// references a given URL is awaited in the loop.  Because the loop is sequential
// (one `await webaudioOutput()` at a time), each unique sample URL is fetched *one
// after another*.  Over a fast localhost the total wait is the SUM of all fetch
// durations; over a CDN (GitHub raw, etc.) each fetch takes 200–2000 ms, so a
// track with 5 unique samples serialises to 1–10 s of dead waiting *before*
// `startRendering()` even begins — making short exports appear 3–5× slower than
// the track's own duration.
//
// This function collects every distinct sample URL from the hap list and fires all
// fetches + decodeAudioData calls in parallel.  superdough's `loadBuffer` already
// deduplicates via a module-level URL→Promise cache, so a second `loadBuffer(url)`
// call during the real hap loop immediately resolves from cache.  The parallel wait
// is therefore max(fetch_times) rather than sum(fetch_times) — typically a 3–10×
// wall-clock improvement for CDN-hosted banks.
async function preloadSampleBuffers(haps, ac) {
  const seenUrls = new Set();
  const loads = [];
  for (const hap of haps) {
    const v = hap.value;
    if (!v || typeof v !== 'object') continue;
    let s = v.s;
    if (!s || ['-', '~', '_'].includes(s)) continue;
    // Mirror superdough's bank-prefix logic so we look up the right sound entry.
    if (v.bank) s = `${v.bank}_${s}`;
    const sound = getSound(s);
    // Synth sounds have no .data.samples; only sample-based sounds do.
    const bank = sound?.data?.samples;
    if (!bank) continue;
    try {
      const { url } = getSampleInfo(v, bank);
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);
      // Errors (404, CORS, etc.) are suppressed here — the real hap loop will
      // handle them per-hap and emit the existing [export] hap skipped warning.
      loads.push(loadBuffer(url, ac, s).catch(() => {}));
    } catch (_) { /* unmappable sound — skip */ }
  }
  if (loads.length) await Promise.all(loads);
}

// Shared context setup + hap scheduling for one OfflineAudioContext. Each hap is
// scheduled at (its absolute onset) minus timeOffsetSec, so a segment that
// renders starting partway through the track lands its haps correctly at the
// segment context's t=0. See render.js header comment re: realm-global superdough.
async function scheduleAndRender(ctx, haps, cps, timeOffsetSec) {
  setAudioContext(ctx);
  // Null controller BEFORE resetGlobalEffects (closed-context throw guard — see
  // the long-form note that was here previously and the regression test).
  setSuperdoughAudioController(null);
  resetGlobalEffects();
  await initAudio();
  await preloadSampleBuffers(haps, ctx);
  for (const hap of haps) {
    const when = hap.whole.begin.valueOf() / cps - timeOffsetSec;
    try {
      await webaudioOutput(hap, null, hap.duration / cps, cps, when);
    } catch (err) {
      // superdough's node-pool (nodePools.mjs) retains GainNode / BiquadFilterNode
      // objects across OfflineAudioContext instances.  On a second render the pool
      // may return a node that belongs to the previous context; connecting it to the
      // new context's graph throws this error.  Because getNodeFromPool() *pops* the
      // stale node before returning it, each retry consumes one bad pool entry until
      // the pool is exhausted for that key, at which point the factory creates a
      // fresh node on the correct context.  We retry up to 8 times (more stale
      // entries than any real track is likely to accumulate between renders).
      if (err.message?.includes('different audio context')) {
        let retryErr = err;
        for (let attempt = 0; attempt < 8 && retryErr?.message?.includes('different audio context'); attempt++) {
          try { await webaudioOutput(hap, null, hap.duration / cps, cps, when); retryErr = null; }
          catch (e) { retryErr = e; }
        }
        if (retryErr) console.warn('[export] hap skipped:', retryErr.message);
      } else {
        console.warn('[export] hap skipped:', err.message);
      }
    }
  }
  return ctx.startRendering();
}

// Render a set of haps into a fresh, full-length OfflineAudioContext (timeOffset 0).
async function renderHapsToBuffer(haps, { cps, seconds, cycles }, onProgress) {
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * SAMPLE_RATE), SAMPLE_RATE);
  // Real per-cycle progress: the whole song is one monolithic startRendering(),
  // so to "see where it's at" we suspend the offline render at each cycle
  // boundary, report, and resume. Suspend times must land on a 128-sample render
  // quantum. We cap the checkpoint count so dense (≤512-cycle) renders don't
  // schedule hundreds of suspends. Defensive: any failure just means fewer
  // ticks; the render itself is unaffected.
  // NOTE: suspends must be registered on ctx BEFORE startRendering() runs inside
  // scheduleAndRender. Since scheduleAndRender awaits async setup before calling
  // startRendering, suspends registered synchronously here are valid.
  if (onProgress && cycles > 1) {
    const step = Math.max(1, Math.ceil(cycles / 100));
    for (let c = step; c < cycles; c += step) {
      const frame = Math.round((c / cps) * SAMPLE_RATE / 128) * 128;
      const t = frame / SAMPLE_RATE;
      if (t <= 0 || t >= seconds) continue;
      ctx.suspend(t).then(() => { onProgress(c, cycles); ctx.resume(); }).catch(() => {});
    }
  }
  return scheduleAndRender(ctx, haps, cps, 0);
}

// Render a track to a single mixed Blob (wav 16-bit or mp3).
export async function renderTrack(track, format, onProgress) {
  const pattern = await evalPattern(track);
  const spec = exportSpec(track);
  const buffer = await renderHapsToBuffer(collectHaps(pattern, spec.cycles, spec.cps), spec, onProgress);
  onProgress?.(spec.cycles, spec.cycles); // render done; encode/blob is the last sliver
  return format === 'wav'
    ? new Blob([encodeWav(buffer)], { type: 'audio/wav' })
    : new Blob(encodeMp3(buffer), { type: 'audio/mpeg' });
}

// Render a single time-segment of a track to keep-region PCM. Queries the
// pattern up to the segment's last cycle, keeps only haps whose onset is at/after
// the warm-up start, renders into a warm-up-padded OfflineAudioContext, then
// slices off the warm-up so the returned PCM tiles exactly with its neighbours.
export async function renderSegment(track, segment) {
  const pattern = await evalPattern(track);
  const haps = collectHaps(pattern, segment.queryEndCycle, segment.cps)
    .filter((h) => h.whole.begin.valueOf() / segment.cps >= segment.renderStartSec);
  const ctx = new OfflineAudioContext(2, segment.renderLengthSamples, SAMPLE_RATE);
  const buf = await scheduleAndRender(ctx, haps, segment.cps, segment.renderStartSec);
  const a = segment.keepOffsetSamples;
  const b = a + segment.keepLengthSamples;
  const ch0 = buf.getChannelData(0).slice(a, b);
  const ch1 = buf.getChannelData(1).slice(a, b);
  return { index: segment.index, length: ch0.length, channels: [ch0, ch1] };
}

// Render one full-length, time-aligned 24-bit WAV per distinct sound, bundled
// into a single .zip. Each stem is the whole song length starting at bar 1, so
// dropping the folder into a DAW lines the parts up automatically.
export async function renderStemsZip(track, onProgress) {
  const pattern = await evalPattern(track);
  const spec = exportSpec(track);
  const groups = groupHapsBySound(collectHaps(pattern, spec.cycles, spec.cps));
  const names = stemFilenames(track.id, groups.map((g) => g.name));
  const files = [];
  for (let i = 0; i < groups.length; i++) {
    const buffer = await renderHapsToBuffer(groups[i].haps, spec);
    files.push({ name: names[i], data: new Uint8Array(encodeWav(buffer, 24)) });
    onProgress?.(i + 1, groups.length);
  }
  return new Blob([zipStore(files)], { type: 'application/zip' });
}
