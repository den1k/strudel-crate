// Headless Strudel evaluation environment for Node.
// Mirrors strudel's own test/runtime.mjs: stubs browser-only functions,
// then evalScope()s the pattern vocabulary onto globalThis.
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

const id = (x) => x;
let ready;

export function initStrudelEnv() {
  if (ready) return ready;
  for (const name of BROWSER_ONLY_METHODS) {
    core.Pattern.prototype[name] = function () { return this; };
  }
  // evalScope is ASYNC: it puts note/s/stack/lpf/... on globalThis so that
  // transpiled code can resolve bare identifiers.
  ready = core.evalScope(core, mini, tonal, webaudio, {
    samples: id, // browser-only: loads audio over fetch
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
