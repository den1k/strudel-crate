import { StrudelMirror } from '@strudel/codemirror';
import { transpiler } from '@strudel/transpiler';
import { getAudioContext, webaudioOutput } from '@strudel/webaudio';

const editors = new Map(); // trackId -> StrudelMirror

export const getEditor = (trackId) => editors.get(trackId) ?? null;

export const isStarted = (trackId) =>
  editors.get(trackId)?.repl.scheduler.started ?? false;

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
