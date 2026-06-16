# Tracks & Stems in InstantDB — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move crate's tracks and stems from on-disk JSON into InstantDB as the source of truth, each owned by an author profile with an artist name, public by default, with the client reading Instant directly and all writes going through the server's admin SDK.

**Architecture:** New `instant.schema.ts`/`instant.perms.ts` define `profiles`, `tracks`, `stems` (two identical content entities; `slug` = human id separate from the UUID entity `id`; rating/notes/lesson as fields). The vanilla client reads via `@instantdb/core` `subscribeQuery` (public reads enforced by perms; entities mapped so `id` = slug to keep existing render/editor/export code intact). All mutations (generation ingest, rating, profile edits) go through server endpoints using `@instantdb/admin`, preserving the `CRATE_ALLOWED_EMAILS` gate. Generation skills validate in-memory and transact to Instant via `save-track.mjs`/`save-stem.mjs`, using a gitignored `staging/` dir as ephemeral scratch. A one-time migration imports existing items to kalavox.

**Tech Stack:** Node 24, `@instantdb/core` (client), `@instantdb/admin` (server/scripts), Express, Vite, Vitest, vanilla JS, Strudel.

**Spec:** `docs/superpowers/specs/2026-06-16-tracks-stems-in-instantdb-design.md`

**Branch:** `feature/tracks-stems-instantdb` (already created). Work in a git worktree per the repo's parallel-sessions rule.

---

## Phase 1 — Schema, permissions, shared client db

### Task 1: Create the InstantDB schema

**Files:**
- Create: `instant.schema.ts`

- [ ] **Step 1: Write the schema file**

```ts
// instant.schema.ts
// Crate's data model. tracks & stems are identical content entities; profiles
// hold an artist name and link to a $user. The human-readable id lives in `slug`
// (the Instant entity id is a UUID). meta is the nested { bpm, genre, ... } object.
import { i } from '@instantdb/core';

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
  rating: i.number().optional(), // 1-5 or absent
  notes: i.string().optional(), // per-item notes
  lesson: i.string().optional(), // cross-batch lesson
};

const _schema = i.schema({
  entities: {
    $users: i.entity({
      email: i.string().unique().indexed().optional(),
    }),
    profiles: i.entity({
      artistName: i.string().indexed(),
      createdAt: i.string().indexed(),
    }),
    tracks: i.entity({ ...itemFields }),
    stems: i.entity({ ...itemFields }),
  },
  links: {
    tracksAuthor: {
      forward: { on: 'tracks', has: 'one', label: 'author' },
      reverse: { on: 'profiles', has: 'many', label: 'tracks' },
    },
    stemsAuthor: {
      forward: { on: 'stems', has: 'one', label: 'author' },
      reverse: { on: 'profiles', has: 'many', label: 'stems' },
    },
    userProfile: {
      forward: { on: 'profiles', has: 'one', label: 'user', onDelete: 'cascade' },
      reverse: { on: '$users', has: 'one', label: 'profile' },
    },
  },
});

type _AppSchema = typeof _schema;
interface AppSchema extends _AppSchema {}
const schema: AppSchema = _schema;

export type { AppSchema };
export default schema;
```

- [ ] **Step 2: Type-check the schema imports resolve**

Run: `node -e "import('@instantdb/core').then(m => console.log(typeof m.i.schema))"`
Expected: prints `function` (confirms `@instantdb/core` exposes `i.schema`).

- [ ] **Step 3: Commit**

```bash
git add instant.schema.ts
git commit -m "feat: add InstantDB schema for profiles, tracks, stems"
```

### Task 2: Create the permissions file

**Files:**
- Create: `instant.perms.ts`

- [ ] **Step 1: Write the perms file**

```ts
// instant.perms.ts
// Public reads (or owner-only for non-public items). ALL writes are server-side
// via the admin SDK, which bypasses these rules — so client create/update/delete
// are intentionally "false". profiles are publicly viewable so artist names show
// to logged-out visitors (playback is public).
const ownerOrPublic =
  "data.isPublic == true || (auth.id != null && auth.id in data.ref('author.user.id'))";

const rules = {
  tracks: {
    allow: { view: ownerOrPublic, create: 'false', update: 'false', delete: 'false' },
  },
  stems: {
    allow: { view: ownerOrPublic, create: 'false', update: 'false', delete: 'false' },
  },
  profiles: {
    allow: { view: 'true', create: 'false', update: 'false', delete: 'false' },
  },
};

export default rules;
```

- [ ] **Step 2: Commit**

```bash
git add instant.perms.ts
git commit -m "feat: add InstantDB permissions (public read, server-only writes)"
```

> **Note:** the schema + perms are *pushed* to the Instant app in Task 16 (cutover), after the server/scripts that depend on them are in place. Pushing early is harmless but the migration must run after the push.

### Task 3: Shared client db instance

**Files:**
- Create: `src/db.js`

- [ ] **Step 1: Write the shared db module**

```js
// src/db.js
// One InstantDB client instance shared by auth.js and app.js. Passing `schema`
// gives query/transact type hints. VITE_INSTANT_APP_ID is inlined at build time.
import { init } from '@instantdb/core';
import schema from '../instant.schema';

const appId = import.meta.env.VITE_INSTANT_APP_ID;

// Null only if Instant isn't configured (no app id) — callers guard on it.
export const db = appId ? init({ appId, schema }) : null;
```

- [ ] **Step 2: Commit**

```bash
git add src/db.js
git commit -m "feat: add shared InstantDB client instance"
```

---

## Phase 2 — Server Instant helpers (write path core)

### Task 4: `server/instant.mjs` helpers with unit tests

**Files:**
- Create: `server/instant.mjs`
- Create: `test/instant.test.mjs`
- Create: `test/fake-admin.mjs`

- [ ] **Step 1: Write the fake admin-db test helper**

```js
// test/fake-admin.mjs
// Minimal stand-in for @instantdb/admin used in tests. Records transactions and
// answers queries from a seeded in-memory store. Supports equality where,
// nested 'user.id' where, and { slug: { $in: [...] } }.
function matchWhere(row, where) {
  return Object.entries(where).every(([key, cond]) => {
    const val = key === 'user.id' ? row.user?.id : row[key];
    if (cond && typeof cond === 'object' && Array.isArray(cond.$in)) return cond.$in.includes(val);
    return val === cond;
  });
}

export function fakeAdmin(initial = {}) {
  const store = JSON.parse(JSON.stringify(initial)); // { profiles:[], tracks:[], stems:[] }
  const txs = []; // recorded ops: { ns, id, update?, link?, delete? }

  const chainFor = (ns, entId) => {
    const op = { ns, id: entId };
    const record = () => { if (!txs.includes(op)) txs.push(op); };
    const chain = {
      update(data) { op.update = data; record(); return chain; },
      link(links) { op.link = links; record(); return chain; },
      delete() { op.delete = true; record(); return chain; },
    };
    return chain;
  };

  return {
    _store: store,
    _txs: txs,
    tx: new Proxy({}, {
      get: (_t, ns) => new Proxy({}, { get: (_t2, entId) => chainFor(ns, entId) }),
    }),
    async query(q) {
      const out = {};
      for (const ns of Object.keys(q)) {
        let rows = store[ns] ?? [];
        const where = q[ns].$?.where;
        out[ns] = where ? rows.filter((r) => matchWhere(r, where)) : rows.slice();
      }
      return out;
    },
    async transact() { /* ops already recorded via the chain */ },
  };
}
```

