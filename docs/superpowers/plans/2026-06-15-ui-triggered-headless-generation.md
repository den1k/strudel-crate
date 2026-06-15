# UI-Triggered Headless Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the deployed web UI trigger the real `generate-stems` / `generate-tracks` / `revise-from-notes` skills by POSTing a command; the Express backend runs Claude Code headless, tracks the job, and the UI shows browser notifications + a nav log that deep-links to the new batch.

**Architecture:** A file-backed job store (`server/jobs.mjs`) plus a single-slot serial worker (`server/runner.mjs`) that `spawn`s `claude -p "/<skill> …"` (argv array, scoped `--allowedTools`) in the repo root, diffing the target dir before/after to record `newItems`/`batch`. New `/api/jobs` routes enqueue and report. The frontend adds a generate panel, a status poller, browser notifications, and a nav log; pure logic lives in a unit-tested `src/notifications.js`.

**Tech Stack:** Node ESM, Express 4, Vitest + Supertest, Vite MPA, vanilla DOM, Web Notifications API, Claude Code headless (`claude -p`).

---

## File Structure

**Backend**
- Create `server/jobs.mjs` — job store (file-per-record JSON), `createJobStore({ jobsDir })`.
- Create `server/runner.mjs` — `createRunner(...)` single-slot queue + headless spawn + dir-diff + boot recovery; exports pure helpers `buildArgv`, `collectionFor`, `diffNew`, `batchOf`.
- Modify `server/app.mjs` — optional second arg `{ jobStore, runner, distDir }`; add `/api/jobs` routes + production static serving.
- Modify `server/index.mjs` — wire the job store + runner, call `runner.recover()`.

**Backend tests**
- Create `test/jobs.test.mjs`, `test/runner.test.mjs`.
- Modify `test/api.test.mjs` — add `/api/jobs` route tests.

**Frontend**
- Create `src/notifications.js` — pure helpers (deep-link, unread count, transition detection, notification text).
- Create `src/jobs-ui.js` — DOM: generate panel, status poller, browser notifications, nav log.
- Modify `src/app.js` — read `?batch=` on load; mount `jobs-ui`.
- Modify `index.html`, `stems.html` — nav bell + log container + generate panel container.
- Create `test/notifications.test.mjs`.

**Docs**
- Modify `README.md` — deployment section.

---

## Task 1: Job store (`server/jobs.mjs`)

**Files:**
- Create: `server/jobs.mjs`
- Test: `test/jobs.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
// test/jobs.test.mjs
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJobStore } from '../server/jobs.mjs';

const job = (id, extra = {}) => ({
  id, type: 'generate-stems', prompt: 'alien pads', count: 4, collection: 'stems',
  status: 'queued', createdAt: '2026-06-15T00:00:00Z', startedAt: null,
  finishedAt: null, summary: null, error: null, batch: null, newItems: [], ...extra,
});

let jobsDir, store;
beforeEach(async () => {
  jobsDir = join(await mkdtemp(join(tmpdir(), 'strudel-jobs-')), 'jobs');
  store = createJobStore({ jobsDir });
});

describe('createJobStore', () => {
  it('write then get round-trips a job', async () => {
    await store.write(job('a'));
    expect(await store.get('a')).toMatchObject({ id: 'a', type: 'generate-stems' });
  });

  it('get returns null for missing job', async () => {
    expect(await store.get('nope')).toBeNull();
  });

  it('list returns empty when dir missing', async () => {
    expect(await store.list()).toEqual([]);
  });

  it('list returns jobs newest-first by createdAt', async () => {
    await store.write(job('old', { createdAt: '2026-06-15T00:00:00Z' }));
    await store.write(job('new', { createdAt: '2026-06-15T01:00:00Z' }));
    const ids = (await store.list()).map((j) => j.id);
    expect(ids).toEqual(['new', 'old']);
  });

  it('update merges a patch into an existing job', async () => {
    await store.write(job('a'));
    await store.update('a', { status: 'done', summary: 'ok' });
    expect(await store.get('a')).toMatchObject({ status: 'done', summary: 'ok' });
  });

  it('update returns null for missing job', async () => {
    expect(await store.update('ghost', { status: 'done' })).toBeNull();
  });

  it('exposes the allowed type set', () => {
    expect([...store.TYPES].sort()).toEqual(
      ['generate-stems', 'generate-tracks', 'revise-from-notes'],
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/jobs.test.mjs`
Expected: FAIL — `createJobStore` is not exported / module not found.

- [ ] **Step 3: Implement `server/jobs.mjs`**

