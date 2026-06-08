# Stem Versioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a stem have multiple versions (keeping the original) and add a webapp version-switcher on the card — each version shows its creation date and carries its own rating + notes — then ship a more-harmonic v2 of "Hollow Engine".

**Architecture:** A version is an ordinary stem JSON file with one new optional `versionOf` field pointing at the root stem's id. A pure client-side helper groups the flat `/api/stems` list into families (`family = versionOf ?? id`), and the webapp renders one card per family with a version switcher. No server, store, or validator changes.

**Tech Stack:** Vanilla JS + Vite, vitest, the existing file-backed store, Python Playwright for browser verification.

**Spec:** `docs/superpowers/specs/2026-06-08-stem-versioning-design.md`

---

## Verified facts (do not re-derive)

- `scripts/validate.mjs` `validateTrack` only checks `REQUIRED_FIELDS` + the `meta` schema + bpm↔setcpm. It **ignores unknown fields**, so `versionOf` needs no validator change and the v2 file validates as a normal stem.
- `server/store.mjs` `listTracks()` returns `{ ...track, ...rating }` — it spreads every field of the JSON file, so `versionOf` reaches the client automatically. Ratings live in `data/stem-ratings/<id>.json`, keyed by id; each version having its own id means per-version notes/ratings come for free. **No store change.**
- The webapp entry is `src/app.js`'s `initApp({apiBase, emptyHint})`. Today `renderTracks()` calls `visibleTracks()` → groups by `batch` → `trackCard(track)` per stem. `updatePlayingUi()` matches `card.dataset.id` against `state.playingId`. Editors are cached per id via `codeSection(track)` (`src/editor.js`).
- The Hollow Engine root stem is `stems/2026-06-08-alien-sounds-04.json`, id `2026-06-08-alien-sounds-04`, batch `2026-06-08-alien-sounds`, bpm 116, note: "initially sounds great but needs to be more harmonic".

## Execution environment (worktree)

Per the user, execute in a NEW worktree. At execution time use superpowers:using-git-worktrees. Repo specifics: `worktree.baseRef` points at `origin/main` but there is **no remote**, so a fresh-create can't resolve the base — create manually then enter:

```bash
git worktree add .claude/worktrees/stem-versioning -b stem-versioning main
# then EnterWorktree with path: .claude/worktrees/stem-versioning
npm install   # worktree needs its own node_modules
```

`.claude/worktrees/` is already ignored via `.git/info/exclude`. The user runs parallel Claude sessions against this checkout: never `git checkout` in the main repo; verify `git branch --show-current` before any commit outside the worktree; after merging, `npm install` in the main checkout if deps changed (this plan adds none).

## File structure

- `src/versions.js` — NEW. Pure `groupVersions(stems)` → families. One responsibility: grouping/ordering. Unit-tested.
- `test/versions.test.mjs` — NEW. Tests for `groupVersions`.
- `stems/2026-06-08-alien-sounds-04-v2.json` — NEW. The more-harmonic v2 file.
- `src/app.js` — MODIFY. Import `groupVersions`; replace `visibleTracks` with `visibleFamilies`; rewrite `trackCard(track)` → `trackCard(family)` with a version switcher; adapt `renderTracks`; add a `fmtDate` helper.
- `src/style.css` — MODIFY. Add `.versions` / `.version` switcher styles.

---

### Task 1: `groupVersions` pure helper (TDD)