- [ ] **Step 2: Write the failing tests**

```js
// test/instant.test.mjs
import { describe, it, expect } from 'vitest';
import { fakeAdmin } from './fake-admin.mjs';
import {
  ensureProfile, setArtistName, saveRating, itemSlugs, itemsBySlug, insertItem,
} from '../server/instant.mjs';

describe('ensureProfile', () => {
  it('returns the existing profile id when one is linked', async () => {
    const db = fakeAdmin({ profiles: [{ id: 'p1', artistName: 'Neo', user: { id: 'u1' } }] });
    expect(await ensureProfile(db, { id: 'u1', email: 'neo@x.com' })).toBe('p1');
    expect(db._txs).toHaveLength(0);
  });

  it('creates a profile (artistName = email local part) when none exists', async () => {
    const db = fakeAdmin({ profiles: [] });
    const id = await ensureProfile(db, { id: 'u2', email: 'kalavox@gmail.com' });
    expect(id).toBeTruthy();
    const op = db._txs[0];
    expect(op.ns).toBe('profiles');
    expect(op.update.artistName).toBe('kalavox');
    expect(op.link).toEqual({ user: 'u2' });
  });
});

describe('setArtistName', () => {
  it('updates the existing profile name', async () => {
    const db = fakeAdmin({ profiles: [{ id: 'p1', artistName: 'old', user: { id: 'u1' } }] });
    const res = await setArtistName(db, { id: 'u1', email: 'a@b.c' }, 'New Name');
    expect(res).toEqual({ id: 'p1', artistName: 'New Name' });
    expect(db._txs.at(-1)).toMatchObject({ ns: 'profiles', id: 'p1', update: { artistName: 'New Name' } });
  });
});

describe('saveRating', () => {
  it('patches rating/notes/lesson on the matching slug', async () => {
    const db = fakeAdmin({ tracks: [{ id: 't1', slug: 's-01', rating: null, notes: '', lesson: '' }] });
    const res = await saveRating(db, 'tracks', 's-01', { rating: 4, notes: 'nice' });
    expect(res).toEqual({ rating: 4, notes: 'nice', lesson: '' });
    expect(db._txs[0]).toMatchObject({ ns: 'tracks', id: 't1', update: { rating: 4, notes: 'nice' } });
  });

  it('returns null for an unknown slug', async () => {
    const db = fakeAdmin({ tracks: [] });
    expect(await saveRating(db, 'tracks', 'nope', { rating: 1 })).toBeNull();
  });

  it('clears a rating when rating is explicitly null', async () => {
    const db = fakeAdmin({ tracks: [{ id: 't1', slug: 's-01', rating: 5 }] });
    const res = await saveRating(db, 'tracks', 's-01', { rating: null });
    expect(res.rating).toBeNull();
  });
});

describe('itemSlugs / itemsBySlug', () => {
  it('itemSlugs returns a set of slugs', async () => {
    const db = fakeAdmin({ stems: [{ slug: 'a' }, { slug: 'b' }] });
    expect(await itemSlugs(db, 'stems')).toEqual(new Set(['a', 'b']));
  });
  it('itemsBySlug filters by $in', async () => {
    const db = fakeAdmin({ stems: [{ slug: 'a', batch: 'B1' }, { slug: 'b', batch: 'B2' }] });
    const rows = await itemsBySlug(db, 'stems', ['b']);
    expect(rows).toEqual([{ slug: 'b', batch: 'B2' }]);
  });
});

describe('insertItem', () => {
  const track = {
    id: '2026-06-16-x-01', title: 'X', prompt: 'p', batch: '2026-06-16-x',
    description: 'd', code: 'setcpm(120/4)', createdAt: '2026-06-16T00:00:00Z',
    meta: { bpm: 120, genre: 'g', mood: 'm', key: 'C', instruments: ['s'], energy: 3 },
  };

  it('transacts a new item with slug, defaults and author link', async () => {
    const db = fakeAdmin({ tracks: [] });
    const res = await insertItem(db, 'tracks', track, 'p1');
    expect(res.ok).toBe(true);
    const op = db._txs[0];
    expect(op.ns).toBe('tracks');
    expect(op.update).toMatchObject({ slug: '2026-06-16-x-01', isPublic: true, rating: null, notes: '', lesson: '' });
    expect(op.update.versionOf).toBeUndefined();
    expect(op.link).toEqual({ author: 'p1' });
  });

  it('rejects a duplicate slug', async () => {
    const db = fakeAdmin({ tracks: [{ slug: '2026-06-16-x-01' }] });
    const res = await insertItem(db, 'tracks', track, 'p1');
    expect(res.ok).toBe(false);
    expect(db._txs).toHaveLength(0);
  });

  it('sets versionOf when present', async () => {
    const db = fakeAdmin({ tracks: [] });
    await insertItem(db, 'tracks', { ...track, id: '2026-06-16-x-01-v2', versionOf: '2026-06-16-x-01' }, 'p1');
    expect(db._txs[0].update.versionOf).toBe('2026-06-16-x-01');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- test/instant.test.mjs`
Expected: FAIL — `Cannot find module '../server/instant.mjs'`.

- [ ] **Step 4: Write `server/instant.mjs`**