```js
// File-backed job store: one JSON file per job at <jobsDir>/<id>.json.
// Mirrors server/store.mjs conventions (file-per-record, defensive reads).
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const JOB_TYPES = new Set([
  'generate-stems', 'generate-tracks', 'revise-from-notes',
]);

export function createJobStore({ jobsDir }) {
  async function write(job) {
    await mkdir(jobsDir, { recursive: true });
    await writeFile(join(jobsDir, `${job.id}.json`), JSON.stringify(job, null, 2));
    return job;
  }

  async function get(id) {
    try {
      return JSON.parse(await readFile(join(jobsDir, `${id}.json`), 'utf8'));
    } catch {
      return null;
    }
  }

  async function list() {
    let files;
    try {
      files = await readdir(jobsDir);
    } catch {
      return [];
    }
    const jobs = [];
    for (const f of files.filter((f) => f.endsWith('.json'))) {
      try {
        jobs.push(JSON.parse(await readFile(join(jobsDir, f), 'utf8')));
      } catch {
        // skip malformed job files rather than breaking the whole listing
      }
    }
    return jobs
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, 50);
  }

  async function update(id, patch) {
    const job = await get(id);
    if (!job) return null;
    return write({ ...job, ...patch });
  }

  return { write, get, list, update, TYPES: JOB_TYPES };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/jobs.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add server/jobs.mjs test/jobs.test.mjs
git commit -m "feat: file-backed job store for headless generation jobs"
```

---

## Task 2: Runner pure helpers (`server/runner.mjs` — part 1)

Build and test the pure, side-effect-free helpers first. The queue/worker comes in Task 3.

**Files:**
- Create: `server/runner.mjs`
- Test: `test/runner.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
// test/runner.test.mjs
import { describe, it, expect } from 'vitest';
import { buildArgv, collectionFor, diffNew, batchOf } from '../server/runner.mjs';

describe('collectionFor', () => {
  it('maps generate types to their dir', () => {
    expect(collectionFor('generate-stems')).toBe('stems');
    expect(collectionFor('generate-tracks')).toBe('tracks');
  });
  it('uses the prompt as the collection for revise', () => {
    expect(collectionFor('revise-from-notes', 'stems')).toBe('stems');
    expect(collectionFor('revise-from-notes', 'tracks')).toBe('tracks');
  });
});

describe('buildArgv', () => {
  it('builds a generate-stems invocation', () => {
    const argv = buildArgv({ type: 'generate-stems', prompt: 'alien pads', count: 4 });
    expect(argv[0]).toBe('-p');
    expect(argv[1]).toBe('/generate-stems "alien pads" 4');
    expect(argv).toContain('--output-format');
    expect(argv).toContain('json');
    expect(argv).toContain('--allowedTools');
  });
  it('builds a generate-tracks invocation', () => {
    const argv = buildArgv({ type: 'generate-tracks', prompt: 'dark techno', count: 12 });
    expect(argv[1]).toBe('/generate-tracks "dark techno" 12');
  });
  it('builds a revise invocation with the collection arg', () => {
    const argv = buildArgv({ type: 'revise-from-notes', prompt: 'stems' });
    expect(argv[1]).toBe('/revise-from-notes stems');
  });
});

describe('diffNew', () => {
  it('returns ids present in after but not before, sorted', () => {
    const before = new Set(['a', 'b']);
    const after = new Set(['b', 'c', 'a', 'd']);
    expect(diffNew(before, after)).toEqual(['c', 'd']);
  });
});

describe('batchOf', () => {
  it('strips the trailing -NN to find the shared batch', () => {
    expect(batchOf(['2026-06-15-pads-01', '2026-06-15-pads-02'])).toBe('2026-06-15-pads');
  });
  it('returns null when ids do not share a batch', () => {
    expect(batchOf(['2026-06-15-pads-01', '2026-06-15-bass-01'])).toBeNull();
  });
  it('returns null for an empty list', () => {
    expect(batchOf([])).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/runner.test.mjs`
Expected: FAIL — module/exports not found.

- [ ] **Step 3: Implement the helpers in `server/runner.mjs`**

```js
// Single-slot worker that runs the generation skills headless via `claude -p`.
// Pure helpers (buildArgv/collectionFor/diffNew/batchOf) are exported for tests;
// createRunner (Task 3) owns the queue and side effects.
import { spawn as nodeSpawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const COLLECTION_BY_TYPE = {
  'generate-stems': 'stems',
  'generate-tracks': 'tracks',
};

export function collectionFor(type, prompt) {
  if (type === 'revise-from-notes') return prompt === 'stems' ? 'stems' : 'tracks';
  return COLLECTION_BY_TYPE[type];
}

// Scoped tool allowlist: exactly what the skills + their sub-agents run.
// If sub-agents stall on a permission prompt headless can't answer, widen the
// Bash entry to a bare 'Bash' (still private + fixed prompt) and note it here.
const ALLOWED_TOOLS = [
  'Write', 'Read', 'Edit', 'Task',
  'Bash(node scripts/validate.mjs:*)',
  'Bash(node scripts/feedback.mjs:*)',
  'Bash(node scripts/pending-revisions.mjs:*)',
  'Bash(date:*)', 'Bash(pwd)', 'Bash(ls:*)', 'Bash(grep:*)',
  'Bash(rm stems/:*)', 'Bash(rm tracks/:*)',
].join(',');

export function buildArgv(job) {
  const prompt = job.type === 'revise-from-notes'
    ? `/revise-from-notes ${job.prompt}`
    : `/${job.type} "${job.prompt}" ${job.count}`;
  return ['-p', prompt, '--output-format', 'json', '--allowedTools', ALLOWED_TOOLS];
}

export function diffNew(before, after) {
  return [...after].filter((id) => !before.has(id)).sort();
}

export function batchOf(ids) {
  if (ids.length === 0) return null;
  const batch = (id) => id.replace(/-\d+$/, ''); // strip trailing -NN
  const first = batch(ids[0]);
  return ids.every((id) => batch(id) === first) ? first : null;
}

async function idsIn(dir) {
  try {
    return new Set(
      (await readdir(dir)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)),
    );
  } catch {
    return new Set();
  }
}

function parseSummary(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return parsed.result ?? stdout.slice(0, 4000);
  } catch {
    return stdout.slice(0, 4000);
  }
}

// createRunner is added in Task 3.
export { nodeSpawn, idsIn, parseSummary, ALLOWED_TOOLS };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/runner.test.mjs`
Expected: PASS (helper tests).

