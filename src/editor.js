import {
  initEditor, compartments, extensions, flash, updateMiniLocations, highlightMiniLocations,
} from '@strudel/codemirror';

// One player for the whole page, in the sandboxed engine frame; each track's editor here
// only displays code and hands it over. Solo behaviour falls out of having one scheduler.
const editors = new Map(); // trackId -> { stop, evaluate, view, onToggle, onError }
const playback = { id: null, gen: 0, started: false, cycle: 0, cps: 0.5, at: 0 };
let engine = null;
let audioNonce = 0;

const AUDIO_GATE_AFTER_MS = 1200;
const SAFE_COLOR = /^[#a-zA-Z0-9]{1,32}$/;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export const getEditor = (trackId) => editors.get(trackId) ?? null;

// Cut every sound that's still ringing out. A scheduler's stop() only halts *new* events;
// tearing down superdough's output graph silences what's already dispatched.
export const panic = () => engine?.post({ type: 'panic' });

export const isStarted = (trackId) => playback.id === trackId && playback.started;

// Current cycle of the running track, extrapolated between the engine's ticks, or null.
export function cyclePosition(trackId) {
  if (!isStarted(trackId)) return null;
  return playback.cycle + ((performance.now() - playback.at) / 1000) * playback.cps;
}

// Re-anchor a track's playback to `cycle` (forward or backward), in place.
export function seekEditor(trackId, cycle) {
  if (playback.id !== trackId) return false;
  playback.cycle = Math.max(0, cycle);
  playback.at = performance.now();
  engine?.post({ type: 'seek', gen: playback.gen, cycle: playback.cycle });
  return true;
}

// Resolves once the engine's AudioContext is running. A browser that didn't honour the
// page's gesture gets a tap target inside the frame.
export function resumeAudio() {
  if (!engine) return Promise.resolve();
  const nonce = ++audioNonce;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { engine.showGate(true); engine.post({ type: 'gate', show: true }); }, AUDIO_GATE_AFTER_MS);
    const off = engine.on((m) => {
      if (m.type !== 'audio' || m.state !== 'running') return;
      if (m.nonce !== nonce && m.nonce !== null) return;
      clearTimeout(timer);
      off();
      engine.post({ type: 'gate', show: false });
      engine.showGate(false);
      resolve();
    });
    engine.post({ type: 'resume', nonce });
  });
}

function setStarted(started) {
  if (playback.started === started) return;
  playback.started = started;
  const ed = editors.get(playback.id);
  ed?.onToggle(playback.id, started);
  if (!started && ed) updateMiniLocations(ed.view, []);
}

// Highlight data arrives as plain numbers; give it the shape highlightMiniLocations reads.
function frameHaps(frame) {
  const fraction = (v) => ({ v, valueOf: () => v, lt: (o) => v < o.v });
  return frame.map((f) => ({
    context: { locations: [{ start: num(f.start), end: num(f.end) }] },
    whole: { begin: fraction(num(f.begin)), duration: num(f.duration) || 1 },
    value: SAFE_COLOR.test(f.color ?? '') ? { color: f.color } : {},
  }));
}

function onEngineMessage(m) {
  if (m.gen !== playback.gen) return;
  const ed = editors.get(playback.id);
  switch (m.type) {
    case 'toggle':
      if (m.id === playback.id) setStarted(!!m.started);
      break;
    case 'tick':
      playback.cycle = num(m.cycle);
      playback.cps = num(m.cps) || playback.cps;
      playback.at = performance.now();
      if (ed && Array.isArray(m.frame)) highlightMiniLocations(ed.view, playback.cycle, frameHaps(m.frame));
      break;
    case 'error':
      ed?.onError(playback.id, new Error(String(m.message).slice(0, 500)));
      break;
    case 'evaluated':
      ed?.onError(playback.id, null); // successful eval clears a stale error
      if (ed && Array.isArray(m.locations)) {
        updateMiniLocations(ed.view, m.locations.map(([a, b]) => [num(a), num(b)]));
      }
      break;
    default:
  }
}

export function attachEngine(client) {
  engine = client;
  engine.on(onEngineMessage);
}

function evaluateTrack(trackId, code) {
  if (playback.id !== trackId) {
    setStarted(false); // solo: the outgoing track's UI hears about it first
    playback.cycle = 0;
    playback.at = performance.now();
  }
  playback.id = trackId;
  playback.gen += 1;
  engine?.post({ type: 'highlight', on: true });
  engine?.post({ type: 'play', gen: playback.gen, id: trackId, code });
}

function stopTrack(trackId) {
  if (playback.id !== trackId) return;
  playback.gen += 1;
  setStarted(false);
  engine?.post({ type: 'stop', gen: playback.gen });
}

// Mount a code view into `root` for a track. Idempotent per track id.
export function mountEditor({ track, root, onToggle, onError }) {
  if (editors.has(track.id)) return editors.get(track.id);
  let code = track.code;
  const ed = {
    onToggle,
    onError,
    evaluate: () => { flash(ed.view); evaluateTrack(track.id, code); },
    stop: () => stopTrack(track.id),
  };
  ed.view = initEditor({
    root,
    initialCode: track.code,
    onChange: (v) => { if (v.docChanged) code = v.state.doc.toString(); },
    onEvaluate: () => ed.evaluate(),
    onStop: () => ed.stop(),
  });
  // Match the app's code-block styling; avoid strudel's persisted settings atom, which is
  // shared by all editors.
  root.style.display = 'block';
  root.style.backgroundColor = 'var(--background)';
  root.style.fontSize = '12px';
  root.style.fontFamily = 'var(--mono)';
  const cm = root.querySelector('.cm-editor');
  if (cm) cm.style.backgroundColor = 'transparent';
  const scroller = root.querySelector('.cm-scroller');
  if (scroller) scroller.style.fontFamily = 'var(--mono)';
  ed.view.dispatch({
    effects: [
      compartments.isLineWrappingEnabled.reconfigure(extensions.isLineWrappingEnabled(true)),
      compartments.isLineNumbersDisplayed.reconfigure(extensions.isLineNumbersDisplayed(false)),
    ],
  });
  editors.set(track.id, ed);
  return ed;
}