```js
// server/instant.mjs
// Instant admin helpers. adminDb is injected (real client in prod, fake in tests).
import { id } from '@instantdb/admin';

// Returns the profile id for a user, creating one (artistName = email local part)
// if none is linked yet. Idempotent.
export async function ensureProfile(adminDb, user) {
  const { profiles } = await adminDb.query({ profiles: { $: { where: { 'user.id': user.id } } } });
  if (profiles[0]) return profiles[0].id;
  const profileId = id();
  const artistName = (user.email || 'artist').split('@')[0];
  await adminDb.transact(
    adminDb.tx.profiles[profileId].update({ artistName, createdAt: new Date().toISOString() }).link({ user: user.id }),
  );
  return profileId;
}

export async function getProfile(adminDb, user) {
  const profileId = await ensureProfile(adminDb, user);
  const { profiles } = await adminDb.query({ profiles: { $: { where: { id: profileId } } } });
  const p = profiles[0] ?? { id: profileId, artistName: (user.email || 'artist').split('@')[0] };
  return { id: p.id, artistName: p.artistName };
}

export async function setArtistName(adminDb, user, artistName) {
  const profileId = await ensureProfile(adminDb, user);
  await adminDb.transact(adminDb.tx.profiles[profileId].update({ artistName }));
  return { id: profileId, artistName };
}

// Patch shared rating fields on the item with the given slug. Returns the merged
// {rating, notes, lesson} or null if no item matches.
export async function saveRating(adminDb, namespace, slug, { rating, notes, lesson }) {
  const res = await adminDb.query({ [namespace]: { $: { where: { slug } } } });
  const item = res[namespace][0];
  if (!item) return null;
  const patch = {};
  if (rating !== undefined) patch.rating = rating; // null clears
  if (notes !== undefined) patch.notes = notes ?? '';
  if (lesson !== undefined) patch.lesson = lesson ?? '';
  await adminDb.transact(adminDb.tx[namespace][item.id].update(patch));
  return {
    rating: 'rating' in patch ? patch.rating : (item.rating ?? null),
    notes: 'notes' in patch ? patch.notes : (item.notes ?? ''),
    lesson: 'lesson' in patch ? patch.lesson : (item.lesson ?? ''),
  };
}

export async function itemSlugs(adminDb, namespace) {
  const res = await adminDb.query({ [namespace]: {} });
  return new Set(res[namespace].map((i) => i.slug));
}

export async function itemsBySlug(adminDb, namespace, slugs) {
  if (!slugs.length) return [];
  const res = await adminDb.query({ [namespace]: { $: { where: { slug: { $in: slugs } } } } });
  return res[namespace];
}

// All items in a namespace, with their rating/notes/lesson — for feedback and
// pending-revisions digests.
export async function queryItems(adminDb, namespace) {
  const res = await adminDb.query({ [namespace]: {} });
  return res[namespace];
}

// Insert a validated track/stem object. `track.id` becomes `slug`. Rejects a
// duplicate slug. Links author when a profile id is given.
export async function insertItem(adminDb, namespace, track, authorProfileId) {
  const existing = await itemsBySlug(adminDb, namespace, [track.id]);
  if (existing.length) return { ok: false, error: `slug already exists: ${track.id}` };
  const entId = id();
  const update = {
    slug: track.id,
    title: track.title,
    prompt: track.prompt,
    batch: track.batch,
    description: track.description,
    code: track.code,
    meta: track.meta,
    createdAt: track.createdAt,
    isPublic: true,
    rating: track.rating ?? null,
    notes: track.notes ?? '',
    lesson: track.lesson ?? '',
  };
  if (track.versionOf) update.versionOf = track.versionOf;
  let tx = adminDb.tx[namespace][entId].update(update);
  if (authorProfileId) tx = tx.link({ author: authorProfileId });
  await adminDb.transact(tx);
  return { ok: true, id: entId };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- test/instant.test.mjs`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add server/instant.mjs test/instant.test.mjs test/fake-admin.mjs
git commit -m "feat: server Instant helpers (profiles, ratings, item insert/query)"
```

---

## Phase 3 — Server endpoints & runner

### Task 5: Repoint rating route, add profile routes, inject adminDb

**Files:**
- Modify: `server/app.mjs`
- Modify: `test/` app suite (find with `grep -rl "createApp" test/`)

- [ ] **Step 1: Inspect the existing app test to learn its setup**

Run: `grep -rln "createApp\|/api/tracks\|/api/stems\|rating" test/`
Read the matching file(s) to see how `createApp` is currently constructed and which routes are asserted. You will: (a) swap the `stores` arg for `{ namespaces, adminDb }`, (b) delete assertions for the retired `GET /api/tracks`/`GET /api/stems` list routes, (c) keep/adjust the rating-route assertions to use a `fakeAdmin` seeded with a matching slug, (d) add assertions for `GET`/`PUT /api/profile`.

- [ ] **Step 2: Rewrite `collectionRoutes` and `createApp`, add profile routes**

Replace the `collectionRoutes` function and the `createApp` signature/body in `server/app.mjs` with:

```js
// One rating route per collection at /api/<name>/:id/rating (id = slug).
// Listing is retired — the client reads Instant directly.
function collectionRoutes(app, name, adminDb, requireAuth) {
  app.put(`/api/${name}/:id/rating`, requireAuth, wrap(async (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'invalid id' });
    const { rating, notes, lesson } = req.body ?? {};
    if (rating != null && !(Number.isInteger(rating) && rating >= 1 && rating <= 5)) {
      return res.status(400).json({ error: 'rating must be an integer 1-5' });
    }
    if (notes != null && typeof notes !== 'string') return res.status(400).json({ error: 'notes must be a string' });
    if (lesson != null && typeof lesson !== 'string') return res.status(400).json({ error: 'lesson must be a string' });
    const saved = await saveRating(adminDb, name, id, { rating, notes, lesson });
    if (!saved) return res.status(404).json({ error: 'not found' });
    res.json(saved);
  }));
}

function profileRoutes(app, adminDb, requireAuth) {
  app.get('/api/profile', requireAuth, wrap(async (req, res) => {
    res.json(await getProfile(adminDb, req.user));
  }));
  app.put('/api/profile', requireAuth, wrap(async (req, res) => {
    const { artistName } = req.body ?? {};
    if (typeof artistName !== 'string' || !artistName.trim() || artistName.length > 60) {
      return res.status(400).json({ error: 'artistName required (1-60 chars)' });
    }
    res.json(await setArtistName(adminDb, req.user, artistName.trim()));
  }));
}
```

Add the import at the top of `server/app.mjs`:

```js
import { saveRating, getProfile, setArtistName } from './instant.mjs';
```

Change `createApp` to take `adminDb` + `namespaces` instead of `stores`:

```js
export function createApp(opts = {}) {
  const app = express();
  app.use(express.json());

  const requireAuth = opts.requireAuth ?? ((_req, _res, next) => next());
  const adminDb = opts.adminDb;
  const namespaces = opts.namespaces ?? ['tracks', 'stems'];

  if (adminDb) {
    for (const name of namespaces) collectionRoutes(app, name, adminDb, requireAuth);
    profileRoutes(app, adminDb, requireAuth);
  }

  if (opts.jobStore && opts.runner) jobRoutes(app, opts.jobStore, opts.runner, opts.progressFor, requireAuth);

  if (opts.distDir) {
    app.get(['/stems', '/stems/'], (_req, res) => res.sendFile(join(opts.distDir, 'stems.html')));
    app.use(express.static(opts.distDir));
  }

  app.use((err, _req, res, _next) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });

  return app;
}
```

> Note: `jobRoutes`, `wrap`, `ID_RE` are unchanged. Remove the now-unused `collectionFor` import only if nothing else uses it (it's still used by jobRoutes — keep it).

- [ ] **Step 3: Update the app test suite**

In the app test file, construct the app with a fake admin db, e.g.:

```js
import { fakeAdmin } from './fake-admin.mjs';
// ...
const adminDb = fakeAdmin({ tracks: [{ id: 't1', slug: 'demo-01', rating: null, notes: '', lesson: '' }], profiles: [] });
const app = createApp({ adminDb, namespaces: ['tracks', 'stems'] /*, jobStore, runner, ... as before */ });
```

Replace any `GET /api/tracks`/`GET /api/stems` list assertions with rating + profile assertions, e.g.:

```js
it('PUT /api/tracks/:id/rating persists a rating', async () => {
  const res = await request(app).put('/api/tracks/demo-01/rating').send({ rating: 5 });
  expect(res.status).toBe(200);
  expect(res.body.rating).toBe(5);
});

it('PUT /api/tracks/:id/rating 404s for an unknown id', async () => {
  const res = await request(app).put('/api/tracks/missing/rating').send({ rating: 5 });
  expect(res.status).toBe(404);
});