- [ ] **Step 5: Verify the real headless flag spelling**

The `--allowedTools` flag and whether sub-agents inherit it can vary by Claude Code version. Confirm before relying on it:

Run: `claude --help 2>&1 | grep -iE 'allowedtools|permission-mode|output-format'`
Expected: lines documenting `--allowedTools`, `--output-format`, and (likely) `--permission-mode`. If `--allowedTools` is absent or named differently, update `buildArgv` and `ALLOWED_TOOLS` accordingly, and re-run Step 4. If sub-agents need it explicitly, add `--permission-mode acceptEdits` or the version's documented non-interactive flag.

- [ ] **Step 6: Commit**

```bash
git add server/runner.mjs test/runner.test.mjs
git commit -m "feat: runner pure helpers (argv, collection, dir diff, batch)"
```

---

## Task 3: Runner queue + worker (`server/runner.mjs` — part 2)

**Files:**
- Modify: `server/runner.mjs` (append `createRunner`)
- Test: `test/runner.test.mjs` (append worker tests)

- [ ] **Step 1: Write the failing tests**

Append to `test/runner.test.mjs`:

```js
import { describe as describe2, it as it2, expect as expect2, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as join2 } from 'node:path';
import { createRunner } from '../server/runner.mjs';
import { createJobStore } from '../server/jobs.mjs';

// A controllable fake child process + spawn.
function fakeSpawnFactory() {
  const children = [];
  const spawn = (cmd, argv, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.argv = argv;
    child.opts = opts;
    children.push(child);
    return child;
  };
  return { spawn, children };
}

const baseJob = (id, extra = {}) => ({
  id, type: 'generate-stems', prompt: 'pads', count: 2, collection: 'stems',
  status: 'queued', createdAt: '2026-06-15T00:00:00Z', startedAt: null,
  finishedAt: null, summary: null, error: null, batch: null, newItems: [], ...extra,
});

let repoRoot, jobStore, ticks;
beforeEach(async () => {
  repoRoot = await mkdtemp(join2(tmpdir(), 'strudel-runner-'));
  await mkdir(join2(repoRoot, 'stems'), { recursive: true });
  jobStore = createJobStore({ jobsDir: join2(repoRoot, 'data', 'jobs') });
  let n = 0;
  ticks = () => `2026-06-15T00:00:0${n++}Z`;
});

const flush = () => new Promise((r) => setTimeout(r, 10));

describe2('createRunner worker', () => {
  it2('runs a job: running -> done, captures newItems/batch/summary', async () => {
    const { spawn, children } = fakeSpawnFactory();
    const runner = createRunner({ repoRoot, dirs: { stems: 'stems', tracks: 'tracks' }, jobStore, spawn, now: ticks });
    await jobStore.write(baseJob('j1'));
    await runner.enqueue(baseJob('j1'));
    await flush();
    expect2((await jobStore.get('j1')).status).toBe('running');
    // simulate the skill writing two stem files, then claude exiting 0
    await writeFile(join2(repoRoot, 'stems', '2026-06-15-pads-01.json'), '{}');
    await writeFile(join2(repoRoot, 'stems', '2026-06-15-pads-02.json'), '{}');
    children[0].stdout.emit('data', JSON.stringify({ result: 'OK 2 stems' }));
    children[0].emit('close', 0);
    await flush();
    const done = await jobStore.get('j1');
    expect2(done.status).toBe('done');
    expect2(done.newItems).toEqual(['2026-06-15-pads-01', '2026-06-15-pads-02']);
    expect2(done.batch).toBe('2026-06-15-pads');
    expect2(done.summary).toBe('OK 2 stems');
  });

  it2('marks a job failed on non-zero exit', async () => {
    const { spawn, children } = fakeSpawnFactory();
    const runner = createRunner({ repoRoot, dirs: { stems: 'stems', tracks: 'tracks' }, jobStore, spawn, now: ticks });
    await jobStore.write(baseJob('j1'));
    await runner.enqueue(baseJob('j1'));
    await flush();
    children[0].emit('close', 1);
    await flush();
    expect2((await jobStore.get('j1')).status).toBe('failed');
  });

  it2('runs jobs one at a time (single slot)', async () => {
    const { spawn, children } = fakeSpawnFactory();
    const runner = createRunner({ repoRoot, dirs: { stems: 'stems', tracks: 'tracks' }, jobStore, spawn, now: ticks });
    await jobStore.write(baseJob('j1'));
    await jobStore.write(baseJob('j2'));
    await runner.enqueue(baseJob('j1'));
    await runner.enqueue(baseJob('j2'));
    await flush();
    expect2(children).toHaveLength(1);            // only the first spawned
    expect2((await jobStore.get('j2')).status).toBe('queued');
    children[0].emit('close', 0);
    await flush();
    expect2(children).toHaveLength(2);            // second starts after first closes
  });

  it2('recover() marks running jobs interrupted and resumes queued', async () => {
    const { spawn, children } = fakeSpawnFactory();
    await jobStore.write(baseJob('stale', { status: 'running' }));
    await jobStore.write(baseJob('waiting', { status: 'queued' }));
    const runner = createRunner({ repoRoot, dirs: { stems: 'stems', tracks: 'tracks' }, jobStore, spawn, now: ticks });
    await runner.recover();
    await flush();
    expect2((await jobStore.get('stale')).status).toBe('interrupted');
    expect2(children).toHaveLength(1);            // the queued job resumed
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/runner.test.mjs`
Expected: FAIL — `createRunner` not exported.

