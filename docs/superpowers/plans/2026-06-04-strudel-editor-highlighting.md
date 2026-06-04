# Strudel Editor with Real-Time Highlighting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static `<pre>` code display on each track card with Strudel's `StrudelMirror` editor so that, while a track plays, its mini-notation events highlight in real time (strudel.cc-style), and Ctrl+Enter re-evaluates edited code live.

**Architecture:** Each track card lazy-mounts a `StrudelMirror` instance (from `@strudel/codemirror@1.3.0`) inside its existing `<details class="code">`. StrudelMirror owns evaluation + scheduling per editor; its built-in `solo` mode stops every other editor when one starts, so playback stays one-at-a-time. The app's play/stop buttons route through the editor instances instead of `@strudel/web`'s global `evaluate()`/`hush()`. Because `renderTracks()` rebuilds all cards with `replaceChildren()`, the `<details>` element of each track is cached in a Map and *moved* into freshly rendered cards — this preserves mounted editors, session-only edits, and open/closed state across re-renders.

**Tech Stack:** Vanilla JS + Vite, `@strudel/codemirror` 1.3.0 (CodeMirror 6), existing `@strudel/web` 1.3.0 `initStrudel` prebake (samples register globally in superdough, shared by all editors), vitest.

**Spec:** `docs/superpowers/specs/2026-06-04-strudel-editor-highlighting-design.md`

---

## Verified API facts (from the published `@strudel/codemirror@1.3.0` source)

These were confirmed by reading the package tarball — do not re-derive them:

- `new StrudelMirror(options)` destructures `{ root, id, initialCode, onDraw, drawContext, drawTime, autodraw, prebake, bgFill, solo = true, ...replOptions }` and passes `replOptions` (e.g. `defaultOutput`, `getTime`, `transpiler`, `onToggle`, `onEvalError`, `afterEval`, `beforeEval`) through to `repl()` from `@strudel/core`. Our pinned `@strudel/core@1.2.6` `repl()` supports `onEvalError`, `onToggle`, `afterEval` (see `node_modules/@strudel/core/repl.mjs:17-27`).
- `prebake` is **required** — the constructor calls `this.prebaked = prebake()` unconditionally and `beforeEval` awaits it. Pass `() => ready` (the existing `initStrudel` promise).
- `solo: true` (default): when an editor starts, it dispatches a `start-repl` DOM event; every other editor with a different `id` calls `this.stop()`. Mutual exclusion is built in.
- `onToggle(started)` fires on scheduler start AND stop (including stops triggered by solo mode).
- Methods: `evaluate()`, `stop()`, `setCode(code)`, `setFontSize(px)`, `setFontFamily(str)`, `setLineWrappingEnabled(bool)`, `setLineNumbersDisplayed(bool)`. Avoid `updateSettings()` — it persists to a localStorage-backed global atom.
- Default settings already enable pattern highlighting and flash-on-eval (`isPatternHighlightingEnabled: true`, `isFlashEnabled: true`, theme `strudelTheme`, fontSize 18 — we override size/family/wrapping per editor).
- Ctrl+Enter → `evaluate()`, Ctrl+. → `stop()` keymaps are built into the editor.
- The active-event highlight decoration is `outline: solid 2px var(--foreground)` (per `highlight.mjs`), and the editor root background is painted with `var(--background)`. Both CSS variables can be overridden scoped to our editor container.
- `@strudel/codemirror@1.3.0` pins `@strudel/core@1.2.6`, `@strudel/transpiler@1.2.6`, `@strudel/tonal@1.2.6`, `superdough@1.3.0` — identical to this repo's pins, so no duplicate Strudel module instances.

---

### Task 1: Pure playing-state helper (TDD)

When one editor replaces another, solo mode fires two `onToggle` events (new start, old stop) in either order. This pure function decides the next `playingId` and must ignore stale stop events.

**Files:**
- Create: `src/playing-state.js`
- Test: `test/playing-state.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/playing-state.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { nextPlayingId } from '../src/playing-state.js';

describe('nextPlayingId', () => {
  it('sets the track id when a track starts', () => {
    expect(nextPlayingId(null, 'a', true)).toBe('a');
  });

  it('replaces the current track when another starts', () => {
    expect(nextPlayingId('a', 'b', true)).toBe('b');
  });

  it('clears when the playing track stops', () => {
    expect(nextPlayingId('a', 'a', false)).toBe(null);
  });

  it('ignores a stale stop from a replaced track (new start arrived first)', () => {
    // user switched a -> b; b's start event landed, then a's solo-stop lands late
    expect(nextPlayingId('b', 'a', false)).toBe('b');
  });

  it('stays null when a stop arrives with nothing playing', () => {
    expect(nextPlayingId(null, 'a', false)).toBe(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/playing-state.test.mjs`
