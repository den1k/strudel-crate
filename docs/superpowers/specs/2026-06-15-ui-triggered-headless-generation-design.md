# UI-Triggered Headless Generation — Design

**Date:** 2026-06-15
**Status:** Approved (pending spec review)

## Problem

The generation skills (`generate-stems`, `generate-tracks`, `revise-from-notes`)
only run inside a Claude Code session in a terminal. We want to deploy strudel-ai
to a server and trigger these same skills from the web UI — clicking "Generate" in
the browser should run the real skill on the server — while the terminal Claude
Code experience stays exactly as it is (same `claude` binary, same
`.claude/skills/`).

## Decisions (from brainstorming)

- **Execution model:** headless. The server invokes Claude Code non-interactively
  (`claude -p`). No human-in-the-loop runner; no piping into a live terminal.
- **Exposure:** private / single-user. The deployed UI is reachable only by the
  owner (login, VPN, or tunnel — out of scope here). Therefore: no auth layer, no
  rate limiting, no abuse hardening in this design.
- **Bridge shape:** a job runner *inside the existing Express server* (Approach A).
  Not a separate daemon, not a terminal pipe.
- **Division of responsibility:** the **UI is dumb** — it POSTs `{type, prompt,
  count}` and polls status. The **backend owns** the exact command string and the
  tool allowlist. The browser never sees or controls which tools Claude may use.

## Architecture

```
Browser (Generate panel)                Express server (single PORT)
  POST /api/jobs {type,prompt,count} ─────▶  validate → enqueue → 201 {job}
  GET  /api/jobs/:id  (poll) ─────────────▶  job status + summary
                                              │
                                   server/runner.mjs (single-slot queue)
                                              │ spawn (argv array, cwd=repoRoot)
                                              ▼
                            claude -p "/generate-stems \"<prompt>\" <count>"
                                  --output-format json
                                  --allowedTools <scoped list>
                                              │
                                   runs the SAME skill, writes stems/ | tracks/
                                              ▼
  GET /api/<stems|tracks> (existing) ◀──── new items appear in the listing
```

Single concurrency (one job at a time) is the core invariant: it prevents two runs
from racing on the same `stems/`/`tracks/` directories and from doubling the
already-large (≤30) agent fan-out into rate-limit walls.

## Components

### 1. Job store — `server/jobs.mjs`
File-per-record JSON, mirroring `server/store.mjs`. Records live at
`data/jobs/<id>.json`.

Job shape:
```
{
  id,           // generated, [A-Za-z0-9_-]+ (matches server ID_RE)
  type,         // "generate-stems" | "generate-tracks" | "revise-from-notes"
  prompt,       // sound/style prompt (generate-*) or collection "stems"|"tracks" (revise)
  count,        // integer 1..30 (generate-* only; ignored for revise)
  status,       // "queued" | "running" | "done" | "failed" | "interrupted"
  createdAt, startedAt, finishedAt,  // ISO-8601 UTC
  summary,      // skill's final report text (from claude JSON result) on success
  error,        // one-line reason on failure
  collection,   // "stems" | "tracks" — which page/dir this job targets
  batch,        // batch id of the produced items (for deep-linking), or null
  newItems      // array of item ids created by the run (dir diff), may be []
}
```
API: `createJobStore({ jobsDir })` → `{ create, get, list, update }`. `list`
returns newest-first, capped (e.g. 50).

### 2. Serial worker — `server/runner.mjs`
- A single-slot queue. `enqueue(job)` persists it `queued`; if the worker is idle,
  it starts immediately, else it waits its turn.
- On start: set `running` + `startedAt`, persist.
- **Snapshot before:** read the set of item ids currently in the target dir
  (`stems/` or `tracks/`).
- Spawn the child (see §3). Stream nothing to the client live in v1; capture
  stdout/stderr.
- **Diff after:** re-read the target dir; `newItems` = ids present now but not in
  the before-snapshot. Derive `batch` from the new ids (their common
  `YYYY-MM-DD-<slug>` prefix; null if none/ambiguous). This is parser-free and
  works for both generate (new items) and revise (new version files).