- [ ] **Step 3: Append `createRunner` to `server/runner.mjs`**

```js
export function createRunner({
  repoRoot, dirs, jobStore,
  spawn = nodeSpawn,
  now = () => new Date().toISOString(),
}) {
  const queue = [];
  let running = false;

  function runClaude(job) {
    return new Promise((resolve) => {
      let out = '';
      const child = spawn('claude', buildArgv(job), { cwd: repoRoot });
      child.stdout?.on('data', (d) => { out += d; });
      child.on('error', () => resolve({ code: -1, out }));
      child.on('close', (code) => resolve({ code: code ?? -1, out }));
    });
  }

  async function runOne(id) {
    const job = await jobStore.get(id);
    if (!job) return;
    const dir = join(repoRoot, dirs[job.collection]);
    await jobStore.update(id, { status: 'running', startedAt: now() });
    const before = await idsIn(dir);
    const { code, out } = await runClaude(job);
    const after = await idsIn(dir);
    const newItems = diffNew(before, after);
    const patch = { finishedAt: now(), newItems, batch: batchOf(newItems) };
    if (code === 0) {
      patch.status = 'done';
      patch.summary = parseSummary(out);
    } else {
      patch.status = 'failed';
      patch.error = `claude exited ${code}`;
    }
    await jobStore.update(id, patch);
  }

  async function pump() {
    if (running) return;
    const id = queue.shift();
    if (!id) return;
    running = true;
    try {
      await runOne(id);
    } finally {
      running = false;
      if (queue.length) pump();
    }
  }

  async function enqueue(job) {
    queue.push(job.id);
    pump();
    return job;
  }

  async function recover() {
    for (const job of await jobStore.list()) {
      if (job.status === 'running') {
        await jobStore.update(job.id, { status: 'interrupted', finishedAt: now() });
      } else if (job.status === 'queued') {
        queue.push(job.id);
      }
    }
    pump();
  }

  return { enqueue, recover };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/runner.test.mjs`
Expected: PASS (helpers + worker tests).

- [ ] **Step 5: Commit**

```bash
git add server/runner.mjs test/runner.test.mjs
git commit -m "feat: single-slot runner with boot recovery and dir-diff capture"
```

---

## Task 4: `/api/jobs` routes (`server/app.mjs`)

**Files:**
- Modify: `server/app.mjs`
- Test: `test/api.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `test/api.test.mjs` (after the existing imports, add the store import; reuse the existing `beforeEach` base dir by adding a job store + fake runner there):

```js
import { createJobStore } from '../server/jobs.mjs';