it('PUT /api/profile validates artistName', async () => {
  const res = await request(app).put('/api/profile').send({ artistName: '' });
  expect(res.status).toBe(400);
});
```

(If the suite tests the auth gate, keep injecting a `requireAuth` that sets `req.user = { id: 'u1', email: 'kalavox@gmail.com' }`.)

- [ ] **Step 4: Run the app suite**

Run: `npm test -- test/<app-test-file>.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/app.mjs test/
git commit -m "feat: rating + profile routes backed by Instant; retire list routes"
```

### Task 6: Runner author attribution + Instant-based item detection

**Files:**
- Modify: `server/runner.mjs`
- Modify: `server/app.mjs` (job creation: capture userId/userEmail)
- Modify: `test/` runner suite (find with `grep -rl "createRunner\|diffNew\|buildArgv" test/`)

- [ ] **Step 1: Capture the author on job creation**

In `server/app.mjs` `jobRoutes`, in the `POST /api/jobs` handler, add the user to the `base` job object (after `requireAuth` has set `req.user`):

```js
const base = {
  id: randomUUID(),
  type,
  userId: req.user?.id ?? null,
  userEmail: req.user?.email ?? null,
  createdAt: new Date().toISOString(),
  status: 'queued',
  startedAt: null, finishedAt: null, summary: null, error: null,
  batch: null, newItems: [],
};
```

- [ ] **Step 2: Switch the runner from disk diff to Instant, inject adminDb + ensureProfile**

In `server/runner.mjs`:

1. Add imports at the top:

```js
import { itemSlugs, itemsBySlug, ensureProfile } from './instant.mjs';
```

2. Replace the file-based `idsIn` usage and add author env. Change `createRunner` to accept `adminDb`:

```js
export function createRunner({
  repoRoot, jobStore, adminDb,
  spawn = nodeSpawn,
  now = () => new Date().toISOString(),
}) {
```

(Drop the `dirs` param — collections are Instant namespaces now.)

3. Replace `runClaude` to inject the author profile id via env:

```js
  function runClaude(job, authorProfileId) {
    return new Promise((resolve) => {
      let out = '';
      let resolved = false;
      const settle = (result) => { if (!resolved) { resolved = true; resolve(result); } };
      const env = { ...process.env };
      if (authorProfileId) env.CRATE_AUTHOR_PROFILE_ID = authorProfileId;
      const child = spawn('claude', buildArgv(job), { cwd: repoRoot, env });
      child.stdout?.on('data', (d) => { out += d; });
      child.on('error', () => settle({ code: -1, out }));
      child.on('close', (code) => settle({ code: code ?? -1, out }));
    });
  }
```

4. Rewrite `runOne` to use Instant slugs for before/after and `readBatch` via `itemsBySlug`:

```js
  async function runOne(id) {
    const job = await jobStore.get(id);
    if (!job) return;
    const ns = job.collection; // 'tracks' | 'stems'
    const authorProfileId = job.userId
      ? await ensureProfile(adminDb, { id: job.userId, email: job.userEmail })
      : null;
    const before = await itemSlugs(adminDb, ns);
    await jobStore.update(id, { status: 'running', startedAt: now(), baselineCount: before.size });
    const { code, out } = await runClaude(job, authorProfileId);
    const after = await itemSlugs(adminDb, ns);
    const newItems = diffNew(before, after);
    const newRows = await itemsBySlug(adminDb, ns, newItems);
    const patch = { finishedAt: now(), newItems, batch: majorityBatch(newRows) };
    if (code === 0) { patch.status = 'done'; patch.summary = parseSummary(out); }
    else { patch.status = 'failed'; patch.error = `claude exited ${code}`; }
    await jobStore.update(id, patch);
  }
```

5. Replace the file-reading `readBatch` with a pure `majorityBatch(rows)` (same tie/majority logic, no disk):

```js
// The trustworthy batch is the majority `batch` among the newly-created rows
// (a generate run also emits stray revise versions from other batches). Null on
// a genuine tie or when no new row carries a batch.
export function majorityBatch(rows) {
  const counts = new Map();
  for (const r of rows) if (r.batch) counts.set(r.batch, (counts.get(r.batch) ?? 0) + 1);
  if (counts.size === 0) return null;
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) return null;
  return sorted[0][0];
}
```

6. Delete the old `idsIn` and async `readBatch` functions and remove `idsIn` from exports. Keep `diffNew`, `liveProduced`, `buildArgv`, `parseSummary`, `nodeSpawn`, `ALLOWED_TOOLS` exports (update Task 11 changes `ALLOWED_TOOLS`).

- [ ] **Step 3: Update the runner test suite**

- Remove tests for the deleted `idsIn`/async `readBatch`.
- Add a `majorityBatch` unit test:

```js
import { majorityBatch } from '../server/runner.mjs';
it('majorityBatch picks the dominant batch', () => {
  expect(majorityBatch([{ batch: 'A' }, { batch: 'A' }, { batch: 'B' }])).toBe('A');
});
it('majorityBatch returns null on a tie', () => {
  expect(majorityBatch([{ batch: 'A' }, { batch: 'B' }])).toBeNull();
});
it('majorityBatch returns null when no batch', () => {
  expect(majorityBatch([{}, {}])).toBeNull();
});
```

- `buildArgv`/`diffNew`/`liveProduced` tests are unchanged (argv is unchanged — the author goes via env, not argv).

- [ ] **Step 4: Run the runner suite**

Run: `npm test -- test/<runner-test-file>.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/runner.mjs server/app.mjs test/
git commit -m "feat: runner attributes authors and detects items via Instant"
```

### Task 7: Wire `server/index.mjs` to Instant

**Files:**
- Modify: `server/index.mjs`

- [ ] **Step 1: Load .env for local dev, hoist adminDb, update wiring**

Rewrite `server/index.mjs` so a single `adminDb` is created and passed to `requireAuth`, `createApp`, and `createRunner`; `progressFor` uses `itemSlugs`; and `.env` is loaded for local `npm run dev`:

```js
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { init as initAdmin } from '@instantdb/admin';
import { createApp } from './app.mjs';
import { createJobStore } from './jobs.mjs';
import { createRunner, liveProduced } from './runner.mjs';
import { itemSlugs } from './instant.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(repoRoot, 'dist');

// Local `npm run dev` doesn't get systemd's EnvironmentFile — load .env ourselves.
try { process.loadEnvFile(join(repoRoot, '.env')); } catch { /* prod: env already set */ }

const allowedEmails = (process.env.CRATE_ALLOWED_EMAILS ?? '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const { INSTANT_APP_ID, INSTANT_ADMIN_TOKEN } = process.env;
const adminDb = INSTANT_APP_ID && INSTANT_ADMIN_TOKEN
  ? initAdmin({ appId: INSTANT_APP_ID, adminToken: INSTANT_ADMIN_TOKEN })
  : null;
if (!adminDb) console.warn('[crate] Instant admin not configured — writes will fail');

function buildRequireAuth() {
  if (!adminDb) {
    console.warn('[crate] Instant auth not configured — mutating routes are OPEN');
    return undefined;
  }
  return async (req, res, next) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'sign in required' });
    try {
      const user = await adminDb.auth.verifyToken(token);
      const email = user?.email?.toLowerCase();
      if (!email || !allowedEmails.includes(email)) return res.status(403).json({ error: 'account not allowed' });
      req.user = user;
      next();
    } catch {
      return res.status(401).json({ error: 'invalid or expired session' });
    }
  };
}

