# Live Job Progress Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show live `running · X/N · elapsed` progress in the webapp while a generation job runs, derived from a directory-diff baseline (not Claude's output stream).

**Architecture:** The runner persists a `baselineCount` (dir item count at job start). The server enriches running jobs with a live `produced` count via an injected `progressFor`. The client renders progress from pure formatters, ticking the elapsed clock every second and pinning the active job atop the bell's log.

**Tech Stack:** Node ESM, Express, vitest + supertest, Vite-bundled vanilla JS.

**Branch:** `job-progress-spine` (already created; holds the design spec commit).

**Spec:** `docs/superpowers/specs/2026-06-15-job-progress-spine-design.md`

---

## File Structure

- **Modify** `server/runner.mjs` — add `liveProduced(job, currentCount)`; persist `baselineCount` in `runOne`.
- **Modify** `server/app.mjs` — `GET /api/jobs` enriches jobs with `produced` via injected `opts.progressFor`.
- **Modify** `server/index.mjs` — wire a real `progressFor` from collection dirs.
- **Modify** `src/notifications.js` — pure `formatElapsed`, `progressText`.
- **Modify** `src/jobs-ui.js` — select active job, tick the pill, pin active in the log.
- **Modify** `src/style.css` — a `.active` log-entry style.
- **Tests:** `test/runner.test.mjs`, `test/api.test.mjs`, `test/notifications.test.mjs`.

Test command throughout: `node --max-old-space-size=4096 ./node_modules/.bin/vitest run <file>` (the heap flag avoids a known OOM when `validate.mjs`-loading tests run together; for these server/client tests plain `npx vitest run <file>` is fine too).

---

## Task 1: Server — `liveProduced` helper + persist `baselineCount`

**Files:**
- Modify: `server/runner.mjs`
- Test: `test/runner.test.mjs`

- [ ] **Step 1: Write the failing tests**

Add to `test/runner.test.mjs`. First extend the import on line 3:

```js
import { buildArgv, collectionFor, diffNew, liveProduced } from '../server/runner.mjs';
```

Add a new describe block (place it after the `diffNew` describe, before the `import { describe as describe2 ... }` line):

```js
describe('liveProduced', () => {
  it('returns produced = current - baseline for a running job', () => {
    expect(liveProduced({ status: 'running', baselineCount: 5 }, 8)).toBe(3);
  });
  it('clamps to 0 when files were removed', () => {
    expect(liveProduced({ status: 'running', baselineCount: 5 }, 2)).toBe(0);
  });
  it('is undefined for non-running jobs', () => {
    expect(liveProduced({ status: 'done', baselineCount: 5 }, 8)).toBeUndefined();
    expect(liveProduced({ status: 'queued', baselineCount: 5 }, 8)).toBeUndefined();
  });
  it('is undefined when baselineCount is missing', () => {
    expect(liveProduced({ status: 'running' }, 8)).toBeUndefined();
  });
});
```

Then, in the existing test `'runs a job: running -> done, captures newItems/batch/summary'`, immediately after the line `expect2((await jobStore.get('j1')).status).toBe('running');` add:

```js
    expect2((await jobStore.get('j1')).baselineCount).toBe(0);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/runner.test.mjs`
Expected: FAIL — `liveProduced` is not exported (import undefined); and `baselineCount` is `undefined` not `0`.

- [ ] **Step 3: Implement in `server/runner.mjs`**

Add this exported function (place it next to the other exported helpers, e.g. right after `diffNew`):

```js
// Live count of items produced since the job started. Undefined unless the job
// is running AND has a numeric baseline (so a stray pre-baseline job never shows
// a bogus full-directory count).
export function liveProduced(job, currentCount) {
  if (job.status !== 'running' || typeof job.baselineCount !== 'number') return undefined;
  return Math.max(0, currentCount - job.baselineCount);
}
```

In `runOne`, change the start of the function so the baseline is computed BEFORE the running update and persisted. Replace these two lines:

```js
    await jobStore.update(id, { status: 'running', startedAt: now() });
    const before = await idsIn(dir);
```

with:

```js
    const before = await idsIn(dir);
    await jobStore.update(id, { status: 'running', startedAt: now(), baselineCount: before.size });
```