**Files:**
- Create: `src/versions.js`
- Test: `test/versions.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/versions.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { groupVersions } from '../src/versions.js';

const stem = (id, extra = {}) => ({
  id, batch: 'b', title: id, prompt: 'p',
  createdAt: '2026-06-08T00:00:00Z', code: 's("bd")', meta: {}, ...extra,
});

describe('groupVersions', () => {
  it('makes each standalone stem its own single-version family', () => {
    const fams = groupVersions([stem('a'), stem('b')]);
    expect(fams.map((f) => f.family)).toEqual(['a', 'b']);
    expect(fams[0].versions).toHaveLength(1);
    expect(fams[0].versions[0].version).toBe(1);
    expect(fams[0].latest.id).toBe('a');
  });

  it('groups a root with its versionOf children into one family', () => {
    const root = stem('a', { createdAt: '2026-06-08T00:00:00Z' });
    const v2 = stem('a-v2', { versionOf: 'a', createdAt: '2026-06-08T01:00:00Z' });
    const fams = groupVersions([root, v2]);
    expect(fams).toHaveLength(1);
    expect(fams[0].family).toBe('a');
    expect(fams[0].versions.map((v) => v.id)).toEqual(['a', 'a-v2']);
    expect(fams[0].versions.map((v) => v.version)).toEqual([1, 2]);
    expect(fams[0].latest.id).toBe('a-v2');
  });

  it('orders versions by createdAt regardless of input order', () => {
    const v2 = stem('a-v2', { versionOf: 'a', createdAt: '2026-06-08T02:00:00Z' });
    const root = stem('a', { createdAt: '2026-06-08T00:00:00Z' });
    const fams = groupVersions([v2, root]); // child first
    expect(fams[0].versions.map((v) => v.id)).toEqual(['a', 'a-v2']);
    expect(fams[0].latest.id).toBe('a-v2');
  });

  it('preserves first-occurrence order across families', () => {
    const fams = groupVersions([stem('b'), stem('a'), stem('b-v2', { versionOf: 'b' })]);
    expect(fams.map((f) => f.family)).toEqual(['b', 'a']);
  });

  it('forms a family from an orphan version whose root is absent', () => {
    const fams = groupVersions([stem('x-v2', { versionOf: 'x' })]);
    expect(fams).toHaveLength(1);
    expect(fams[0].family).toBe('x');
    expect(fams[0].versions[0].version).toBe(1);
    expect(fams[0].latest.id).toBe('x-v2');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/versions.test.mjs`
Expected: FAIL — cannot resolve `../src/versions.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/versions.js`:

```js
// Group a flat stem list into version families.
// A version is a stem file with an optional `versionOf` pointing at its root
// stem's id; absent => the stem is its own root (version 1).
// family = versionOf ?? id. Within a family, versions are ordered by createdAt
// ascending and numbered 1..N; `latest` is the newest. Family array order
// follows first occurrence in the input (which the store sorts by filename).
export function groupVersions(stems) {
  const byFamily = new Map(); // family -> { family, versions: [] }
  for (const stem of stems) {
    const family = stem.versionOf ?? stem.id;
    if (!byFamily.has(family)) byFamily.set(family, { family, versions: [] });
    byFamily.get(family).versions.push(stem);
  }
  return [...byFamily.values()].map((fam) => {
    const versions = [...fam.versions]
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
      .map((v, i) => ({ ...v, version: i + 1 }));
    return { family: fam.family, versions, latest: versions[versions.length - 1] };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/versions.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: zero failures (existing tests + 5 new).

- [ ] **Step 6: Commit**

```bash
git add src/versions.js test/versions.test.mjs
git commit -m "feat: groupVersions helper for stem version families"
```

---

### Task 2: Generate the more-harmonic Hollow Engine v2

This task produces the data file. It is a generation task — dispatch a sub-agent (or do it inline) to write and validate the file.

**Files:**
- Create: `stems/2026-06-08-alien-sounds-04-v2.json`

- [ ] **Step 1: Generate the v2 file**

Dispatch a general-purpose agent with this prompt (work in the worktree root):

```
You are writing one Strudel STEM file: a more-harmonic version 2 of an existing
stem. Work in <worktree root>.

1. Read STEMS_GUIDE.md COMPLETELY and follow every rule (ONE star sound, an
   8–32 cycle morph arc, >=3 modulated dimensions, original transformed sound).
