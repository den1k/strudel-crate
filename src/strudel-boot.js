// The one place the webapp boots Strudel. NOT @strudel/web: its dist inlines
// private copies of core/webaudio, so sounds registered through it are invisible
// to editor.js's webaudioOutput (two registries — silent playback). evalScope
// mirrors scripts/strudel-env.mjs but with real audio, keeping every page on the
// exact module instances the editors play through.
import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import * as tonal from '@strudel/tonal';
import * as webaudio from '@strudel/webaudio';
import { initAudioOnFirstClick, registerSynthSounds, samples } from '@strudel/webaudio';
import banks from '../shared/sample-banks.json';
import { enableSilentSwitchPlayback } from './ios-audio.js';

// Boot once per page. Returns a promise that resolves when the sample banks are
// loaded (pass it to mountEditor's `prebake`). Call exactly once.
export function bootStrudel() {
  initAudioOnFirstClick(); // resume the AudioContext on the first user gesture
  enableSilentSwitchPlayback(); // iOS: play through the hardware silent switch
  return (async () => {
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
}
