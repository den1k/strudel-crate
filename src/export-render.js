import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import * as tonal from '@strudel/tonal';
import * as webaudio from '@strudel/webaudio';
import { registerSynthSounds, samples } from '@strudel/webaudio';
import banks from '../shared/sample-banks.json';
import { renderTrack, renderStemsZip } from './render.js';

// Register the same sound map the app loads on boot. This only registers (URLs
// + synth defs); individual samples are fetched/decoded lazily during a render,
// so no running AudioContext is needed here — this iframe is headless.
const ready = (async () => {
  await core.evalScope(core, mini, tonal, webaudio);
  await Promise.all([
    registerSynthSounds(),
    ...banks.map((b) =>
      b.shorthand
        ? samples(b.shorthand)
        : samples(b.json, b.base, { prebake: b.prebake, tag: b.tag }),
    ),
  ]);
})();

window.addEventListener('message', async (e) => {
  const data = e.data || {};
  if (data.type !== 'render') return;
  const { id, track, format } = data;
  try {
    await ready;
    const blob = format === 'stems' ? await renderStemsZip(track) : await renderTrack(track, format);
    parent.postMessage({ type: 'done', id, blob }, '*');
  } catch (err) {
    parent.postMessage({ type: 'error', id, message: err.message }, '*');
  }
});

// Tell the parent we can accept a render request once strudel is registered.
ready.then(() => parent.postMessage({ type: 'ready' }, '*'));