2. This is v2 of "Hollow Engine". The listener note on v1 was: "initially
   sounds great but needs to be more harmonic." The v1 code is:

   setcpm(116/4)
   stack(
     note("<c1 c1 eb1 <g0 bb0>>*2").s("sine")
       .fm(sine.slow(24).range(2, 13)).fmh("<1 1.5 2.01 0.5 3.99>/5")
       .penv("<0 0 7 -5>/8").pattack(0.002).pdecay(0.1)
       .lpf(sine.slow(31).range(180, 2600)).resonance(sine.slow(17).range(6, 17)).ftype("ladder")
       .lpenv(4).lpattack(0.008).lpdecay(0.18)
       .vib("<3 5 7>/8").vibmod(sine.slow(13).range(0.1, 0.9))
       .attack(0.005).decay(0.22).sustain(0.55).release(0.07)
       .shape(0.34).crush("<16 16 10 8>/16")
       .pan(sine.slow(11).range(0.3, 0.7))
       .off(1/8, x => x.add(note(12.05)).gain(0.28).pan(0.78).fm(9))
       .delay("0.4:0.375:0.6").room(0.25).gain(0.85)
   )

   Make it MORE HARMONIC while keeping the same FM-sine-bass identity, ladder
   filter, and morph arc: prefer harmonic-integer fmh ratios (e.g. 1, 2, 3, 4)
   over the inharmonic 2.01/3.99; tame the bitcrush so pitch reads clearly;
   reinforce pitch with consonant interval/chord-tone stacking (e.g. add a fifth
   or octave via .off(...).add(note(7)) / note(12)). Keep setcpm(116/4).
3. Write stems/2026-06-08-alien-sounds-04-v2.json with ALL required stem fields
   PLUS the version link:
     id "2026-06-08-alien-sounds-04-v2",
     versionOf "2026-06-08-alien-sounds-04",
     batch "2026-06-08-alien-sounds",
     prompt "alien sounds",
     title "Hollow Engine v2",
     createdAt "2026-06-08T22:30:00Z",
     description (1-3 sentences: the sound and how the v2 is more harmonic),
     meta { bpm 116, genre, mood, key (a real pitched key, not atonal),
            instruments, energy 1-5 },
     code (your revised Strudel code — single stack(), no arrange()).
4. Run: node scripts/validate.mjs stems/2026-06-08-alien-sounds-04-v2.json
   Fix and re-run until it PASSES (up to 3 attempts).
5. Reply with exactly: OK <id> "<title>"   or   FAILED <id> <reason>
```

- [ ] **Step 2: Confirm validation**

Run: `node scripts/validate.mjs stems/2026-06-08-alien-sounds-04-v2.json`
Expected: a `PASS ...` line.

- [ ] **Step 3: Confirm the version link is present**

Run: `node -e "const j=require('./stems/2026-06-08-alien-sounds-04-v2.json'); console.log(j.versionOf, j.id, j.meta.bpm)"`
Expected: `2026-06-08-alien-sounds-04 2026-06-08-alien-sounds-04-v2 116`

- [ ] **Step 4: Commit**

```bash
git add stems/2026-06-08-alien-sounds-04-v2.json
git commit -m "feat: more-harmonic Hollow Engine v2 (versionOf alien-sounds-04)"
```

---

### Task 3: Wire grouping + version switcher into the webapp

**Files:**
- Modify: `src/app.js`

- [ ] **Step 1: Import `groupVersions`**

In `src/app.js`, after the existing `import { exportTrack, isExporting } from './export.js';` line (currently line 8), add:

```js
import { groupVersions } from './versions.js';
```

- [ ] **Step 2: Add a date formatter**

In `src/app.js`, immediately after the `flashError` helper (the block ending with the `};` after `setTimeout(() => el.classList.remove('error'), 1200);`), add:

```js
  // short, human date for version labels, e.g. "Jun 8"
  const fmtDate = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? ''
      : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
