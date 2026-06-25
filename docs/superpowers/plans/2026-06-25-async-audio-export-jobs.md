# Async Audio Export Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make song downloads (WAV/MP3/stems) non-blocking: clicking a download button kicks off a background render job, shows a "rendering…" state, and — when the render finishes — fires a notification and adds a persistent download link to the existing notifications log.

**Architecture:** Reuse the app's existing file-backed **jobs system** (`server/jobs.mjs` store, `server/runner.mjs` queue, `POST/GET /api/jobs`, the nav bell + `#job-log` dropdown + browser `Notification` in `src/jobs-ui.js`/`src/notifications.js`). Add a new `export-audio` job type that runs the existing headless-Chrome renderer on its own single-slot lane (so it never blocks generation), records a `downloadUrl` on completion, and surfaces through the same notification UI. Harden the renderer (raise puppeteer `protocolTimeout`, recycle the browser per render) so the minute-long renders that currently OOM/timeout actually complete.

**Tech Stack:** Node + Express server, `puppeteer-core` headless Chrome render, file-backed JSON job store, vanilla-JS + `@instantdb/core` client, `vitest` for tests.

## Global Constraints

- **Worktree required.** `src/app.js` and `src/song.js` are being edited by a parallel session. Per the repo's global rules, implement this on an isolated git worktree (invoke `superpowers:using-git-worktrees`), then merge to the main worktree and `sudo systemctl restart vimsical-crate` to deploy. A branch in a worktree is NOT live.
- **No InstantDB schema/perms change.** Jobs live in the file-backed store (`data/jobs/<id>.json`), not InstantDB. Do not touch `instant.schema.ts` / `instant.perms.ts`.
- **Reuse, don't fork.** Extend the existing jobs/notifications/runner code. Do not build a parallel notification system.
- **Download link = existing route.** The download URL is the existing `GET /api/:ns/:slug/audio.:fmt` (it already sets `Content-Disposition: attachment`, so a plain link click downloads). Once a render is cached this returns instantly.
- **Test runner:** `npx vitest run <file>` for single files; tests live under `test/`.

## Decisions & Assumptions (confirm during review)

