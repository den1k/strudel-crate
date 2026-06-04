# Strudel-Style Editor with Real-Time Highlighting

**Date:** 2026-06-04
**Status:** Approved

## Goal

Replace the static `<pre>` code display on each track card with the Strudel REPL
editor (`StrudelMirror` from `@strudel/codemirror`), so that while a track plays,
the mini-notation events light up in real time — the same highlighting behavior
as strudel.cc. The editor is editable: Ctrl+Enter re-evaluates the code live.

## Decisions

- **Editability:** Editable with live re-evaluate. Edits are session-only — they
  are never written back to the track JSON; a page reload restores stored code.
- **Placement:** One editor per track card, lazy-mounted. The existing
  `<details class="code">` keeps its place in the card layout; the CodeMirror
  instance is created only when the details is first opened or the track is
  first played.
- **Approach:** Use `StrudelMirror` off the shelf rather than hand-wiring
  CodeMirror to the global `@strudel/web` scheduler. Highlighting, transpiler
  `miniLocations`, flash-on-eval, and keymaps come from upstream.

## Architecture

### Dependencies

- Add `@strudel/codemirror` (1.2.x, matching the pinned `@strudel/core@1.2.6`
  family). CodeMirror 6 comes with it (~300KB; acceptable for a local tool).

### Sample loading and audio init

- Keep the existing `initStrudel({ prebake })` call at startup. Samples register
  globally in superdough, so every editor instance shares them. No per-editor
  sample loading.

### Editor lifecycle (src/main.js)

- `trackCard()` renders an empty `div.editor` inside the existing
  `<details class="code">` instead of a `<pre>`.
- A module-level map `editors: Map<trackId, StrudelMirror>` holds mounted
  instances. `ensureEditor(track)` mounts on first need (details `toggle` open,
  or play).
- StrudelMirror options: `initialCode: track.code`, `transpiler` from
  `@strudel/transpiler`, `defaultOutput: webaudioOutput`,
  `getTime: () => audioContext.currentTime`, pattern highlighting enabled,
  line wrapping on, editable.

### Playback flow

- A module-level `activeEditor` ref enforces one-track-at-a-time:
  starting any editor first stops the previous one.
- `play(track)` → `ensureEditor(track)` → open the code details so highlighting
  is visible → `editor.evaluate()`.
- `stop()` → `activeEditor.stop()`, clear `state.playingId`.
- Ctrl+Enter inside an editor re-evaluates that track (stopping any other
  playing track first) and updates `state.playingId` so transport UI stays
  consistent.
- The global `evaluate`/`hush` imports from `@strudel/web` are no longer used
  for playback (initStrudel remains for prebake/audio init).

### Appearance

- Theme the editor with the existing palette: app dark background, `--acid`
  (#c8f53c) for the active-event highlight, font/size consistent with the
  current code block styling.

### Error handling

- Evaluation errors from edited code render inline below the editor (via
  StrudelMirror's error state) rather than failing silently. Playback state
  resets so the transport doesn't show a phantom "playing" track.

## Testing

- Existing vitest suite (validation, store, feedback) is untouched.
- Play/stop/active-editor coordination is extracted into a small pure helper
  where practical and unit-tested.
- Editor mounting, highlighting, and re-evaluate are verified manually against
  the dev server (`npm run dev`).

## Out of scope

- Persisting edits back to track JSON (would need a save endpoint + validation).
- Multiple tracks playing simultaneously.
- Visualizations beyond event highlighting (punchcard, pianoroll, etc.).