```

- [ ] **Step 3: Replace `visibleTracks` with `visibleFamilies`**

In `src/app.js`, replace the entire `visibleTracks` function (currently):

```js
  function visibleTracks() {
    return state.tracks.filter((t) => {
      if (state.batch !== 'all' && t.batch !== state.batch) return false;
      if (state.filter === 'unrated') return t.rating == null;
      if (state.filter === 'top') return (t.rating ?? 0) >= 4;
      return true;
    });
  }
```

with:

```js
  // Group into version families, then filter by the LATEST version's props so a
  // whole family shows/hides as a unit (all versions share a batch).
  function visibleFamilies() {
    return groupVersions(state.tracks).filter((fam) => {
      const t = fam.latest;
      if (state.batch !== 'all' && t.batch !== state.batch) return false;
      if (state.filter === 'unrated') return t.rating == null;
      if (state.filter === 'top') return (t.rating ?? 0) >= 4;
      return true;
    });
  }
```

- [ ] **Step 4: Rewrite `trackCard(track)` → `trackCard(family)`**

In `src/app.js`, replace the ENTIRE `trackCard` function (from `function trackCard(track) {` through its closing `}` before `function renderTracks()`) with this. It builds the card body for the active version and re-mounts in place when the user switches versions:

```js
  function trackCard(family) {
    const card = document.createElement('article');
    card.className = 'track';
    let active = family.latest; // spec: default to the latest version

    mountBody();
    return card;

    function mountBody() {
      card.dataset.id = active.id;
      card.classList.toggle('playing', active.id === state.playingId);
      const track = active; // body below is per-version, keyed on `active`

      const playBtn = document.createElement('button');
      playBtn.className = 'play';
      playBtn.innerHTML =
        track.id === state.playingId
          ? '<span class="eq"><i></i><i></i><i></i></span>'
          : '▶';
      playBtn.title = track.id === state.playingId ? 'stop' : 'play';
      playBtn.addEventListener('click', () =>
        track.id === state.playingId ? stop() : play(track),
      );

      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.innerHTML = `<h3></h3><span class="id"></span><p class="desc"></p><div class="chips"></div>`;
      $('h3', meta).textContent = track.title;
      $('.id', meta).textContent = track.id;
      $('.desc', meta).textContent = track.description ?? '';
      const m = track.meta ?? {};
      const chips = $('.chips', meta);
      const chipValues = [
        m.genre,
        m.bpm && `${m.bpm} bpm`,
        m.key,
        m.energy && '▮'.repeat(Math.min(m.energy, 5)) + '▯'.repeat(Math.max(0, 5 - m.energy)),
        m.mood,
      ].filter(Boolean);
      for (const value of chipValues) {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = value;
        chips.appendChild(chip);
      }

      // version switcher — only when the family has more than one version
      if (family.versions.length > 1) {
        const versions = document.createElement('div');
        versions.className = 'versions';
        for (const v of family.versions) {
          const b = document.createElement('button');
          b.className = 'version' + (v.id === active.id ? ' on' : '');
          b.textContent = `v${v.version} · ${fmtDate(v.createdAt)}`;
          b.title = `version ${v.version} — ${v.createdAt}`;
          b.addEventListener('click', () => {
            if (v.id === active.id) return;
            active = v;
            mountBody();
          });
          versions.appendChild(b);
        }
        meta.appendChild(versions);
      }

      const exportRow = document.createElement('div');
      exportRow.className = 'exports';
      for (const fmt of ['wav', 'mp3']) {
        const btn = document.createElement('button');
        btn.className = 'export';
        btn.textContent = `↓ ${fmt}`;
        btn.title = fmt === 'wav' ? 'download lossless wav' : 'download mp3 192kbps';
        btn.addEventListener('click', async () => {
          if (isExporting()) return;
          document.querySelectorAll('button.export').forEach((el) => (el.disabled = true));
          const label = btn.textContent;
          try {
            await exportTrack(track, fmt, {
              stopPlayback: stop,
              onStatus: (s) => (btn.textContent = s),
            });
          } catch (err) {
            console.error(err);
            flashError(card);
          } finally {
            btn.textContent = label;
            document.querySelectorAll('button.export').forEach((el) => (el.disabled = false));
          }
        });
        exportRow.appendChild(btn);
      }
      meta.appendChild(exportRow);

      const rate = document.createElement('div');
      rate.className = 'rate';
      for (let n = 1; n <= 5; n++) {
        const b = document.createElement('button');
        b.className = 'block' + (track.rating != null && n <= track.rating ? ' on' : '');
        b.title = `${n}/5`;
        b.addEventListener('click', async () => {
          try {
            await putRating(track, { rating: track.rating === n ? null : n });
          } catch (err) {
            console.error(err);
            flashError(card);
            return;
          }
          rate.querySelectorAll('.block').forEach((el, i) =>
            el.classList.toggle('on', track.rating != null && i < track.rating),
          );
        });
        rate.appendChild(b);
      }

      const autosaveArea = (className, placeholder, value, field) => {
        const ta = document.createElement('textarea');
        ta.className = className;
        ta.placeholder = placeholder;
        ta.value = value ?? '';
        const save = debounce(async () => {
          try {
            await putRating(track, { [field]: ta.value });
            ta.classList.add('saved');
            setTimeout(() => ta.classList.remove('saved'), 600);
          } catch (err) {
            console.error(err);
            flashError(ta);
          }
        }, 600);
        ta.addEventListener('input', save);
        return ta;
      };

      const feedback = document.createElement('div');
      feedback.className = 'feedback';
      feedback.append(
        autosaveArea('notes', 'notes — what works, what to change… (this track only)', track.notes, 'notes'),
        autosaveArea('notes lesson', 'lesson for future tracks — applies to every new batch…', track.lesson, 'lesson'),
      );

      const code = codeSection(track);

      card.replaceChildren(playBtn, meta, rate, feedback, code);
    }
  }