const requireAuth = buildRequireAuth();
const jobStore = createJobStore({ jobsDir: join(repoRoot, 'data', 'jobs') });
const runner = createRunner({ repoRoot, jobStore, adminDb });

const progressFor = async (job) => {
  if (job.status !== 'running') return undefined;
  const count = (await itemSlugs(adminDb, job.collection)).size;
  return liveProduced(job, count);
};

const app = createApp({
  adminDb,
  namespaces: ['tracks', 'stems'],
  jobStore, runner, progressFor, requireAuth,
  distDir: existsSync(distDir) ? distDir : undefined,
});

await runner.recover();

const port = process.env.PORT ?? 3001;
app.listen(port, () => console.log(`strudel-ai api listening on http://localhost:${port}`));
```

- [ ] **Step 2: Boot the server to confirm it starts**

Run: `node server/index.mjs` (Ctrl-C after the listening line)
Expected: prints `strudel-ai api listening on http://localhost:3008` (or your PORT) with no crash. If it warns about Instant not configured, confirm `.env` has `INSTANT_APP_ID`/`INSTANT_ADMIN_TOKEN`.

- [ ] **Step 3: Commit**

```bash
git add server/index.mjs
git commit -m "feat: wire server to Instant admin (single adminDb, env load)"
```

---

## Phase 4 — Generation scripts & skills

### Task 8: Script env loader + admin client

**Files:**
- Create: `scripts/lib/instant.mjs`

- [ ] **Step 1: Write the script-side admin bootstrap**

```js
// scripts/lib/instant.mjs
// Admin client + helpers for CLI scripts. Agents spawned by the runner inherit
// env through the process tree; manual CLI runs need .env loaded here.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { init } from '@instantdb/admin';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
try { process.loadEnvFile(join(repoRoot, '.env')); } catch { /* env already set */ }

const { INSTANT_APP_ID, INSTANT_ADMIN_TOKEN } = process.env;
if (!INSTANT_APP_ID || !INSTANT_ADMIN_TOKEN) {
  console.error('Instant admin not configured (need INSTANT_APP_ID + INSTANT_ADMIN_TOKEN in .env)');
  process.exit(2);
}

export const adminDb = init({ appId: INSTANT_APP_ID, adminToken: INSTANT_ADMIN_TOKEN });
export * from '../../server/instant.mjs';
```

- [ ] **Step 2: Smoke-test it connects**

Run: `node -e "import('./scripts/lib/instant.mjs').then(m => m.itemSlugs(m.adminDb,'tracks')).then(s => console.log('tracks in instant:', s.size))"`
Expected: prints a number (0 before migration). If it errors on auth, the token is wrong.

- [ ] **Step 3: Commit**

```bash
git add scripts/lib/instant.mjs
git commit -m "feat: script-side Instant admin bootstrap"
```

### Task 9: Save scripts (validate + transact)

**Files:**
- Create: `scripts/save-track.mjs`
- Create: `scripts/save-stem.mjs`

- [ ] **Step 1: Write `scripts/save-track.mjs`**

```js
// scripts/save-track.mjs <staging/file.json>
// Validate a generated track (incl. character gate) and transact it to Instant
// `tracks`, linked to CRATE_AUTHOR_PROFILE_ID. Deletes the staging file on
// success. Prints "PASS <slug>" / "FAIL <slug> — <reason>" (exit 0/1).
import { readFile, unlink } from 'node:fs/promises';
import { validateTrack } from './validate.mjs';
import { adminDb, insertItem } from './lib/instant.mjs';

const NAMESPACE = 'tracks';
const CHARACTER = true;

async function main() {
  const file = process.argv[2];
  if (!file) { console.error('usage: node scripts/save-track.mjs <staging/file.json>'); process.exit(2); }

  let track;
  try {
    track = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    console.log(`FAIL ${file} — unreadable JSON: ${err.message}`);
    process.exit(1);
  }

  const result = await validateTrack(track, { character: CHARACTER });
  if (!result.ok) { console.log(`FAIL ${track.id ?? file} — ${result.error}`); process.exit(1); }

  const authorProfileId = process.env.CRATE_AUTHOR_PROFILE_ID || null;
  const saved = await insertItem(adminDb, NAMESPACE, track, authorProfileId);
  if (!saved.ok) { console.log(`FAIL ${track.id} — ${saved.error}`); process.exit(1); }

  try { await unlink(file); } catch { /* best effort */ }
  console.log(`PASS ${track.id}`);
}

main();
```

- [ ] **Step 2: Write `scripts/save-stem.mjs`**

Identical to `save-track.mjs` except the two constants:

```js
const NAMESPACE = 'stems';
const CHARACTER = false;
```

(Repeat the full file with those two values changed and the usage string pointing at `save-stem.mjs`.)

- [ ] **Step 3: Manual verification (after migration is possible, or with a throwaway author)**

Defer a live save test to Task 16's end-to-end check. For now verify the module loads:
Run: `node -e "import('./scripts/save-track.mjs')" 2>&1 | head -1` then Ctrl-C if it waits.
Expected: prints the usage error (no argv) — confirms imports resolve.

- [ ] **Step 4: Commit**

```bash
git add scripts/save-track.mjs scripts/save-stem.mjs
git commit -m "feat: save-track/save-stem scripts (validate + transact to Instant)"
```

### Task 10: `list-slugs.mjs` helper + repoint feedback & pending-revisions

**Files:**
- Create: `scripts/list-slugs.mjs`
- Modify: `scripts/feedback.mjs`
- Modify: `scripts/pending-revisions.mjs`

- [ ] **Step 1: Write `scripts/list-slugs.mjs`**

```js
// scripts/list-slugs.mjs <tracks|stems>
// Print every slug in a namespace, one per line (for the skills' duplicate-batch
// check: `node scripts/list-slugs.mjs tracks | grep <batch>`).
import { adminDb, itemSlugs } from './lib/instant.mjs';

const ns = process.argv[2] === 'stems' ? 'stems' : 'tracks';
for (const slug of [...(await itemSlugs(adminDb, ns))].sort()) console.log(slug);
```

- [ ] **Step 2: Repoint `scripts/feedback.mjs` CLI to Instant**

`buildDigest(tracks)` stays exactly as-is (pure). Replace the CLI block at the bottom:

```js
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const { adminDb, queryItems } = await import('./lib/instant.mjs');
  const ns = process.argv[2] === 'stems' ? 'stems' : 'tracks';
  console.log(buildDigest(await queryItems(adminDb, ns)));
}
```

Remove the now-unused `import { createStore } from '../server/store.mjs';`.

- [ ] **Step 3: Repoint `scripts/pending-revisions.mjs` to Instant**

Replace the CLI block:

```js
import { fileURLToPath } from 'node:url';
import { pendingRevisions } from '../src/versions.js';

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const { adminDb, queryItems } = await import('./lib/instant.mjs');
  const ns = process.argv[2] === 'stems' ? 'stems' : 'tracks';
  console.log(JSON.stringify(pendingRevisions(await queryItems(adminDb, ns)), null, 2));
}
```

Remove the `import { createStore } from '../server/store.mjs';`.

