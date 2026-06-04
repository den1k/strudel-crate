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
    // setcpm/setcps exist only inside repls (each StrudelMirror registers its
    // own); the bare transpiler evaluate() can't see them. Exports derive cps
    // from meta.bpm instead, so a no-op satisfies the reference — same trick
    // as scripts/strudel-env.mjs. ??= so a repl-registered real one survives.
    globalThis.setcpm ??= () => {};
    globalThis.setcps ??= () => {};
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
