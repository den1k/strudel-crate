# Revise-From-Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/revise-from-notes <stems|tracks>` skill that generates a new version of every item whose latest version carries a note, plus a Step 0 that auto-runs it inside `/generate-stems` and `/generate-tracks`.

**Architecture:** A pure `pendingRevisions(items)` helper (in `src/versions.js`, reusing `groupVersions`) selects families whose latest version has a non-empty note and computes the next version id. A thin CLI (`scripts/pending-revisions.mjs`) prints that work list as JSON from the file-backed store. A model-driven skill reads the list and dispatches one agent per item to write+validate a `<root>-v{N}.json` with `versionOf`. The two generate skills gain a Step 0 invoking it.

**Tech Stack:** Vanilla JS (ESM), the existing `createStore` file-backed store, `scripts/validate.mjs`, vitest, model-driven `.claude/skills/*` (parallel agent dispatch).

**Spec:** `docs/superpowers/specs/2026-06-15-revise-from-notes-design.md`

---

## Verified facts (do not re-derive)

- `groupVersions(items)` (`src/versions.js`) returns families `{ family, versions: [{...item, version: n}], latest }`; `versions` sorted by `createdAt` ascending, so `versions[0]` is the root (v1) and `latest` is the newest with `latest.version` set.
- `createStore({tracksDir, ratingsDir}).listTracks()` (`server/store.mjs`) returns each item spread with its rating: `{ ...item, rating, notes, lesson }`. So `notes` is present on every item. Stems live in `stems/` + `data/stem-ratings/`; tracks in `tracks/` + `data/ratings/`.
- `scripts/feedback.mjs` is the CLI pattern to mirror: `process.argv[2] === 'stems' ? stems-store : tracks-store`, guarded by the `fileURLToPath(import.meta.url)` main check.
- `scripts/validate.mjs <path>` prints a `PASS ...` or `FAIL ...` line and is the generation contract.
- Both generate skills start their workflow with `## Workflow` then `1. **Read ... GUIDE.md**`. Stems guide = `STEMS_GUIDE.md`; tracks guide = `STRUDEL_GUIDE.md`.
- A scripts/ file importing `../src/versions.js` is fine — `versions.js` is pure ESM with no DOM/browser dependencies.

## Execution environment (worktree)

Execute in a NEW worktree (superpowers:using-git-worktrees at execution time). Repo specifics: `worktree.baseRef` = `origin/main` but there is NO remote, so fresh-create can't resolve the base — create manually then enter:

```bash
git worktree add .claude/worktrees/revise-from-notes -b revise-from-notes main
# then EnterWorktree with path: .claude/worktrees/revise-from-notes
npm install
```

`.claude/worktrees/` is already ignored via `.git/info/exclude`. The user runs parallel Claude sessions: never `git checkout` in the main repo; verify `git branch --show-current` before any commit outside the worktree. This plan adds no dependencies.

## File structure

- `src/versions.js` — MODIFY: add `pendingRevisions(items)` beside `groupVersions`.
- `test/versions.test.mjs` — MODIFY: add a `pendingRevisions` describe block.
- `scripts/pending-revisions.mjs` — NEW: CLI printing the work list as JSON.
- `.claude/skills/revise-from-notes/SKILL.md` — NEW: the orchestration skill.
- `.claude/skills/generate-stems/SKILL.md` — MODIFY: add Step 0.
- `.claude/skills/generate-tracks/SKILL.md` — MODIFY: add Step 0.

---

### Task 1: `pendingRevisions` selector (TDD)