Expected: FAIL — `Cannot find module '../src/playing-state.js'` (or equivalent resolve error).

- [ ] **Step 3: Write minimal implementation**

Create `src/playing-state.js`:

```js
// Pure transition for "which track is playing".
// Editors report scheduler toggle events (started/stopped). When one track
// replaces another, solo mode stops the old editor around the same time the
// new one starts, and the two events can land in either order — so a stop
// only clears the state if it belongs to the currently playing track.
export function nextPlayingId(current, trackId, started) {
  if (started) return trackId;
  return current === trackId ? null : current;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/playing-state.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: all tests pass (the 5 new ones plus every pre-existing test).

- [ ] **Step 6: Commit**

```bash
git add src/playing-state.js test/playing-state.test.mjs
git commit -m "feat: add nextPlayingId helper for editor toggle events"
```

---

### Task 2: Install @strudel/codemirror

**Files:**
- Modify: `package.json` (dependencies)

- [ ] **Step 1: Install the exact version**

Run: `npm install --save-exact @strudel/codemirror@1.3.0`
Expected: installs cleanly; `package.json` gains `"@strudel/codemirror": "1.3.0"` (exact pin, matching the other `@strudel/*` entries). The `postinstall` script (`scripts/fix-kabelsalat.mjs`) runs automatically — that is normal.

- [ ] **Step 2: Verify the bundle still builds**

Run: `npm run build`
Expected: vite build succeeds (this proves the new dependency tree resolves; the editor isn't imported anywhere yet).

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @strudel/codemirror 1.3.0"
```

---

### Task 3: Editor module

A thin wrapper that mounts one `StrudelMirror` per track and caches it. DOM-free callbacks (`onToggle`, `onError`) keep this module decoupled from `main.js` rendering.

**Files:**
- Create: `src/editor.js`

- [ ] **Step 1: Create `src/editor.js`**

```js
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
```

- [ ] **Step 2: Verify the module builds**

Run: `npm run build`
Expected: build succeeds. (`src/editor.js` isn't imported by `main.js` yet, so if vite tree-shakes it silently, that's fine — the real integration check happens in Task 4.)

- [ ] **Step 3: Commit**

```bash
git add src/editor.js
git commit -m "feat: editor module mounting StrudelMirror per track"
```

---

### Task 4: Wire main.js — cached code sections, lazy mount, play/stop through editors

**Files:**
- Modify: `src/main.js` (imports at line 1; `play`/`stop` at lines 24–39; the `code` block inside `trackCard()` at lines 156–160)

- [ ] **Step 1: Update imports**

In `src/main.js`, replace line 1:

```js
import { initStrudel, evaluate, hush } from '@strudel/web';
```

with:

```js
import { initStrudel } from '@strudel/web';
import { mountEditor, getEditor, isStarted } from './editor.js';
import { nextPlayingId } from './playing-state.js';
```

(`initStrudel` stays: it registers Strudel's functions on `globalThis` via evalScope and prebakes all sample banks — both shared by every editor.)

- [ ] **Step 2: Add code-section cache + editor wiring**

Insert after the `ready.then(...)` block (currently ends line 22):

```js
// --- code sections + editors ---------------------------------------------
// renderTracks() rebuilds every card with replaceChildren(), so the <details>
// holding each editor is cached per track and *moved* into the new card —
// preserving the CodeMirror instance, session-only edits, and open state.
const codeSections = new Map(); // trackId -> <details class="code">

function codeSection(track) {
  let section = codeSections.get(track.id);
  if (section) return section;
  section = document.createElement('details');
  section.className = 'code';
  section.innerHTML = `<summary>code</summary><p class="instruments"></p><p class="eval-error" hidden></p><div class="editor"></div>`;
  $('.instruments', section).textContent = (track.meta?.instruments ?? []).join(' · ');
  section.addEventListener('toggle', () => {
    if (section.open) ensureEditor(track); // lazy-mount on first open
  });
  codeSections.set(track.id, section);
  return section;
}

function ensureEditor(track) {
  return mountEditor({
    track,
    root: $('.editor', codeSection(track)),
    prebake: () => ready,
    onToggle: onEditorToggle,
    onError: onEditorError,
  });
}

function onEditorToggle(trackId, started) {
  const next = nextPlayingId(state.playingId, trackId, started);
  if (next === state.playingId) return;
  state.playingId = next;
  renderTracks();
  renderTransport();
}

function onEditorError(trackId, err) {
  const section = codeSections.get(trackId);
  if (section) {
    const msg = $('.eval-error', section);
    msg.textContent = err ? `✖ ${err.message}` : '';
    msg.hidden = !err;
  }
  // a failed eval that never started the scheduler must not leave a phantom
  // "now playing" state (a failed *re*-eval keeps the old pattern running)
  if (err && state.playingId === trackId && !isStarted(trackId)) {
    state.playingId = null;
    renderTracks();
    renderTransport();
  }
}
```

- [ ] **Step 3: Route play/stop through the editors**

Replace the existing `play`/`stop` functions (the block currently at lines 24–39, under the `// --- playback ...` comment):

```js
// --- playback (one StrudelMirror per track; solo mode keeps it exclusive) --
async function play(track) {
  state.playingId = track.id;
  renderTracks();
  renderTransport();
  await ready; // audio context unlocks via this click
  if (state.playingId !== track.id) return; // user moved on while samples loaded
  const editor = ensureEditor(track);
  codeSection(track).open = true; // reveal the editor so highlighting is visible
  editor.evaluate();
}

function stop() {
  getEditor(state.playingId)?.stop(); // onToggle clears state; next line covers the not-yet-evaluated case
  state.playingId = null;
  renderTracks();
  renderTransport();
}
```

- [ ] **Step 4: Use the cached section in `trackCard()`**

In `trackCard()`, replace the code-details block (currently lines 156–160):

```js
  const code = document.createElement('details');
  code.className = 'code';
  code.innerHTML = `<summary>code</summary><p class="instruments"></p><pre></pre>`;
  $('.instruments', code).textContent = (track.meta?.instruments ?? []).join(' · ');
  $('pre', code).textContent = track.code;
```

with:

```js
  const code = codeSection(track);
```

(`card.append(...)` then *moves* the cached `<details>` into the new card.)

- [ ] **Step 5: Verify build and tests**

Run: `npm run build && npm test`
Expected: build succeeds; all tests pass (the suite doesn't touch `src/main.js`, this is a regression check).

- [ ] **Step 6: Commit**

```bash
git add src/main.js
git commit -m "feat: per-track StrudelMirror playback with cached code sections"
```

---

### Task 5: Styling

**Files:**
- Modify: `src/style.css` (the `.code pre` rule at lines 125–129)

- [ ] **Step 1: Replace the `.code pre` rule**

Replace:

```css
.code pre {
  margin-top: 6px; padding: 10px; overflow-x: auto;
  background: var(--bg); border-left: 2px solid var(--acid);
  color: #b9c49a; white-space: pre-wrap;
}
```

with:

```css
.code .eval-error { color: var(--hot); font-size: 11px; margin: 6px 0 0; }
.code .editor {
  margin-top: 6px;
  border-left: 2px solid var(--acid);
  /* StrudelMirror paints the root with var(--background); the active-event
     highlight outline is `outline: solid 2px var(--foreground)` */
  --background: var(--bg);
  --foreground: var(--acid);
}
.code .editor .cm-editor { padding: 6px 4px; }
```

- [ ] **Step 2: Commit**

```bash
git add src/style.css
git commit -m "style: theme StrudelMirror editor to app palette"
```

---

### Task 6: Manual verification

The editor's behavior is browser-only; verify against the dev server.

- [ ] **Step 1: Start the dev server**

Run: `npm run dev` (API on :3001, vite on :5173). Open `http://localhost:5173`.

