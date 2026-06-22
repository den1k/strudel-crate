# Play Counters (total + per-user) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each song's total play count and the signed-in viewer's own count, and subtly mark songs the viewer hasn't played yet — for both tracks and stems, per version.

**Architecture:** A public, token-aware `POST /api/<ns>/:id/play` route bumps a denormalized `playCount` on the item (everyone counts) and, when an allowlisted user is signed in, upserts a per-user `plays` record. The client fires this ping after 4s of continuous playback, subscribes to its own `plays` to build a slug→count map, and renders `▶ N plays` (with the viewer's count on hover) plus an accent dot before the title of songs the viewer hasn't played.

**Tech Stack:** InstantDB (`@instantdb/admin` server, `@instantdb/core` client), Express 4, vanilla JS ES modules, Vite, Vitest + supertest.

## Global Constraints

- A "play" = playback that survives 4000 ms continuous. Client guard before pinging: `state.playingId === track.id && isStarted(track.id)`.
- Everyone counts toward the total (anonymous included). Per-user records exist only for allowlisted signed-in users.
- Counts are per version. On the client `track.id === slug` (set by `mapRow`); the `plays` map is keyed by slug.
- All persistent writes go server-side via the admin SDK (clients only read + POST the play ping). Mirrors the rating route.
- Display: total reads `▶ N plays` (singular `1 play`); the viewer's own count shows via the element's `title` (`you: N`); an accent dot precedes the title when signed in and the viewer's count is 0.
- Tests use vitest + supertest + the in-memory `fakeAdmin`. Client render/trigger wiring is verified by `npm run build` + manual run (no DOM unit test), consistent with the rest of the app.
- Schema + perms are pushed to Instant at deploy time from the main worktree (needs `.env` credentials) — NOT an implementer task. See "Deploy note" at the end.
- Match existing idiom: lowercase UI copy, mono font, vanilla DOM, the existing server-helper style.

---

### Task 1: Schema + perms for play counts

Add the total-count field, the `plays` entity, its link, and view perms. Files only — the push to Instant happens at deploy time (see Deploy note).

**Files:**
- Modify: `instant.schema.ts` (`itemFields`, `entities`, `links`)
- Modify: `instant.perms.ts` (`rules`)

**Interfaces:**
- Produces: `tracks.playCount` / `stems.playCount` (optional number); `plays` entity `{ namespace, slug, count, lastPlayedAt }`; link `playsProfile` (`plays.profile` ↔ `profiles.plays`).

- [ ] **Step 1: Add `playCount` to the shared item fields**

In `instant.schema.ts`, add to the `itemFields` object (after the `lesson` line):

```ts
  playCount: i.number().optional(), // total plays across everyone; absent ⇒ 0
```

- [ ] **Step 2: Add the `plays` entity**

In `instant.schema.ts`, inside `entities`, after the `stems` entry:

```ts
    plays: i.entity({
      namespace: i.string(),       // 'tracks' | 'stems'
      slug: i.string().indexed(),  // which version was played
      count: i.number(),           // this profile's play count for this item
      lastPlayedAt: i.string(),    // ISO 8601
    }),
```

- [ ] **Step 3: Add the `playsProfile` link**

In `instant.schema.ts`, inside `links`, after `stemsAuthor`:

```ts
    playsProfile: {
      forward: { on: 'plays', has: 'one', label: 'profile', onDelete: 'cascade' },
      reverse: { on: 'profiles', has: 'many', label: 'plays' },
    },
```

- [ ] **Step 4: Add `plays` view perms**

In `instant.perms.ts`, add to the `rules` object (after `profiles`):

```ts
  plays: {
    allow: {
      view: "auth.id != null && auth.id in data.ref('profile.user.id')",
      create: 'false',
      update: 'false',
      delete: 'false',
    },
  },
```

- [ ] **Step 5: Verify schema compiles via the client build**

`instant.schema.ts` is TypeScript; the build is the typecheck (Vite/esbuild imports it through `src/db.js`).

Run: `npm run build`
Expected: `✓ built` with no errors referencing `instant.schema.ts` or `plays`.

- [ ] **Step 6: Commit**

```bash
git add instant.schema.ts instant.perms.ts
git commit -m "feat: schema + perms for play counts (playCount + plays entity)"
```

---

### Task 2: Generalize fake-admin nested `where` resolution

The per-user query filters `plays` by `'profile.id'`. The test double's `matchWhere` only special-cases `'user.id'` and throws on any other nested key. Generalize it to resolve any dotted key.

**Files:**
- Modify: `test/fake-admin.mjs` (`matchWhere`)
- Create: `test/fake-admin.test.mjs`

**Interfaces:**
- Consumes: `fakeAdmin` from `test/fake-admin.mjs`.
- Produces: `db.query` supports `where` keys like `'profile.id'` (resolved as `row.profile?.id`), with `'user.id'` still working.

- [ ] **Step 1: Write the failing test**

Create `test/fake-admin.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { fakeAdmin } from './fake-admin.mjs';

describe('fakeAdmin nested where', () => {
  it('filters by a two-level nested key (profile.id)', async () => {
    const db = fakeAdmin({
      plays: [
        { id: 'pl1', slug: 'a', profile: { id: 'p1' } },
        { id: 'pl2', slug: 'b', profile: { id: 'p2' } },
      ],
    });
    const res = await db.query({ plays: { $: { where: { 'profile.id': 'p1' } } } });
    expect(res.plays.map((r) => r.id)).toEqual(['pl1']);
  });

  it('still filters by user.id', async () => {
    const db = fakeAdmin({
      profiles: [
        { id: 'p1', user: { id: 'u1' } },
        { id: 'p2', user: { id: 'u2' } },
      ],
    });
    const res = await db.query({ profiles: { $: { where: { 'user.id': 'u1' } } } });
    expect(res.profiles.map((r) => r.id)).toEqual(['p1']);
  });

  it('combines a nested key with plain equality keys', async () => {
    const db = fakeAdmin({
      plays: [
        { id: 'pl1', namespace: 'tracks', slug: 'a', profile: { id: 'p1' } },
        { id: 'pl2', namespace: 'stems', slug: 'a', profile: { id: 'p1' } },
      ],
    });
    const res = await db.query({
      plays: { $: { where: { namespace: 'tracks', slug: 'a', 'profile.id': 'p1' } } },
    });
    expect(res.plays.map((r) => r.id)).toEqual(['pl1']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- fake-admin`
Expected: FAIL — the `profile.id` cases throw `unsupported nested where key 'profile.id'`.

- [ ] **Step 3: Generalize `matchWhere`**

In `test/fake-admin.mjs`, replace the nested-key branch inside `matchWhere`. Change:

```js
    let val;
    if (key.includes('.')) {
      if (key === 'user.id') val = row.user?.id;
      else throw new Error(`fake-admin: unsupported nested where key '${key}' — extend matchWhere`);
    } else {
      val = row[key];
    }
```

to:

```js
    // Resolve dotted keys (e.g. 'user.id', 'profile.id') by walking the row.
    const val = key.includes('.')
      ? key.split('.').reduce((o, k) => o?.[k], row)
      : row[key];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- fake-admin`
Expected: PASS (3/3).

- [ ] **Step 5: Run the full suite (no regressions to other fakeAdmin users)**

Run: `npm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add test/fake-admin.mjs test/fake-admin.test.mjs
git commit -m "test: fakeAdmin resolves any nested where key"
```

---

### Task 3: `recordPlay` server helper

Add the admin-SDK helper that bumps the total and upserts the per-user record.

**Files:**
- Modify: `server/instant.mjs` (add `recordPlay`)
- Test: `test/instant.test.mjs` (add `describe('recordPlay')` + import)

**Interfaces:**
- Consumes: `ensureProfile` (same file), `id` from `@instantdb/admin` (already imported), `fakeAdmin` nested-where (Task 2).
- Produces: `recordPlay(adminDb, namespace, slug, user?) → { playCount, you } | null`. `you` is `undefined` when `user` is absent; `null` return means the slug doesn't exist.

- [ ] **Step 1: Write the failing tests**

In `test/instant.test.mjs`, update the import to add `recordPlay`:

```js
import {
  ensureProfile, getProfile, setArtistName, saveRating, itemSlugs, itemsBySlug, insertItem, recordPlay,
} from '../server/instant.mjs';
```

Then add this block (e.g. after the `saveRating` describe):

```js
describe('recordPlay', () => {
  it('bumps the total and treats absent playCount as 0 (anonymous)', async () => {
    const db = fakeAdmin({ tracks: [{ id: 't1', slug: 's-01' }] });
    const res = await recordPlay(db, 'tracks', 's-01', undefined);
    expect(res).toEqual({ playCount: 1, you: undefined });
    expect(db._txs[0]).toMatchObject({ ns: 'tracks', id: 't1', update: { playCount: 1 } });
    expect(db._txs.some((o) => o.ns === 'plays')).toBe(false);
  });

  it('increments an existing total (anonymous)', async () => {
    const db = fakeAdmin({ stems: [{ id: 's1', slug: 'st-01', playCount: 4 }] });
    const res = await recordPlay(db, 'stems', 'st-01', undefined);
    expect(res.playCount).toBe(5);
    expect(db._txs[0]).toMatchObject({ ns: 'stems', id: 's1', update: { playCount: 5 } });
  });

  it('returns null for an unknown slug', async () => {
    const db = fakeAdmin({ tracks: [] });
    expect(await recordPlay(db, 'tracks', 'nope', undefined)).toBeNull();
  });

  it('creates a per-user plays record (count 1) when none exists', async () => {
    const db = fakeAdmin({
      tracks: [{ id: 't1', slug: 's-01', playCount: 0 }],
      profiles: [{ id: 'p1', user: { id: 'u1' } }],
      plays: [],
    });
    const res = await recordPlay(db, 'tracks', 's-01', { id: 'u1', email: 'kalavox@gmail.com' });
    expect(res).toMatchObject({ playCount: 1, you: 1 });
    const playOp = db._txs.find((o) => o.ns === 'plays');
    expect(playOp.update).toMatchObject({ namespace: 'tracks', slug: 's-01', count: 1 });
    expect(playOp.link).toEqual({ profile: 'p1' });
  });

  it('increments an existing per-user plays record', async () => {
    const db = fakeAdmin({
      tracks: [{ id: 't1', slug: 's-01', playCount: 5 }],
      profiles: [{ id: 'p1', user: { id: 'u1' } }],
      plays: [{ id: 'pl1', namespace: 'tracks', slug: 's-01', count: 3, profile: { id: 'p1' } }],
    });
    const res = await recordPlay(db, 'tracks', 's-01', { id: 'u1', email: 'kalavox@gmail.com' });
    expect(res.you).toBe(4);
    const playOp = db._txs.find((o) => o.ns === 'plays' && o.id === 'pl1');
    expect(playOp.update).toMatchObject({ count: 4 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- instant`
Expected: FAIL — `recordPlay is not a function`.

- [ ] **Step 3: Implement `recordPlay`**

Append to `server/instant.mjs`:

```js
// Record a play of <namespace>/<slug>. Always bumps the item's total playCount
// (read-modify-write — under concurrent plays an increment can be lost; accepted
// at this scale). When `user` is given, upserts that user's per-item plays
// record. Returns { playCount, you } or null when the slug doesn't exist.
export async function recordPlay(adminDb, namespace, slug, user) {
  const res = await adminDb.query({ [namespace]: { $: { where: { slug } } } });
  const item = res[namespace][0];
  if (!item) return null;
  const playCount = (item.playCount ?? 0) + 1;
  await adminDb.transact(adminDb.tx[namespace][item.id].update({ playCount }));

  let you;
  if (user) {
    const profileId = await ensureProfile(adminDb, user);
    const found = await adminDb.query({
      plays: { $: { where: { namespace, slug, 'profile.id': profileId } } },
    });
    const existing = found.plays[0];
    const now = new Date().toISOString();
    if (existing) {
      you = (existing.count ?? 0) + 1;
      await adminDb.transact(adminDb.tx.plays[existing.id].update({ count: you, lastPlayedAt: now }));
    } else {
      you = 1;
      const playId = id();
      await adminDb.transact(
        adminDb.tx.plays[playId]
          .update({ namespace, slug, count: 1, lastPlayedAt: now })
          .link({ profile: profileId }),
      );
    }
  }
  return { playCount, you };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- instant`
Expected: PASS (existing + 5 new).

- [ ] **Step 5: Commit**

```bash
git add server/instant.mjs test/instant.test.mjs
git commit -m "feat: recordPlay helper (total + per-user upsert)"
```

---

### Task 4: Soft auth (`buildResolveUser`)

The play route must be reachable by anonymous users but still identify signed-in allowlisted ones. Add a middleware factory that attaches `req.user` when a valid allowlisted token is present and never rejects.

**Files:**
- Modify: `server/auth.mjs` (add `buildResolveUser`)
- Test: `test/auth.test.mjs` (add `describe('buildResolveUser')` + import)

**Interfaces:**
- Produces: `buildResolveUser({ adminDb, allowedEmails }) → middleware`. Sets `req.user` for a valid allowlisted Bearer token; otherwise calls `next()` anonymously. Returns a pass-through when `adminDb` is falsy.

- [ ] **Step 1: Write the failing tests**

In `test/auth.test.mjs`, update the import:

```js
import { buildRequireAuth, buildResolveUser } from '../server/auth.mjs';
```

Add this block at the end of the file:

```js
describe('buildResolveUser', () => {
  it('returns a pass-through when adminDb is missing', async () => {
    const mw = buildResolveUser({ adminDb: null, allowedEmails: allow });
    const req = { headers: {} };
    const { nexted } = await run(mw, req);
    expect(nexted).toBe(true);
    expect(req.user).toBeUndefined();
  });

  it('proceeds anonymously when no token is present', async () => {
    const mw = buildResolveUser({ adminDb: fakeAdmin(async () => ({})), allowedEmails: allow });
    const req = { headers: {} };
    const { nexted } = await run(mw, req);
    expect(nexted).toBe(true);
    expect(req.user).toBeUndefined();
  });

  it('attaches req.user for a valid allowlisted token', async () => {
    const mw = buildResolveUser({
      adminDb: fakeAdmin(async () => ({ id: 'u1', email: 'kalavox@gmail.com' })),
      allowedEmails: allow,
    });
    const req = { headers: { authorization: 'Bearer good' } };
    const { nexted } = await run(mw, req);
    expect(nexted).toBe(true);
    expect(req.user).toMatchObject({ id: 'u1' });
  });

  it('proceeds anonymously for a non-allowlisted email', async () => {
    const mw = buildResolveUser({
      adminDb: fakeAdmin(async () => ({ id: 'u9', email: 'stranger@x.com' })),
      allowedEmails: allow,
    });
    const req = { headers: { authorization: 'Bearer good' } };
    const { nexted } = await run(mw, req);
    expect(nexted).toBe(true);
    expect(req.user).toBeUndefined();
  });

  it('proceeds anonymously when the token is invalid', async () => {
    const mw = buildResolveUser({
      adminDb: fakeAdmin(async () => { throw new Error('bad'); }),
      allowedEmails: allow,
    });
    const req = { headers: { authorization: 'Bearer bad' } };
    const { nexted } = await run(mw, req);
    expect(nexted).toBe(true);
    expect(req.user).toBeUndefined();
  });
});
```

(`run`, `mkRes`, `fakeAdmin`, and `allow` already exist at the top of this test file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- auth`
Expected: FAIL — `buildResolveUser is not a function`.

- [ ] **Step 3: Implement `buildResolveUser`**

Append to `server/auth.mjs`:

```js
// Soft auth for public-but-personalized routes (e.g. play counts): if a valid,
// allowlisted Bearer token is present, attach req.user; otherwise proceed
// anonymously. NEVER rejects. Pass-through when adminDb is missing.
export function buildResolveUser({ adminDb, allowedEmails }) {
  if (!adminDb) return (_req, _res, next) => next();
  return async (req, _res, next) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (token) {
      try {
        const user = await adminDb.auth.verifyToken(token);
        const email = user?.email?.toLowerCase();
        if (email && allowedEmails.includes(email)) req.user = user;
      } catch { /* ignore — proceed anonymously */ }
    }
    next();
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- auth`
Expected: PASS (existing + 5 new).

- [ ] **Step 5: Commit**

```bash
git add server/auth.mjs test/auth.test.mjs
git commit -m "feat: buildResolveUser soft auth middleware"
```

---

### Task 5: Play route + app wiring

Add `POST /api/<ns>/:id/play` (token-aware) and wire `resolveUser` from `createApp` down into the collection routes and from `server/index.mjs`.

**Files:**
- Modify: `server/app.mjs` (`collectionRoutes`, `createApp`, import)
- Modify: `server/index.mjs` (build + pass `resolveUser`)
- Test: `test/api.test.mjs` (seed `plays`, add `describe('play API')`)

**Interfaces:**
- Consumes: `recordPlay` (Task 3), `buildResolveUser` (Task 4).
- Produces: `POST /api/<ns>/:id/play` → 200 `{ playCount, you }`, 404 unknown slug, 400 bad id. `createApp` accepts `opts.resolveUser` (default no-op pass-through).

- [ ] **Step 1: Write the failing tests**

In `test/api.test.mjs`, add `plays: []` to the `beforeEach` seed (so the store has the namespace):

```js
    stems: [{ id: 's1', slug: 'stem-01', rating: null, notes: '', lesson: '' }],
    profiles: [],
    plays: [],
```

Add this block after the `rating API` describe:

```js
describe('play API', () => {
  it('POST /api/tracks/:id/play (anonymous) bumps the total only', async () => {
    const res = await request(app).post('/api/tracks/demo-01/play');
    expect(res.status).toBe(200);
    expect(res.body.playCount).toBe(1);
    expect(res.body.you).toBeUndefined();
  });

  it('404s for an unknown slug', async () => {
    const res = await request(app).post('/api/tracks/missing/play');
    expect(res.status).toBe(404);
  });

  it('rejects ids with path characters', async () => {
    const res = await request(app).post('/api/tracks/..%2Fevil/play');
    expect(res.status).toBe(400);
  });

  it('records a per-user play when signed in', async () => {
    const resolveUser = (req, _res, next) => { req.user = { id: 'u1', email: 'kalavox@gmail.com' }; next(); };
    const db2 = fakeAdmin({
      tracks: [{ id: 't1', slug: 'demo-01', playCount: 0 }],
      profiles: [{ id: 'p1', user: { id: 'u1' } }],
      plays: [],
    });
    const signedApp = createApp({ adminDb: db2, namespaces: ['tracks', 'stems'], requireAuth, resolveUser });
    const res = await request(signedApp).post('/api/tracks/demo-01/play');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ playCount: 1, you: 1 });
    expect(db2._txs.some((o) => o.ns === 'plays')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- api`
Expected: FAIL — `POST /api/tracks/demo-01/play` 404s (no such route) / `playCount` undefined.

- [ ] **Step 3: Add the route and thread `resolveUser`**

In `server/app.mjs`, update the import:

```js
import { saveRating, getProfile, setArtistName, recordPlay } from './instant.mjs';
```

Change the `collectionRoutes` signature and add the play route. Replace:

```js
function collectionRoutes(app, name, adminDb, requireAuth) {
  app.put(`/api/${name}/:id/rating`, requireAuth, wrap(async (req, res) => {
```

with:

```js
function collectionRoutes(app, name, adminDb, requireAuth, resolveUser) {
  app.put(`/api/${name}/:id/rating`, requireAuth, wrap(async (req, res) => {
```

and, immediately after the rating route's closing `}));` (still inside `collectionRoutes`, before its final `}`), add:

```js
  // Public, token-aware: anyone's play bumps the total; a signed-in allowlisted
  // user also gets a per-user record. id = slug.
  app.post(`/api/${name}/:id/play`, resolveUser, wrap(async (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'invalid id' });
    const result = await recordPlay(adminDb, name, id, req.user);
    if (!result) return res.status(404).json({ error: 'not found' });
    res.json(result);
  }));
```

In `createApp`, add the `resolveUser` default and pass it down. Change:

```js
  const requireAuth = opts.requireAuth ?? ((_req, _res, next) => next());
  const adminDb = opts.adminDb;
  const namespaces = opts.namespaces ?? ['tracks', 'stems'];

  if (adminDb) {
    for (const name of namespaces) collectionRoutes(app, name, adminDb, requireAuth);
    profileRoutes(app, adminDb, requireAuth);
  }
```

to:

```js
  const requireAuth = opts.requireAuth ?? ((_req, _res, next) => next());
  const resolveUser = opts.resolveUser ?? ((_req, _res, next) => next());
  const adminDb = opts.adminDb;
  const namespaces = opts.namespaces ?? ['tracks', 'stems'];

  if (adminDb) {
    for (const name of namespaces) collectionRoutes(app, name, adminDb, requireAuth, resolveUser);
    profileRoutes(app, adminDb, requireAuth);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- api`
Expected: PASS (existing + 4 new).

- [ ] **Step 5: Wire `resolveUser` in the server entrypoint**

In `server/index.mjs`, update the auth import:

```js
import { buildRequireAuth, buildResolveUser } from './auth.mjs';
```

After the `const requireAuth = buildRequireAuth({ adminDb, allowedEmails });` line, add:

```js
const resolveUser = buildResolveUser({ adminDb, allowedEmails });
```

And add `resolveUser` to the `createApp({ ... })` call options (alongside `requireAuth`):

```js
const app = createApp({
  adminDb,
  namespaces: ['tracks', 'stems'],
  jobStore, runner, progressFor, requireAuth, resolveUser,
});
```

- [ ] **Step 6: Full suite + build**

Run: `npm test`
Expected: all green.

Run: `npm run build`
Expected: `✓ built`.

- [ ] **Step 7: Commit**

```bash
git add server/app.mjs server/index.mjs test/api.test.mjs
git commit -m "feat: POST /api/:ns/:id/play route (token-aware)"
```

---

### Task 6: Client — trigger, per-user subscription, and card rendering

Fire the play ping after 4s, subscribe to the viewer's own plays, and render the total (`▶ N plays`), the hover count, and the unplayed dot.

**Files:**
- Modify: `src/app.js` (state, `play`, `stop`, the `onUser` block, `trackCard`/`mountBody` rendering)
- Modify: `src/style.css` (`.plays`, `.unplayed-dot`)

**Interfaces:**
- Consumes: `POST /api/<namespace>/:id/play`; `db.subscribeQuery({ plays: { $: { where: { 'profile.id': pid } } } })`; `isStarted` (already imported); `myProfileId` (already in scope).
- Produces: live total + per-user UI on every card. No exported API.

- [ ] **Step 1: Add play state**

In `src/app.js`, find the `state` initializer (around line 20):

```js
  const state = { tracks: [], playingId: null, playingSpec: null, samplesReady: false, batch: 'all', filter: 'all' };
```

Add `playsBySlug` and a play-timer holder:

```js
  const state = { tracks: [], playingId: null, playingSpec: null, samplesReady: false, batch: 'all', filter: 'all', playsBySlug: {} };
  let playTimer = null; // pending "count this play" timer (fires after 4s of playback)
```

- [ ] **Step 2: Fire the ping after 4s of playback**

In the `play(track)` function, at the very top (right after `async function play(track) {`), cancel any pending timer:

```js
  async function play(track) {
    clearTimeout(playTimer);
    state.playingId = track.id;
```

Then at the end of `play`, after `startSeekLoop();`, add the timer:

```js
    startSeekLoop();
    // Count a play only once it has survived 4s of continuous playback.
    playTimer = setTimeout(() => {
      if (state.playingId === track.id && isStarted(track.id)) {
        fetch(`/api/${namespace}/${track.id}/play`, { method: 'POST' }).catch(() => {});
      }
    }, 4000);
  }
```

- [ ] **Step 3: Cancel the timer on stop**

In the `stop()` function, add the clear as the first line:

```js
  function stop() {
    clearTimeout(playTimer);
    getEditor(state.playingId)?.stop();
```

- [ ] **Step 4: Subscribe to the viewer's own plays**

In `src/app.js`, find the `onUser((user) => { ... })` block (around line 543). Replace the whole block with this version (adds a `plays` subscription keyed on the resolved profile id):

```js
  // Track the signed-in user → reveal "mine", resolve their profile id, and
  // subscribe to their plays (slug → count) for the per-user counters + dots.
  const mineBtn = document.querySelector('.seg button[data-filter="mine"]');
  let profileUnsub = null;
  let playsUnsub = null;
  const stopPlays = () => { if (playsUnsub) { playsUnsub(); playsUnsub = null; } state.playsBySlug = {}; };
  onUser((user) => {
    if (mineBtn) mineBtn.hidden = !user;
    if (profileUnsub) { profileUnsub(); profileUnsub = null; }
    stopPlays();
    myProfileId = null;
    if (user && db) {
      profileUnsub = db.subscribeQuery(
        { profiles: { $: { where: { 'user.id': user.id } } } },
        (res) => {
          const pid = res.data?.profiles?.[0]?.id ?? null;
          if (pid !== myProfileId) {
            myProfileId = pid;
            stopPlays();
            if (pid) {
              playsUnsub = db.subscribeQuery(
                { plays: { $: { where: { 'profile.id': pid } } } },
                (r) => {
                  const map = {};
                  for (const p of r.data?.plays ?? []) map[p.slug] = p.count;
                  state.playsBySlug = map;
                  renderTracks();
                },
              );
            }
          }
          if (state.filter === 'mine') renderTracks();
        },
      );
    }
    if (state.filter === 'mine') renderTracks();
  });
```

- [ ] **Step 5: Render the total, hover count, and unplayed dot**

In `src/app.js`, find the `meta.innerHTML` line (around line 302):

```js
      meta.innerHTML = `<h3></h3><span class="id"></span><p class="desc"></p><div class="chips"></div>`;
```

Add a `.plays` span after `.id`:

```js
      meta.innerHTML = `<h3></h3><span class="id"></span><span class="plays"></span><p class="desc"></p><div class="chips"></div>`;
```

Then, right after the `$('.id', meta).textContent = track.id;` line, add:

```js
      const playsEl = $('.plays', meta);
      const total = track.playCount ?? 0;
      playsEl.textContent = `▶ ${total} ${total === 1 ? 'play' : 'plays'}`;
      if (myProfileId != null) {
        const you = state.playsBySlug[track.id] ?? 0; // track.id === slug
        playsEl.title = `you: ${you}`;
        if (!(you > 0)) {
          const dot = document.createElement('span');
          dot.className = 'unplayed-dot';
          dot.title = 'you haven’t played this yet';
          $('h3', meta).prepend(dot);
        }
      }
```

- [ ] **Step 6: Style the counter and dot**

In `src/style.css`, add after the `.chip { ... }` rule (search for `.chip {`):

```css
.plays { display: block; margin-top: 4px; font-size: 11px; color: var(--dim); font-family: var(--mono); }
.unplayed-dot {
  display: inline-block; width: 6px; height: 6px; border-radius: 50%;
  background: var(--acid); margin-right: 6px; vertical-align: middle;
}
```

- [ ] **Step 7: Build + full suite**

Run: `npm run build`
Expected: `✓ built`.

Run: `npm test`
Expected: all green (this task adds no tests; confirms no regressions).

- [ ] **Step 8: Manual check**

Run `npm run dev` (needs `.env`). On a card: `▶ 0 plays` shows in the meta row. Press play and let it run >4s → after the ping + subscription refresh, the total ticks up. Signed in: songs you haven't played show an accent dot before the title; hovering the `▶ N plays` text shows `you: N`; once you've played a song the dot disappears for it. Quick play→stop (<4s) does not increment.

- [ ] **Step 9: Commit**

```bash
git add src/app.js src/style.css
git commit -m "feat: play counters + unplayed dot on song cards"
```

---

## Deploy note (controller / not an implementer task)

The schema and perms must be pushed to Instant before the new server code runs in production, and the push needs `.env` credentials (present only in the main worktree). At deploy time, from `/home/builder/apps/crate`:

```bash
set -a; source .env; set +a
npx instant-cli push schema --app "$INSTANT_APP_ID" --token "$INSTANT_ADMIN_TOKEN" --yes
npx instant-cli push perms  --app "$INSTANT_APP_ID" --token "$INSTANT_ADMIN_TOKEN" --yes
npm run build
sudo systemctl restart vimsical-crate
```

(Additive schema changes — new optional field, new entity, new link — are backward compatible with existing rows.)

## Self-Review Notes

- **Spec coverage:** model → Task 1; fake-admin nested where → Task 2; `recordPlay` (total + upsert, anon vs signed-in, 404) → Task 3; soft auth → Task 4; route + wiring → Task 5; client trigger/subscription/render + CSS → Task 6; schema push → Deploy note. All covered.
- **Type/name consistency:** `recordPlay(adminDb, namespace, slug, user) → { playCount, you } | null`, `buildResolveUser({ adminDb, allowedEmails })`, `opts.resolveUser`, `state.playsBySlug` (slug→count), and the `plays` entity field names (`namespace`, `slug`, `count`, `lastPlayedAt`) are used identically across tasks.
- **No server changes beyond the play path; reads stay public; `db`-null/anon paths handled.**