1. **Auth:** Creating an `export-audio` job goes through the existing `POST /api/jobs`, which is `requireAuth`. So a signed-in operator triggers renders; **cached files stay publicly downloadable** (the probe/GET path is public). Anonymous visitors clicking an uncached format get a "sign in to render" hint. *(If anonymous on-demand rendering is desired, we'd add a public rate-limited path instead.)*
2. **Render reliability:** This plan raises `protocolTimeout` and recycles the browser per render so most tracks complete. It does **not** implement chunked/segmented rendering. The very largest tracks (8-min / 10-stem) may still fail; that failure is surfaced honestly as a `failed` job in the log. Chunked rendering is future work.
3. **Concurrency:** Export jobs run on a **separate single-slot lane** from generation, so a long export never blocks track generation and vice-versa. Within the export lane, renders are serial (bounds memory).
4. **Song page gets the bell + log.** We add the notification bell/log markup to `song.html` and mount the jobs UI there in "bell-only" mode (no generate panel), so the download link appears in the log on the page where the user clicked.

---

## File Structure

**Server (modify):**
- `server/jobs.mjs` — add `export-audio` to `JOB_TYPES`.
- `server/audio-export.mjs` — add `cachedOnly(ns, idOrSlug, fmt)` (resolve + cache lookup, never renders).
- `server/render-audio.mjs` — raise `protocolTimeout`; close the browser after each render (recycle) to bound memory.
- `server/runner.mjs` — add an export lane: branch `export-audio` jobs to a renderer path that sets `downloadUrl`; keep generation path unchanged.
- `server/app.mjs` — accept `export-audio` in `POST /api/jobs` (validate ns/slug/fmt, dedupe); add `?probe=1` branch to the audio GET route (cached-or-202, no render).

**Client (modify):**
- `src/notifications.js` — extend `notificationText`, add `downloadLink(job)`, handle export jobs in `progressText`.
- `src/jobs-ui.js` — render export jobs in the log with a download `<a>`; fire the completion `Notification` with the download link; allow mounting with a bell but no gen panel.
- `src/song.js` — replace the bare `<a download>` button handler with the async export flow (`requestExport`); mount bell-only jobs UI.
- `src/app.js` — replace the bare `<a download>` handler on list-page rows with the same `requestExport` flow.
- `src/export-download.js` *(new)* — shared `requestExport({ ns, slug, fmt, title, button })` helper used by both `song.js` and `app.js` (probe → download or POST job + "rendering…" state). Keeps the flow DRY and unit-testable.
- `song.html` — add the bell + `#job-log` markup to the masthead nav (mirror `index.html`), without the generate panel.

**Tests (create/extend):**
- `test/jobs.test.mjs` — `export-audio` is an accepted type.
- `test/audio-export.test.mjs` — `cachedOnly` returns a path on hit, null on miss, never renders.
- `test/render-audio.test.mjs` — browser is closed after each render; `protocolTimeout` is passed to launch.
- `test/runner.test.mjs` — an `export-audio` job runs the renderer (not claude) and records `downloadUrl` / `failed`.
- `test/notifications.test.mjs` — `notificationText` + `downloadLink` for export jobs.
- `test/export-download.test.mjs` — `requestExport` probe-hit downloads; probe-miss posts a job.
- `test/api.test.mjs` — extend: `POST /api/jobs` accepts export-audio; `?probe=1` does not render.

---

## Task 1: Accept the `export-audio` job type

**Files:**
- Modify: `server/jobs.mjs:6-8`
- Test: `test/jobs.test.mjs`

**Interfaces:**
- Produces: `JOB_TYPES` now contains `'export-audio'`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/jobs.test.mjs
import { describe, it, expect } from 'vitest';
import { JOB_TYPES } from '../server/jobs.mjs';

describe('JOB_TYPES', () => {
  it('includes export-audio', () => {
    expect(JOB_TYPES.has('export-audio')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/jobs.test.mjs`
Expected: FAIL — `export-audio` not in set.

- [ ] **Step 3: Add the type**

In `server/jobs.mjs`, change the `JOB_TYPES` set:

```javascript
export const JOB_TYPES = new Set([
  'generate-stems', 'generate-tracks', 'revise-from-notes', 'remix',
  'export-audio',
]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/jobs.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/jobs.mjs test/jobs.test.mjs
git commit -m "feat(jobs): accept export-audio job type"
```

---

## Task 2: `cachedOnly` lookup + `?probe=1` route (no render on miss)

**Files:**
- Modify: `server/audio-export.mjs`
- Modify: `server/app.mjs:94-110` (audio route)
- Test: `test/audio-export.test.mjs`, `test/api.test.mjs`

**Interfaces:**
- Consumes: `cache.cachedPath(ns, id, fmt)`, `cache.EXT`, `resolveRow` (existing in `audio-export.mjs`).
- Produces: `audioExport.cachedOnly(ns, idOrSlug, fmt) => { path, filename } | null` (resolves the row + checks cache; never renders). Audio GET route: `?probe=1` returns the file if cached, else `202 { status: 'rendering' }`, with no render side-effect.

- [ ] **Step 1: Write the failing test**

```javascript
// test/audio-export.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { createAudioExport } from '../server/audio-export.mjs';

const row = { id: 'uuid-1', slug: 'song-1', code: 'x', meta: { bpm: 120 } };
const adminDb = { query: vi.fn(async () => ({ tracks: [row] })) };
const baseCache = { EXT: { wav: 'wav', mp3: 'mp3', stems: 'zip' } };

describe('cachedOnly', () => {
  it('returns the cached path on hit, without rendering', async () => {
    const renderer = { render: vi.fn() };
    const cache = { ...baseCache, cachedPath: vi.fn(async () => '/cache/uuid-1.wav') };
    const ax = createAudioExport({ adminDb, cache, renderer });
    const out = await ax.cachedOnly('tracks', 'song-1', 'wav');
    expect(out).toEqual({ path: '/cache/uuid-1.wav', filename: 'song-1.wav' });
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it('returns null on miss, without rendering', async () => {
    const renderer = { render: vi.fn() };
    const cache = { ...baseCache, cachedPath: vi.fn(async () => null) };
    const ax = createAudioExport({ adminDb, cache, renderer });
    expect(await ax.cachedOnly('tracks', 'song-1', 'wav')).toBeNull();
    expect(renderer.render).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/audio-export.test.mjs`
Expected: FAIL — `ax.cachedOnly is not a function`.

- [ ] **Step 3: Implement `cachedOnly`**

In `server/audio-export.mjs`, add inside `createAudioExport` (after `getOrRender`):

```javascript
  async function cachedOnly(ns, idOrSlug, fmt) {
    if (!namespaces.includes(ns) || !FORMATS.has(fmt)) return null;
    const row = await resolveRow(ns, idOrSlug);
    if (!row) return null;
    const hit = await cache.cachedPath(ns, row.id, fmt);
    if (!hit) return null;
    return { path: hit, filename: `${row.slug}.${cache.EXT[fmt]}` };
  }
```

And add `cachedOnly` to the returned object:

```javascript
  return { getOrRender, cachedOnly, prewarm };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/audio-export.test.mjs`
Expected: PASS

- [ ] **Step 5: Add the `?probe=1` route branch**

In `server/app.mjs`, in the `audioRoutes` handler, add at the top of the handler body (before the existing `getOrRender` block):

```javascript
    if (req.query.probe) {
      const cached = await audioExport.cachedOnly(ns, id, fmt);
      if (!cached) return res.status(202).json({ status: 'rendering' });
      const cext = cached.filename.split('.').pop();
      res.type(AUDIO_TYPE[cext] ?? 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${cached.filename}"`);
      return res.sendFile(cached.path);
    }
```

- [ ] **Step 6: Add an API test for probe**

```javascript
// test/api.test.mjs — add within the audio describe block
it('GET audio with ?probe=1 returns 202 on cache miss and does not render', async () => {
  const audioExport = {
    cachedOnly: async () => null,
    getOrRender: vi.fn(),
  };
  const app = createApp({ audioExport });
  const res = await request(app).get('/api/tracks/song-1/audio.wav?probe=1');
  expect(res.status).toBe(202);
  expect(audioExport.getOrRender).not.toHaveBeenCalled();
});
```

*(Match the existing `createApp`/`request` setup already used in `test/api.test.mjs`; reuse its imports.)*

- [ ] **Step 7: Run tests**

Run: `npx vitest run test/audio-export.test.mjs test/api.test.mjs`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add server/audio-export.mjs server/app.mjs test/audio-export.test.mjs test/api.test.mjs
git commit -m "feat(audio-export): cachedOnly lookup + ?probe=1 route (no render on miss)"
```

---

## Task 3: Harden the renderer (timeout + browser recycle)

**Files:**
- Modify: `server/render-audio.mjs`
- Test: `test/render-audio.test.mjs`

**Interfaces:**
- Produces: `createRenderer` launches Chrome with `protocolTimeout` (default 1_200_000 ms / 20 min, overridable via `protocolMs` option) and closes the browser after **each** render so memory never accumulates across renders. `render(track, fmt)` signature unchanged.

**Why:** Measured failures are (a) the default 180 s `protocolTimeout` aborting long renders and (b) OOM crashes from memory accumulating in the long-lived browser across renders. Recycling the browser per render + a generous protocol timeout fixes the common cases.

- [ ] **Step 1: Write the failing test**

```javascript
// test/render-audio.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { createRenderer } from '../server/render-audio.mjs';

function fakeBrowser() {
  const page = {
    goto: vi.fn(async () => {}),
    evaluate: vi.fn(async () => Buffer.from('x').toString('base64')),
    close: vi.fn(async () => {}),
  };
  return {
    closed: false,
    newPage: vi.fn(async () => page),
    on: vi.fn(),
    close: vi.fn(async function () { this.closed = true; }),
    _page: page,
  };
}

describe('createRenderer hardening', () => {
  it('passes protocolTimeout to launch and closes the browser after each render', async () => {
    const browser = fakeBrowser();
    const launch = vi.fn(async () => browser);
    const renderer = createRenderer({ pageUrl: 'http://x/export-render.html', launch, idleMs: 999999 });

    await renderer.render({ id: 't', code: 'c', meta: { bpm: 120 } }, 'wav');

    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ protocolTimeout: 1200000 }));
    expect(browser.close).toHaveBeenCalledTimes(1); // recycled after the render
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/render-audio.test.mjs`
Expected: FAIL — `protocolTimeout` absent / browser not closed after render.

- [ ] **Step 3: Implement hardening**

In `server/render-audio.mjs`:

Add `protocolMs = 1_200_000` to the `createRenderer` destructured options.

Change `ensureBrowser` to pass the timeout:

```javascript
  async function ensureBrowser() {
    if (browser) return browser;
    browser = await launch({
      executablePath: chromePath,
      headless: true,
      protocolTimeout: protocolMs,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    browser.on('disconnected', () => { browser = null; });
    return browser;
  }
```

Change `renderOnce` to recycle the browser after each render (replace the `finally` block):

```javascript
    } finally {
      await page.close().catch(() => {});
      // Recycle the browser after every render: a long-lived Chrome accumulates
      // memory across renders (big OfflineAudioContext graphs) and eventually
      // OOM-crashes the tab. A fresh browser per render bounds peak memory.
      await close();
    }
```

*(`close()` already nulls `browser` and clears the idle timer; the next render re-launches. Remove the now-redundant `armIdleClose()` call from the `finally`, and the idle-timer machinery may stay unused — leave `armIdleClose`/`idleTimer` in place to keep the diff small, or delete if the reviewer prefers.)*

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/render-audio.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/render-audio.mjs test/render-audio.test.mjs
git commit -m "fix(render-audio): 20min protocolTimeout + recycle browser per render to bound memory"
```

---

## Task 4: Export lane in the runner

**Files:**
- Modify: `server/runner.mjs`
- Test: `test/runner.test.mjs`

**Interfaces:**
- Consumes: `audioExport.getOrRender(ns, slug, fmt)` (existing), `jobStore.update`, `jobStore.get`.
- Produces: when a job has `type === 'export-audio'`, the runner renders via `audioExport` (NOT claude) on a **separate single-slot lane**, then patches the job `{ status: 'done', finishedAt, downloadUrl }` on success or `{ status: 'failed', finishedAt, error }` on failure. `downloadUrl = /api/<collection>/<slug>/audio.<fmt>`. `enqueue` routes export jobs to the export lane and all other types to the existing generation lane.

- [ ] **Step 1: Write the failing test**

```javascript
// test/runner.test.mjs — add to the existing suite (reuse its imports/helpers)
import { describe, it, expect, vi } from 'vitest';
import { createRunner } from '../server/runner.mjs';

function memStore() {
  const jobs = new Map();
  return {
    jobs,
    get: async (id) => jobs.get(id) ?? null,
    update: async (id, patch) => { const j = { ...jobs.get(id), ...patch }; jobs.set(id, j); return j; },
    write: async (j) => { jobs.set(j.id, j); return j; },
    list: async () => [...jobs.values()],
  };
}

describe('runner export-audio lane', () => {
  it('renders via audioExport and records downloadUrl', async () => {
    const jobStore = memStore();
    const audioExport = { getOrRender: vi.fn(async () => ({ path: '/c/x.wav', filename: 'song-1.wav' })) };
    const spawn = vi.fn(() => { throw new Error('claude must not run for export jobs'); });
    const runner = createRunner({ repoRoot: '.', jobStore, adminDb: {}, spawn, audioExport });

    const job = { id: 'j1', type: 'export-audio', collection: 'tracks', slug: 'song-1', fmt: 'wav', status: 'queued' };
    await jobStore.write(job);
    await runner.enqueue(job);
    await vi.waitFor(() => expect(jobStore.jobs.get('j1').status).toBe('done'));

    expect(audioExport.getOrRender).toHaveBeenCalledWith('tracks', 'song-1', 'wav');
    expect(jobStore.jobs.get('j1').downloadUrl).toBe('/api/tracks/song-1/audio.wav');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('marks the job failed when the render throws', async () => {
    const jobStore = memStore();
    const audioExport = { getOrRender: vi.fn(async () => { throw new Error('render boom'); }) };
    const runner = createRunner({ repoRoot: '.', jobStore, adminDb: {}, spawn: vi.fn(), audioExport });
    const job = { id: 'j2', type: 'export-audio', collection: 'stems', slug: 'st-1', fmt: 'stems', status: 'queued' };
    await jobStore.write(job);
    await runner.enqueue(job);
    await vi.waitFor(() => expect(jobStore.jobs.get('j2').status).toBe('failed'));
    expect(jobStore.jobs.get('j2').error).toContain('render boom');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/runner.test.mjs`
Expected: FAIL — export jobs currently fall through to the claude path.

- [ ] **Step 3: Implement the export lane**

In `server/runner.mjs`, inside `createRunner`, add a second single-slot lane and an export runner. After the existing `const queue = []; let active = 0;` add:

```javascript
  const exportQueue = [];
  let exportActive = 0;

  async function runExport(id) {
    const job = await jobStore.get(id);
    if (!job) return;
    try {
      await jobStore.update(id, { status: 'running', startedAt: now() });
      await audioExport.getOrRender(job.collection, job.slug, job.fmt);
      await jobStore.update(id, {
        status: 'done',
        finishedAt: now(),
        downloadUrl: `/api/${job.collection}/${job.slug}/audio.${job.fmt}`,
      });
    } catch (err) {
      await jobStore.update(id, { status: 'failed', finishedAt: now(), error: String(err?.message ?? err) });
    }
  }

  function pumpExport() {
    while (exportActive < 1 && exportQueue.length) {
      const id = exportQueue.shift();
      exportActive += 1;
      runExport(id)
        .catch((err) => console.error('runExport failed', err))
        .finally(() => { exportActive -= 1; pumpExport(); });
    }
  }
```

Change `enqueue` to route by type:

```javascript
  async function enqueue(job) {
    if (job.type === 'export-audio') { exportQueue.push(job.id); pumpExport(); return job; }
    queue.push(job.id);
    pump();
    return job;
  }
```

Update `recover()` so interrupted/queued export jobs re-route correctly:

```javascript
  async function recover() {
    for (const job of await jobStore.list()) {
      if (job.status === 'running') {
        await jobStore.update(job.id, { status: 'interrupted', finishedAt: now() });
      } else if (job.status === 'queued') {
        (job.type === 'export-audio' ? exportQueue : queue).push(job.id);
      }
    }
    pump();
    pumpExport();
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/runner.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/runner.mjs test/runner.test.mjs
git commit -m "feat(runner): export-audio lane renders via audioExport and records downloadUrl"
```

---

## Task 5: `POST /api/jobs` accepts export-audio (validate + dedupe)

**Files:**
- Modify: `server/app.mjs:141-189` (jobRoutes POST handler)
- Test: `test/api.test.mjs`

**Interfaces:**
- Consumes: `jobStore.list`, `jobStore.write`, `runner.enqueue`, `ID_RE` (existing slug regex in app.mjs).
- Produces: `POST /api/jobs { type:'export-audio', namespace, slug, fmt }` validates `namespace ∈ {tracks,stems}`, `ID_RE.test(slug)`, `fmt ∈ {wav,mp3,stems}`; if an identical export job is already `queued`/`running`, returns that job (dedupe) instead of creating a duplicate; otherwise creates `{ ...base, type:'export-audio', collection:namespace, slug, fmt, prompt:slug, count:null }` and enqueues it.

- [ ] **Step 1: Write the failing test**

```javascript
// test/api.test.mjs — add a describe block (reuse existing createApp/request setup)
it('POST /api/jobs creates an export-audio job', async () => {
  const written = [];
  const jobStore = {
    TYPES: new Set(['export-audio']),
    list: async () => [],
    write: async (j) => { written.push(j); return j; },
  };
  const runner = { enqueue: async () => {} };
  const app = createApp({ jobStore, runner });
  const res = await request(app)
    .post('/api/jobs')
    .send({ type: 'export-audio', namespace: 'tracks', slug: 'song-1', fmt: 'wav' });
  expect(res.status).toBe(201);
  expect(res.body).toMatchObject({ type: 'export-audio', collection: 'tracks', slug: 'song-1', fmt: 'wav', status: 'queued' });
});

it('POST /api/jobs rejects an invalid export fmt', async () => {
  const jobStore = { TYPES: new Set(['export-audio']), list: async () => [], write: async (j) => j };
  const app = createApp({ jobStore, runner: { enqueue: async () => {} } });
  const res = await request(app)
    .post('/api/jobs')
    .send({ type: 'export-audio', namespace: 'tracks', slug: 'song-1', fmt: 'ogg' });
  expect(res.status).toBe(400);
});
```

*(If the production `createApp` wires `requireAuth`, the test harness already passes a no-op `requireAuth`; mirror however `test/api.test.mjs` constructs the app for the existing job tests.)*

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/api.test.mjs`
Expected: FAIL — export-audio branch not handled (falls into the generate branch and 400s on prompt).

- [ ] **Step 3: Implement the branch**

In `server/app.mjs`, in the `POST /api/jobs` handler, add this branch BEFORE the `if (type === 'remix')` chain (right after the `base` object is built):

```javascript
    if (type === 'export-audio') {
      const { namespace, slug, fmt } = req.body ?? {};
      const FMTS = new Set(['wav', 'mp3', 'stems']);
      if (namespace !== 'tracks' && namespace !== 'stems') {
        return res.status(400).json({ error: 'namespace must be tracks or stems' });
      }
      if (!ID_RE.test(String(slug ?? ''))) return res.status(400).json({ error: 'invalid slug' });
      if (!FMTS.has(fmt)) return res.status(400).json({ error: 'fmt must be wav, mp3, or stems' });

      // Dedupe: if this exact export is already in flight, return it.
      const existing = (await jobStore.list()).find((j) =>
        j.type === 'export-audio' && j.collection === namespace && j.slug === slug && j.fmt === fmt
        && (j.status === 'queued' || j.status === 'running'));
      if (existing) return res.status(200).json(existing);

      const job = { ...base, type: 'export-audio', prompt: slug, count: null, collection: namespace, slug, fmt };
      await jobStore.write(job);
      await runner.enqueue(job);
      return res.status(201).json(job);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/api.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/app.mjs test/api.test.mjs
git commit -m "feat(api): POST /api/jobs accepts + dedupes export-audio jobs"
```

---

## Task 6: Notification text + download link for export jobs

**Files:**
- Modify: `src/notifications.js`
- Test: `test/notifications.test.mjs`

**Interfaces:**
- Produces:
  - `downloadLink(job) => string | null` — `job.downloadUrl` for a done export job, else null.
  - `notificationText(job)` — for `type === 'export-audio'`: done → `{ title: '<FMT> ready', body: slug }`; failed → `{ title: 'Export failed', body: slug }`. Generation jobs keep their existing text.
  - `progressText(job, nowMs)` — for a running export job returns `rendering <fmt>… · m:ss`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/notifications.test.mjs — add (reuse existing imports)
import { downloadLink, notificationText, progressText } from '../src/notifications.js';

describe('export-audio notifications', () => {
  const done = { type: 'export-audio', status: 'done', collection: 'tracks', slug: 'song-1', fmt: 'wav', downloadUrl: '/api/tracks/song-1/audio.wav' };
  it('downloadLink returns the url for a done export', () => {
    expect(downloadLink(done)).toBe('/api/tracks/song-1/audio.wav');
  });
  it('downloadLink is null for a non-export or unfinished job', () => {
    expect(downloadLink({ type: 'generate-tracks', status: 'done' })).toBeNull();
    expect(downloadLink({ type: 'export-audio', status: 'running' })).toBeNull();
  });
  it('notificationText announces the ready format', () => {
    expect(notificationText(done)).toEqual({ title: 'WAV ready', body: 'song-1' });
  });
  it('notificationText reports export failure', () => {
    expect(notificationText({ ...done, status: 'failed' })).toEqual({ title: 'Export failed', body: 'song-1' });
  });
  it('progressText shows rendering for a running export', () => {
    const t = progressText({ type: 'export-audio', status: 'running', fmt: 'mp3', startedAt: new Date(0).toISOString() }, 5000);
    expect(t).toMatch(/^rendering mp3…/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/notifications.test.mjs`
Expected: FAIL — `downloadLink` undefined; export branches missing.

- [ ] **Step 3: Implement**

In `src/notifications.js`:

Add the export branch at the top of `notificationText`:

```javascript
export function notificationText(job) {
  if (job.type === 'export-audio') {
    const fmt = String(job.fmt ?? '').toUpperCase();
    if (job.status === 'failed') return { title: 'Export failed', body: job.slug };
    return { title: `${fmt} ready`, body: job.slug };
  }
  if (job.status === 'failed') return { title: 'Generation failed', body: job.prompt };
  // ...existing lines unchanged...
```

Add `downloadLink`:

```javascript
export function downloadLink(job) {
  return job.type === 'export-audio' && job.status === 'done' ? (job.downloadUrl ?? null) : null;
}
```

Add an export branch at the top of `progressText` (after the `queued` check):

```javascript
  if (job.status === 'queued') return 'queued';
  if (job.type === 'export-audio') {
    if (job.status !== 'running') return '';
    const elapsed = job.startedAt ? ` · ${formatElapsed(nowMs - Date.parse(job.startedAt))}` : '';
    return `rendering ${job.fmt}…${elapsed}`;
  }
  if (job.status !== 'running') return '';
  // ...existing generation lines unchanged...
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/notifications.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/notifications.js test/notifications.test.mjs
git commit -m "feat(notifications): export-audio notification text + downloadLink helper"
```

---

## Task 7: `requestExport` client helper (probe → download or job)

**Files:**
- Create: `src/export-download.js`
- Test: `test/export-download.test.mjs`

**Interfaces:**
- Produces: `requestExport({ ns, slug, fmt, signedIn, fetchImpl, postJob, onState })` where:
  - probes `GET /api/<ns>/<slug>/audio.<fmt>?probe=1`.
  - **200** → calls `onState('ready')` and resolves `{ ready: true, url }` (caller triggers the download).
  - **202** and `signedIn` → calls `postJob({ type:'export-audio', namespace:ns, slug, fmt })`, then `onState('rendering')`, resolves `{ ready: false, queued: true }`.
  - **202** and not `signedIn` → `onState('signin')`, resolves `{ ready: false, queued: false }`.
  - Network error → `onState('error')`.
  - `fetchImpl`/`postJob` are injected for testability (default to `window.fetch` and a POST to `/api/jobs`).

- [ ] **Step 1: Write the failing test**

```javascript
// test/export-download.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { requestExport } from '../src/export-download.js';

const url = '/api/tracks/song-1/audio.wav';

describe('requestExport', () => {
  it('downloads immediately on a cache hit (200)', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200 }));
    const onState = vi.fn();
    const out = await requestExport({ ns: 'tracks', slug: 'song-1', fmt: 'wav', signedIn: true, fetchImpl, postJob: vi.fn(), onState });
    expect(out).toEqual({ ready: true, url });
    expect(onState).toHaveBeenCalledWith('ready');
  });

  it('posts an export job on a miss (202) when signed in', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 202 }));
    const postJob = vi.fn(async () => ({ id: 'j1' }));
    const onState = vi.fn();
    const out = await requestExport({ ns: 'tracks', slug: 'song-1', fmt: 'wav', signedIn: true, fetchImpl, postJob, onState });
    expect(postJob).toHaveBeenCalledWith({ type: 'export-audio', namespace: 'tracks', slug: 'song-1', fmt: 'wav' });
    expect(out).toEqual({ ready: false, queued: true });
    expect(onState).toHaveBeenCalledWith('rendering');
  });

  it('asks anonymous users to sign in on a miss', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 202 }));
    const postJob = vi.fn();
    const onState = vi.fn();
    const out = await requestExport({ ns: 'tracks', slug: 'song-1', fmt: 'wav', signedIn: false, fetchImpl, postJob, onState });
    expect(postJob).not.toHaveBeenCalled();
    expect(out).toEqual({ ready: false, queued: false });
    expect(onState).toHaveBeenCalledWith('signin');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/export-download.test.mjs`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/export-download.js`**

```javascript
// Shared download flow for both the song page and the list rows. Probes the
// cache; on a hit the caller downloads instantly, on a miss we enqueue a
// background export job and the notifications UI delivers the link when ready.

async function defaultPostJob(body) {
  const res = await fetch('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`job post failed: ${res.status}`);
  return res.json();
}

export async function requestExport({
  ns, slug, fmt, signedIn,
  fetchImpl = (...a) => fetch(...a),
  postJob = defaultPostJob,
  onState = () => {},
}) {
  const url = `/api/${ns}/${slug}/audio.${fmt}`;
  let res;
  try {
    res = await fetchImpl(`${url}?probe=1`);
  } catch {
    onState('error');
    return { ready: false, queued: false, error: true };
  }
  if (res.status === 200) {
    onState('ready');
    return { ready: true, url };
  }
  if (!signedIn) {
    onState('signin');
    return { ready: false, queued: false };
  }
  try {
    await postJob({ type: 'export-audio', namespace: ns, slug, fmt });
  } catch {
    onState('error');
    return { ready: false, queued: false, error: true };
  }
  onState('rendering');
  return { ready: false, queued: true };
}

// Trigger a browser download of an already-ready URL.
export function triggerDownload(url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/export-download.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/export-download.js test/export-download.test.mjs
git commit -m "feat(client): requestExport probe-then-job download helper"
```

---

## Task 8: Wire download buttons to `requestExport` (song page + list rows)

**Files:**
- Modify: `src/song.js` (the export-button block — currently builds `↓︎ <fmt>` buttons with a bare `<a download>` handler)
- Modify: `src/app.js` (the list-row export buttons — same bare-handler pattern)

**Note:** These two files are under concurrent edit by another session; locate the current button-creation block by its content (`btn.className = 'export'` / ``btn.textContent = `↓︎ ${fmt}` `` and the `const url = ` / `a.click()` handler) rather than by line number.

**Interfaces:**
- Consumes: `requestExport`, `triggerDownload` from `src/export-download.js`; the current auth/user state (the page already knows whether a user is signed in — reuse that, e.g. the `db.useAuth`/`subscribeAuth` value already wired in `src/auth.js`).

- [ ] **Step 1: Update the song-page handler**

In `src/song.js`, add at the top:

```javascript
import { requestExport, triggerDownload } from './export-download.js';
```

Replace the button's `click` handler (the block that currently creates an `<a>` and clicks it) with:

```javascript
    btn.addEventListener('click', async () => {
      if (btn.dataset.busy) return;
      btn.dataset.busy = '1';
      const original = btn.textContent;
      const out = await requestExport({
        ns, slug: item.entityId, fmt, signedIn: isSignedIn(),
        onState: (s) => {
          if (s === 'rendering') btn.textContent = `rendering ${fmt}…`;
          else if (s === 'signin') btn.textContent = 'sign in to render';
          else if (s === 'error') btn.textContent = 'error — retry';
        },
      });
      if (out.ready) { triggerDownload(out.url); btn.textContent = original; }
      // On a queued render, leave the "rendering…" label; the notification +
      // log deliver the link. Re-enable so the user can re-click to re-check.
      setTimeout(() => { delete btn.dataset.busy; if (!out.ready && out.queued) return; btn.textContent = original; }, 4000);
    });
```

*(`isSignedIn()` = whatever the page already uses to read auth state. If `item.entityId` is not in scope on this row, use the same id the current `/api/${ns}/${id}/audio.${fmt}` URL uses.)*

- [ ] **Step 2: Update the list-row handler in `src/app.js`**

Apply the identical change to the list-row export buttons in `src/app.js`: import `requestExport`/`triggerDownload`, replace the bare `<a download>` click handler with the same async flow, using that row's `collection`/`track.entityId`.

- [ ] **Step 3: Manual verification (no unit test — DOM/integration)**

Build and run locally, then:

```bash
npm run build
```

Verify by hand (record results in the PR):
- Click WAV on an **uncached** track while signed in → button shows `rendering wav…`, no hang, page stays responsive.
- The nav bell shows the export job as `rendering wav… · m:ss`, then on completion a browser notification `WAV ready` fires and the `#job-log` shows a download link.
- Clicking the log link downloads the file.
- Click WAV again (now cached) → downloads immediately, no job created.
- Click WAV while signed out → button shows `sign in to render`.

- [ ] **Step 4: Commit**

```bash
git add src/song.js src/app.js
git commit -m "feat(client): downloads kick off async export jobs with rendering state"
```

---

## Task 9: Add the bell + log to the song page and mount bell-only jobs UI

**Files:**
- Modify: `song.html` (masthead nav)
- Modify: `src/jobs-ui.js` (allow mounting with a bell but no gen panel)
- Modify: `src/song.js` (mount the jobs UI)

**Interfaces:**
- Produces: `mountJobsUI` mounts when `#job-bell` is present even if `#gen-prompt`/`#gen-go` are absent (it guards each gen-panel listener instead of early-returning on a missing prompt).

- [ ] **Step 1: Relax `mountJobsUI` gating**

In `src/jobs-ui.js`, change the early return:

```javascript
  if (!bell) return; // no notifications nav — nothing to mount
```

and guard each generate-panel wiring so a missing panel is a no-op:

```javascript
  if (promptEl && $('#gen-go')) {
    $('#gen-go').addEventListener('click', () => { /* existing */ });
    $('#gen-revise')?.addEventListener('click', () => { /* existing */ });
  }
```

*(Leave the poller, bell, badge, log, and notification code unconditional — those are what the song page needs.)*

- [ ] **Step 2: Add the bell + log markup to `song.html`**

In `song.html`, inside the masthead nav (mirror `index.html:22` and `:45`), add the bell button and, near the end of the masthead, the log container:

```html
      <button id="job-bell" class="job-bell" aria-label="notifications" title="downloads & jobs"><svg class="bell-ico" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 1.6a3.4 3.4 0 0 0-3.4 3.4c0 3-1.5 4-1.5 4h9.8s-1.5-1-1.5-4A3.4 3.4 0 0 0 8 1.6Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M6.4 12a1.6 1.6 0 0 0 3.2 0" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg><span id="job-unread" class="job-unread" hidden>0</span></button>
```

```html
  <div id="job-log" class="job-log" hidden></div>
```

*(Do NOT add `#gen-prompt`/`#gen-go` — the song page has no generate panel.)*

- [ ] **Step 3: Mount the jobs UI on the song page**

In `src/song.js`, after the page renders, add:

```javascript
  const { mountJobsUI } = await import('./jobs-ui.js');
  mountJobsUI({ collection: ns });
```

- [ ] **Step 4: Render the download link in the log**

In `src/jobs-ui.js` `renderLog`, in the `finished` map, handle export jobs (import `downloadLink`):

```javascript
    const finishedHtml = finished.map((j) => {
      if (j.type === 'export-audio') {
        const link = downloadLink(j);
        if (link) return `<a href="${escapeHtml(link)}" download title="download">${escapeHtml(`${String(j.fmt).toUpperCase()} — ${j.slug}`)}</a>`;
        return `<span class="failed">${escapeHtml(`export failed: ${j.slug}`)}</span>`;
      }
      if (j.status === 'done') { /* existing generation branch */ }
      // ...existing failed branch...
    }).join('');
```

And in `fire(job)` (the browser Notification), make an export notification's click open the download link:

```javascript
  function fire(job) {
    if (!(notifySupported() && Notification.permission === 'granted')) return;
    const { title, body } = notificationText(job);
    const n = new Notification(title, { body });
    const link = downloadLink(job);
    n.onclick = () => { window.focus(); window.location.href = link || deepLink(job); };
  }
```

Add the import at the top:

```javascript
import { deepLink, unreadCount, newlyFinished, notificationText, progressText, downloadLink } from './notifications.js';
```

- [ ] **Step 5: Manual verification**

```bash
npm run build
```

- On a song page while signed in, trigger an uncached export; confirm the bell badge increments, the log lists `rendering wav…`, then a `WAV ready` link appears and downloads on click.
- Confirm the song page has NO generate panel and no console errors from the missing `#gen-prompt`.

- [ ] **Step 6: Commit**

```bash
git add song.html src/jobs-ui.js src/song.js
git commit -m "feat(song): notifications bell + download log on the song page"
```

---

## Task 10: Full test sweep + deploy

- [ ] **Step 1: Run the whole suite**

Run: `npx vitest run`
Expected: all green (existing + new).

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: clean build, `out/`/`dist/` produced.

- [ ] **Step 3: Merge the worktree branch to the live worktree and deploy**

```bash
# from the main worktree at /home/builder/apps/crate, after merging the branch:
sudo systemctl restart vimsical-crate
```

- [ ] **Step 4: Smoke test in production**

- Open the originally-reported song, click WAV → no hang, `rendering wav…`, notification + log link on completion, link downloads.
- Verify generation jobs still run (export lane didn't disturb the generation lane).

---

## Self-Review Notes

- **Spec coverage:** "say the song is being rendered" → Task 8 button state + Task 6/9 `rendering <fmt>…` in the log. "send a notification with a download link" → Task 9 `fire()` opens `downloadLink`. "show a download link in the notifications log" → Task 9 `renderLog` export branch. Underlying "downloads don't hang / give feedback" → Tasks 2–5 (async job + probe) and Task 3 (renders actually complete).
- **Out of scope (flagged):** chunked rendering for the very largest tracks; anonymous on-demand rendering; per-user scoping of the (currently global) jobs log.
- **Type consistency:** job fields `collection`, `slug`, `fmt`, `downloadUrl` are used identically across runner (Task 4), API (Task 5), notifications (Task 6), and jobs-ui (Task 9).