> `pendingRevisions`/`groupVersions` use `item.id` for family grouping. The Instant rows from `queryItems` have a UUID `id` and a separate `slug`. **Fix:** in `scripts/pending-revisions.mjs`, map rows to `{ ...r, id: r.slug }` before passing to `pendingRevisions` so families key on the slug and `nextId` is `<slug>-v<n>`:

```js
const rows = (await queryItems(adminDb, ns)).map((r) => ({ ...r, id: r.slug }));
console.log(JSON.stringify(pendingRevisions(rows), null, 2));
```

- [ ] **Step 4: Verify feedback runs against Instant (empty is fine pre-migration)**

Run: `node scripts/feedback.mjs tracks`
Expected: `No lessons yet — no cross-track feedback to apply.` (or a digest if data exists).

- [ ] **Step 5: Commit**

```bash
git add scripts/list-slugs.mjs scripts/feedback.mjs scripts/pending-revisions.mjs
git commit -m "feat: list-slugs helper; feedback + pending-revisions read Instant"
```

### Task 11: Update skills + runner tool allowlist + gitignore staging

**Files:**
- Modify: `.claude/skills/generate-tracks/SKILL.md`
- Modify: `.claude/skills/generate-stems/SKILL.md`
- Modify: `.claude/skills/revise-from-notes/SKILL.md`
- Modify: `server/runner.mjs` (`ALLOWED_TOOLS`)
- Modify: `.gitignore`

- [ ] **Step 1: Update the generation tool allowlist**

In `server/runner.mjs`, replace the `ALLOWED_TOOLS` array with the new script set (drop disk `rm tracks/`/`rm stems/`; add the save + list-slugs scripts; keep `Write` for staging):

```js
const ALLOWED_TOOLS = [
  'Write', 'Read', 'Edit', 'Task',
  'Bash(node scripts/save-track.mjs:*)',
  'Bash(node scripts/save-stem.mjs:*)',
  'Bash(node scripts/list-slugs.mjs:*)',
  'Bash(node scripts/feedback.mjs:*)',
  'Bash(node scripts/pending-revisions.mjs:*)',
  'Bash(node scripts/validate.mjs:*)',
  'Bash(date:*)', 'Bash(pwd)', 'Bash(ls:*)', 'Bash(grep:*)',
  'Bash(mkdir -p staging)', 'Bash(rm staging/:*)',
].join(',');
```

- [ ] **Step 2: Update `generate-tracks/SKILL.md`**

Make these edits (preserve everything else — style brief, directives, seeds):

- In step 3, change the duplicate-batch check from
  `If \`ls tracks/ | grep <batch>\` shows the batch already exists`
  to
  `If \`node scripts/list-slugs.mjs tracks | grep <batch>\` shows the batch already exists`.
- In the agent prompt, step 3, change `Write tracks/{id}.json with all required fields:` to `Write staging/{id}.json with all required fields:` (run `mkdir -p staging` first if needed).
- In the agent prompt, replace step 4 with:

```
4. Run: node scripts/save-track.mjs staging/{id}.json
   This validates AND saves the track to the database (with you as author).
   If it prints FAIL: read the reason, fix staging/{id}.json, re-run. Up to 3 attempts.
   - unknown sounds → grep scripts/sounds.json for valid names.
   - "lacks character" → add an off-grid groove (euclid/swing), dirt
     (crush/shape/vowel), richer harmony, or a transform until >=3 categories.
   If still failing after 3 attempts: delete the file (rm staging/{id}.json).
   On PASS the track is live; do NOT also run validate.mjs.
```

- Anywhere the report/notes mention validation as "the contract", keep it but note the save script is the validation+persist step.

- [ ] **Step 3: Update `generate-stems/SKILL.md`**

Apply the analogous edits: `list-slugs.mjs stems` for the duplicate check; agents write `staging/{id}.json`; agents run `node scripts/save-stem.mjs staging/{id}.json` instead of `validate.mjs`; 3-attempt loop; delete staging file on final failure.

- [ ] **Step 4: Update `revise-from-notes/SKILL.md`**

- The work list already comes from `node scripts/pending-revisions.mjs <stems|tracks>` (now Instant-backed) — confirm that command is referenced; if it reads files directly, change it to that command.
- Each revised version is written to `staging/{nextId}.json` (with `versionOf` set to the root slug, `id` = `{nextId}`) and saved via `node scripts/save-track.mjs` (tracks) or `node scripts/save-stem.mjs` (stems).
- Remove any `rm tracks/`/`rm stems/` instructions (revisions are new rows, never overwrite).

- [ ] **Step 5: Gitignore the staging dir**

Add to `.gitignore`:

```
staging/
```

- [ ] **Step 6: Sanity-check the skills reference only allowlisted commands**

Run: `grep -nE "scripts/[a-z-]+\.mjs" .claude/skills/*/SKILL.md`
Expected: only `save-track.mjs`, `save-stem.mjs`, `list-slugs.mjs`, `feedback.mjs`, `pending-revisions.mjs` appear (no `validate.mjs` as the save step; no `tracks/`/`stems/` writes).

- [ ] **Step 7: Commit**

```bash
git add .claude/skills server/runner.mjs .gitignore
git commit -m "feat: generation skills write to Instant via save scripts"
```

---

## Phase 5 — One-time migration

### Task 12: Migration script

**Files:**
- Create: `scripts/migrate-to-instant.mjs`

- [ ] **Step 1: Write the migration script**

```js
// scripts/migrate-to-instant.mjs
// One-time import of disk tracks/stems + their disk ratings into Instant,
// authored by kalavox. Idempotent: skips slugs already present.
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminDb, ensureProfile, itemSlugs, insertItem } from './lib/instant.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

async function ratingFor(ratingsDir, slug) {
  const r = await readJson(join(repoRoot, ratingsDir, `${slug}.json`));
  return { rating: r?.rating ?? null, notes: r?.notes ?? '', lesson: r?.lesson ?? '' };
}

async function migrateNamespace(ns, itemsDir, ratingsDir, profileId) {
  const existing = await itemSlugs(adminDb, ns);
  let files;
  try { files = (await readdir(join(repoRoot, itemsDir))).filter((f) => f.endsWith('.json')); }
  catch { files = []; }

  let created = 0, skipped = 0, failed = 0;
  for (const file of files.sort()) {
    const item = await readJson(join(repoRoot, itemsDir, file));
    if (!item?.id) { failed++; continue; }
    if (existing.has(item.id)) { skipped++; continue; }
    const rating = await ratingFor(ratingsDir, item.id);
    const res = await insertItem(adminDb, ns, { ...item, ...rating }, profileId);
    if (res.ok) { created++; existing.add(item.id); } else { skipped++; }
  }
  console.log(`${ns}: created ${created}, skipped ${skipped}, failed ${failed}`);
}

async function main() {
  const email = (process.env.CRATE_ALLOWED_EMAILS ?? '').split(',')[0].trim().toLowerCase();
  if (!email) { console.error('set CRATE_ALLOWED_EMAILS in .env'); process.exit(2); }

  const { $users } = await adminDb.query({ $users: { $: { where: { email } } } });
  const user = $users[0];
  if (!user) { console.error(`no $users row for ${email} — sign in once in the app first`); process.exit(2); }

  const profileId = await ensureProfile(adminDb, { id: user.id, email });
  console.log(`author: ${email} (profile ${profileId})`);

  await migrateNamespace('tracks', 'tracks', 'data/ratings', profileId);
  await migrateNamespace('stems', 'stems', 'data/stem-ratings', profileId);
  console.log('migration complete');
}

main();
```

