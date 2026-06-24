import { StrudelMirror } from '@strudel/codemirror';
import { transpiler } from '@strudel/transpiler';
import { getAudioContext, webaudioOutput, resetGlobalEffects } from '@strudel/webaudio';
import { readCycle, applySeek } from './transport.js';

const editors = new Map(); // trackId -> StrudelMirror

export const getEditor = (trackId) => editors.get(trackId) ?? null;

// Cut every sound that's still ringing out. A scheduler's stop() only halts
// *new* events; samples, long notes, and reverb tails already dispatched to
// WebAudio keep playing to their natural end — so switching or pausing a song
// bleeds the old audio over. Tearing down and rebuilding superdough's output
// graph silences them instantly (this is what the Strudel REPL's "panic" does).
// Global by design: the app plays one song at a time, so flushing every voice
// on stop/switch is exactly the intent. Safe before resume — re-evaluating a
// paused track schedules fresh voices into the rebuilt graph.
export const panic = () => resetGlobalEffects();

export const isStarted = (trackId) =>
  editors.get(trackId)?.repl.scheduler.started ?? false;

// Current cycle of a track's running scheduler, or null if unavailable.
export const cyclePosition = (trackId) =>
  readCycle(editors.get(trackId)?.repl.scheduler ?? null);

// Re-anchor a track's playback to `cycle` (forward or backward), in place.
export const seekEditor = (trackId, cycle) =>
  applySeek(editors.get(trackId)?.repl.scheduler ?? null, cycle);

// Mount a StrudelMirror into `root` for a track. Idempotent per track id.
// solo mode (the default) makes editors mutually exclusive: starting one
// dispatches a 'start-repl' event that stops every other editor.
export function mountEditor({ track, root, prebake, onToggle, onError }) {
  if (editors.has(track.id)) return editors.get(track.id);
  const editor = new StrudelMirror({
    id: track.id,
    root,
    initialCode: track.code,
    prebake, // samples are prebaked globally once; this just awaits readiness
    transpiler,
    defaultOutput: webaudioOutput,
    getTime: () => getAudioContext().currentTime,
    onToggle: (started) => onToggle(track.id, started),
    onEvalError: (err) => onError(track.id, err),
    afterEval: () => onError(track.id, null), // successful eval clears stale error
  });
  // match the app's code-block styling; avoid updateSettings() — it writes to
  // a localStorage-persisted global atom shared by all editors
  editor.setFontSize(12);
  editor.setFontFamily('var(--mono)');
  editor.setLineWrappingEnabled(true);
  editor.setLineNumbersDisplayed(false);
  editors.set(track.id, editor);
  return editor;
}