```

- [ ] **Step 5: Update `renderTracks` to iterate families**

In `src/app.js`, replace the body of `renderTracks` (currently it calls `visibleTracks()`, groups by `t.batch`, and calls `trackCard(t)`) with:

```js
  function renderTracks() {
    const main = $('#tracks');
    main.replaceChildren();
    const families = visibleFamilies();
    if (families.length === 0) {
      main.innerHTML = `<p class="empty">nothing here — ${emptyHint}</p>`;
      return;
    }
    const byBatch = new Map();
    for (const fam of families) {
      const batch = fam.latest.batch;
      if (!byBatch.has(batch)) byBatch.set(batch, []);
      byBatch.get(batch).push(fam);
    }
    for (const [batch, list] of [...byBatch.entries()].sort().reverse()) {
      const section = document.createElement('section');
      section.className = 'batch';
      const h2 = document.createElement('h2');
      h2.textContent = batch;
      const promptSpan = document.createElement('span');
      promptSpan.textContent = list[0].latest.prompt;
      h2.appendChild(promptSpan);
      section.appendChild(h2);
      list.forEach((fam) => section.appendChild(trackCard(fam)));
      main.appendChild(section);
    }
  }
```

- [ ] **Step 6: Build and test**

Run: `npm run build && npm test`
Expected: build succeeds; zero test failures. (The suite doesn't import `src/app.js`; this is a regression check.)

- [ ] **Step 7: Commit**

```bash
git add src/app.js
git commit -m "feat: per-family cards with version switcher in the webapp"
```

---

### Task 4: Version-switcher styles

**Files:**
- Modify: `src/style.css`

- [ ] **Step 1: Add switcher CSS**

Append to `src/style.css`:

```css
.versions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.version {
  background: transparent; color: var(--dim);
  border: 1px solid var(--line); font-family: var(--mono); font-size: 11px;
  padding: 2px 8px; cursor: pointer;
}
.version:hover { color: var(--acid); border-color: var(--acid); }
.version.on { background: var(--acid); color: var(--bg); border-color: var(--acid); }
```

- [ ] **Step 2: Commit**

```bash
git add src/style.css
git commit -m "style: version switcher buttons"
```

---

### Task 5: Browser verification

The switcher is browser-only. Verify with Python Playwright (`/usr/local/opt/python@3.11/bin/python3.11`, Chromium cached). The v2 file lives only in the worktree, so the worktree needs its OWN API+web pair on free ports (the user's live :3001/:5173 serve the main checkout and must not be touched — parallel sessions). Capture `console` messages (headless is deaf — "not found" in console is the only audio-failure signal).

- [ ] **Step 1: Serve the worktree app on a free port pair**

The worktree `vite.config.js` proxies `/api` to `http://localhost:3001`. Point it at a worktree API on 3002 instead — edit the worktree's `vite.config.js` proxy target from `'http://localhost:3001'` to `'http://localhost:3002'` (worktree-local; revert before finishing so it isn't committed). Then start both in the background:

```
PORT=3002 node server/index.mjs        # worktree API serving worktree stems/
npx vite --port 5274 --strictPort      # worktree web, proxying /api -> :3002
```

Confirm both stems are served:
`curl -s 'http://localhost:5274/api/stems' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=JSON.parse(s);console.log(a.filter(x=>x.id.includes('alien-sounds-04')).map(x=>x.id))})"`
Expected: includes both `2026-06-08-alien-sounds-04` and `2026-06-08-alien-sounds-04-v2`.

- [ ] **Step 2: Drive and assert**

Write and run a Playwright script against `http://localhost:5274/stems` that:
1. Waits for `.track` cards and `#status.ready`.
2. Locates the Hollow Engine family card (the card whose `.versions` contains a `v2` button, or whose `.id` shows `...-04-v2` by default since latest is shown). Asserts a `.versions` switcher exists with exactly 2 buttons labeled `v1 · …` and `v2 · …`, each showing a month/day date.
3. Asserts the default-shown version is v2 (`card.dataset.id` ends with `-v2`, the `v2` button has class `on`).
4. Clicks the `v1` button → asserts `card.dataset.id` becomes `2026-06-08-alien-sounds-04`, the `.desc`/chips update, and opening the code `<details>` shows v1's code (contains `2.01` or `3.99` from the inharmonic v1; v2 should NOT).
5. Picks any single-version stem card → asserts it has NO `.versions` switcher.
6. Saves a note on the v2 (type into its `.notes`, wait for debounce ~700ms) → asserts `data/stem-ratings/2026-06-08-alien-sounds-04-v2.json` is written and `data/stem-ratings/2026-06-08-alien-sounds-04.json` is unchanged (v1's note preserved).
7. Reports zero uncaught page errors.

- [ ] **Step 3: Judge and fix**

All green → done. Any failure → use superpowers:systematic-debugging. Known risk areas:
- If switching versions while v1 plays drops the card's "playing" highlight: that's accepted behavior (audio continues; transport still names it) — do not treat as a failure.
- Editor not showing on a freshly-switched version: `codeSection(active)` mounts lazily on `<details>` open; confirm opening the details after switching renders the active version's code.

- [ ] **Step 4: Stop the servers; revert the proxy edit; commit any fixes**

Stop the background API/vite processes. Revert the worktree `vite.config.js` proxy target back to `'http://localhost:3001'` (it was a verification-only edit) and confirm `git status` shows `vite.config.js` clean.

```bash
git add -A src/ stems/
git commit -m "fix: stem versioning verification fixes"   # only if fixes were needed
```