- On exit 0: parse the JSON result, store its text as `summary`, set `done`.
  On non-zero exit / spawn error: store a one-line `error`, set `failed`.
- Always set `finishedAt`, then pick the next `queued` job.
- **Boot recovery:** when the runner is constructed, any job left `running` (server
  was killed mid-run) is marked `interrupted`; remaining `queued` jobs resume.

### 3. Headless invocation
`spawn('claude', argv, { cwd: repoRoot })` — **argv array, never a shell string**,
so prompt text cannot break out into the shell. Type → argv:

| type | prompt arg | claude prompt |
|------|-----------|---------------|
| `generate-stems`    | sound prompt  | `/generate-stems "<prompt>" <count>` |
| `generate-tracks`   | style prompt  | `/generate-tracks "<prompt>" <count>` |
| `revise-from-notes` | `stems`/`tracks` | `/revise-from-notes <collection>` |

Flags:
- `--output-format json` — capture the skill's final report into `job.summary`.
- `--allowedTools <list>` — **scoped allowlist**, not blanket bypass. Must cover
  what the skills and their sub-agents use:
  - `Write`, `Read`, `Edit` — agents write/fix `stems/*.json` / `tracks/*.json`.
  - `Task` — skills fan out parallel sub-agents.
  - `Bash` scoped to the commands the skills actually run:
    `node scripts/validate.mjs …`, `node scripts/feedback.mjs …`,
    `node scripts/pending-revisions.mjs …`, `date …`, `pwd`, `ls …`,
    `grep … scripts/sounds.json`, `rm stems/… | tracks/…`.
    The exact `Bash(...)` patterns are tuned during implementation; if scoping
    proves brittle for sub-agents, fall back to allowing `Bash` broadly (still
    private, fixed prompt) and record that decision.
- The permission-mode/allowlist flag spelling (`--allowedTools` and whether
  sub-agents inherit it, vs. needing `--permission-mode`) is verified against the
  installed Claude Code version during implementation, not assumed here.

The child inherits the server's environment, so it uses the owner's existing
Claude login on the box.

### 4. API routes — added to `server/app.mjs`
- `POST /api/jobs` `{type, prompt, count}`:
  - `type` must be one of the three allowlisted values → else 400.
  - generate-*: `prompt` non-empty string (cap length, e.g. ≤500) required;
    `count` coerced to int and clamped 1..30 (default 30).
  - revise: `prompt` must be `stems` or `tracks`.
  - Derive `collection` (`stems`|`tracks`) from `type` (generate-tracks → tracks,
    generate-stems → stems, revise → the `prompt` value) so the runner knows which
    dir to diff and the UI knows which page to deep-link.
  - Enqueue via the runner, return `201 { job }`.
- `GET /api/jobs` → recent jobs (newest-first).
- `GET /api/jobs/:id` → one job (404 if missing; reuse `ID_RE`).
- Wire the runner + job store in `server/index.mjs` alongside the existing stores.

### 5. Frontend — `src/`
- A "Generate" panel on the stems and tracks pages: a prompt input, a count input
  (1–30), and a Generate button → `POST /api/jobs`.
- A status strip that polls `GET /api/jobs` (e.g. every 3 s while any job is
  `queued`/`running`): shows type, prompt, status, and `summary`/`error` when
  finished.
- When a job transitions to `done`, re-fetch the existing `/api/<stems|tracks>`
  listing so the new items appear. No new listing wiring needed.
- A "Revise from notes" button per collection (no prompt; posts
  `type=revise-from-notes`, `prompt=<collection>`).
- **Deep-link entry point:** on page load, `app.js` reads a `?batch=<id>` query
  param; if present, it preselects that value in the existing `batch-filter`
  dropdown and sets `state.batch` so the page opens scrolled/filtered to the new
  items. This is the target the notifications and nav log link to.

