import {
  setAudioContext,
  setSuperdoughAudioController,
  resetGlobalEffects,
  initAudio,
  webaudioOutput,
} from '@strudel/webaudio';
import { evaluate } from '@strudel/transpiler';
import { exportSpec, collectHaps } from './export-spec.js';
import { encodeWav, encodeMp3 } from './encoders.js';

const SAMPLE_RATE = 44100;

// Render a track to a downloadable Blob using an OfflineAudioContext. Intended
// to run inside the export iframe, which owns its global audio context — so,
// unlike the old main-thread path, there is no live context to close and
// restore. setcpm/setcps exist only inside repls; the bare transpiler can't see
// them, and exports derive cps from meta.bpm, so no-ops satisfy the reference
// (??= so a repl-registered real one survives if present).
export async function renderTrack(track, format) {
  globalThis.setcpm ??= () => {};
  globalThis.setcps ??= () => {};
  const { pattern } = await evaluate(track.code);
  if (typeof pattern?.queryArc !== 'function') {
    throw new Error('code did not evaluate to a pattern');
  }
  const { cps, cycles, seconds } = exportSpec(track);
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * SAMPLE_RATE), SAMPLE_RATE);
  setAudioContext(ctx);
  // Rebind superdough to the offline context: clear any analyser/effect state
  // and null the controller so superdough lazily recreates it on `ctx` (the
  // iframe boot may have created one on a default AudioContext). Everything is
  // imported from @strudel/webaudio so there is ONE superdough instance: pulling
  // SuperdoughAudioController from the `superdough/...` subpath instead loads a
  // SECOND superdough copy (its own vite dep chunk with its own audio-context
  // global that we'd never set), leaving its reverb/effect nodes on the default
  // context — they then fail to connect to offline-context nodes ("cannot
  // connect to an AudioNode belonging to a different audio context") and silence
  // every sound using room/delay/etc.
  resetGlobalEffects();
  setSuperdoughAudioController(null);
  await initAudio();
  // collectHaps queries cycle-by-cycle (one throwing cycle can't zero the whole
  // render); ascending onset order matters for graph-state controls like `cut`,
  // and awaiting each call lets samples load into the offline context.
  for (const hap of collectHaps(pattern, cycles, cps)) {
    try {
      await webaudioOutput(hap, null, hap.duration / cps, cps, hap.whole.begin.valueOf() / cps);
    } catch (err) {
      console.warn('[export] hap skipped:', err.message);
    }
  }
  const buffer = await ctx.startRendering();
  return format === 'wav'
    ? new Blob([encodeWav(buffer)], { type: 'audio/wav' })
    : new Blob(encodeMp3(buffer), { type: 'audio/mpeg' });
}