**Files:**
- Modify: `src/versions.js`
- Test: `test/versions.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append this block to `test/versions.test.mjs` (the file already imports from `../src/versions.js` and defines a `stem(id, extra)` helper — extend the import and reuse the helper):

First, update the import line at the top of the file from:

```js
import { groupVersions } from '../src/versions.js';
```

to:

```js
import { groupVersions, pendingRevisions } from '../src/versions.js';
```

Then append:

```js
describe('pendingRevisions', () => {
  it('selects a single-version stem whose latest has a note → -v2', () => {
    const work = pendingRevisions([
      stem('a', { title: 'Aaa', notes: 'more harmonic', code: 's("bd")', batch: 'bt', prompt: 'pr' }),
    ]);
    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({
      root: 'a', nextId: 'a-v2', version: 2,
      note: 'more harmonic', code: 's("bd")', batch: 'bt', prompt: 'pr', title: 'Aaa',
    });
  });

  it('numbers the next version off the latest and titles off the ROOT', () => {
    const work = pendingRevisions([
      stem('a', { title: 'Aaa', createdAt: '2026-06-08T00:00:00Z' }),
      stem('a-v2', { versionOf: 'a', title: 'Aaa v2', createdAt: '2026-06-08T01:00:00Z', notes: 'darker' }),
    ]);
    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({ root: 'a', nextId: 'a-v3', version: 3, note: 'darker', title: 'Aaa' });
  });

  it('ignores a note on a non-latest version', () => {
    const work = pendingRevisions([
      stem('a', { createdAt: '2026-06-08T00:00:00Z', notes: 'old note on v1' }),
      stem('a-v2', { versionOf: 'a', createdAt: '2026-06-08T01:00:00Z' }), // latest, no note
    ]);
    expect(work).toEqual([]);
  });

  it('skips whitespace-only and empty notes', () => {
    const work = pendingRevisions([
      stem('a', { notes: '   ' }),
      stem('b', { notes: '' }),
      stem('c', {}),
    ]);
    expect(work).toEqual([]);
  });

  it('trims the note in the work item', () => {
    const work = pendingRevisions([stem('a', { notes: '  punchier  ' })]);
    expect(work[0].note).toBe('punchier');
  });

  it('returns one work item per qualifying family', () => {
    const work = pendingRevisions([
      stem('a', { notes: 'x' }),
      stem('b', {}),
      stem('c', { notes: 'y' }),
    ]);
    expect(work.map((w) => w.root)).toEqual(['a', 'c']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/versions.test.mjs`
Expected: FAIL — `pendingRevisions` is not exported / not a function.

- [ ] **Step 3: Implement**

Append to `src/versions.js`:

```js
// Select families whose LATEST version carries a non-empty note and describe
// the next version to generate. Linear chains mean "latest with a note" == "a
// noted item that hasn't had a newer version yet". The new version's title is
// based on the ROOT (v1) title so suffixes don't stack ("Aaa v3", not "Aaa v2 v3").
export function pendingRevisions(items) {
  return groupVersions(items)
    .filter((fam) => fam.latest.notes?.trim())
    .map((fam) => {
      const version = fam.latest.version + 1;
      return {
        root: fam.family,
        nextId: `${fam.family}-v${version}`,
        version,
        note: fam.latest.notes.trim(),
        code: fam.latest.code,
        batch: fam.latest.batch,
        prompt: fam.latest.prompt,
        title: fam.versions[0].title,
      };
    });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/versions.test.mjs`
Expected: PASS (the 5 existing groupVersions tests + 6 new pendingRevisions tests).

- [ ] **Step 5: Full suite**

Run: `npm test`
Expected: zero failures.

- [ ] **Step 6: Commit**

```bash
git add src/versions.js test/versions.test.mjs
git commit -m "feat: pendingRevisions — select noted leaves needing a new version"
```

---

### Task 2: `pending-revisions.mjs` CLI

**Files:**
- Create: `scripts/pending-revisions.mjs`

- [ ] **Step 1: Create the CLI**

Create `scripts/pending-revisions.mjs`:

```js
// Print the note-driven revision work list as JSON, consumed by the
// revise-from-notes skill. Usage: node scripts/pending-revisions.mjs <stems|tracks>
import { fileURLToPath } from 'node:url';
import { createStore } from '../server/store.mjs';
import { pendingRevisions } from '../src/versions.js';

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const store = process.argv[2] === 'stems'
    ? createStore({ tracksDir: 'stems', ratingsDir: 'data/stem-ratings' })
    : createStore({ tracksDir: 'tracks', ratingsDir: 'data/ratings' });
  console.log(JSON.stringify(pendingRevisions(await store.listTracks()), null, 2));
}
```

- [ ] **Step 2: Verify it runs and emits JSON**

Run: `node scripts/pending-revisions.mjs stems`
Expected: prints a JSON array (likely `[]` on a fresh worktree — the Hollow Engine note is on v1 whose latest v2 has no note, so it is correctly NOT listed). No error.

Run: `node scripts/pending-revisions.mjs tracks`
Expected: prints a JSON array, no error.

- [ ] **Step 3: Confirm the selector wiring end-to-end with a temporary note**

Run this one-liner to prove a noted leaf surfaces (it writes a temp stem-rating, runs the CLI, then deletes the temp rating):

```bash
mkdir -p data/stem-ratings && \
printf '{"id":"2026-06-08-dirty-bass-01","rating":3,"notes":"punchier","lesson":"","updatedAt":"2026-06-15T00:00:00Z"}\n' > data/stem-ratings/2026-06-08-dirty-bass-01.json && \
node scripts/pending-revisions.mjs stems | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const w=JSON.parse(s).find(x=>x.root==='2026-06-08-dirty-bass-01');console.log('nextId:',w?.nextId,'| version:',w?.version,'| note:',w?.note)})" && \
rm -f data/stem-ratings/2026-06-08-dirty-bass-01.json
```

Expected: `nextId: 2026-06-08-dirty-bass-01-v2 | version: 2 | note: punchier`

- [ ] **Step 4: Commit**

```bash
git add scripts/pending-revisions.mjs
git commit -m "feat: pending-revisions CLI emitting the note-driven work list"
```

---

### Task 3: The `revise-from-notes` skill

**Files:**
- Create: `.claude/skills/revise-from-notes/SKILL.md`

- [ ] **Step 1: Create the skill file**

Create `.claude/skills/revise-from-notes/SKILL.md` with exactly:

```markdown
---
name: revise-from-notes
description: Generate a new version of every stem/track whose latest version has a listener note, honoring that note. Use when the user wants to act on notes, regenerate versions from feedback, or revise noted items. Also auto-runs as Step 0 of /generate-stems and /generate-tracks. Args: <stems|tracks>
---

# Revise From Notes

For the chosen collection, generate one new VERSION of every item whose latest
version carries a non-empty note, with the new version honoring that note. A note
is a per-item request for change; the new version supersedes the noted one.

## Workflow

1. **Resolve the collection** from the argument: `stems` or `tracks` (default to
   `tracks` if absent). Set:
   - stems → dir `stems/`, guide `STEMS_GUIDE.md`
   - tracks → dir `tracks/`, guide `STRUDEL_GUIDE.md`

2. **Read the guide** (`STEMS_GUIDE.md` or `STRUDEL_GUIDE.md`) in full (Read
   tool). Agents must read it themselves too — your prompt tells them to.

3. **Get the work list:** run `node scripts/pending-revisions.mjs <collection>`.
   It prints a JSON array; each item is
   `{ root, nextId, version, note, code, batch, prompt, title }`. If the array is
   empty, report "Nothing to revise — no noted items pending." and STOP.

4. **Get a timestamp** for the new versions: `date -u +%Y-%m-%dT%H:%M:%SZ`.

5. **Fan out agents:** dispatch ALL agents for a wave in a SINGLE message
   (parallel tool calls), waves of at most 8. Each agent gets this prompt with
   placeholders filled from one work item:

   ```
   You are writing exactly one Strudel <collection-singular> file: a new VERSION
   of an existing one that honors a listener note. Work in <repo root>.

   1. Read <guide> COMPLETELY and follow every rule in it.
   2. This is version {version} of "{title}". The listener note to honor is:
      "{note}". The current (latest) version's code is:

      {code}

      Revise it to honor the note while keeping the same core identity. Change
      enough to address the note; do not just copy the code.
   3. Write <dir>/{nextId}.json with ALL required fields PLUS the version link:
      id "{nextId}", versionOf "{root}", batch "{batch}", prompt "{prompt}",
      title "{title} v{version}", createdAt "{timestamp}",
      description (1-3 sentences: the sound/track and how this version answers
      the note), meta {...the full required meta object...}, code (your revised
      Strudel code).
   4. Run: node scripts/validate.mjs <dir>/{nextId}.json
      If FAIL: read the error, fix (for unknown sounds grep scripts/sounds.json),
      re-run. Up to 3 attempts. If still failing, delete the file
      (rm <dir>/{nextId}.json).
   5. Reply with EXACTLY one line:
      OK {nextId} "{title} v{version}"  — or —  FAILED {nextId} <one-line reason>
   ```

6. **Report:** a table (nextId · title · status), the count of versions written,
   and any failures with reasons.

## Notes

- Validation is the contract: a version only exists if `validate.mjs` passes it.
- Never edit `scripts/sounds.json` to make a file pass — change the file.
- The new version starts with no rating/notes, so the next run will not
  re-trigger it. The original note stays on its (now superseded) version.
- `<collection-singular>` is "STEM" for stems, "TRACK" for tracks.
```

- [ ] **Step 2: Sanity-check the skill is discoverable**

Run: `node -e "const fs=require('fs');const s=fs.readFileSync('.claude/skills/revise-from-notes/SKILL.md','utf8');console.log(/^---[\s\S]*name: revise-from-notes[\s\S]*description:[\s\S]*---/.test(s) ? 'frontmatter OK' : 'FRONTMATTER BAD')"`
Expected: `frontmatter OK`

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/revise-from-notes/SKILL.md
git commit -m "feat: revise-from-notes skill — agent-driven version regeneration"
```

---

### Task 4: Auto-run Step 0 in the generate skills

**Files:**
- Modify: `.claude/skills/generate-stems/SKILL.md`
- Modify: `.claude/skills/generate-tracks/SKILL.md`

- [ ] **Step 1: Add Step 0 to generate-stems**

In `.claude/skills/generate-stems/SKILL.md`, find:

```
## Workflow

1. **Read `STEMS_GUIDE.md`** in full (Read tool). Agents must read it themselves
   too — your prompt tells them to.
```

Replace with:

```
## Workflow

0. **Revise from notes first:** run the `revise-from-notes` skill with argument
   `stems` to bring any noted stems up to date with a new version before
   generating the new batch. (It is a no-op if nothing is noted.)

1. **Read `STEMS_GUIDE.md`** in full (Read tool). Agents must read it themselves
   too — your prompt tells them to.
```

- [ ] **Step 2: Add Step 0 to generate-tracks**

In `.claude/skills/generate-tracks/SKILL.md`, find:

```
## Workflow

1. **Read `STRUDEL_GUIDE.md`** in full (Read tool). Agents must read it themselves
   too — your prompt tells them to.
```

Replace with:

```
## Workflow

0. **Revise from notes first:** run the `revise-from-notes` skill with argument
   `tracks` to bring any noted tracks up to date with a new version before
   generating the new batch. (It is a no-op if nothing is noted.)

1. **Read `STRUDEL_GUIDE.md`** in full (Read tool). Agents must read it themselves
   too — your prompt tells them to.
```

- [ ] **Step 3: Verify both edits landed**

Run: `grep -c "Revise from notes first" .claude/skills/generate-stems/SKILL.md .claude/skills/generate-tracks/SKILL.md`
Expected: each file reports `1`.

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/generate-stems/SKILL.md .claude/skills/generate-tracks/SKILL.md
git commit -m "feat: auto-run revise-from-notes as Step 0 of both generate skills"
```

---

### Task 5: End-to-end verification

Exercise the real flow once: a noted leaf → a validated `-v2` with `versionOf`.

- [ ] **Step 1: Seed a temporary note on a single-version stem**

Pick `2026-06-08-dirty-bass-01` (present in the worktree from main). Write a note rating:

```bash
mkdir -p data/stem-ratings
printf '{"id":"2026-06-08-dirty-bass-01","rating":4,"notes":"make it punchier and add more sub weight","lesson":"","updatedAt":"2026-06-15T00:00:00Z"}\n' > data/stem-ratings/2026-06-08-dirty-bass-01.json
```

- [ ] **Step 2: Confirm the CLI lists it**

Run: `node scripts/pending-revisions.mjs stems | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const w=JSON.parse(s).find(x=>x.root==='2026-06-08-dirty-bass-01');console.log(JSON.stringify(w))})"`
Expected: a JSON object with `nextId: "2026-06-08-dirty-bass-01-v2"`, `version: 2`, the note, and the original code/title.

- [ ] **Step 3: Generate the version via one agent**

Dispatch a single general-purpose agent with the revise-from-notes agent prompt (from Task 3 Step 1), filled from the Step 2 work item: collection stems, guide `STEMS_GUIDE.md`, dir `stems/`, the `nextId`/`root`/`version`/`note`/`code`/`batch`/`prompt`/`title`, and a `createdAt` from `date -u +%Y-%m-%dT%H:%M:%SZ`. Let it write `stems/2026-06-08-dirty-bass-01-v2.json` and validate.

- [ ] **Step 4: Confirm the artifact**

Run: `node scripts/validate.mjs stems/2026-06-08-dirty-bass-01-v2.json && node -e "const j=require('./stems/2026-06-08-dirty-bass-01-v2.json');console.log('versionOf:',j.versionOf,'| title:',j.title)"`
Expected: a `PASS ...` line, then `versionOf: 2026-06-08-dirty-bass-01 | title: <original> v2`.

- [ ] **Step 5: Confirm idempotency**

Run: `node scripts/pending-revisions.mjs stems | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const hit=JSON.parse(s).some(x=>x.root==='2026-06-08-dirty-bass-01');console.log('still pending:',hit)})"`
Expected: `still pending: false` — the new latest (`-v2`) has no note, so the family is no longer selected.

- [ ] **Step 6: Clean up verification artifacts**

The seeded note and the generated test version are verification-only — remove them so the branch merges only the feature code:

```bash
rm -f data/stem-ratings/2026-06-08-dirty-bass-01.json stems/2026-06-08-dirty-bass-01-v2.json
git status --short   # expect: clean (only committed feature files differ from main)
```

Expected: no untracked/modified files remain from verification.

- [ ] **Step 7: Final suite + build**

Run: `npm test && npm run build`
Expected: zero test failures; build succeeds.