describe('jobs API', () => {
  let jobApp, enqueued;
  beforeEach(async () => {
    const base = await mkdtemp(join(tmpdir(), 'strudel-jobsapi-'));
    enqueued = [];
    const jobStore = createJobStore({ jobsDir: join(base, 'jobs') });
    const runner = { enqueue: async (job) => { enqueued.push(job); } };
    jobApp = createApp(
      {
        tracks: createStore({ tracksDir: join(base, 'tracks'), ratingsDir: join(base, 'r1') }),
        stems: createStore({ tracksDir: join(base, 'stems'), ratingsDir: join(base, 'r2') }),
      },
      { jobStore, runner },
    );
  });

  it('POST /api/jobs enqueues a generate-stems job', async () => {
    const res = await request(jobApp).post('/api/jobs').send({ type: 'generate-stems', prompt: 'alien pads', count: 4 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ type: 'generate-stems', prompt: 'alien pads', count: 4, collection: 'stems', status: 'queued' });
    expect(enqueued).toHaveLength(1);
  });

  it('clamps count to 1..30', async () => {
    const res = await request(jobApp).post('/api/jobs').send({ type: 'generate-tracks', prompt: 'techno', count: 999 });
    expect(res.body.count).toBe(30);
  });

  it('rejects an unknown type', async () => {
    const res = await request(jobApp).post('/api/jobs').send({ type: 'rm-rf', prompt: 'x' });
    expect(res.status).toBe(400);
  });

  it('rejects a missing prompt for generate', async () => {
    const res = await request(jobApp).post('/api/jobs').send({ type: 'generate-stems' });
    expect(res.status).toBe(400);
  });

  it('accepts revise-from-notes with a collection prompt', async () => {
    const res = await request(jobApp).post('/api/jobs').send({ type: 'revise-from-notes', prompt: 'stems' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ type: 'revise-from-notes', collection: 'stems' });
  });

  it('rejects revise-from-notes with a bad collection', async () => {
    const res = await request(jobApp).post('/api/jobs').send({ type: 'revise-from-notes', prompt: 'drums' });
    expect(res.status).toBe(400);
  });

  it('GET /api/jobs lists queued jobs and GET /:id fetches one', async () => {
    const created = (await request(jobApp).post('/api/jobs').send({ type: 'generate-stems', prompt: 'p', count: 1 })).body;
    const list = await request(jobApp).get('/api/jobs');
    expect(list.body).toHaveLength(1);
    const one = await request(jobApp).get(`/api/jobs/${created.id}`);
    expect(one.status).toBe(200);
    expect(one.body.id).toBe(created.id);
  });

  it('GET /api/jobs/:id returns 404 for missing job', async () => {
    const res = await request(jobApp).get('/api/jobs/does-not-exist');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/api.test.mjs`
Expected: FAIL — `createApp` ignores the second arg; `/api/jobs` returns 404.

- [ ] **Step 3: Modify `server/app.mjs`**

Add imports at the top (after the existing `import express`):

```js
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import express from 'express';
import { collectionFor } from './runner.mjs';
```

Add this function above `createApp`:

```js
function jobRoutes(app, jobStore, runner) {
  app.post('/api/jobs', wrap(async (req, res) => {
    const { type, prompt, count } = req.body ?? {};
    if (!jobStore.TYPES.has(type)) return res.status(400).json({ error: 'invalid type' });

    const base = {
      id: randomUUID(),
      type,
      createdAt: new Date().toISOString(),
      status: 'queued',
      startedAt: null, finishedAt: null, summary: null, error: null,
      batch: null, newItems: [],
    };

    let job;
    if (type === 'revise-from-notes') {
      if (prompt !== 'stems' && prompt !== 'tracks') {
        return res.status(400).json({ error: 'collection must be stems or tracks' });
      }
      job = { ...base, prompt, count: null, collection: prompt };
    } else {
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 500) {
        return res.status(400).json({ error: 'prompt required (1-500 chars)' });
      }
      const n = Math.min(30, Math.max(1, Math.floor(Number(count) || 30)));
      job = { ...base, prompt: prompt.trim(), count: n, collection: collectionFor(type) };
    }

    await jobStore.write(job);
    await runner.enqueue(job);
    res.status(201).json(job);
  }));

  app.get('/api/jobs', wrap(async (_req, res) => res.json(await jobStore.list())));

  app.get('/api/jobs/:id', wrap(async (req, res) => {
    if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'invalid id' });
    const job = await jobStore.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'not found' });
    res.json(job);
  }));
}
```

Change the `createApp` signature and body to register job routes and optional static serving (keep the existing collection routes + error handler):

```js
export function createApp(stores, opts = {}) {
  const app = express();
  app.use(express.json());
  for (const [name, store] of Object.entries(stores)) collectionRoutes(app, name, store);

  if (opts.jobStore && opts.runner) jobRoutes(app, opts.jobStore, opts.runner);

  // Production: serve the built SPA (dev uses Vite). Defined AFTER the API so
  // /api/* always wins; the /stems clean URL mirrors vite.config.js's rewrite.
  if (opts.distDir) {
    app.get(['/stems', '/stems/'], (_req, res) => res.sendFile(join(opts.distDir, 'stems.html')));
    app.use(express.static(opts.distDir));
  }

  // JSON error responses (body-parser 400s and async store failures land here).
  app.use((err, _req, res, _next) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });

  return app;
}
```

- [ ] **Step 4: Run the full test suite to verify nothing regressed**

Run: `npx vitest run test/api.test.mjs`
Expected: PASS — existing tracks/stems tests plus the new jobs tests.

- [ ] **Step 5: Commit**

```bash
git add server/app.mjs test/api.test.mjs
git commit -m "feat: /api/jobs routes for enqueueing headless generation"
```

---

## Task 5: Wire the server + production static (`server/index.mjs`)

**Files:**
- Modify: `server/index.mjs`

- [ ] **Step 1: Replace `server/index.mjs` with the wired version**

```js
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { createApp } from './app.mjs';
import { createStore } from './store.mjs';
import { createJobStore } from './jobs.mjs';
import { createRunner } from './runner.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(repoRoot, 'dist');

const jobStore = createJobStore({ jobsDir: join(repoRoot, 'data', 'jobs') });
const runner = createRunner({
  repoRoot,
  dirs: { stems: 'stems', tracks: 'tracks' },
  jobStore,
});

const app = createApp(
  {
    tracks: createStore({ tracksDir: 'tracks', ratingsDir: 'data/ratings' }),
    stems: createStore({ tracksDir: 'stems', ratingsDir: 'data/stem-ratings' }),
  },
  { jobStore, runner, distDir: existsSync(distDir) ? distDir : undefined },
);

await runner.recover(); // requeue/clean up jobs left over from a restart