- [ ] **Step 2: Commit (do not run yet — run in Task 16 after the schema push)**

```bash
git add scripts/migrate-to-instant.mjs
git commit -m "feat: one-time disk->Instant migration script"
```

---

## Phase 6 — Client reads (subscribe), authors, profile UI

### Task 13: Refactor auth.js onto the shared db + expose the user

**Files:**
- Modify: `src/auth.js`

- [ ] **Step 1: Use the shared db and broadcast auth changes**

In `src/auth.js`:

1. Replace the local init with the shared instance:

```js
import { db } from './db.js';
```

Delete the `import { init } from '@instantdb/core';` and the `const appId = ...` / `const db = init({ appId })` lines inside `setupAuth`.

2. Add a module-level user broadcast above `setupAuth`:

```js
let currentUser = null;
const userListeners = new Set();
export function onUser(cb) { cb(currentUser); userListeners.add(cb); return () => userListeners.delete(cb); }
function setUser(u) { currentUser = u; for (const cb of userListeners) cb(u); }
```

3. In `setupAuth`, guard on the shared db and call `setUser` in the auth subscription:

```js
export function setupAuth() {
  if (!db) return; // Instant not configured — leave the app open
  const btn = mountButton();
  const modal = mountModal(db);
  const gen = document.querySelector('.generate');
  if (gen) gen.hidden = true;

  db.subscribeAuth((auth) => {
    const user = auth?.user ?? null;
    token = user?.refresh_token ?? null;
    setUser(user);
    if (gen) gen.hidden = !user;
    if (user) {
      btn.textContent = 'sign out';
      btn.title = user.email;
      btn.onclick = () => db.auth.signOut();
      modal.close();
    } else {
      btn.textContent = 'sign in';
      btn.title = 'sign in to generate & rate';
      btn.onclick = () => modal.open();
    }
  });
}
```

(The `token` variable + fetch patch at the top of the file are unchanged.)

- [ ] **Step 2: Build to confirm no import errors**

Run: `npm run build`
Expected: build succeeds (Vite resolves `./db.js` and `../instant.schema`).

- [ ] **Step 3: Commit**

```bash
git add src/auth.js
git commit -m "refactor: auth.js uses shared db and broadcasts current user"
```

### Task 14: App reads from Instant; artist name + "mine" filter

**Files:**
- Modify: `src/app.js`
- Modify: `src/main.js`
- Modify: `src/stems.js`
- Modify: `index.html` and `stems.html` (add the "mine" filter button)

- [ ] **Step 1: Switch entry points from apiBase to namespace**

`src/main.js`:

```js
import { initApp } from './app.js';
import { setupAuth } from './auth.js';

setupAuth();
initApp({
  namespace: 'tracks',
  emptyHint: 'generate some tracks: <code>/generate-tracks "dark techno" 12</code>',
  splitStems: true,
}).catch((err) => console.error('initApp failed', err));
```

`src/stems.js`:

```js
import { initApp } from './app.js';
import { setupAuth } from './auth.js';

setupAuth();
initApp({
  namespace: 'stems',
  emptyHint: 'conjure some stems: <code>/generate-stems "alien sound" 30</code>',
}).catch((err) => console.error('initApp failed', err));
```

- [ ] **Step 2: Add the "mine" filter button to both pages**

In `index.html` and `stems.html`, inside the `.seg` segmented control (next to `all`/`unrated`/`top`), add:

```html
<button data-filter="mine" hidden>mine</button>
```

(Keep it `hidden` — Step 4 reveals it when signed in.)

- [ ] **Step 3: Replace fetch-load with a subscription + entity mapping**

In `src/app.js`:

1. Update the signature and imports:

```js
import { db } from './db.js';
import { onUser } from './auth.js';
// ...
export async function initApp({ namespace, emptyHint, splitStems = false }) {
```

2. Replace the `const collection = apiBase.endsWith('/stems') ? 'stems' : 'tracks';` line with:

```js
const collection = namespace; // 'tracks' | 'stems'
```

3. Add author/user state next to the existing `state`:

```js
let myProfileId = null;
let myUserId = null;
```

4. Map Instant rows so the rest of the file keeps treating `id` as the human slug. Add a helper:

```js
// Present each Instant entity to the render code as { ...fields, id: slug }.
function mapRow(row) {
  return {
    ...row,
    id: row.slug,
    artistName: row.author?.artistName ?? null,
    authorProfileId: row.author?.id ?? null,
  };
}
```

5. Replace `putRating`'s fetch URL (apiBase is gone):

```js
const res = await fetch(`/api/${namespace}/${track.id}/rating`, {
```

6. Add the "mine" filter to `visibleFamilies()` (extend the existing filter chain):

```js
function visibleFamilies() {
  return groupVersions(state.tracks).filter((fam) => {
    const t = fam.latest;
    if (state.batch !== 'all' && t.batch !== state.batch) return false;
    if (state.filter === 'unrated') return t.rating == null;
    if (state.filter === 'top') return (t.rating ?? 0) >= 4;
    if (state.filter === 'mine') return myProfileId != null && t.authorProfileId === myProfileId;
    return true;
  });
}
```

7. Render the artist name in the card. In `trackCard`'s `mountBody`, after the line that sets `$('.desc', meta).textContent = ...`, add:

```js
if (track.artistName) {
  const by = document.createElement('span');
  by.className = 'by';
  by.textContent = `by ${track.artistName}`;
  meta.querySelector('h3').after(by);
}
```

8. Replace the whole `loadTracks()` + its call + the `mountJobsUI` block at the bottom of `initApp` with a live subscription:

```js
  // --- live data from Instant ------------------------------------------------
  function applyRows(rows) {
    state.tracks = rows.map(mapRow);
    renderBatchFilter();
    renderTracks();
    renderTransport();
  }

  if (!db) {
    $('#tracks').innerHTML = `<p class="empty">Instant not configured — set VITE_INSTANT_APP_ID</p>`;
  } else {
    db.subscribeQuery(
      { [namespace]: { author: {}, $: { order: { createdAt: 'desc' } } } },
      (res) => {
        if (res.error) {
          $('#tracks').innerHTML = `<p class="empty">could not load: ${res.error.message}</p>`;
          return;
        }
        if (res.data) applyRows(res.data[namespace] ?? []);
      },
    );
  }

  // Track the signed-in user → reveal "mine" and resolve their profile id.
  const mineBtn = document.querySelector('.seg button[data-filter="mine"]');
  let profileUnsub = null;
  onUser((user) => {
    myUserId = user?.id ?? null;
    if (mineBtn) mineBtn.hidden = !user;
    if (profileUnsub) { profileUnsub(); profileUnsub = null; }
    myProfileId = null;
    if (user && db) {
      profileUnsub = db.subscribeQuery(
        { profiles: { $: { where: { 'user.id': user.id } } } },
        (res) => { myProfileId = res.data?.profiles?.[0]?.id ?? null; if (state.filter === 'mine') renderTracks(); },
      );
    }
    if (state.filter === 'mine') renderTracks();
  });

  const { mountJobsUI } = await import('./jobs-ui.js');
  mountJobsUI({ collection, onBatchDone: () => { /* subscription updates live */ } });
}
```

