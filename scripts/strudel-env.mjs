// Headless Strudel evaluation environment for Node.
// Mirrors strudel's own test/runtime.mjs: stubs browser-only functions,
// then evalScope()s the pattern vocabulary onto globalThis.
//
// Unlike a pure transpile check, this env wires up the REAL samples() loader
// from @strudel/webaudio so a track can self-declare external sample banks
// (`samples('github:user/repo')`). After evaluation we can read back the set
// of sound names the code actually loaded (see loadedSoundNames()).
import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import * as tonal from '@strudel/tonal';
import * as webaudio from '@strudel/webaudio';

// Pattern methods that only have audio/visual side effects in the browser.
const BROWSER_ONLY_METHODS = [
  'osc', 'csound', 'tone', 'webdirt', 'pianoroll', 'speak', 'wave', 'filter',
  'adsr', 'webaudio', 'soundfont', 'tune', 'midi', '_scope', '_spiral',
  '_pitchwheel', '_pianoroll', '_spectrum', 'markcss', 'p',
];

let ready;

export function initStrudelEnv() {
  if (ready) return ready;
  for (const name of BROWSER_ONLY_METHODS) {
    core.Pattern.prototype[name] = function () { return this; };
  }
  // evalScope is ASYNC: it puts note/s/stack/lpf/... on globalThis so that
  // transpiled code can resolve bare identifiers. We deliberately pass the REAL
  // webaudio `samples` so `samples('github:...')` fetches the bank's manifest
  // and registers its sounds in webaudio's soundMap (no audio is decoded in
  // Node — only the JSON manifest is fetched, and decode is lazy/at-trigger).
  ready = core.evalScope(core, mini, tonal, webaudio, {
    setcps: id,
    setcpm: id,
    getAudioContext: () => ({ currentTime: 0 }),
    getDrawContext: () => ({
      clearRect() {}, fillRect() {}, fillText() {},
      canvas: { width: 100, height: 100 },
    }),
  });
  return ready;
}

const id = (x) => x;

// Sound names currently registered in webaudio's soundMap (what samples() loaded
// plus any synth sounds registered this session). Underscore-prefixed keys are
// manifest metadata (e.g. `_base`), not playable sounds — filtered out.
export function loadedSoundNames() {
  const map = webaudio.soundMap?.get?.() ?? {};
  return Object.keys(map).filter((k) => !k.startsWith('_'));
}

// Clear sounds registered by previous validations so each track is validated
// against ONLY the base set ∪ its own samples() loads (no cross-track leakage).
export function resetLoadedSounds() {
  webaudio.resetLoadedSounds?.();
}