const port = process.env.PORT ?? 3001;
app.listen(port, () => console.log(`strudel-ai api listening on http://localhost:${port}`));
```

- [ ] **Step 2: Verify the server boots and serves the API**

Run: `node server/index.mjs & sleep 1 && curl -s localhost:3001/api/jobs && curl -s localhost:3001/api/tracks >/dev/null && echo OK && kill %1`
Expected: `[]` from `/api/jobs`, then `OK`. (No `dist/` yet, so static serving stays off — that's expected.)

- [ ] **Step 3: Commit**

```bash
git add server/index.mjs
git commit -m "feat: wire job store + runner into the server with boot recovery"
```

---

## Task 6: Frontend pure helpers (`src/notifications.js`)

**Files:**
- Create: `src/notifications.js`
- Test: `test/notifications.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
// test/notifications.test.mjs
import { describe, it, expect } from 'vitest';
import { deepLink, unreadCount, newlyFinished, notificationText } from '../src/notifications.js';

const job = (id, extra = {}) => ({
  id, type: 'generate-stems', prompt: 'pads', collection: 'stems',
  status: 'done', batch: '2026-06-15-pads', newItems: ['2026-06-15-pads-01'], ...extra,
});

describe('deepLink', () => {
  it('links stems jobs to /stems with the batch', () => {
    expect(deepLink(job('a'))).toBe('/stems?batch=2026-06-15-pads');
  });
  it('links tracks jobs to / with the batch', () => {
    expect(deepLink(job('a', { collection: 'tracks' }))).toBe('/?batch=2026-06-15-pads');
  });
  it('falls back to the collection page when batch is null', () => {
    expect(deepLink(job('a', { batch: null }))).toBe('/stems');
  });
});

describe('newlyFinished', () => {
  it('returns jobs whose finished status differs from the previous snapshot', () => {
    const prev = new Map([['a', 'running'], ['b', 'done']]);
    const jobs = [job('a', { status: 'done' }), job('b', { status: 'done' }), job('c', { status: 'running' })];
    expect(newlyFinished(prev, jobs).map((j) => j.id)).toEqual(['a']);
  });
});

describe('unreadCount', () => {
  it('counts finished jobs newer than lastSeenId (list is newest-first)', () => {
    const jobs = [job('c'), job('b'), job('a')];
    expect(unreadCount(jobs, 'a')).toBe(2);
  });
  it('counts all when nothing seen yet', () => {
    const jobs = [job('c'), job('b')];
    expect(unreadCount(jobs, null)).toBe(2);
  });
  it('ignores unfinished jobs', () => {
    const jobs = [job('c', { status: 'running' }), job('b')];
    expect(unreadCount(jobs, null)).toBe(1);
  });
});

