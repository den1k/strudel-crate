# Concurrent Job Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the generation job runner run up to N jobs (default 2) in parallel — including two jobs in the same collection — instead of strictly one at a time.

**Architecture:** Today `server/runner.mjs` serializes everything with a single `running` boolean, and it attributes a job's output by diffing the whole namespace's slug set before vs. after the run (`itemSlugs` → `diffNew`). That diff cross-contaminates when two jobs touch the same namespace at once. We replace it with **job-scoped attribution**: every created row is stamped with the runner job's id (via a `CRATE_JOB_ID` env var that flows through the `claude` child → sub-agents → `save-*.mjs` → `insertItem`), and the runner reads back only its own rows with a new `itemsByJob` query. Once attribution is job-local, we swap the single boolean for an `active` counter capped at `maxConcurrent`. The generation **skills are not touched** — env flows through the process tree exactly like the existing `CRATE_AUTHOR_PROFILE_ID`.

**Tech Stack:** Node ESM, Express, InstantDB admin SDK (`@instantdb/admin`), Vitest. Frontend is vanilla JS + Vite.

## Global Constraints

- Node ESM throughout (`.mjs`, `import`/`export`). No TypeScript in `server/` or `scripts/` (only `instant.schema.ts`/`instant.perms.ts` are TS).
- Test runner is Vitest. Full suite: `npm test`. Single file: `npx vitest run <path>`. Single case: `npx vitest run <path> -t '<name>'`.
- Tests must not depend on the network: they use `test/fake-admin.mjs`, which supports only equality `where`, dotted-key `where` (`'user.id'`), and `{ field: { $in: [...] } }`. The new `where: { jobId }` is plain equality — already supported.
- The new schema field is **additive and optional** (`i.string().indexed().optional()`); pushing it to the shared live Instant app is safe and non-destructive. The push needs `INSTANT_APP_ID` + `INSTANT_ADMIN_TOKEN` from `/home/builder/apps/crate/.env`.
- `insertItem` reads `process.env.CRATE_JOB_ID` directly (mirrors how `save-stem.mjs`/`save-track.mjs` already read `CRATE_AUTHOR_PROFILE_ID`). Tests that set it MUST clear it in a `finally` so they don't leak into other tests.
- End every git commit message with this trailer (two lines, blank line before it):

  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```
- This is code-modifying work on a git repo: per the project rule, execute it inside an isolated git worktree (the execution sub-skill handles this).

## File Structure

| File | Change | Responsibility after change |
|------|--------|------------------------------|
| `instant.schema.ts` | Modify (`itemFields`) | Adds the indexed optional `jobId` field to `tracks` + `stems`. |
| `server/instant.mjs` | Modify (`insertItem`) + add `itemsByJob` | `insertItem` stamps `jobId` from env; `itemsByJob` reads a job's own rows. |
| `server/runner.mjs` | Modify (`runOne`, `runClaude`, `liveProduced`, `createRunner`/`pump`; remove `diffNew`) | Job-scoped attribution + N-slot concurrency. |
| `server/index.mjs` | Modify (`progressFor`, `createRunner` call) | Wires job-scoped progress + the concurrency cap from env. |
| `test/instant.test.mjs` | Modify | Tests for `jobId` stamping + `itemsByJob`. |
| `test/runner.test.mjs` | Modify | Drops `diffNew`/baseline tests; adds env, attribution, concurrency tests. |

**Out of scope (verified, no change needed):** `.claude/skills/**` (env flows through the process tree), `scripts/save-stem.mjs` / `scripts/save-track.mjs` (call `insertItem` unchanged), `scripts/lib/instant.mjs` (re-exports `server/instant.mjs`, so it picks up `itemsByJob` and the new `insertItem` for free), `instant.perms.ts` (the new field needs no rule — `view` already covers it), `src/jobs-ui.js` / `src/notifications.js` (consume `job.produced`, whose shape is unchanged), `test/api.test.mjs` (uses a stub `progressFor`).

---

## Task 1: Add the `jobId` schema field and push it

**Files:**
- Modify: `instant.schema.ts:7-24` (the shared `itemFields` object)

**Interfaces:**
- Consumes: nothing.
- Produces: a `jobId` attribute on both `tracks` and `stems`, queryable via `where: { jobId }` (indexed). Tasks 2-5 depend on this field existing in the live app.

- [ ] **Step 1: Add the field to `itemFields`**

In `instant.schema.ts`, add one line to the `itemFields` object (after `remixOf`, line 23):

```typescript
const itemFields = {
  slug: i.string().unique().indexed(), // human id, e.g. "2026-06-03-seed-01"
  title: i.string(),
  prompt: i.string(),
  batch: i.string().indexed(),
  description: i.string(),
  code: i.string(),
  meta: i.json(), // { bpm, genre, mood, key, instruments: string[], energy }
  createdAt: i.string().indexed(), // ISO 8601 — sorts chronologically lexicographically
  isPublic: i.boolean().indexed(),
  versionOf: i.string().indexed().optional(), // root slug for v2+, absent for v1
  notes: i.string().optional(), // per-item notes
  lesson: i.string().optional(), // cross-batch lesson
  playCount: i.number().optional(), // total plays across everyone; absent ⇒ 0
  ratingSum: i.number().optional(),   // sum of all users' ratings; absent ⇒ 0
  ratingCount: i.number().optional(), // number of users who rated; absent ⇒ 0
  remixOf: i.string().indexed().optional(), // source root slug when this item is a remix
  jobId: i.string().indexed().optional(), // runner job that created this row; for per-job attribution + progress
};
```

- [ ] **Step 2: Push the schema to the live Instant app**

Run (the `.env` already holds the credentials; the push is additive/non-destructive):

```bash
set -a; . ./.env; set +a
npx instant-cli push schema --app "$INSTANT_APP_ID" --token "$INSTANT_ADMIN_TOKEN" --yes
```

Expected: CLI reports adding attribute `jobId` to `tracks` and `stems` and exits 0. It must NOT report any deletions.

- [ ] **Step 3: Commit**

```bash
git add instant.schema.ts
git commit -m "feat(schema): add indexed jobId to tracks/stems for per-job attribution"
```

---

## Task 2: Stamp `jobId` on insert and add the `itemsByJob` reader

**Files:**
- Modify: `server/instant.mjs:165-188` (`insertItem`) and add `itemsByJob` near `itemsBySlug` (after line 119)
- Test: `test/instant.test.mjs`

**Interfaces:**
- Consumes: `jobId` field from Task 1; `process.env.CRATE_JOB_ID` (set by the runner in Task 3).
- Produces:
  - `insertItem(adminDb, namespace, track, authorProfileId)` — unchanged signature; now also writes `jobId: process.env.CRATE_JOB_ID` onto the row when that env var is set.
  - `itemsByJob(adminDb, namespace, jobId) => Promise<row[]>` — every row in `namespace` whose `jobId` equals the argument.

- [ ] **Step 1: Write the failing tests**

In `test/instant.test.mjs`, add `itemsByJob` to the import block (line 4):

```javascript
import {
  ensureProfile, getProfile, setArtistName, itemSlugs, itemsBySlug, itemsByJob, insertItem, recordPlay, setRating,
  setNotes, itemOwnerProfileId,
} from '../server/instant.mjs';
```

Add these two `it` blocks **inside** the existing `describe('insertItem', ...)` block (so they share the `track` fixture), right after the "sets versionOf when present" test:

```javascript
  it('stamps jobId from CRATE_JOB_ID when set', async () => {
    const db = fakeAdmin({ tracks: [] });
    process.env.CRATE_JOB_ID = 'job-123';
    try {
      await insertItem(db, 'tracks', track, 'p1');
    } finally {
      delete process.env.CRATE_JOB_ID;
    }
    expect(db._txs[0].update.jobId).toBe('job-123');
  });

  it('omits jobId when CRATE_JOB_ID is unset', async () => {
    const db = fakeAdmin({ tracks: [] });
    delete process.env.CRATE_JOB_ID;
    await insertItem(db, 'tracks', track, 'p1');
    expect(db._txs[0].update.jobId).toBeUndefined();
  });
```

Add this as a new top-level `describe` (e.g. right after the `describe('itemSlugs / itemsBySlug', ...)` block):

```javascript
describe('itemsByJob', () => {
  it('returns only rows whose jobId matches', async () => {
    const db = fakeAdmin({ stems: [
      { slug: 'a', jobId: 'j1' }, { slug: 'b', jobId: 'j2' }, { slug: 'c', jobId: 'j1' },
    ] });
    const rows = await itemsByJob(db, 'stems', 'j1');
    expect(rows.map((r) => r.slug)).toEqual(['a', 'c']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/instant.test.mjs -t 'jobId'`
Expected: FAIL — `itemsByJob` is `undefined` / not exported, and `update.jobId` is `undefined` in the stamping test.

- [ ] **Step 3: Implement `itemsByJob`**

In `server/instant.mjs`, add right after `itemsBySlug` (after line 119):

```javascript
// Rows created by a given runner job (stamped with jobId via CRATE_JOB_ID at
// insert time). The basis for per-job newItems + live progress, replacing the
// namespace-wide before/after diff so jobs can share a namespace concurrently.
export async function itemsByJob(adminDb, namespace, jobId) {
  const res = await adminDb.query({ [namespace]: { $: { where: { jobId } } } });
  return res[namespace];
}
```

- [ ] **Step 4: Implement `jobId` stamping in `insertItem`**

In `server/instant.mjs`, in `insertItem`, add the stamping right after the `versionOf`/`remixOf` lines (currently lines 182-183), before `let tx = ...`:

```javascript
  if (track.versionOf) update.versionOf = track.versionOf;
  if (track.remixOf) update.remixOf = track.remixOf;
  // Stamp the runner job that created this row. The runner sets CRATE_JOB_ID in
  // the claude child's env (Task 3); it flows through sub-agents to save-*.mjs.
  // Absent for manual CLI runs — those rows simply carry no jobId.
  const jobId = process.env.CRATE_JOB_ID;
  if (jobId) update.jobId = jobId;
  let tx = adminDb.tx[namespace][entId].update(update);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/instant.test.mjs`
Expected: PASS (whole file, including the three new cases).

- [ ] **Step 6: Commit**

```bash
git add server/instant.mjs test/instant.test.mjs
git commit -m "feat(instant): stamp jobId on insert and add itemsByJob reader"
```

---

## Task 3: Job-scoped attribution in the runner (still serial)

This task switches the runner from namespace-diff attribution to per-job attribution and sets `CRATE_JOB_ID` in the child env. It keeps the existing single-slot behavior — concurrency comes in Task 4. Splitting it this way means a reviewer can confirm attribution is correct before the concurrency switch flips.

**Files:**
- Modify: `server/runner.mjs` — imports (line 5), `liveProduced` (55-58), remove `diffNew` (48-50), `runClaude` (91-105), `runOne` (107-132)
- Test: `test/runner.test.mjs`

**Interfaces:**
- Consumes: `itemsByJob` (Task 2); the runner job's `id`.
- Produces:
  - `liveProduced(job, producedCount) => number | undefined` — returns `producedCount` while `job.status === 'running'`, else `undefined`. (Signature unchanged; second arg is now the job's own row count, not the namespace total. `baselineCount` is gone.)
  - `runClaude` sets `env.CRATE_JOB_ID = job.id`.
  - `runOne` computes `newItems`/`batch` from `itemsByJob(adminDb, ns, id)`. No longer writes `baselineCount`.
  - `diffNew` is removed (no longer used anywhere).

- [ ] **Step 1: Update the runner unit tests (write the failing tests)**

In `test/runner.test.mjs`:

(a) Remove `diffNew` from the import on line 3:

```javascript
import { buildArgv, collectionFor, liveProduced, majorityBatch } from '../server/runner.mjs';
```

(b) Delete the entire `describe('diffNew', ...)` block (lines 39-45).

(c) Replace the entire `describe('liveProduced', ...)` block (lines 47-61) with:

```javascript
describe('liveProduced', () => {
  it('returns the produced count for a running job', () => {
    expect(liveProduced({ status: 'running' }, 3)).toBe(3);
  });
  it('is undefined for non-running jobs', () => {
    expect(liveProduced({ status: 'done' }, 8)).toBeUndefined();
    expect(liveProduced({ status: 'queued' }, 8)).toBeUndefined();
  });
});
```

(d) In the worker test `'runs a job: running -> done, captures newItems/batch/summary'` (starts line 135): remove the `baselineCount` assertion (line 143), and add `jobId: 'j1'` to the two pushed rows so `itemsByJob` finds them. The body becomes:

```javascript
  it2('runs a job: running -> done, captures newItems/batch/summary', async () => {
    const { spawn, children } = fakeSpawnFactory();
    const admin = fakeAdmin({ profiles: [], stems: [], tracks: [] });
    const runner = createRunner({ repoRoot, jobStore, adminDb: admin, spawn, now: ticks });
    await jobStore.write(baseJob('j1'));
    await runner.enqueue(baseJob('j1'));
    await until(() => children.length === 1);
    expect2((await jobStore.get('j1')).status).toBe('running');
    // The agent's save scripts created two new stem rows, each stamped with this job's id.
    admin._store.stems.push(
      { id: 's1', slug: '2026-06-15-pads-01', batch: '2026-06-15-pads', jobId: 'j1' },
      { id: 's2', slug: '2026-06-15-pads-02', batch: '2026-06-15-pads', jobId: 'j1' },
    );
    children[0].stdout.emit('data', JSON.stringify({ result: 'OK 2 stems' }));
    children[0].emit('close', 0);
    await until(async () => (await jobStore.get('j1')).status === 'done');
    const done = await jobStore.get('j1');
    expect2(done.newItems).toEqual(['2026-06-15-pads-01', '2026-06-15-pads-02']);
    expect2(done.batch).toBe('2026-06-15-pads');
    expect2(done.summary).toBe('OK 2 stems');
  });
```

(e) In `'derives batch from the row field, not the slug (revise version rows)'` (line 239): add `jobId: 'rev'` to the pushed row:

```javascript
    admin._store.stems.push({ id: 's1', slug: '2026-06-08-alien-04-v2', batch: '2026-06-08-alien', jobId: 'rev' });
```

(f) In `'picks the majority batch when Step-0 revise adds version rows from another batch'` (line 255): add `jobId: 'gen'` to all three pushed rows:

```javascript
    admin._store.stems.push({ id: 'o1', slug: '2026-06-01-old-03-v2', batch: '2026-06-01-old', jobId: 'gen' });
    admin._store.stems.push(
      { id: 'n1', slug: '2026-06-15-new-01', batch: '2026-06-15-new', jobId: 'gen' },
      { id: 'n2', slug: '2026-06-15-new-02', batch: '2026-06-15-new', jobId: 'gen' },
    );
```

(g) In `'returns null batch when new rows span multiple batches'` (line 274): add `jobId: 'j1'` to both pushed rows:

```javascript
    admin._store.stems.push(
      { id: 'a1', slug: '2026-06-15-pads-01', batch: '2026-06-15-pads', jobId: 'j1' },
      { id: 'b1', slug: '2026-06-15-bass-01', batch: '2026-06-15-bass', jobId: 'j1' },
    );
```

(h) Add a new test (place after the `'omits the author env var...'` test) asserting the job-id env var:

```javascript
  it2('sets CRATE_JOB_ID in the child env', async () => {
    const { spawn, children } = fakeSpawnFactory();
    const admin = fakeAdmin({ profiles: [], stems: [], tracks: [] });
    const runner = createRunner({ repoRoot, jobStore, adminDb: admin, spawn, now: ticks });
    await jobStore.write(baseJob('j1'));
    await runner.enqueue(baseJob('j1'));
    await until(() => children.length === 1);
    expect2(children[0].opts.env.CRATE_JOB_ID).toBe('j1');
    children[0].emit('close', 0);
    await until(async () => (await jobStore.get('j1')).status === 'done');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/runner.test.mjs`
Expected: FAIL — `CRATE_JOB_ID` is undefined in the child env; `liveProduced` still uses `baselineCount`; and (because the implementation still diffs the namespace) the batch tests that rely on `jobId` filtering still pass only by accident — the `CRATE_JOB_ID` test and the `liveProduced` rewrite fail. (It is fine if some cases still pass; the suite as a whole must be red.)

- [ ] **Step 3: Update imports and remove `diffNew`**

In `server/runner.mjs`, change the import on line 5 to pull in `itemsByJob` (and drop the now-unused `itemSlugs`/`itemsBySlug`):

```javascript
import { itemsByJob, ensureProfile } from './instant.mjs';
```

Delete the `diffNew` function (lines 48-50):

```javascript
// (removed — attribution is now job-scoped via itemsByJob, no namespace diff)
```

- [ ] **Step 4: Simplify `liveProduced`**

Replace the `liveProduced` function (lines 55-58) with:

```javascript
// Number of rows this job has produced so far (rows stamped with its jobId).
// Undefined unless the job is running — a finished job reports final newItems.
export function liveProduced(job, producedCount) {
  if (job.status !== 'running') return undefined;
  return producedCount;
}
```

- [ ] **Step 5: Set `CRATE_JOB_ID` in the child env**

In `server/runner.mjs`, in `runClaude` (around line 97-98), add the job-id env var next to the author one:

```javascript
      const env = { ...process.env };
      env.CRATE_JOB_ID = job.id;
      if (authorProfileId) env.CRATE_AUTHOR_PROFILE_ID = authorProfileId;
```

- [ ] **Step 6: Rewrite `runOne` to attribute by jobId**

Replace `runOne` (lines 107-132) with (drops the `before`/`after`/`itemSlugs`/`baselineCount` machinery):

```javascript
  async function runOne(id) {
    const job = await jobStore.get(id);
    if (!job) return;
    const ns = job.collection; // 'tracks' | 'stems'
    try {
      const authorProfileId = job.userId
        ? await ensureProfile(adminDb, { id: job.userId, email: job.userEmail })
        : null;
      await jobStore.update(id, { status: 'running', startedAt: now() });
      const { code, out, err } = await runClaude(job, authorProfileId);
      const newRows = await itemsByJob(adminDb, ns, id);
      const newItems = newRows.map((r) => r.slug).sort();
      const patch = { finishedAt: now(), newItems, batch: majorityBatch(newRows) };
      if (code === 0) { patch.status = 'done'; patch.summary = parseSummary(out); }
      else {
        patch.status = 'failed';
        const tail = (err ?? '').trim().slice(-500);
        patch.error = tail ? `claude exited ${code}: ${tail}` : `claude exited ${code}`;
      }
      await jobStore.update(id, patch);
    } catch (err) {
      await jobStore.update(id, { status: 'failed', finishedAt: now(), error: String(err?.message ?? err) });
    }
  }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/runner.test.mjs`
Expected: PASS.

Then confirm `diffNew` is truly gone (no stragglers):

Run: `grep -rn "diffNew\|baselineCount\|itemSlugs" server/runner.mjs`
Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add server/runner.mjs test/runner.test.mjs
git commit -m "feat(runner): attribute job output by jobId instead of namespace diff"
```

---

## Task 4: Run up to `maxConcurrent` jobs in parallel

**Files:**
- Modify: `server/runner.mjs` — `createRunner` signature (line 83), the `running` flag → `active` counter (88-89), `pump` (134-145), `enqueue` (147-151), `recover` (153-162)
- Test: `test/runner.test.mjs`

**Interfaces:**
- Consumes: job-scoped attribution (Task 3).
- Produces:
  - `createRunner({ repoRoot, jobStore, adminDb, spawn?, now?, maxConcurrent? })` — `maxConcurrent` defaults to `2`.
  - `pump()` is now synchronous (returns `void`): it starts jobs until `active === maxConcurrent` or the queue drains; each `runOne` decrements `active` and re-pumps on completion.
  - `enqueue`/`recover` unchanged in signature.

- [ ] **Step 1: Update the concurrency tests (write the failing tests)**

In `test/runner.test.mjs`, replace the `'runs jobs one at a time (single slot)'` test (lines 212-225) with two tests:

```javascript
  it2('runs up to maxConcurrent jobs at once and queues the rest', async () => {
    const { spawn, children } = fakeSpawnFactory();
    const admin = fakeAdmin({ profiles: [], stems: [], tracks: [] });
    const runner = createRunner({ repoRoot, jobStore, adminDb: admin, spawn, now: ticks, maxConcurrent: 2 });
    for (const id of ['j1', 'j2', 'j3']) {
      await jobStore.write(baseJob(id));
      await runner.enqueue(baseJob(id));
    }
    await until(() => children.length === 2);
    expect2(children).toHaveLength(2);                       // two slots filled
    expect2((await jobStore.get('j3')).status).toBe('queued'); // third waits
    children[0].emit('close', 0);                            // free a slot
    await until(() => children.length === 3);                // third starts
    expect2(children).toHaveLength(3);
  });

  it2('respects maxConcurrent: 1 (serial)', async () => {
    const { spawn, children } = fakeSpawnFactory();
    const admin = fakeAdmin({ profiles: [], stems: [], tracks: [] });
    const runner = createRunner({ repoRoot, jobStore, adminDb: admin, spawn, now: ticks, maxConcurrent: 1 });
    await jobStore.write(baseJob('j1'));
    await jobStore.write(baseJob('j2'));
    await runner.enqueue(baseJob('j1'));
    await runner.enqueue(baseJob('j2'));
    await until(() => children.length === 1);
    expect2((await jobStore.get('j2')).status).toBe('queued');
    children[0].emit('close', 0);
    await until(() => children.length === 2);
  });

  it2('attributes rows per job when two run concurrently in the same namespace', async () => {
    const { spawn, children } = fakeSpawnFactory();
    const admin = fakeAdmin({ profiles: [], stems: [], tracks: [] });
    const runner = createRunner({ repoRoot, jobStore, adminDb: admin, spawn, now: ticks, maxConcurrent: 2 });
    await jobStore.write(baseJob('jA'));
    await jobStore.write(baseJob('jB'));
    await runner.enqueue(baseJob('jA'));
    await runner.enqueue(baseJob('jB'));
    await until(() => children.length === 2);
    // Both jobs wrote into stems; each row carries its own job's id.
    admin._store.stems.push(
      { id: 'a1', slug: 'a-01', batch: 'A', jobId: 'jA' },
      { id: 'b1', slug: 'b-01', batch: 'B', jobId: 'jB' },
    );
    children[0].emit('close', 0); // jA (enqueued first → children[0])
    children[1].emit('close', 0); // jB
    await until(async () =>
      (await jobStore.get('jA')).status === 'done' && (await jobStore.get('jB')).status === 'done');
    expect2((await jobStore.get('jA')).newItems).toEqual(['a-01']);
    expect2((await jobStore.get('jB')).newItems).toEqual(['b-01']);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/runner.test.mjs -t 'maxConcurrent'`
Expected: FAIL — with the single-slot implementation, only one child ever spawns, so `until(() => children.length === 2)` times out.

- [ ] **Step 3: Add the `maxConcurrent` param and the `active` counter**

In `server/runner.mjs`, update the `createRunner` destructure (line 83-87) to accept `maxConcurrent`:

```javascript
export function createRunner({
  repoRoot, jobStore, adminDb,
  spawn = nodeSpawn,
  now = () => new Date().toISOString(),
  maxConcurrent = 2,
}) {
  const queue = [];
  let active = 0;
```

- [ ] **Step 4: Rewrite `pump` to fill all free slots**

Replace `pump` (lines 134-145) with a synchronous slot-filling loop:

```javascript
  function pump() {
    while (active < maxConcurrent && queue.length) {
      const id = queue.shift();
      active += 1;
      runOne(id)
        .catch((err) => console.error('runOne failed', err))
        .finally(() => { active -= 1; pump(); });
    }
  }
```

- [ ] **Step 5: Update `enqueue` and `recover` to the void `pump`**

`pump` no longer returns a promise. Update `enqueue` (lines 147-151):

```javascript
  async function enqueue(job) {
    queue.push(job.id);
    pump();
    return job;
  }
```

And the tail of `recover` (line 161) — replace `pump().catch((err) => console.error('runner pump failed', err));` with:

```javascript
    pump();
```

- [ ] **Step 6: Run the runner tests to verify they pass**

Run: `npx vitest run test/runner.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/runner.mjs test/runner.test.mjs
git commit -m "feat(runner): run up to maxConcurrent jobs in parallel (default 2)"
```

---

## Task 5: Wire job-scoped progress and the concurrency cap into the server

**Files:**
- Modify: `server/index.mjs:9` (import), `:30` (`createRunner` call), `:32-36` (`progressFor`)

**Interfaces:**
- Consumes: `itemsByJob` (Task 2), `liveProduced` (Task 3), `maxConcurrent` (Task 4).
- Produces: the running server starts up to `CRATE_MAX_JOBS` (default 2) jobs at once and reports each job's own produced count.

- [ ] **Step 1: Swap the `itemSlugs` import for `itemsByJob`**

In `server/index.mjs`, change line 9:

```javascript
import { itemsByJob } from './instant.mjs';
```

- [ ] **Step 2: Pass `maxConcurrent` into the runner**

Change line 30:

```javascript
const runner = createRunner({ repoRoot, jobStore, adminDb, maxConcurrent: Number(process.env.CRATE_MAX_JOBS) || 2 });
```

- [ ] **Step 3: Make `progressFor` count the job's own rows**

Replace `progressFor` (lines 32-36):

```javascript
const progressFor = async (job) => {
  if (!adminDb || job.status !== 'running') return undefined;
  const produced = (await itemsByJob(adminDb, job.collection, job.id)).length;
  return liveProduced(job, produced);
};
```

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS — all files green, including `test/api.test.mjs` (its stub `progressFor` is unaffected) and `test/instant.test.mjs` / `test/runner.test.mjs`.

- [ ] **Step 5: Confirm no stale references remain**

Run: `grep -rn "baselineCount\|diffNew" server/ test/`
Expected: no output.

Run: `node --check server/index.mjs && node --check server/runner.mjs && node --check server/instant.mjs`
Expected: no output (all parse cleanly).

- [ ] **Step 6: Commit**

```bash
git add server/index.mjs
git commit -m "feat(server): job-scoped progress + CRATE_MAX_JOBS concurrency cap"
```

---

## Manual smoke test (after Task 5, before deploy)

The unit suite covers attribution and slot logic with a fake spawn. To confirm the real path end-to-end, on the deploy host (main worktree) with `.env` configured:

1. Start the server: `node server/index.mjs` (or restart the service after merge).
2. Authenticated, POST two same-collection jobs back-to-back, e.g. two `generate-stems` requests.
3. `GET /api/jobs` and confirm **both** show `status: "running"` simultaneously, each with its own `produced` count climbing independently (not a shared namespace total).
4. When both finish, confirm each job's `newItems` lists only the rows it created (no overlap), and `batch` is each run's own batch.

To tune the cap without code changes, set `CRATE_MAX_JOBS` in the service's environment (default 2). Note each job already fans out many parallel sub-agents, so raise the cap with CPU/Anthropic-API load in mind.

---

## Self-Review

**Spec coverage** (the chosen approach: "Full cap-N concurrency"):
- Cap of N parallel slots → Task 4 (`maxConcurrent`, default 2) + Task 5 (`CRATE_MAX_JOBS`). ✓
- Two jobs in the same namespace at once → enabled by job-scoped attribution (Tasks 1-3) and proven by the "attributes rows per job when two run concurrently in the same namespace" test (Task 4). ✓
- `newItems`/`batch` per job → Task 3 `runOne` via `itemsByJob`. ✓
- Live progress per job → Task 3 `liveProduced` + Task 5 `progressFor`. ✓
- Save scripts/skills untouched → env flows through the process tree; verified `scripts/lib/instant.mjs` re-exports `server/instant.mjs`. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N". Every code step shows full code; every run step shows the exact command and expected result. ✓

**Type/name consistency:** `itemsByJob(adminDb, namespace, jobId)` defined in Task 2, consumed identically in Tasks 3 and 5. `liveProduced(job, producedCount)` redefined in Task 3 and called with that shape in Task 5. `CRATE_JOB_ID` set in Task 3 `runClaude`, read in Task 2 `insertItem`. `maxConcurrent` named consistently in Tasks 4 and 5. `diffNew`/`baselineCount`/`itemSlugs`-in-runner removed in Task 3, asserted absent in Tasks 3 and 5. ✓