(Remove the old `async function loadTracks() { ... }`, the `await loadTracks();` call, and the old `mountJobsUI({ collection, onBatchDone: () => loadTracks() })`.)

- [ ] **Step 4: Add minimal CSS for the artist name**

In `src/style.css`, add:

```css
.track .by { display: block; font-size: 0.8rem; opacity: 0.7; margin: 0.1rem 0; }
```

- [ ] **Step 5: Build + lint the bundle**

Run: `npm run build`
Expected: build succeeds with no unresolved imports.

- [ ] **Step 6: Commit**

```bash
git add src/app.js src/main.js src/stems.js index.html stems.html src/style.css
git commit -m "feat: client reads tracks/stems from Instant; artist name + mine filter"
```

### Task 15: Profile (artist name) editor

**Files:**
- Modify: `src/auth.js` (mount a small profile control when signed in)
- Modify: `src/style.css`

- [ ] **Step 1: Mount an artist-name editor next to the auth button**

In `src/auth.js`, add a function and call it from `setupAuth` (it shows only when signed in, loads via `GET /api/profile`, saves via `PUT /api/profile`):

```js
function mountProfile() {
  const nav = document.querySelector('.nav');
  const wrap = document.createElement('form');
  wrap.className = 'profile-edit';
  wrap.hidden = true;
  wrap.innerHTML = `<input type="text" name="artist" placeholder="artist name" maxlength="60" />`;
  nav?.appendChild(wrap);
  const input = wrap.elements.artist;

  async function load() {
    try {
      const res = await fetch('/api/profile');
      if (res.ok) { const p = await res.json(); input.value = p.artistName ?? ''; }
    } catch { /* ignore */ }
  }
  async function save() {
    const artistName = input.value.trim();
    if (!artistName) return;
    try {
      const res = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artistName }),
      });
      input.classList.toggle('saved', res.ok);
      setTimeout(() => input.classList.remove('saved'), 600);
    } catch { /* ignore */ }
  }
  wrap.addEventListener('submit', (e) => { e.preventDefault(); save(); input.blur(); });
  input.addEventListener('blur', save);

  return { show: () => { wrap.hidden = false; load(); }, hide: () => { wrap.hidden = true; } };
}
```

Wire it in `setupAuth` — create it once and toggle in the auth subscription:

```js
  const profile = mountProfile();
  // ...inside db.subscribeAuth handler:
  //   if (user) { ...; profile.show(); } else { ...; profile.hide(); }
```

- [ ] **Step 2: Style the editor**

In `src/style.css`:

```css
.profile-edit input { font: inherit; padding: 0.25rem 0.5rem; border-radius: 6px; }
.profile-edit input.saved { outline: 2px solid #4caf50; }
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/auth.js src/style.css
git commit -m "feat: artist-name profile editor in the nav"
```

---

## Phase 7 — Cutover, cleanup, verification

### Task 16: Push schema, migrate, end-to-end verify, deploy

**Files:**
- Delete: `server/store.mjs` (disk store, now unused)
- Modify: any remaining importers of `server/store.mjs`

- [ ] **Step 1: Confirm nothing still imports the disk store**

Run: `grep -rn "store.mjs\|createStore\|listTracks\|saveRating(.*ratingsDir" server scripts src test`
Expected: no references to `server/store.mjs`/`createStore` remain (feedback/pending-revisions were repointed; app uses `server/instant.mjs`). If any remain, fix them before deleting.

- [ ] **Step 2: Delete the disk store**

```bash
git rm server/store.mjs
```

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS (ignore any pre-existing unrelated failures). Confirm `instant.test.mjs`, the app suite, and runner suite pass.

- [ ] **Step 4: Push schema + perms to the Instant app**

```bash
set -a; . ./.env; set +a
npx instant-cli push schema --app "$INSTANT_APP_ID" --token "$INSTANT_ADMIN_TOKEN" --yes
npx instant-cli push perms  --app "$INSTANT_APP_ID" --token "$INSTANT_ADMIN_TOKEN" --yes
```

Expected: CLI reports the new entities/links and rules applied.

- [ ] **Step 5: Run the one-time migration**

Pre-req: kalavox has signed into the app at least once (so a `$users` row exists).

```bash
node scripts/migrate-to-instant.mjs
```

Expected: `author: kalavox@gmail.com (profile ...)`, then `tracks: created 65, ...` / `stems: created 91, ...`, then `migration complete`. Re-running prints all `skipped` (idempotent).

- [ ] **Step 6: End-to-end manual verification (dev)**

Run: `npm run dev` and open http://localhost:5173.
Verify, in order:
1. **Logged out:** all migrated tracks load and play; each card shows `by kalavox`; the generate panel and "mine" tab are hidden.
2. **Sign in** (allowlisted email): generate panel + "mine" tab appear; set an artist name in the nav field and confirm it saves (green flash).
3. **"mine" filter** shows your items only.
4. **Rate** a track 1–5 and add a note → reload → the rating/note persisted (came from Instant).
5. **Generate** a tiny batch (`/generate-tracks "test" 2` via the panel) → the new tracks appear **in real time** with `by <your artist name>`, under "mine", and play.
6. Open http://localhost:5173/stems and confirm stems load + the same behaviors.

Record the outcome of each numbered check before claiming completion (per verification-before-completion).

- [ ] **Step 7: Commit cleanup**

```bash
git add -A
git commit -m "chore: remove disk store; tracks/stems fully on Instant"
```

- [ ] **Step 8: Deploy**

Per the repo deploy rule: merge `feature/tracks-stems-instantdb` into the main worktree's branch, then:

```bash
cd /home/builder/apps/crate
git checkout main && git merge --no-ff feature/tracks-stems-instantdb
npm ci && npm run build
sudo systemctl restart vimsical-crate
```

Verify: `https://crate.vimsical.com` loads, plays public tracks logged-out, and shows artist names. Tail logs on error: `tail -f /home/builder/logs/crate.log`.

---

## Self-review notes

- **Spec coverage:** Instant storage (Tasks 1,4,9,12), authors (Tasks 4,6,9,12), profiles + artist name (Tasks 4,5,15), public-by-default + view perms (Tasks 1,2,14), client-direct reads (Tasks 3,13,14), full disk retirement incl. skills/validate/feedback/revise (Tasks 8–12,16), migration to kalavox (Task 12,16), vanilla JS (no framework task). Covered.
- **Type/name consistency:** `insertItem`, `saveRating`, `ensureProfile`, `setArtistName`, `getProfile`, `itemSlugs`, `itemsBySlug`, `queryItems`, `majorityBatch` are defined once (Tasks 4/6) and reused by the same names everywhere. The client `id = slug` mapping is applied in `mapRow` (Task 14) and in `pending-revisions.mjs` (Task 10) so all family-grouping keys on slug consistently.
- **No live secrets** are embedded; all push/migrate steps read `INSTANT_APP_ID`/`INSTANT_ADMIN_TOKEN` from `.env`.