describe('notificationText', () => {
  it('summarizes a successful stems job', () => {
    expect(notificationText(job('a'))).toEqual({ title: '1 stems ready', body: 'pads' });
  });
  it('labels failures', () => {
    expect(notificationText(job('a', { status: 'failed' }))).toEqual({ title: 'Generation failed', body: 'pads' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/notifications.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/notifications.js`**

```js
// Pure helpers for the job notifications + nav log. No DOM, no network — the
// DOM/poller wiring lives in jobs-ui.js so this stays unit-testable.

const FINISHED = new Set(['done', 'failed', 'interrupted']);

export function deepLink(job) {
  const page = job.collection === 'stems' ? '/stems' : '/';
  return job.batch ? `${page}?batch=${encodeURIComponent(job.batch)}` : page;
}

// Jobs that reached a finished state since the previous poll snapshot.
// prevById: Map<id, status> captured on the last poll.
export function newlyFinished(prevById, jobs) {
  return jobs.filter((j) => FINISHED.has(j.status) && prevById.get(j.id) !== j.status);
}

// Count of finished jobs newer than lastSeenId. `jobs` is newest-first.
export function unreadCount(jobs, lastSeenId) {
  let n = 0;
  for (const j of jobs) {
    if (j.id === lastSeenId) break;
    if (FINISHED.has(j.status)) n += 1;
  }
  return n;
}

export function notificationText(job) {
  if (job.status === 'failed') return { title: 'Generation failed', body: job.prompt };
  if (job.status === 'interrupted') return { title: 'Generation interrupted', body: job.prompt };
  const n = job.newItems?.length ?? 0;
  return { title: `${n} ${job.collection} ready`, body: job.prompt };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/notifications.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/notifications.js test/notifications.test.mjs
git commit -m "feat: pure helpers for job notifications and nav log"
```

---

## Task 7: Frontend DOM — generate panel, poller, notifications, nav log (`src/jobs-ui.js`)

This task wires the DOM. It is verified manually in the browser (the project has no DOM test harness; pure logic was covered in Task 6).

**Files:**
- Create: `src/jobs-ui.js`
- Modify: `index.html`, `stems.html`
- Modify: `src/app.js`

- [ ] **Step 1: Add the markup to `index.html`**

In `index.html`, inside `<nav class="nav" aria-label="sections">`, after the existing links, add the bell:

```html
      <button id="job-bell" class="job-bell" aria-label="notifications" title="generation log">🔔<span id="job-unread" class="job-unread" hidden>0</span></button>
```

Immediately after the `</header>` closing tag, add the generate panel + log dropdown containers:

```html
  <section class="generate" aria-label="generate">
    <input id="gen-prompt" type="text" placeholder='e.g. dark techno' aria-label="prompt" />
    <input id="gen-count" type="number" min="1" max="30" value="12" aria-label="count" />
    <button id="gen-go">Generate</button>
    <button id="gen-revise">Revise from notes</button>
    <span id="gen-status" class="gen-status" role="status"></span>
  </section>
  <div id="job-log" class="job-log" hidden></div>
```

- [ ] **Step 2: Add the same markup to `stems.html`**

Add the identical `#job-bell` button inside `stems.html`'s `<nav>`, and the identical `<section class="generate">` + `<div id="job-log">` blocks right after its `</header>`. (Repeat the exact HTML from Step 1 — both pages share the same control ids; `jobs-ui.js` reads the page's collection from the app, not the markup.)

- [ ] **Step 3: Implement `src/jobs-ui.js`**

```js
// DOM wiring for UI-triggered generation: a generate panel that POSTs jobs, a
// poller that drives browser notifications, and a nav log dropdown. Pure logic
// is imported from notifications.js.
import { deepLink, unreadCount, newlyFinished, notificationText } from './notifications.js';

const $ = (sel) => document.querySelector(sel);
const SEEN_KEY = 'strudel-jobs-last-seen';

export function mountJobsUI({ collection, onBatchDone }) {
  const promptEl = $('#gen-prompt');
  const countEl = $('#gen-count');
  const statusEl = $('#gen-status');
  const bell = $('#job-bell');
  const unreadEl = $('#job-unread');
  const logEl = $('#job-log');
  if (!promptEl || !bell) return; // markup absent — nothing to mount

  let prevById = null;            // null until the first poll (seed without notifying)
  const startedAt = Date.now();

  async function post(body) {
    statusEl.textContent = 'queued…';
    const res = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) { statusEl.textContent = 'rejected'; return; }
    statusEl.textContent = 'running…';
    if (Notification?.permission === 'default') Notification.requestPermission();
  }

  $('#gen-go').addEventListener('click', () => {
    const prompt = promptEl.value.trim();
    if (!prompt) return;
    const count = Math.min(30, Math.max(1, Number(countEl.value) || 12));
    post({ type: collection === 'stems' ? 'generate-stems' : 'generate-tracks', prompt, count });
  });

  $('#gen-revise').addEventListener('click', () => {
    post({ type: 'revise-from-notes', prompt: collection });
  });

  function fire(job) {
    const { title, body } = notificationText(job);
    if (Notification?.permission === 'granted') {
      const n = new Notification(title, { body });
      n.onclick = () => { window.focus(); window.location.href = deepLink(job); };
    }
  }

  function renderBadge(jobs) {
    const lastSeen = localStorage.getItem(SEEN_KEY);
    const n = unreadCount(jobs, lastSeen);
    unreadEl.textContent = String(n);
    unreadEl.hidden = n === 0;
  }

  function renderLog(jobs) {
    logEl.innerHTML = jobs
      .filter((j) => ['done', 'failed', 'interrupted'].includes(j.status))
      .map((j) => {
        const label = j.status === 'done'
          ? `${j.newItems?.length ?? 0} ${j.collection} — ${j.prompt}`
          : `${j.status}: ${j.prompt}`;
        return j.status === 'done'
          ? `<a href="${deepLink(j)}">${label}</a>`
          : `<span>${label}</span>`;
      })
      .join('') || '<span class="empty">no jobs yet</span>';
  }

  bell.addEventListener('click', () => {
    logEl.hidden = !logEl.hidden;
    if (!logEl.hidden) {
      // mark all seen
      const jobs = lastJobs;
      if (jobs[0]) localStorage.setItem(SEEN_KEY, jobs[0].id);
      renderBadge(jobs);
    }
  });

  let lastJobs = [];
  async function poll() {
    try {
      const jobs = await (await fetch('/api/jobs')).json();
      lastJobs = jobs;
      if (prevById !== null) {
        for (const job of newlyFinished(prevById, jobs)) {
          if (new Date(job.finishedAt).getTime() >= startedAt) fire(job);
          if (job.status === 'done' && job.collection === collection) onBatchDone?.(job);
        }
      }
      prevById = new Map(jobs.map((j) => [j.id, j.status]));
      renderBadge(jobs);
      renderLog(jobs);
      const active = jobs.some((j) => j.status === 'queued' || j.status === 'running');
      statusEl.textContent = active ? 'running…' : '';
    } catch {
      // network blip — retry on the next tick
    }
    setTimeout(poll, 3000);
  }
  poll();
}
```

- [ ] **Step 4: Mount it from `src/app.js` and honor `?batch=`**

In `src/app.js`, inside `initApp({ apiBase, emptyHint })`, after `const state = { … }`, set the initial batch from the URL:

```js
  const collection = apiBase.endsWith('/stems') ? 'stems' : 'tracks';
  const urlBatch = new URLSearchParams(location.search).get('batch');
  if (urlBatch) state.batch = urlBatch;
```

Then, near the end of `initApp` (after the first listing render is wired), mount the jobs UI:

```js
  const { mountJobsUI } = await import('./jobs-ui.js');
  mountJobsUI({
    collection,
    onBatchDone: () => loadTracks(), // re-fetch the listing so new items appear
  });
```

> Note: use the existing listing-refresh function name. In `src/app.js` find the function that fetches `apiBase` and re-renders (search for `fetch(apiBase` or the function called on initial load) and call that instead of `loadTracks()` if it has a different name. Also confirm `state.batch` is applied when the `batch-filter` `<select>` is populated — when building its options, set `select.value = state.batch` if that batch exists.

- [ ] **Step 5: Add minimal styles to `src/style.css`**

```css
.generate { display: flex; gap: .5rem; align-items: center; padding: .5rem 1rem; flex-wrap: wrap; }
.generate input[type="text"] { flex: 1; min-width: 12rem; }
.generate input[type="number"] { width: 4rem; }
.gen-status { font-size: .85rem; opacity: .7; }
.job-bell { position: relative; background: none; border: 0; cursor: pointer; font-size: 1.1rem; }
.job-unread { position: absolute; top: -.3rem; right: -.4rem; background: #e0245e; color: #fff; border-radius: 1rem; font-size: .65rem; padding: 0 .35rem; }
.job-log { position: absolute; right: 1rem; margin-top: .25rem; background: #111; border: 1px solid #333; border-radius: .5rem; padding: .5rem; display: flex; flex-direction: column; gap: .35rem; max-width: 22rem; z-index: 20; }
.job-log a { color: #4ea1ff; text-decoration: none; }
.job-log .empty { opacity: .6; }
```

- [ ] **Step 6: Manual verification in the browser**

Run: `npm run dev`
Then in a browser at http://localhost:5173 :
1. Type a prompt (e.g. `test pads`), set count `2`, click **Generate**. Grant the notification permission prompt.
2. Confirm `#gen-status` shows `queued…` → `running…`. (The real `claude` must be on PATH + logged in for the job to actually run; otherwise the job goes `failed` — that still exercises the UI path.)
3. When the job finishes, confirm a browser notification fires and the 🔔 badge increments.
4. Click 🔔 → the log dropdown lists the job; clicking a `done` entry navigates to `/stems?batch=…` (or `/?batch=…`) and the batch filter is preselected.

Expected: panel posts jobs, poller updates status, notification fires on completion, log deep-links to the batch. Note any deviation and fix before committing.

- [ ] **Step 7: Run the full test suite (no regressions)**

Run: `npx vitest run`
Expected: PASS — all prior suites plus the new `jobs`/`runner`/`notifications` tests.

- [ ] **Step 8: Commit**

```bash
git add src/jobs-ui.js src/app.js src/style.css index.html stems.html
git commit -m "feat: generate panel, job poller, browser notifications, nav log"
```

---

## Task 8: Deployment docs (`README.md`)

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Append a deployment section to `README.md`**

```markdown
## Deploying (private, single-user)

The web UI can trigger the generation skills on the server via headless Claude Code.

**Prerequisites on the box:**
- `claude` (Claude Code CLI) on `PATH` and logged in (`claude` once, interactively).
- This repo checked out; the server runs with its cwd at the repo root.

**Build + run a single port:**

    npm ci
    npm run build           # emits dist/
    PORT=3001 node server/index.mjs

Express serves the built UI from `dist/` and the API (including `/api/jobs`) on the
same `PORT`. Run it under a process manager (pm2 or systemd) so it restarts on
crash; on boot the runner marks any interrupted job and resumes the queue.

**Security:** the `/api/jobs` endpoint runs Claude Code with a scoped tool
allowlist (see `server/runner.mjs`). Keep the deployment private — behind a login,
VPN, or tunnel — since anyone who can reach it can trigger generation runs.

**Redeploy:**

    git pull && npm ci && npm run build && <restart the server>
```

- [ ] **Step 2: Verify the production build + static serving end-to-end**

Run: `npm run build && PORT=3199 node server/index.mjs & sleep 2 && curl -s -o /dev/null -w "%{http_code}\n" localhost:3199/ && curl -s -o /dev/null -w "%{http_code}\n" localhost:3199/stems && curl -s localhost:3199/api/jobs && kill %1`
Expected: `200` for `/`, `200` for `/stems`, and `[]` for `/api/jobs`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: deployment guide for UI-triggered headless generation"
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** job store (T1), serial worker + dir-diff + boot recovery + headless argv/allowlist (T2–T3), API routes + validation/clamping (T4), wiring + production static serving (T5), notification/log pure logic (T6), DOM panel + poller + browser notifications + nav log + `?batch=` deep-link (T7), deployment (T8). All spec sections map to a task.
- **Type consistency:** the job shape (`id, type, prompt, count, status, createdAt, startedAt, finishedAt, summary, error, collection, batch, newItems`) is identical across `jobs.mjs`, the API route, the runner patches, and the frontend helpers. `collectionFor` is defined once in `runner.mjs` and imported by `app.mjs`.
- **Known follow-up flagged in code:** the `--allowedTools` spelling and sub-agent inheritance are verified live in Task 2 Step 5; widen the `Bash(...)` entry to bare `Bash` if sub-agents stall.
- **App.js integration caveat (T7 Step 4):** the exact listing-refresh function name and `batch-filter` option-selection are confirmed against the real `src/app.js` during implementation — the plan calls this out rather than guessing the symbol.
```
