// The Strudel runtime, inside an opaque-origin frame (see strudel-engine-client.js and the
// CSP in server/app.mjs). Page and engine speak only by postMessage. NOT @strudel/web: its
// dist inlines private copies of core/webaudio, so sounds registered through it are
// invisible to webaudioOutput (two registries, silent playback).
import './frame-lockdown.js';
import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import * as tonal from '@strudel/tonal';
import * as webaudio from '@strudel/webaudio';
import { repl } from '@strudel/core';
import { transpiler } from '@strudel/transpiler';
import {
  getAudioContext, initAudio, registerSynthSounds, resetGlobalEffects, samples, webaudioOutput,
} from '@strudel/webaudio';
import banks from '../shared/sample-banks.json';
import { vocabulary } from '../shared/strudel-scope.js';
import { enableSilentSwitchPlayback } from './ios-audio.js';
import { installCacheAwareSamples, warmSampleCacheIndex } from './sample-cache-client.js';
import { applySeek, readCycle } from './transport.js';

const TICK_MS = 50;
const send = (msg) => parent.postMessage(msg, '*');

const unlockSession = enableSilentSwitchPlayback(); // iOS: play through the silent switch
warmSampleCacheIndex();

const ready = (async () => {
  await core.evalScope(...[core, mini, tonal, webaudio].map(vocabulary));
  // evalScope copies webaudio's exports onto globalThis; wrap the now-global samples() so
  // tracks that self-declare a vendored bank prefer the local cache.
  installCacheAwareSamples(globalThis);
  await Promise.all([
    registerSynthSounds(),
    ...banks.map((b) => (b.shorthand
      ? samples(b.shorthand)
      : samples(b.json, b.base, { prebake: b.prebake, tag: b.tag }))),
  ]);
})();

let gen = 0;
let id = null;
let highlight = false;
let ticker = null;

function frameLocations(state, cycle) {
  if (!highlight || !state.pattern) return undefined;
  try {
    const out = [];
    for (const hap of state.pattern.queryArc(cycle, cycle + 0.001)) {
      if (!hap.whole || !hap.context?.locations) continue;
      const begin = hap.whole.begin.valueOf();
      const end = hap.whole.end.valueOf();
      if (cycle < begin || cycle >= end) continue;
      const color = typeof hap.value?.color === 'string' ? hap.value.color : undefined;
      for (const { start, end: stop } of hap.context.locations) out.push({ start, end: stop, begin, duration: end - begin, color });
    }
    return out;
  } catch {
    return [];
  }
}

const engine = repl({
  defaultOutput: webaudioOutput,
  getTime: () => getAudioContext().currentTime,
  transpiler,
  beforeEval: () => ready,
  onEvalError: (err) => send({ type: 'error', gen, message: String(err?.message ?? err) }),
  afterEval: ({ meta }) => {
    send({ type: 'evaluated', gen, locations: meta?.miniLocations ?? [] });
  },
  onToggle: (started) => {
    send({ type: 'toggle', gen, id, started });
    clearInterval(ticker);
    ticker = null;
    if (!started) return;
    ticker = setInterval(() => {
      const cycle = readCycle(engine.scheduler);
      if (cycle == null) return;
      send({ type: 'tick', gen, cycle, cps: engine.scheduler.cps, frame: frameLocations(engine.state, cycle) });
    }, TICK_MS);
  },
});

let audioInit = null;
async function resume(nonce) {
  const ctx = getAudioContext();
  try { await ctx.resume(); } catch { /* reported below */ }
  // Worklets must be in before the first hap, or their nodes fail to construct.
  if (ctx.state === 'running') {
    audioInit ??= initAudio().catch(() => {});
    await audioInit;
  }
  send({ type: 'audio', nonce, state: ctx.state });
}

let gate = null;
function showGate(show) {
  if (!show) { gate?.remove(); gate = null; return; }
  if (gate) return;
  gate = document.createElement('button');
  gate.textContent = 'tap to enable audio';
  Object.assign(gate.style, {
    position: 'fixed', inset: '0', width: '100%', height: '100%', border: '0',
    background: 'rgba(0,0,0,.72)', color: '#fff', font: '600 18px system-ui, sans-serif', cursor: 'pointer',
  });
  gate.addEventListener('click', () => { unlockSession?.(); resume(null); });
  document.body.appendChild(gate);
}

const handlers = {
  unlock: () => { unlockSession?.(); getAudioContext().resume().catch(() => {}); },
  resume: ({ nonce }) => resume(nonce),
  gate: ({ show }) => showGate(show),
  highlight: ({ on }) => { highlight = !!on; },
  panic: () => resetGlobalEffects(),
  stop: ({ gen: g }) => {
    gen = g;
    engine.scheduler.stop();
  },
  seek: ({ gen: g, cycle }) => { if (g === gen) applySeek(engine.scheduler, Number(cycle) || 0); },
  play: async ({ gen: g, id: playId, code }) => {
    if (id !== playId && engine.scheduler.started) engine.scheduler.stop();
    gen = g;
    id = playId;
    engine.setCode(code);
    await engine.evaluate(code);
    // Stopped while samples were still loading: don't let the late start stand.
    if (gen !== g && id === playId && engine.scheduler.started) engine.scheduler.stop();
  },
};

window.addEventListener('message', (e) => {
  if (e.source !== parent || e.source === window || e.origin !== location.origin) return;
  const { type } = e.data ?? {};
  if (Object.hasOwn(handlers, type)) handlers[type](e.data);
});

send({ type: 'hello' }); // listening: the page waits for this before showing a fresh frame's gate
ready.then(() => send({ type: 'ready' }));
