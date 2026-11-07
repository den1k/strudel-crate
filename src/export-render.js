import './frame-lockdown.js';
import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import * as tonal from '@strudel/tonal';
import * as webaudio from '@strudel/webaudio';
import { registerSynthSounds, samples } from '@strudel/webaudio';
import banks from '../shared/sample-banks.json';
import { vocabulary } from '../shared/strudel-scope.js';
import { renderTrack, renderStemsZip, renderSegment } from './render.js';
import { isTrustedExportMessage } from './export-guard.js';

// Register the same sound map the app loads on boot. This only registers (URLs
// + synth defs); individual samples are fetched/decoded lazily during a render,
// so no running AudioContext is needed here — this iframe is headless.
const ready = (async () => {
  await core.evalScope(...[core, mini, tonal, webaudio].map(vocabulary));
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
  if (!isTrustedExportMessage(e, window)) return;
  const data = e.data || {};
  if (data.type === 'render-segment') {
    const { id, segment, track } = data;
    try {
      await ready;
      const part = await renderSegment(track, segment);
      parent.postMessage(
        { type: 'segment-done', id, index: part.index, length: part.length, ch0: part.channels[0], ch1: part.channels[1] },
        '*',
        [part.channels[0].buffer, part.channels[1].buffer],
      );
    } catch (err) {
      parent.postMessage({ type: 'error', id, message: err.message }, '*');
    }
    return;
  }
  if (data.type !== 'render') return;
  const { id, track, format } = data;
  try {
    await ready;
    const onProgress = (done, total) => parent.postMessage({ type: 'progress', id, done, total }, '*');
    const blob = format === 'stems'
      ? await renderStemsZip(track, onProgress)
      : await renderTrack(track, format, onProgress);
    parent.postMessage({ type: 'done', id, blob }, '*');
  } catch (err) {
    parent.postMessage({ type: 'error', id, message: err.message }, '*');
  }
});

// Tell the parent we can accept a render request once strudel is registered.
ready.then(() => parent.postMessage({ type: 'ready' }, '*'));