- [ ] **Step 2: Walk the checklist**

1. Click ▶ on a track → its code `<details>` opens, the editor shows the code, and once samples are ready, mini-notation tokens get acid-green outline flashes in time with the audio.
2. Open a *different* track's code details without playing → editor mounts, shows code, no audio.
3. Click ▶ on a second track while the first plays → first stops (solo mode), second plays, transport shows the second title, only the second card has the `playing` border.
4. Edit the playing track's code (e.g. change a sound name) and press **Ctrl+Enter** → flash, pattern changes audibly, highlighting follows the new code.
5. Make a syntax error (e.g. delete a closing `)`), press Ctrl+Enter → red `✖ …` message under the instruments line; fix it, Ctrl+Enter → message clears.
6. Press **STOP** in the transport → audio stops, no card shows playing state.
7. Switch batch filter while a track plays → cards re-render, playback continues, the playing track's editor (with any edits and highlighting) survives.
8. Reload the page → all code shows the stored JSON (session edits gone, as specced).

- [ ] **Step 3: Fix anything that fails**

If a step fails, use superpowers:systematic-debugging before patching. Known risk areas:
- Highlight color wrong → the theme may inject global `--foreground`; bump specificity of the `.code .editor` override.
- Editor invisible when details opens → CodeMirror sometimes needs a refresh when mounted hidden; if so, mount inside the `toggle` handler only when `section.open` is true (already the case) — confirm the root has height.

- [ ] **Step 4: Final commit (if fixes were needed)**

```bash
git add -A src/
git commit -m "fix: editor verification fixes"
```