### 7. Notifications & nav log — `src/notifications.js` (shared by both pages)
The job poller (§5) is the single source of completion events; both features hang
off it. Read-state is per-browser, so it lives in `localStorage`
(`lastSeenJobId` / seen-ids set) — not on the server.

**Browser notifications (Web Notifications API):**
- A toggle (bell) in the nav requests `Notification.permission` on first enable;
  if denied, the feature silently degrades to the in-app log only.
- When the poller sees a job flip to `done` **or** `failed` (and it wasn't already
  seen), fire one `Notification` — title e.g. `12 stems ready` / `Job failed`,
  body = prompt. Its click handler focuses the tab and navigates to the job's
  deep-link (`/` or `/stems` + `?batch=<batch>`), falling back to the collection
  page when `batch` is null.
- Only fire for jobs newer than page load, to avoid a burst of stale notifications
  on first visit.

**Nav log:**
- A bell/log control added to the `<nav>` of both `index.html` and `stems.html`,
  with an unread-count badge (jobs completed since `lastSeenJobId`).
- Clicking opens a dropdown listing recent finished jobs from `GET /api/jobs`
  (newest-first): collection, prompt, item count (`newItems.length`), status, time.
- Each entry is a link to its deep-link target (cross-page navigation between `/`
  and `/stems` is a normal page load). Opening the dropdown clears the unread
  badge and updates `lastSeenJobId`.
- Failed jobs appear in the log with their `error`, no deep-link.

### 6. Production serving + deployment
- `npm run build` → `dist/`. Extend `server/app.mjs` to serve static `dist/` (and
  SPA fallback) in addition to `/api`, so one `PORT` serves both. (Dev keeps the
  Vite + api split via `npm run dev`.)
- Run the server under a process manager (pm2 or systemd) with `PORT` set.
- Prerequisites on the box: `claude` on `PATH` and logged in (already done); the
  repo checked out where the server's `cwd` resolves to repo root.
- Deploy cycle: `git pull && npm ci && npm run build && <restart>`.

## Testing
- **Job store:** unit tests (create/get/list/update, boot-recovery marks `running`
  → `interrupted`) following the existing `test/` patterns.
- **API:** supertest (already a dep) — validation (bad type, missing prompt,
  out-of-range count → 400), enqueue returns 201, status fetch.
- **Runner:** inject a fake spawn so tests don't invoke real `claude` — assert the
  exact argv built per type, single-slot serialization (second job stays `queued`
  until the first finishes), exit-code → status mapping, and the dir-diff
  (`newItems`/`batch` computed from files appearing between before/after snapshots).
- **Notifications/log:** unit-test the deep-link builder (job → `/` or `/stems` +
  `?batch=`), unread-count from `lastSeenJobId`, and the "only notify jobs newer
  than page load" guard. The Web Notifications API itself is mocked.
- **Manual end-to-end:** on the server, click Generate for a 2-stem batch, confirm
  the job runs, files land in `stems/`, and the UI lists them.

## Out of scope / YAGNI
- Auth, rate limiting, multi-user, abuse protection (private/single-user).
- Live token-by-token streaming to the UI (`stream-json`) — status + final summary
  is enough for v1; can add later.
- Cancelling a running job from the UI.
- Multi-job concurrency / worktree isolation.

## Risks
- **Permission scoping for sub-agents:** the scoped `--allowedTools` must reach the
  fanned-out Task agents, or runs stall waiting on a prompt that headless can't
  answer. Mitigation: tune patterns during implementation; broad-`Bash` fallback.
- **Subscription rate limits:** a 30-agent fan-out is heavy; back-to-back UI clicks
  could exhaust the plan's limits. Single concurrency + the manual count cap
  mitigate; surfaced as a `failed` job with the rate-limit reason if hit.
- **Long jobs vs. proxy timeouts:** generation takes minutes, but the HTTP request
  returns immediately (async job) — only the front proxy's idle timeout on the
  *poll* endpoints matters, and those are fast.