(The rest of `runOne` still uses `before` exactly as before.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/runner.test.mjs`
Expected: PASS (all `liveProduced` cases + the `baselineCount` assertion + all pre-existing runner tests).

- [ ] **Step 5: Commit**

```bash
git add server/runner.mjs test/runner.test.mjs
git commit -m "feat: runner persists baselineCount + liveProduced helper"
```

---

## Task 2: Server — enrich `GET /api/jobs` with `produced`

**Files:**
- Modify: `server/app.mjs`
- Modify: `server/index.mjs`
- Test: `test/api.test.mjs`

- [ ] **Step 1: Write the failing test**

Add to the `describe('jobs API', ...)` block in `test/api.test.mjs` (after the existing `GET /api/jobs lists queued jobs` test). This test builds its own app with an injected `progressFor`:

```js
  it('GET /api/jobs attaches produced for running jobs via progressFor', async () => {
    const base = await mkdtemp(join(tmpdir(), 'strudel-jobsprog-'));
    const jobStore = createJobStore({ jobsDir: join(base, 'jobs') });
    const runner = { enqueue: async () => {} };
    const progressFor = async (j) => (j.status === 'running' ? 7 : undefined);
    const app2 = createApp(
      {
        tracks: createStore({ tracksDir: join(base, 'tracks'), ratingsDir: join(base, 'r1') }),
        stems: createStore({ tracksDir: join(base, 'stems'), ratingsDir: join(base, 'r2') }),
      },
      { jobStore, runner, progressFor },
    );
    await jobStore.write({
      id: 'run1', type: 'generate-stems', prompt: 'p', count: 4, collection: 'stems',
      status: 'running', createdAt: '2026-06-15T00:00:00Z', startedAt: '2026-06-15T00:00:01Z',
      finishedAt: null, summary: null, error: null, batch: null, newItems: [], baselineCount: 2,
    });
    await jobStore.write({
      id: 'q1', type: 'generate-stems', prompt: 'p', count: 4, collection: 'stems',
      status: 'queued', createdAt: '2026-06-15T00:00:02Z', startedAt: null,
      finishedAt: null, summary: null, error: null, batch: null, newItems: [],
    });
    const list = await request(app2).get('/api/jobs');
    const running = list.body.find((j) => j.id === 'run1');
    const queued = list.body.find((j) => j.id === 'q1');
    expect(running.produced).toBe(7);
    expect(queued.produced).toBeUndefined();
  });
```

Confirm `mkdtemp`, `join`, `tmpdir`, `createJobStore`, `createStore`, `request`, `createApp` are already imported at the top of `test/api.test.mjs` (they are — the file already uses all of them). No new imports needed.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/api.test.mjs`
Expected: FAIL — `running.produced` is `undefined` (route doesn't enrich yet).

- [ ] **Step 3: Implement in `server/app.mjs`**

Change the `jobRoutes` signature to accept `progressFor`:

```js
function jobRoutes(app, jobStore, runner, progressFor) {
```

Replace the existing list route:

```js
  app.get('/api/jobs', wrap(async (_req, res) => res.json(await jobStore.list())));
```

with:

```js
  app.get('/api/jobs', wrap(async (_req, res) => {
    const jobs = await jobStore.list();
    if (!progressFor) return res.json(jobs);
    const enriched = await Promise.all(jobs.map(async (job) => {
      const produced = await progressFor(job);
      return produced === undefined ? job : { ...job, produced };
    }));
    res.json(enriched);
  }));
```

In `createApp`, pass `opts.progressFor` through. Replace:

```js
  if (opts.jobStore && opts.runner) jobRoutes(app, opts.jobStore, opts.runner);
```

with:

```js
  if (opts.jobStore && opts.runner) jobRoutes(app, opts.jobStore, opts.runner, opts.progressFor);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/api.test.mjs`
Expected: PASS (new test + all existing jobs-API tests, which pass no `progressFor` and so see unchanged behavior).

- [ ] **Step 5: Wire the real `progressFor` in `server/index.mjs`**

Change the runner import to also pull the two helpers:

```js
import { createRunner, idsIn, liveProduced } from './runner.mjs';
```

Hoist `dirs` to a const and reuse it (replace the inline `dirs: { stems: 'stems', tracks: 'tracks' }` in the `createRunner` call):

```js
const dirs = { stems: 'stems', tracks: 'tracks' };
const runner = createRunner({ repoRoot, dirs, jobStore });

// Live produced-count for a running job: items in its collection dir now,
// minus the baseline captured when it started.
const progressFor = async (job) => {
  if (job.status !== 'running') return undefined;
  const count = (await idsIn(join(repoRoot, dirs[job.collection]))).size;
  return liveProduced(job, count);
};
```

Then add `progressFor` to the `createApp` opts:

```js
const app = createApp(
  {
    tracks: createStore({ tracksDir: 'tracks', ratingsDir: 'data/ratings' }),
    stems: createStore({ tracksDir: 'stems', ratingsDir: 'data/stem-ratings' }),
  },
  { jobStore, runner, progressFor, distDir: existsSync(distDir) ? distDir : undefined },
);
```

- [ ] **Step 6: Verify the suite still passes**

Run: `npx vitest run test/api.test.mjs test/runner.test.mjs`
Expected: PASS. (`index.mjs` has no direct test; it is exercised at runtime — Task 5 confirms the server boots.)

- [ ] **Step 7: Commit**

```bash
git add server/app.mjs server/index.mjs test/api.test.mjs
git commit -m "feat: GET /api/jobs reports live produced count for running jobs"
```

---

## Task 3: Client — pure progress formatters

**Files:**
- Modify: `src/notifications.js`
- Test: `test/notifications.test.mjs`

- [ ] **Step 1: Write the failing tests**

Extend the import on line 3 of `test/notifications.test.mjs`:

```js
import { deepLink, unreadCount, newlyFinished, notificationText, formatElapsed, progressText } from '../src/notifications.js';
```

Add these describe blocks at the end of the file:

```js
describe('formatElapsed', () => {
  it('formats minutes and zero-padded seconds', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(9000)).toBe('0:09');
    expect(formatElapsed(134000)).toBe('2:14');
  });
  it('clamps negative input to 0:00', () => {
    expect(formatElapsed(-500)).toBe('0:00');
  });
});

describe('progressText', () => {
  const start = '2026-06-15T00:00:00Z';
  const now = Date.parse('2026-06-15T00:02:14Z'); // 2:14 later

  it('shows queued', () => {
    expect(progressText({ status: 'queued' }, now)).toBe('queued');
  });
  it('shows running with X/N and elapsed', () => {
    expect(progressText({ status: 'running', startedAt: start, produced: 12, count: 30 }, now))
      .toBe('running · 12/30 · 2:14');
  });
  it('clamps produced to count', () => {
    expect(progressText({ status: 'running', startedAt: start, produced: 33, count: 30 }, now))
      .toBe('running · 30/30 · 2:14');
  });
  it('shows "N produced" when there is no count (revise jobs)', () => {
    expect(progressText({ status: 'running', startedAt: start, produced: 5, count: null }, now))
      .toBe('running · 5 produced · 2:14');
  });
  it('shows running + elapsed only when produced is absent', () => {
    expect(progressText({ status: 'running', startedAt: start }, now)).toBe('running · 2:14');
  });
  it('is empty for finished jobs', () => {
    expect(progressText({ status: 'done', startedAt: start }, now)).toBe('');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/notifications.test.mjs`
Expected: FAIL — `formatElapsed`/`progressText` are not exported.

- [ ] **Step 3: Implement in `src/notifications.js`**

Append:

```js
// "m:ss" elapsed string. Negative input (clock skew) clamps to 0:00.
export function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// One-line live status for an active job. nowMs is the current epoch ms.
// queued -> "queued"; running -> "running · X/N · m:ss" (or "· N produced"
// when the job has no count, or just elapsed when produced is absent);
// finished/other -> "" (finished jobs are rendered elsewhere).
export function progressText(job, nowMs) {
  if (job.status === 'queued') return 'queued';
  if (job.status !== 'running') return '';
  let count = '';
  if (job.produced != null && job.count) count = ` · ${Math.min(job.produced, job.count)}/${job.count}`;
  else if (job.produced != null) count = ` · ${job.produced} produced`;
  const elapsed = job.startedAt ? ` · ${formatElapsed(nowMs - Date.parse(job.startedAt))}` : '';
  return `running${count}${elapsed}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/notifications.test.mjs`
Expected: PASS (new blocks + all existing notifications tests).

- [ ] **Step 5: Commit**

```bash
git add src/notifications.js test/notifications.test.mjs
git commit -m "feat: progressText/formatElapsed live job status formatters"
```

---

## Task 4: Client — render live progress in the UI

**Files:**
- Modify: `src/jobs-ui.js`
- Modify: `src/style.css`

No unit test (this is DOM/poller glue, consistent with the codebase keeping testable logic in `notifications.js`). Verified by build + manual check.

- [ ] **Step 1: Import the formatter**

In `src/jobs-ui.js`, extend the import from `./notifications.js`:

```js
import { deepLink, unreadCount, newlyFinished, notificationText, progressText } from './notifications.js';
```

- [ ] **Step 2: Track the active job**

Right after the line `let lastJobs = [];` add:

```js
  let activeJob = null; // the running job, else the next queued one, else null
```

- [ ] **Step 3: Replace the status rendering with a ticking render**

Replace the existing tail of `poll()`:

```js
      renderBadge(jobs);
      renderLog(jobs);
      const active = jobs.some((j) => j.status === 'queued' || j.status === 'running');
      setStatus(active ? 'running…' : '', active ? 'busy' : '');
```

with:

```js
      activeJob = jobs.find((j) => j.status === 'running')
        || jobs.find((j) => j.status === 'queued') || null;
      renderBadge(jobs);
      renderLog(jobs);
      renderActive();
```

Add a `renderActive` function (place it next to `renderLog`):

```js
  // Re-render the status pill from the active job + the live clock. Called on
  // every poll AND once a second so the elapsed time advances between polls.
  function renderActive() {
    if (!activeJob) { setStatus('', ''); return; }
    setStatus(progressText(activeJob, Date.now()), 'busy');
  }
```

Start the 1-second ticker — replace the final `poll();` line at the end of `mountJobsUI` with:

```js
  poll();
  setInterval(renderActive, 1000);
```

- [ ] **Step 4: Pin the active job atop the log**

Replace the whole `renderLog` function:

```js
  function renderLog(jobs) {
    const finished = jobs.filter((j) => ['done', 'failed', 'interrupted'].includes(j.status));
    logEl.innerHTML = finished.length
      ? finished.map((j) => {
          if (j.status === 'done') {
            const label = `${j.newItems?.length ?? 0} ${j.collection} — ${j.prompt}`;
            return `<a href="${deepLink(j)}" title="${escapeHtml(j.summary || '')}">${escapeHtml(label)}</a>`;
          }
          const reason = j.error || j.prompt;
          return `<span class="failed">${escapeHtml(`${j.status}: ${reason}`)}</span>`;
        }).join('')
      : '<span class="empty">no jobs yet</span>';
  }
```

with:

```js
  function renderLog(jobs) {
    const active = jobs.filter((j) => j.status === 'queued' || j.status === 'running');
    const finished = jobs.filter((j) => ['done', 'failed', 'interrupted'].includes(j.status));
    const activeHtml = active.map((j) =>
      `<span class="active">${escapeHtml(progressText(j, Date.now()))} — ${escapeHtml(j.prompt)}</span>`
    ).join('');
    const finishedHtml = finished.map((j) => {
      if (j.status === 'done') {
        const label = `${j.newItems?.length ?? 0} ${j.collection} — ${j.prompt}`;
        return `<a href="${deepLink(j)}" title="${escapeHtml(j.summary || '')}">${escapeHtml(label)}</a>`;
      }
      const reason = j.error || j.prompt;
      return `<span class="failed">${escapeHtml(`${j.status}: ${reason}`)}</span>`;
    }).join('');
    logEl.innerHTML = (activeHtml + finishedHtml) || '<span class="empty">no jobs yet</span>';
  }
```

(The active line refreshes each 3s poll; the always-visible pill ticks every second. The active line has no link because the batch isn't known until the job finishes.)

- [ ] **Step 5: Add a `.active` log-entry style**

In `src/style.css`, find the existing job-log entry rules (search for `#job-log .failed` or `#job-log .empty`). Immediately before the `.failed` rule, add a matching `.active` rule (mirror the layout of the sibling entries — same display/padding — with an emphasized color):

```css
#job-log .active {
  display: block;
  padding: 0.4rem 0.6rem;
  color: var(--accent, #b6ff5a);
  font-variant-numeric: tabular-nums;
}
```

If the sibling selectors are written differently (e.g. `.job-log a`), match their exact prefix/padding instead so the active line aligns with the rest; keep `font-variant-numeric: tabular-nums;` so the ticking digits don't jitter.

- [ ] **Step 6: Build to verify the bundle compiles**

Run: `npm run build`
Expected: build succeeds, `jobs-ui` bundled with no errors.

- [ ] **Step 7: Manual verification (document result)**

Start the app (`npm run dev`), open the page, click generate with a small count, and confirm: the status pill shows `running · X/N · m:ss` with the seconds advancing, and opening the bell shows the active job pinned above finished entries. (If no API is running, at minimum confirm the page loads without console errors.)

- [ ] **Step 8: Commit**

```bash
git add src/jobs-ui.js src/style.css
git commit -m "feat: live job progress in status pill and log dropdown"
```

---

## Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole test suite**

Run: `node --max-old-space-size=4096 ./node_modules/.bin/vitest run`
Expected: all tests pass (including the new runner/api/notifications assertions).

- [ ] **Step 2: Confirm the server boots with the new wiring**

Run (a high PORT avoids the known dev-server squat on 3001):
`PORT=3987 node -e "import('./server/index.mjs').then(() => { console.log('boot ok'); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); })"`
Expected: prints `strudel-ai api listening on http://localhost:3987` then `boot ok` (the import wires `progressFor` without throwing). If it exits non-zero with the error, the wiring is broken; fix before proceeding.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 4: Commit any verification fixes** (otherwise skip)

```bash
git add -A && git commit -m "chore: verification fixes for job progress spine"
```
