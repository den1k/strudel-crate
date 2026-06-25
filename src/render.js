import {
  setAudioContext,
  setSuperdoughAudioController,
  resetGlobalEffects,
  initAudio,
  webaudioOutput,
} from '@strudel/webaudio';
import { evaluate } from '@strudel/transpiler';
import { exportSpec, collectHaps, groupHapsBySound, stemFilenames } from './export-spec.js';
import { encodeWav, encodeMp3 } from './encoders.js';
import { zipStore } from './zip.js';

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

// Render a set of haps into a fresh, full-length OfflineAudioContext. Rebinds
// superdough to that context (null the controller so it rebuilds on `ctx`;
// everything imported from @strudel/webaudio keeps a SINGLE superdough instance
// — importing from `superdough/...` would create a second copy whose effect
// nodes live on a different context and fail to connect). Two renders of the
// same `seconds` produce time-aligned buffers (both start at t=0).
async function renderHapsToBuffer(haps, { cps, seconds, cycles }, onProgress) {
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
  // Real per-cycle progress: the whole song is one monolithic startRendering(),
  // so to "see where it's at" we suspend the offline render at each cycle
  // boundary, report, and resume. Suspend times must land on a 128-sample render
  // quantum. We cap the checkpoint count so dense (≤512-cycle) renders don't
  // schedule hundreds of suspends. Defensive: any failure just means fewer
  // ticks; the render itself is unaffected.
  if (onProgress && cycles > 1) {
    const step = Math.max(1, Math.ceil(cycles / 100));
    for (let c = step; c < cycles; c += step) {
      const frame = Math.round((c / cps) * SAMPLE_RATE / 128) * 128;
      const t = frame / SAMPLE_RATE;
      if (t <= 0 || t >= seconds) continue;
      ctx.suspend(t)
        .then(() => { onProgress(c, cycles); ctx.resume(); })
        .catch(() => {});
    }
  }
  return ctx.startRendering();
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
