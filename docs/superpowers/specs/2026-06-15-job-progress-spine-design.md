# Live progress spine for generation jobs

**Date:** 2026-06-15
**Status:** Approved design, pre-implementation
**Surface:** Webapp generate panel only (server/runner + jobs-ui). Not the in-session skill flow.

## Problem

When a generation job runs from the webapp (a headless `claude -p` process started by
`server/runner.mjs`), a 30-item batch takes minutes, but the UI shows only a static
`running…` pill and the bell's log lists **finished jobs only**. There is no mid-run
signal at all — `--output-format json` emits a single blob on process close, so nothing
is captured until the end.

## Goal

While a job runs, show live, trustworthy progress in the webapp: how many items have been
produced and how long it has been running. Robust and cheap — no coupling to Claude's
internal event stream.

## Approach

Derive progress from facts already available, not from Claude's output:

1. **Produced count** — each validated stem/track lands on disk as it is created. Diff the
   collection dir's current item count against a **baseline** captured when the job
   started.
2. **Elapsed** — from the job's existing `startedAt`, ticked client-side.

The runner keeps `--output-format json` unchanged. The server enriches running jobs with a
`produced` count at read time; the client renders `running · 12/30 · 2m14s` and updates the
clock every second between the 3-second polls.

## Components

### 1. Server — capture baseline + enrich

**`server/runner.mjs`:**
- `runOne` already computes `before = idsIn(dir)` at start. Persist its size: include
  `baselineCount: before.size` in the existing `status:'running'` update.
- New exported helper `liveProduced(job, currentCount)` (pure, testable): returns
  `undefined` unless `job.status === 'running'` AND `job.baselineCount` is a number;
  otherwise `Math.max(0, currentCount - job.baselineCount)`. Returning `undefined` when the
  baseline is absent avoids a bogus full-directory count on any stray pre-baseline job.

**`server/app.mjs`:**
- `createApp(stores, opts)` accepts an optional `opts.progressFor(job) => Promise<number|undefined>`.
- The `GET /api/jobs` list route maps each job: if `progressFor` is provided, attach
  `produced = await progressFor(job)` (for non-running jobs `progressFor` returns
  `undefined`, so the field is simply absent). When `progressFor` is absent, behavior is
  unchanged (existing tests and old jobs stay green).

**`server/index.mjs`:**
- Wire `progressFor`: it knows the collection dirs, so it reads the running job's
  collection dir count (`idsIn(dir).size`) and returns `liveProduced(job, currentCount)`.

### 2. Client — pure formatters + render

**`src/notifications.js` (pure, no DOM/network):**
- `formatElapsed(ms)` → `m:ss` (e.g. `2:14`). Clamp negatives to `0:00`.
- `progressText(job, nowMs)` →
  - `queued` → `"queued"`
  - `running` → `"running"` + count segment + ` · ${formatElapsed(nowMs - Date.parse(job.startedAt))}`
    - count segment: `job.produced != null && job.count` → ` · ${Math.min(job.produced, job.count)}/${job.count}`;
      else `job.produced != null` → ` · ${job.produced} produced`; else `""`.
  - finished/other → `""` (finished rendering is handled by existing code).

**`src/jobs-ui.js`:**
- In `poll()`, select the active job: first `running`, else first `queued` (jobs are
  newest-first). Store it as `activeJob`.
- Add a 1-second `setInterval` that re-renders the status pill from `activeJob` +
  `Date.now()` via `progressText`, so the clock advances between polls. Clear the pill when
  there is no active job.
- `renderLog(jobs)` pins the active (queued/running) job at the top of the dropdown with
  its live `progressText`, above the existing finished entries — making the log a true
  activity log (active + finished). The active line is not a link (no batch yet).

## Data flow

poll → `GET /api/jobs` returns the running job with `produced` → client computes elapsed
locally → status pill + pinned log line show `running · X/N · elapsed`, refreshed each
second → on finish, existing finished-job rendering + browser notification take over
unchanged.

## Edge cases

- **Old jobs without `baselineCount`** → `liveProduced` returns `undefined`, so the pill
  shows `running · elapsed` with no count segment. (In practice none exist: `recover()`
  marks any pre-restart running job `interrupted`.)
- **`revise-from-notes`** (no `count`) → `X produced · elapsed`.
- **`produced` transiently exceeds `count`** (generate auto-runs revise as Step 0, adding a
  few files) → clamped to `count` in the `/N` form.
- **Dir missing / file deleted** → `idsIn` returns empty / `Math.max(0, …)` clamps to 0.
- **Multiple active jobs** → single-slot runner means at most one `running`; pill shows the
  running one, log can show queued ones too.

## Testing

- `test/notifications.test.mjs`: `formatElapsed` (incl. negative/zero), `progressText` for
  queued, running+count, running with `produced > count` (clamped), revise (no count),
  finished (empty).
- `test/runner.test.mjs`: `liveProduced` math (running vs non-running, missing baseline,
  negative clamp); `runOne` persists `baselineCount` on the running update (via the existing
  fake-spawn harness).
- `test/api.test.mjs`: `GET /api/jobs` attaches `produced` for a running job when a
  `progressFor` is injected, and omits it otherwise.

## Files touched

- Edit: `server/runner.mjs`, `server/app.mjs`, `server/index.mjs`,
  `src/notifications.js`, `src/jobs-ui.js`
- Edit (tests): `test/notifications.test.mjs`, `test/runner.test.mjs`, `test/api.test.mjs`

## Out of scope (YAGNI)

- No `--output-format stream-json` parsing, no per-agent OK/FAIL activity feed, no
  `fs.watch`. The spine is a clean substrate a richer feed could sit on later.
