# Social Layer (Ratings, Owner Notes/Lessons, Remix) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single-value rating/notes/lesson fields into a social layer: any logged-in user can rate (with a public aggregate + a clear "your rating"), only a song's owner can write its notes/lessons (notes public-read, lessons private), and any allowlisted user can remix a song/stem into a brand-new item they own without touching the original.

**Architecture:** Per-user `ratings` rows (mirroring the existing `plays` entity) with a denormalized `ratingSum`/`ratingCount` aggregate on each item, maintained server-side. A new lightweight `requireUser` auth gate (valid token, no allowlist) sits beside the existing allowlist `requireAuth`. Remix reuses the `claude -p` jobs pipeline with a new `remix` job type and a new `/remix` skill that writes a remixer-owned item carrying `remixOf`.

**Tech Stack:** Node ESM, Express 4, `@instantdb/admin` (server) / `@instantdb/core` (client, vanilla JS), Vitest + Supertest, InstantDB CLI for schema/perms.

## Global Constraints

- Server is ESM (`.mjs`); client is vanilla JS (`.js`) bundled by Vite. No TypeScript in runtime code.
- All InstantDB writes go through the admin SDK server-side; client `create`/`update`/`delete` perms stay `false`.
- Has-one links come back from InstaQL as a **single-element list** — unwrap with `[0]` (e.g. `item.author?.[0]?.id`).
- The test `fakeAdmin` mock filters `query` results but **does not mutate the store on `transact`** and **does not resolve links** — tests seed the expected post-state and assert on recorded `adminDb._txs`. Seed nested link data as literal arrays on rows (e.g. `author: [{ id: 'p1', user: [{ id: 'u1' }] }]`).
- Index any field used in a `where`/`order`. New indexed fields: `ratings.slug`, `tracks.remixOf`, `stems.remixOf`.
- Generation prompts/instructions: 1–500 chars, no double-quote character (it breaks the `claude -p` slash-command boundary).
- Run the full suite with `npx vitest run`. A single file: `npx vitest run test/<file>`.
- This work runs in an isolated git worktree (created by the executing skill). The live service runs from the main worktree at `/home/builder/apps/crate`; deploy = merge to main worktree's branch + `sudo systemctl restart vimsical-crate`.

---

## File Structure

**Schema / perms**
- `instant.schema.ts` (modify) — `ratings` entity, `ratingsProfile` link, item `ratingSum`/`ratingCount`/`remixOf`.
- `instant.perms.ts` (modify) — `ratings` view rule, `lesson` field rule.

**Server**
- `server/auth.mjs` (modify) — add `buildRequireUser`.
- `server/instant.mjs` (modify) — add `setRating`, `setNotes`, `itemOwnerProfileId`; extend `insertItem` with `remixOf`; remove `saveRating`.
- `server/app.mjs` (modify) — split rating route, add notes route, add `remix` job branch; thread `requireUser` + `allowedEmails`.
- `server/index.mjs` (modify) — build `requireUser`, pass it + `allowedEmails` into `createApp`.
- `server/runner.mjs` (modify) — `remix` collection mapping, `buildArgv` branch, allow `remix-source.mjs` tool.
- `server/jobs.mjs` (modify) — add `remix` to `JOB_TYPES`.

**Scripts / skill**
- `scripts/remix-source.mjs` (create) — emit source item + a fresh `newId` for the `/remix` skill.
- `scripts/migrate-ratings.mjs` (create) — backfill `ratings` rows + aggregates from the legacy `rating` field.
- `src/ratings-migrate.js` (create) — pure `planRatingMigration(items)` used by the script (testable).
- `.claude/skills/remix/SKILL.md` (create) — the `/remix` headless command.

**Client**
- `src/ratings.js` (create) — pure helpers: `aggregateAvg`, `isTopAggregate`, `myRatingOf`.
- `src/app.js` (modify) — rating control + aggregate badge + `ratings` subscription, owner-gated notes/lessons, remix entry point, filters.
- `src/song.js` (modify) — public "creator's notes" + remix backlink on the song page.
- `src/jobs-ui.js` (modify) — `post` helper reused for remix jobs (no structural change; remix posted from app.js).

**Tests**
- `test/instant.test.mjs` (modify) — `setRating`, `setNotes`, `itemOwnerProfileId`, `insertItem` remixOf.
- `test/auth.test.mjs` (modify) — `buildRequireUser`.
- `test/api.test.mjs` (modify) — split rating route, notes route, remix job.
- `test/runner.test.mjs` (modify) — remix `buildArgv`/`collectionFor`.
- `test/ratings.test.mjs` (create) — pure client rating helpers.
- `test/ratings-migrate.test.mjs` (create) — `planRatingMigration`.

---

## Task 1: Schema & permissions

**Files:**
- Modify: `instant.schema.ts`
- Modify: `instant.perms.ts`

**Interfaces:**
- Produces: `ratings` entity `{ namespace, slug, value, updatedAt }`; `ratingsProfile` link (`ratings.profile` has-one ↔ `profiles.ratings` has-many, cascade); item fields `ratingSum?`, `ratingCount?`, `remixOf?` (indexed). The legacy `rating` field stays until Task 10's migration runs.

- [ ] **Step 1: Add the new item fields to `itemFields` in `instant.schema.ts`**

In the `itemFields` object, after the `playCount` line add:

```ts
  ratingSum: i.number().optional(),   // sum of all users' ratings; absent ⇒ 0
  ratingCount: i.number().optional(), // number of users who rated; absent ⇒ 0
  remixOf: i.string().indexed().optional(), // source root slug when this item is a remix
```

Leave the existing `rating` field in place for now (Task 10 migrates then removes it).

- [ ] **Step 2: Add the `ratings` entity**

In `entities`, after the `plays` entity add:

```ts
    ratings: i.entity({
      namespace: i.string(),       // 'tracks' | 'stems'
      slug: i.string().indexed(),  // which item was rated
      value: i.number(),           // 1-5
      updatedAt: i.string(),       // ISO 8601
    }),
```

- [ ] **Step 3: Add the `ratingsProfile` link**

In `links`, after `playsProfile` add:

```ts
    ratingsProfile: {
      forward: { on: 'ratings', has: 'one', label: 'profile', onDelete: 'cascade' },
      reverse: { on: 'profiles', has: 'many', label: 'ratings' },
    },
```

- [ ] **Step 4: Add the `ratings` view rule + `lesson` field rule in `instant.perms.ts`**

Add a `ratings` block (a user sees only their own rating) and a `fields` rule on both collections hiding `lesson` from non-owners. Replace the `tracks` and `stems` blocks and add `ratings`:

```ts
  tracks: {
    allow: { view: ownerOrPublic, create: 'false', update: 'false', delete: 'false' },
    fields: { lesson: "auth.id != null && auth.id in data.ref('author.user.id')" },
  },
  stems: {
    allow: { view: ownerOrPublic, create: 'false', update: 'false', delete: 'false' },
    fields: { lesson: "auth.id != null && auth.id in data.ref('author.user.id')" },
  },
  ratings: {
    allow: {
      view: "auth.id != null && auth.id in data.ref('profile.user.id')",
      create: 'false',
      update: 'false',
      delete: 'false',
    },
  },
```

- [ ] **Step 5: Push schema and perms**

Load the app id + admin token from `.env` and push. Run:

```bash
set -a && . ./.env && set +a
npx instant-cli push schema --app "$INSTANT_APP_ID" --token "$INSTANT_ADMIN_TOKEN" --yes
npx instant-cli push perms --app "$INSTANT_APP_ID" --token "$INSTANT_ADMIN_TOKEN" --yes
```

Expected: both commands report success (schema adds `ratings`, the three item fields, and the link; perms update without error).

- [ ] **Step 6: Smoke-check the new namespace**

Run:

```bash
node -e "import('./scripts/lib/instant.mjs').then(async ({adminDb})=>{const r=await adminDb.query({ratings:{}});console.log('ratings rows:',r.ratings.length)})"
```

Expected: prints `ratings rows: 0` (namespace exists, empty).

- [ ] **Step 7: Commit**

```bash
git add instant.schema.ts instant.perms.ts
git commit -m "feat(schema): ratings entity, item aggregate + remixOf fields, lesson field perm"
```

---

## Task 2: `setRating` server helper + aggregate

**Files:**
- Modify: `server/instant.mjs`
- Test: `test/instant.test.mjs`

**Interfaces:**
- Consumes: `id` from `@instantdb/admin` (already imported in `server/instant.mjs`).
- Produces: `setRating(adminDb, namespace, slug, profileId, value) → { you, avg, count } | null`. `value` is an integer 1–5 to set/change, or `null` to clear. `avg` is `ratingSum/ratingCount` rounded to 1 decimal, or `null` when count is 0. Writes the item's `ratingSum`/`ratingCount` and upserts/deletes the caller's `ratings` row in one `transact`.

- [ ] **Step 1: Write the failing tests**

Add to `test/instant.test.mjs` (import `setRating` alongside the existing imports from `../server/instant.mjs`):

```js
import { setRating } from '../server/instant.mjs';

describe('setRating', () => {
  const seed = () => fakeAdmin({
    tracks: [{ id: 't1', slug: 'demo-01', ratingSum: 0, ratingCount: 0 }],
    profiles: [{ id: 'p1' }, { id: 'p2' }],
    ratings: [],
  });

  it('returns null for an unknown slug', async () => {
    const db = seed();
    expect(await setRating(db, 'tracks', 'nope', 'p1', 5)).toBe(null);
  });

  it('adds a first rating: count 0→1, sum=value', async () => {
    const db = seed();
    const out = await setRating(db, 'tracks', 'demo-01', 'p1', 4);
    expect(out).toEqual({ you: 4, avg: 4, count: 1 });
    const itemTx = db._txs.find((t) => t.ns === 'tracks');
    expect(itemTx.update).toEqual({ ratingSum: 4, ratingCount: 1 });
    const ratingTx = db._txs.find((t) => t.ns === 'ratings');
    expect(ratingTx.update).toMatchObject({ namespace: 'tracks', slug: 'demo-01', value: 4 });
    expect(ratingTx.link).toEqual({ profile: 'p1' });
  });

  it('changes an existing rating: sum adjusts, count unchanged', async () => {
    const db = fakeAdmin({
      tracks: [{ id: 't1', slug: 'demo-01', ratingSum: 4, ratingCount: 1 }],
      profiles: [{ id: 'p1' }],
      ratings: [{ id: 'r1', namespace: 'tracks', slug: 'demo-01', value: 4, profile: { id: 'p1' } }],
    });
    const out = await setRating(db, 'tracks', 'demo-01', 'p1', 2);
    expect(out).toEqual({ you: 2, avg: 2, count: 1 });
    const itemTx = db._txs.find((t) => t.ns === 'tracks');
    expect(itemTx.update).toEqual({ ratingSum: 2, ratingCount: 1 });
    const ratingTx = db._txs.find((t) => t.ns === 'ratings' && t.id === 'r1');
    expect(ratingTx.update).toMatchObject({ value: 2 });
  });

  it('clears a rating: count 1→0, sum back to 0, row deleted', async () => {
    const db = fakeAdmin({
      tracks: [{ id: 't1', slug: 'demo-01', ratingSum: 4, ratingCount: 1 }],
      profiles: [{ id: 'p1' }],
      ratings: [{ id: 'r1', namespace: 'tracks', slug: 'demo-01', value: 4, profile: { id: 'p1' } }],
    });
    const out = await setRating(db, 'tracks', 'demo-01', 'p1', null);
    expect(out).toEqual({ you: null, avg: null, count: 0 });
    const itemTx = db._txs.find((t) => t.ns === 'tracks');
    expect(itemTx.update).toEqual({ ratingSum: 0, ratingCount: 0 });
    const ratingTx = db._txs.find((t) => t.ns === 'ratings' && t.id === 'r1');
    expect(ratingTx.delete).toBe(true);
  });

  it('aggregates two distinct users', async () => {
    const db = fakeAdmin({
      tracks: [{ id: 't1', slug: 'demo-01', ratingSum: 5, ratingCount: 1 }],
      profiles: [{ id: 'p1' }, { id: 'p2' }],
      ratings: [{ id: 'r1', namespace: 'tracks', slug: 'demo-01', value: 5, profile: { id: 'p2' } }],
    });
    const out = await setRating(db, 'tracks', 'demo-01', 'p1', 4);
    expect(out).toEqual({ you: 4, avg: 4.5, count: 2 });
    const itemTx = db._txs.find((t) => t.ns === 'tracks');
    expect(itemTx.update).toEqual({ ratingSum: 9, ratingCount: 2 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/instant.test.mjs`
Expected: FAIL — `setRating is not a function`.

- [ ] **Step 3: Implement `setRating`**

In `server/instant.mjs` (it already imports `id` from `@instantdb/admin`), remove the `saveRating` function and add:

```js
// Set/clear the caller's rating for an item and maintain the denormalized
// aggregate (ratingSum/ratingCount) on the item. `value` is 1-5 to set, or null
// to clear. Computes the new aggregate from the currently-stored ratings plus
// this caller's delta (the row is upserted/deleted in the same transact).
// Returns { you, avg, count } or null when the slug doesn't exist.
export async function setRating(adminDb, namespace, slug, profileId, value) {
  const res = await adminDb.query({ [namespace]: { $: { where: { slug } } } });
  const item = res[namespace][0];
  if (!item) return null;

  const found = await adminDb.query({
    ratings: { $: { where: { namespace, slug, 'profile.id': profileId } } },
  });
  const existing = found.ratings[0];
  const prev = existing ? (existing.value ?? 0) : 0;

  let count = item.ratingCount ?? 0;
  let sum = item.ratingSum ?? 0;
  const txs = [];
  const now = new Date().toISOString();

  if (value == null) {
    if (existing) {
      sum -= prev;
      count -= 1;
      txs.push(adminDb.tx.ratings[existing.id].delete());
    }
  } else if (existing) {
    sum += value - prev;
    txs.push(adminDb.tx.ratings[existing.id].update({ value, updatedAt: now }));
  } else {
    sum += value;
    count += 1;
    txs.push(
      adminDb.tx.ratings[id()]
        .update({ namespace, slug, value, updatedAt: now })
        .link({ profile: profileId }),
    );
  }

  txs.push(adminDb.tx[namespace][item.id].update({ ratingSum: sum, ratingCount: count }));
  await adminDb.transact(txs);

  return {
    you: value == null ? null : value,
    avg: count ? Math.round((sum / count) * 10) / 10 : null,
    count,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/instant.test.mjs`
Expected: PASS (the new `setRating` block; note other tests in this file referencing `saveRating` will be fixed in Task 5 — if `saveRating` is imported there, temporarily expect those to fail until Task 5. If the file imports `saveRating`, comment that import now and the dependent test cases will move to Task 5.)

> Note: `saveRating` is also referenced in `server/app.mjs` (Task 5 rewrites that) and possibly in existing `test/instant.test.mjs` cases. If removing `saveRating` breaks an existing test in this file, delete those specific `saveRating` cases now — Task 5 covers the replacement route behavior end-to-end.

- [ ] **Step 5: Commit**

```bash
git add server/instant.mjs test/instant.test.mjs
git commit -m "feat(server): setRating helper with denormalized aggregate"
```

---

## Task 3: `setNotes` + `itemOwnerProfileId` helpers

**Files:**
- Modify: `server/instant.mjs`
- Test: `test/instant.test.mjs`

**Interfaces:**
- Produces:
  - `itemOwnerProfileId(adminDb, namespace, slug) → string | null` — the linked author's profile id (unwrapping the has-one list), or `null` if the item is unowned/missing.
  - `setNotes(adminDb, namespace, slug, { notes, lesson }) → { notes, lesson } | null` — patches the item's `notes`/`lesson` (only keys present in the argument), returns the merged values or `null` if the slug doesn't exist.

- [ ] **Step 1: Write the failing tests**

Add to `test/instant.test.mjs`:

```js
import { setNotes, itemOwnerProfileId } from '../server/instant.mjs';

describe('itemOwnerProfileId', () => {
  it('unwraps the has-one author list', async () => {
    const db = fakeAdmin({ tracks: [{ id: 't1', slug: 'demo-01', author: [{ id: 'p1' }] }] });
    expect(await itemOwnerProfileId(db, 'tracks', 'demo-01')).toBe('p1');
  });
  it('returns null when unowned', async () => {
    const db = fakeAdmin({ tracks: [{ id: 't1', slug: 'demo-01' }] });
    expect(await itemOwnerProfileId(db, 'tracks', 'demo-01')).toBe(null);
  });
  it('returns null for a missing item', async () => {
    const db = fakeAdmin({ tracks: [] });
    expect(await itemOwnerProfileId(db, 'tracks', 'nope')).toBe(null);
  });
});

describe('setNotes', () => {
  it('patches only the provided keys and echoes merged values', async () => {
    const db = fakeAdmin({ tracks: [{ id: 't1', slug: 'demo-01', notes: 'old', lesson: 'keep' }] });
    const out = await setNotes(db, 'tracks', 'demo-01', { notes: 'new' });
    expect(out).toEqual({ notes: 'new', lesson: 'keep' });
    const tx = db._txs.find((t) => t.ns === 'tracks');
    expect(tx.update).toEqual({ notes: 'new' });
  });
  it('returns null for a missing item', async () => {
    const db = fakeAdmin({ tracks: [] });
    expect(await setNotes(db, 'tracks', 'nope', { notes: 'x' })).toBe(null);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/instant.test.mjs`
Expected: FAIL — `setNotes is not a function` / `itemOwnerProfileId is not a function`.

- [ ] **Step 3: Implement the helpers**

In `server/instant.mjs` add:

```js
// The linked author's profile id (has-one comes back as a single-element list),
// or null when the item is unowned or missing.
export async function itemOwnerProfileId(adminDb, namespace, slug) {
  const res = await adminDb.query({ [namespace]: { author: {}, $: { where: { slug } } } });
  const item = res[namespace][0];
  return item?.author?.[0]?.id ?? null;
}

// Patch notes/lesson on the item (only the keys present in `patch`). Returns the
// merged { notes, lesson } or null when the slug doesn't exist. Caller is
// responsible for the owner check.
export async function setNotes(adminDb, namespace, slug, patch) {
  const res = await adminDb.query({ [namespace]: { $: { where: { slug } } } });
  const item = res[namespace][0];
  if (!item) return null;
  const update = {};
  if (patch.notes !== undefined) update.notes = patch.notes ?? '';
  if (patch.lesson !== undefined) update.lesson = patch.lesson ?? '';
  await adminDb.transact(adminDb.tx[namespace][item.id].update(update));
  return {
    notes: 'notes' in update ? update.notes : (item.notes ?? ''),
    lesson: 'lesson' in update ? update.lesson : (item.lesson ?? ''),
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/instant.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/instant.mjs test/instant.test.mjs
git commit -m "feat(server): setNotes + itemOwnerProfileId helpers"
```

---

## Task 4: `buildRequireUser` auth gate

**Files:**
- Modify: `server/auth.mjs`
- Test: `test/auth.test.mjs`

**Interfaces:**
- Produces: `buildRequireUser({ adminDb }) → middleware | undefined`. Verifies a Bearer token via `adminDb.auth.verifyToken`; on success attaches `req.user` and calls `next()`. **No allowlist** — any authenticated user passes. 401 on missing/non-Bearer/invalid token. Returns `undefined` (routes open) when `adminDb` is missing, matching `buildRequireAuth`.

- [ ] **Step 1: Write the failing tests**

Add to `test/auth.test.mjs` (reuses `mkRes`, `run`, `fakeAdmin` helpers already in the file):

```js
import { buildRequireUser } from '../server/auth.mjs';

describe('buildRequireUser', () => {
  it('returns undefined when adminDb is missing', () => {
    expect(buildRequireUser({ adminDb: null })).toBeUndefined();
  });
  it('401s with no Authorization header', async () => {
    const mw = buildRequireUser({ adminDb: fakeAdmin(async () => ({})) });
    const { res, nexted } = await run(mw, { headers: {} });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(401);
  });
  it('attaches req.user for ANY valid token (no allowlist)', async () => {
    const user = { id: 'u9', email: 'stranger@example.com' };
    const mw = buildRequireUser({ adminDb: fakeAdmin(async () => user) });
    const req = { headers: { authorization: 'Bearer good' } };
    const { nexted } = await run(mw, req);
    expect(nexted).toBe(true);
    expect(req.user).toEqual(user);
  });
  it('401s on an invalid token', async () => {
    const mw = buildRequireUser({ adminDb: fakeAdmin(async () => { throw new Error('bad'); }) });
    const { res, nexted } = await run(mw, { headers: { authorization: 'Bearer bad' } });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/auth.test.mjs`
Expected: FAIL — `buildRequireUser is not a function`.

- [ ] **Step 3: Implement `buildRequireUser`**

In `server/auth.mjs` add:

```js
// Lightweight gate for routes open to ANY logged-in user (e.g. rating): verify
// the Instant session token and attach req.user. No allowlist. Pass-through-less
// like buildRequireAuth: returns undefined (routes open) when adminDb is missing.
export function buildRequireUser({ adminDb }) {
  if (!adminDb) {
    console.warn('[crate] Instant auth not configured — user-gated routes are OPEN');
    return undefined;
  }
  return async (req, res, next) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'sign in required' });
    try {
      req.user = await adminDb.auth.verifyToken(token);
      next();
    } catch {
      return res.status(401).json({ error: 'invalid or expired session' });
    }
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/auth.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/auth.mjs test/auth.test.mjs
git commit -m "feat(server): buildRequireUser gate (any authenticated user)"
```

---

## Task 5: Rewrite the rating route (per-user + aggregate)

**Files:**
- Modify: `server/app.mjs`
- Test: `test/api.test.mjs`

**Interfaces:**
- Consumes: `setRating`, `ensureProfile` from `server/instant.mjs`; a `requireUser` middleware and `allowedEmails` array from `createApp` opts.
- Produces: `PUT /api/:ns/:id/rating` body `{ value: 1-5 | null }` → `200 { you, avg, count }`. Gate `requireUser`. Resolves the caller's profile via `ensureProfile(adminDb, req.user)`. `createApp(opts)` now accepts `opts.requireUser` (default open no-op) and `opts.allowedEmails` (default `[]`), threading `requireUser` into `collectionRoutes`.

- [ ] **Step 1: Write the failing tests**

In `test/api.test.mjs`, update the imports and `beforeEach` to seed `ratings` + a profile and pass `requireUser`, then add rating tests. Replace the existing `requireAuth` stub line and `beforeEach`/`describe('rating API')` block:

```js
const requireAuth = (req, _res, next) => { req.user = { id: 'u1', email: 'kalavox@gmail.com' }; next(); };
const requireUser = (req, _res, next) => { req.user = { id: 'u1', email: 'kalavox@gmail.com' }; next(); };

let app, adminDb;
beforeEach(() => {
  adminDb = fakeAdmin({
    tracks: [
      { id: 't1', slug: 'demo-01', ratingSum: 0, ratingCount: 0, notes: '', lesson: '', author: [{ id: 'p1', user: [{ id: 'u1' }] }] },
      { id: 't2', slug: 'rated-01', ratingSum: 5, ratingCount: 1, notes: '', lesson: '', author: [{ id: 'p9', user: [{ id: 'u9' }] }] },
    ],
    stems: [{ id: 's1', slug: 'stem-01', ratingSum: 0, ratingCount: 0, notes: '', lesson: '', author: [{ id: 'p1', user: [{ id: 'u1' }] }] }],
    profiles: [{ id: 'p1', user: [{ id: 'u1' }] }],
    ratings: [],
    plays: [],
  });
  app = createApp({ adminDb, namespaces: ['tracks', 'stems'], requireAuth, requireUser, allowedEmails: ['kalavox@gmail.com'] });
});

describe('rating API', () => {
  it('PUT /api/tracks/:id/rating records the caller rating + aggregate', async () => {
    const res = await request(app).put('/api/tracks/demo-01/rating').send({ value: 4 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ you: 4, avg: 4, count: 1 });
  });
  it('clears with value null', async () => {
    const res = await request(app).put('/api/tracks/demo-01/rating').send({ value: null });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
  });
  it('404s an unknown id', async () => {
    const res = await request(app).put('/api/tracks/missing/rating').send({ value: 5 });
    expect(res.status).toBe(404);
  });
  it('rejects out-of-range', async () => {
    const res = await request(app).put('/api/tracks/demo-01/rating').send({ value: 9 });
    expect(res.status).toBe(400);
  });
  it('rejects path-char ids', async () => {
    const res = await request(app).put('/api/tracks/..%2Fevil/rating').send({ value: 3 });
    expect(res.status).toBe(400);
  });
});
```

Delete the old rating-API cases that referenced `rating`/`notes`/`lesson` in the body (they are superseded by the split routes).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/api.test.mjs`
Expected: FAIL — route returns old shape / `setRating` not wired.

- [ ] **Step 3: Rewrite the route and `createApp` wiring**

In `server/app.mjs`:

1. Update the import line:

```js
import { setRating, setNotes, itemOwnerProfileId, ensureProfile, getProfile, setArtistName, recordPlay } from './instant.mjs';
```

2. Change `collectionRoutes` signature and the rating route:

```js
function collectionRoutes(app, name, adminDb, requireUser, resolveUser, playLimiter, allowedEmails) {
  app.put(`/api/${name}/:id/rating`, requireUser, wrap(async (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'invalid id' });
    const { value } = req.body ?? {};
    if (value != null && !(Number.isInteger(value) && value >= 1 && value <= 5)) {
      return res.status(400).json({ error: 'value must be an integer 1-5 or null' });
    }
    const profileId = await ensureProfile(adminDb, req.user);
    const out = await setRating(adminDb, name, id, profileId, value ?? null);
    if (!out) return res.status(404).json({ error: 'not found' });
    res.json(out);
  }));
```

(The `play` route in this function is unchanged.)

3. In `createApp`, after the existing `requireAuth`/`resolveUser` defaults add:

```js
  const requireUser = opts.requireUser ?? ((_req, _res, next) => next());
  const allowedEmails = opts.allowedEmails ?? [];
```

4. Update the `collectionRoutes` call site to pass the new args:

```js
    for (const name of namespaces) collectionRoutes(app, name, adminDb, requireUser, resolveUser, playLimiter, allowedEmails);
```

(`playLimiter` is the existing local in `createApp`; keep its current position. If the current call passes `requireAuth`, replace that argument with `requireUser`.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/api.test.mjs`
Expected: PASS for the rating block (notes/remix tests come in Tasks 6–7).

- [ ] **Step 5: Wire `requireUser` + `allowedEmails` in `server/index.mjs`**

In `server/index.mjs`, add the import and build the gate, then pass into `createApp`:

```js
import { buildRequireAuth, buildResolveUser, buildRequireUser } from './auth.mjs';
// ...after requireAuth/resolveUser are built:
const requireUser = buildRequireUser({ adminDb });
// ...in the createApp({ ... }) options object, add:
requireUser, allowedEmails,
```

(`allowedEmails` already exists as a local in `index.mjs`.)

- [ ] **Step 6: Commit**

```bash
git add server/app.mjs server/index.mjs test/api.test.mjs
git commit -m "feat(api): per-user rating route with aggregate (requireUser gate)"
```

---

## Task 6: Notes/lessons route (owner-gated)

**Files:**
- Modify: `server/app.mjs`
- Test: `test/api.test.mjs`

**Interfaces:**
- Consumes: `setNotes`, `itemOwnerProfileId`, `ensureProfile`; `requireUser`, `allowedEmails`.
- Produces: `PUT /api/:ns/:id/notes` body `{ notes?: string, lesson?: string }` → `200 { notes, lesson }`. Gate `requireUser` + owner check: 403 unless the caller's profile equals the item's author, OR the item is unowned and the caller's email is in `allowedEmails`. 404 unknown id, 400 bad body.

- [ ] **Step 1: Write the failing tests**

Add to `test/api.test.mjs`. The default `requireUser` stub above is user `u1`/profile `p1` (owner of `demo-01`). Add a helper to build an app as a different (non-owner) user:

```js
import { buildRequireUser } from '../server/auth.mjs'; // not used directly; stubs below

describe('notes API', () => {
  const asUser = (user, emails = ['kalavox@gmail.com']) =>
    createApp({ adminDb, namespaces: ['tracks', 'stems'],
      requireAuth, allowedEmails: emails,
      requireUser: (req, _res, next) => { req.user = user; next(); } });

  it('owner can write notes + lesson', async () => {
    const a = asUser({ id: 'u1', email: 'kalavox@gmail.com' });
    const res = await request(a).put('/api/tracks/demo-01/notes').send({ notes: 'tight', lesson: 'more swing' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ notes: 'tight', lesson: 'more swing' });
  });
  it('non-owner is forbidden', async () => {
    const a = asUser({ id: 'u9', email: 'stranger@example.com' });
    // u9 maps to a different profile; seed it so ensureProfile finds it
    adminDb._store.profiles.push({ id: 'p9', user: [{ id: 'u9' }] });
    const res = await request(a).put('/api/tracks/demo-01/notes').send({ notes: 'mine now' });
    expect(res.status).toBe(403);
  });
  it('404s unknown id', async () => {
    const a = asUser({ id: 'u1', email: 'kalavox@gmail.com' });
    const res = await request(a).put('/api/tracks/missing/notes').send({ notes: 'x' });
    expect(res.status).toBe(404);
  });
  it('rejects non-string notes', async () => {
    const a = asUser({ id: 'u1', email: 'kalavox@gmail.com' });
    const res = await request(a).put('/api/tracks/demo-01/notes').send({ notes: 42 });
    expect(res.status).toBe(400);
  });
});
```

> `ensureProfile` in `fakeAdmin` queries `profiles` by `user.id` and returns the seeded row's `id`; seed profile `p1`→`u1` (already in `beforeEach`) and `p9`→`u9` as shown so the owner comparison is meaningful. For the unowned-item fallback, the unit coverage is the 403 non-owner path; the allowlist-fallback branch is exercised in Step 3's logic and verified manually in Task 11.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/api.test.mjs`
Expected: FAIL — `/notes` route 404s as unknown route (not yet defined).

- [ ] **Step 3: Add the notes route**

In `server/app.mjs` `collectionRoutes`, after the rating route add:

```js
  app.put(`/api/${name}/:id/notes`, requireUser, wrap(async (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'invalid id' });
    const { notes, lesson } = req.body ?? {};
    if (notes != null && typeof notes !== 'string') return res.status(400).json({ error: 'notes must be a string' });
    if (lesson != null && typeof lesson !== 'string') return res.status(400).json({ error: 'lesson must be a string' });

    const owner = await itemOwnerProfileId(adminDb, name, id);
    if (owner === undefined) return res.status(404).json({ error: 'not found' });
    const callerProfile = await ensureProfile(adminDb, req.user);
    const email = req.user?.email?.toLowerCase();
    const isOwner = owner != null && owner === callerProfile;
    const isAdminOnUnowned = owner == null && email && allowedEmails.includes(email);
    if (!isOwner && !isAdminOnUnowned) return res.status(403).json({ error: 'not your song' });

    const out = await setNotes(adminDb, name, id, { notes, lesson });
    if (!out) return res.status(404).json({ error: 'not found' });
    res.json(out);
  }));
```

> `itemOwnerProfileId` returns `null` for both unowned and missing items. To distinguish a missing item (404) from an unowned one, rely on `setNotes` returning `null` for a missing slug — the final `if (!out) 404` covers the missing case, while the unowned+admin branch proceeds to `setNotes`. The `owner === undefined` line is dead given the helper's contract; replace it with a direct existence pre-check:

```js
    const exists = (await adminDb.query({ [name]: { $: { where: { slug: id } } } }))[name][0];
    if (!exists) return res.status(404).json({ error: 'not found' });
    const owner = await itemOwnerProfileId(adminDb, name, id);
```

Use this existence pre-check in place of the `owner === undefined` line.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/api.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/app.mjs test/api.test.mjs
git commit -m "feat(api): owner-gated notes/lessons route"
```

---

## Task 7: Remix job type (validation + enqueue)

**Files:**
- Modify: `server/jobs.mjs`
- Modify: `server/app.mjs`
- Test: `test/api.test.mjs`

**Interfaces:**
- Consumes: existing `requireAuth` (allowlist) on `POST /api/jobs`; `adminDb` for source existence check.
- Produces: `POST /api/jobs` accepts `{ type: 'remix', namespace: 'tracks'|'stems', slug, instructions }`. Validates namespace, `ID_RE` slug + existence, instructions 1–500 chars no `"`. Creates a job `{ ...base, type:'remix', prompt: instructions, sourceSlug: slug, collection: namespace, count: null }`. 201 with the job.

- [ ] **Step 1: Add `remix` to job types**

In `server/jobs.mjs`:

```js
export const JOB_TYPES = new Set([
  'generate-stems', 'generate-tracks', 'revise-from-notes', 'remix',
]);
```

- [ ] **Step 2: Write the failing tests**

Add to `test/api.test.mjs` (the jobs routes need a `jobStore` + `runner`; mirror the existing jobs test setup in this file — if jobs tests already exist here, reuse their app/jobStore. Otherwise build a minimal one):

```js
import { createJobStore } from '../server/jobs.mjs';

describe('remix jobs', () => {
  let jobApp, runner, store;
  beforeEach(async () => {
    store = createJobStore(await mkdtemp(join(tmpdir(), 'jobs-')));
    runner = { enqueue: async () => {} };
    jobApp = createApp({
      adminDb, namespaces: ['tracks', 'stems'], requireAuth, requireUser,
      allowedEmails: ['kalavox@gmail.com'], jobStore: store, runner,
    });
  });

  it('enqueues a remix job for an existing source', async () => {
    const res = await request(jobApp).post('/api/jobs')
      .send({ type: 'remix', namespace: 'tracks', slug: 'demo-01', instructions: 'make it darker' });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe('remix');
    expect(res.body.sourceSlug).toBe('demo-01');
    expect(res.body.collection).toBe('tracks');
    expect(res.body.prompt).toBe('make it darker');
  });
  it('400s an unknown source slug', async () => {
    const res = await request(jobApp).post('/api/jobs')
      .send({ type: 'remix', namespace: 'tracks', slug: 'nope', instructions: 'x' });
    expect(res.status).toBe(400);
  });
  it('400s a bad namespace', async () => {
    const res = await request(jobApp).post('/api/jobs')
      .send({ type: 'remix', namespace: 'songs', slug: 'demo-01', instructions: 'x' });
    expect(res.status).toBe(400);
  });
  it('400s instructions containing a double quote', async () => {
    const res = await request(jobApp).post('/api/jobs')
      .send({ type: 'remix', namespace: 'tracks', slug: 'demo-01', instructions: 'say "hi"' });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/api.test.mjs`
Expected: FAIL — remix branch missing; job lacks `sourceSlug`.

- [ ] **Step 4: Implement the remix branch + thread `adminDb` into `jobRoutes`**

In `server/app.mjs`:

1. Change `jobRoutes` to accept `adminDb`:

```js
function jobRoutes(app, jobStore, runner, progressFor, requireAuth, adminDb) {
```

2. In the `POST /api/jobs` handler, add a `remix` branch alongside the existing `revise-from-notes` / else branches:

```js
    let job;
    if (type === 'remix') {
      const { namespace, slug, instructions } = req.body ?? {};
      if (namespace !== 'tracks' && namespace !== 'stems') {
        return res.status(400).json({ error: 'namespace must be tracks or stems' });
      }
      if (!ID_RE.test(String(slug ?? ''))) return res.status(400).json({ error: 'invalid slug' });
      if (typeof instructions !== 'string' || !instructions.trim() || instructions.length > 500) {
        return res.status(400).json({ error: 'instructions required (1-500 chars)' });
      }
      if (instructions.includes('"')) return res.status(400).json({ error: 'instructions may not contain double quotes' });
      const exists = adminDb && (await adminDb.query({ [namespace]: { $: { where: { slug } } } }))[namespace][0];
      if (!exists) return res.status(400).json({ error: 'source not found' });
      job = { ...base, type: 'remix', prompt: instructions.trim(), count: null, collection: namespace, sourceSlug: slug };
    } else if (type === 'revise-from-notes') {
      // ...existing revise branch unchanged...
```

3. Update the `jobRoutes` call inside `createApp` to pass `adminDb`:

```js
  if (opts.jobStore && opts.runner) jobRoutes(app, opts.jobStore, opts.runner, opts.progressFor, requireAuth, adminDb);
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/api.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/jobs.mjs server/app.mjs test/api.test.mjs
git commit -m "feat(api): remix job type with source validation"
```

---

## Task 8: Runner remix command

**Files:**
- Modify: `server/runner.mjs`
- Test: `test/runner.test.mjs`

**Interfaces:**
- Consumes: a `remix` job `{ type:'remix', collection, sourceSlug, prompt }`.
- Produces: `collectionFor('remix', _, job)` resolves the job's `collection`; `buildArgv(remixJob)` yields `['-p', '/remix <collection> <sourceSlug> "<instructions>"', '--output-format', 'json', '--allowedTools', ALLOWED_TOOLS]`. The runner's `ALLOWED_TOOLS` permits `node scripts/remix-source.mjs`.

- [ ] **Step 1: Write the failing tests**

Add to `test/runner.test.mjs`:

```js
import { buildArgv } from '../server/runner.mjs';

describe('remix buildArgv', () => {
  it('builds the /remix command', () => {
    const argv = buildArgv({ type: 'remix', collection: 'tracks', sourceSlug: 'demo-01', prompt: 'darker, halftime' });
    expect(argv[0]).toBe('-p');
    expect(argv[1]).toBe('/remix tracks demo-01 "darker, halftime"');
  });
  it('strips double quotes defensively', () => {
    const argv = buildArgv({ type: 'remix', collection: 'stems', sourceSlug: 's-01', prompt: 'a "b" c' });
    expect(argv[1]).toBe('/remix stems s-01 "a b c"');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/runner.test.mjs`
Expected: FAIL — `buildArgv` produces the generic `/remix "<prompt>" undefined` form.

- [ ] **Step 3: Implement the remix branch**

In `server/runner.mjs`:

1. Extend `collectionFor` to honor a job collection for remix:

```js
export function collectionFor(type, prompt, collection) {
  if (type === 'remix') return collection;
  if (type === 'revise-from-notes') return prompt === 'stems' ? 'stems' : 'tracks';
  return COLLECTION_BY_TYPE[type];
}
```

2. Add a `remix` branch in `buildArgv` (the function receives the whole `job`):

```js
  const prompt = job.type === 'revise-from-notes'
    ? `/revise-from-notes ${safePrompt}`
    : job.type === 'remix'
      ? `/remix ${job.collection} ${job.sourceSlug} "${safePrompt}"`
      : `/${job.type} "${safePrompt}" ${job.count}`;
```

3. Add the remix-source script to `ALLOWED_TOOLS` (in the array):

```js
  'Bash(node scripts/remix-source.mjs:*)',
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/runner.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/runner.mjs test/runner.test.mjs
git commit -m "feat(runner): /remix command argv + tool allow"
```

---

## Task 9: `remix-source.mjs` + `insertItem` remixOf + `/remix` skill

**Files:**
- Modify: `server/instant.mjs`
- Create: `scripts/remix-source.mjs`
- Create: `.claude/skills/remix/SKILL.md`
- Test: `test/instant.test.mjs`

**Interfaces:**
- Produces:
  - `insertItem` persists `track.remixOf` when present (same pattern as `versionOf`).
  - `scripts/remix-source.mjs <namespace> <slug>` prints JSON `{ root, newId, namespace, title, batch, prompt, code, meta }` for the source item, where `root` = the source's `versionOf ?? slug` and `newId` is a fresh unused slug `<source-slug>-remix-NN`.
  - `.claude/skills/remix/SKILL.md` — single-item generation honoring instructions, writing `remixOf` + `prompt`.

- [ ] **Step 1: Write the failing test for `insertItem` remixOf**

Add to `test/instant.test.mjs`:

```js
import { insertItem } from '../server/instant.mjs';

describe('insertItem remixOf', () => {
  it('persists remixOf when present', async () => {
    const db = fakeAdmin({ tracks: [] });
    const track = { id: 'demo-01-remix-01', title: 't', prompt: 'darker', batch: 'b', description: 'd', code: 'c', meta: {}, createdAt: '2026-06-22T00:00:00Z', remixOf: 'demo-01' };
    const out = await insertItem(db, 'tracks', track, 'p1');
    expect(out.ok).toBe(true);
    const tx = db._txs.find((t) => t.ns === 'tracks');
    expect(tx.update.remixOf).toBe('demo-01');
    expect(tx.link).toEqual({ author: 'p1' });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/instant.test.mjs`
Expected: FAIL — `remixOf` absent from the recorded update.

- [ ] **Step 3: Persist `remixOf` in `insertItem`**

In `server/instant.mjs` `insertItem`, after the `if (track.versionOf) update.versionOf = track.versionOf;` line add:

```js
  if (track.remixOf) update.remixOf = track.remixOf;
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/instant.test.mjs`
Expected: PASS.

- [ ] **Step 5: Create `scripts/remix-source.mjs`**

```js
// scripts/remix-source.mjs <tracks|stems> <slug>
// Print the source item + a fresh newId for the /remix skill, as JSON.
import { fileURLToPath } from 'node:url';

export function nextRemixId(sourceSlug, existingSlugs) {
  for (let n = 1; n < 100; n++) {
    const candidate = `${sourceSlug}-remix-${String(n).padStart(2, '0')}`;
    if (!existingSlugs.includes(candidate)) return candidate;
  }
  throw new Error('too many remixes');
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const { adminDb } = await import('./lib/instant.mjs');
  const ns = process.argv[2] === 'stems' ? 'stems' : 'tracks';
  const slug = process.argv[3];
  const res = await adminDb.query({ [ns]: { $: { where: { slug } } } });
  const item = res[ns][0];
  if (!item) { console.error(`source not found: ${ns}/${slug}`); process.exit(1); }
  const all = await adminDb.query({ [ns]: {} });
  const newId = nextRemixId(slug, all[ns].map((r) => r.slug));
  console.log(JSON.stringify({
    root: item.versionOf ?? item.slug,
    newId, namespace: ns,
    title: item.title, batch: item.batch, prompt: item.prompt,
    code: item.code, meta: item.meta,
  }, null, 2));
}
```

- [ ] **Step 6: Add a unit test for `nextRemixId`**

Create `test/remix-source.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { nextRemixId } from '../scripts/remix-source.mjs';

describe('nextRemixId', () => {
  it('picks 01 when none exist', () => {
    expect(nextRemixId('demo-01', ['demo-01'])).toBe('demo-01-remix-01');
  });
  it('skips taken numbers', () => {
    expect(nextRemixId('demo-01', ['demo-01', 'demo-01-remix-01', 'demo-01-remix-02'])).toBe('demo-01-remix-03');
  });
});
```

Run: `npx vitest run test/remix-source.test.mjs` → Expected: PASS.

- [ ] **Step 7: Create `.claude/skills/remix/SKILL.md`**

```markdown
---
name: remix
description: Generate a new remix of one existing stem/track honoring the remixer's instructions, owned by the remixer and linked to the source via remixOf. Never touches the original. Args: <stems|tracks> <slug> "<instructions>"
---

# Remix

Produce ONE new item: a remix of an existing stem/track that honors the
remixer's instructions. The new item is a fresh row owned by the remixer (via
CRATE_AUTHOR_PROFILE_ID) and carries `remixOf` = the source's root slug. The
original is read-only input — never edit or overwrite it.

## Workflow

1. **Parse args:** `<collection> <slug> "<instructions>"`. Collection is `stems`
   or `tracks`. Set guide/singular/save script:
   - stems → guide `STEMS_GUIDE.md`, singular `STEM`, save `save-stem.mjs`
   - tracks → guide `STRUDEL_GUIDE.md`, singular `TRACK`, save `save-track.mjs`

2. **Read the guide** (`STEMS_GUIDE.md` or `STRUDEL_GUIDE.md`) COMPLETELY and
   follow every rule in it.

3. **Get the source + new id:** run
   `node scripts/remix-source.mjs <collection> <slug>`. It prints JSON
   `{ root, newId, namespace, title, batch, prompt, code, meta }`. If it errors
   (source not found), report that and STOP.

4. **Get a timestamp:** `date -u +%Y-%m-%dT%H:%M:%SZ`.

5. **Run `pwd`** to get the absolute repo root; use it for every path below.

6. **Write the remix:** revise the source `code` to honor the instructions while
   keeping it a coherent {singular}. Change enough to genuinely realize the
   instructions; do not just copy. Run `mkdir -p staging`, then write
   `<repo root>/staging/{newId}.json` with ALL required fields PLUS the remix link:
   - id `{newId}`, remixOf `{root}`, batch `{batch}`, prompt `"<instructions>"`,
     title `{title} (remix)`, createdAt `{timestamp}`,
   - description (1-3 sentences: the sound and how this remix realizes the
     instructions),
   - meta (the full required meta object per the guide),
   - code (your revised Strudel code).

7. **Validate + save:** run `node scripts/{save_script} staging/{newId}.json`.
   On FAIL read the reason, fix the file (grep `scripts/sounds.json` for unknown
   sounds), re-run — up to 3 attempts. If still failing, `rm staging/{newId}.json`.
   On PASS the remix is live and owned by the remixer.

8. **Report** exactly one line:
   `OK {newId} "{title} (remix)"`  — or —  `FAILED {newId} <one-line reason>`

## Notes

- The save script is the contract: it validates AND persists with the remixer as
  author (CRATE_AUTHOR_PROFILE_ID), setting remixOf so the item shows a "remixed
  from" backlink. The source row is never modified.
- Never edit `scripts/sounds.json` to make a file pass — change the file.
```

- [ ] **Step 8: Commit**

```bash
git add server/instant.mjs scripts/remix-source.mjs .claude/skills/remix/SKILL.md test/instant.test.mjs test/remix-source.test.mjs
git commit -m "feat(remix): remix-source script, insertItem remixOf, /remix skill"
```

---

## Task 10: Ratings migration (legacy `rating` → per-user rows + aggregate)

**Files:**
- Create: `src/ratings-migrate.js`
- Create: `scripts/migrate-ratings.mjs`
- Test: `test/ratings-migrate.test.mjs`

**Interfaces:**
- Produces: `planRatingMigration(items) → { creates, patches }` where each `item` is `{ slug, rating, authorProfileId, createdAt }`. `creates` = `[{ slug, value, profileId, updatedAt }]` (only for items with a rating AND an author). `patches` = `[{ slug, ratingSum, ratingCount }]` for every item with a non-null rating (count 1, sum = rating) — so legacy scores show even when unowned.

- [ ] **Step 1: Write the failing test**

Create `test/ratings-migrate.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { planRatingMigration } from '../src/ratings-migrate.js';

describe('planRatingMigration', () => {
  it('creates a per-user row + aggregate for an owned rated item', () => {
    const { creates, patches } = planRatingMigration([
      { slug: 'a', rating: 5, authorProfileId: 'p1', createdAt: '2026-01-01T00:00:00Z' },
    ]);
    expect(creates).toEqual([{ slug: 'a', value: 5, profileId: 'p1', updatedAt: '2026-01-01T00:00:00Z' }]);
    expect(patches).toEqual([{ slug: 'a', ratingSum: 5, ratingCount: 1 }]);
  });
  it('seeds aggregate but no row for an unowned rated item', () => {
    const { creates, patches } = planRatingMigration([
      { slug: 'b', rating: 3, authorProfileId: null, createdAt: 'x' },
    ]);
    expect(creates).toEqual([]);
    expect(patches).toEqual([{ slug: 'b', ratingSum: 3, ratingCount: 1 }]);
  });
  it('ignores unrated items', () => {
    const { creates, patches } = planRatingMigration([{ slug: 'c', rating: null, authorProfileId: 'p1' }]);
    expect(creates).toEqual([]);
    expect(patches).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/ratings-migrate.test.mjs`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `planRatingMigration`**

Create `src/ratings-migrate.js`:

```js
// Pure planner for the legacy rating → ratings migration. See the migration
// script for the side-effecting runner.
export function planRatingMigration(items) {
  const creates = [];
  const patches = [];
  for (const it of items) {
    if (it.rating == null) continue;
    patches.push({ slug: it.slug, ratingSum: it.rating, ratingCount: 1 });
    if (it.authorProfileId) {
      creates.push({ slug: it.slug, value: it.rating, profileId: it.authorProfileId, updatedAt: it.createdAt });
    }
  }
  return { creates, patches };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/ratings-migrate.test.mjs`
Expected: PASS.

- [ ] **Step 5: Implement the migration runner**

Create `scripts/migrate-ratings.mjs`:

```js
// One-off: backfill ratings rows + item aggregates from the legacy `rating`
// field, for both collections. Idempotent-ish: re-running re-creates rows, so
// run once. Usage: node scripts/migrate-ratings.mjs
import { id } from '@instantdb/admin';
import { adminDb } from './lib/instant.mjs';
import { planRatingMigration } from '../src/ratings-migrate.js';

for (const ns of ['tracks', 'stems']) {
  const res = await adminDb.query({ [ns]: { author: {} } });
  const items = res[ns].map((r) => ({
    slug: r.slug, rating: r.rating ?? null,
    authorProfileId: r.author?.[0]?.id ?? null,
    createdAt: r.createdAt,
    _id: r.id,
  }));
  const bySlug = new Map(items.map((it) => [it.slug, it._id]));
  const { creates, patches } = planRatingMigration(items);

  const txs = [];
  for (const c of creates) {
    txs.push(adminDb.tx.ratings[id()]
      .update({ namespace: ns, slug: c.slug, value: c.value, updatedAt: c.updatedAt })
      .link({ profile: c.profileId }));
  }
  for (const p of patches) {
    txs.push(adminDb.tx[ns][bySlug.get(p.slug)].update({ ratingSum: p.ratingSum, ratingCount: p.ratingCount }));
  }
  if (txs.length) await adminDb.transact(txs);
  console.log(`${ns}: ${creates.length} ratings rows, ${patches.length} aggregates`);
}
```

- [ ] **Step 6: Run the migration**

```bash
node scripts/migrate-ratings.mjs
```

Expected: prints a per-collection summary. Then spot-check:

```bash
node -e "import('./scripts/lib/instant.mjs').then(async ({adminDb})=>{const r=await adminDb.query({ratings:{}});console.log('ratings:',r.ratings.length)})"
```

- [ ] **Step 7: Remove the legacy `rating` field from the schema**

In `instant.schema.ts`, delete the `rating: i.number().optional(),` line from `itemFields`, and remove `rating: track.rating ?? null,` from `insertItem` in `server/instant.mjs`. Push:

```bash
set -a && . ./.env && set +a
npx instant-cli push schema --app "$INSTANT_APP_ID" --token "$INSTANT_ADMIN_TOKEN" --yes
```

Expected: schema push drops the `rating` attribute.

- [ ] **Step 8: Commit**

```bash
git add src/ratings-migrate.js scripts/migrate-ratings.mjs test/ratings-migrate.test.mjs instant.schema.ts server/instant.mjs
git commit -m "feat: migrate legacy rating into per-user ratings + drop the field"
```

---

## Task 11: Client — rating control, aggregate badge, subscription, filters

**Files:**
- Create: `src/ratings.js`
- Test: `test/ratings.test.mjs`
- Modify: `src/app.js`

**Interfaces:**
- Consumes: `state.myRatings` (slug→value map from the caller's `ratings` subscription); `track.ratingSum`/`track.ratingCount` from each item row.
- Produces:
  - `src/ratings.js`: `aggregateAvg(item)`, `isTopAggregate(item)`, `myRatingOf(state, slug)`.
  - Rating control bound to the caller's own rating; an aggregate badge `★ {avg} · {count}`; `unrated`/`top` filters per spec.

- [ ] **Step 1: Write the failing test for the pure helpers**

Create `test/ratings.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { aggregateAvg, isTopAggregate, myRatingOf } from '../src/ratings.js';

describe('ratings helpers', () => {
  it('aggregateAvg rounds to one decimal, null when no ratings', () => {
    expect(aggregateAvg({ ratingSum: 9, ratingCount: 2 })).toBe(4.5);
    expect(aggregateAvg({ ratingSum: 0, ratingCount: 0 })).toBe(null);
    expect(aggregateAvg({})).toBe(null);
  });
  it('isTopAggregate is true at avg >= 4 with at least one rating', () => {
    expect(isTopAggregate({ ratingSum: 8, ratingCount: 2 })).toBe(true);
    expect(isTopAggregate({ ratingSum: 7, ratingCount: 2 })).toBe(false);
    expect(isTopAggregate({ ratingSum: 0, ratingCount: 0 })).toBe(false);
  });
  it('myRatingOf reads the per-user map', () => {
    expect(myRatingOf({ myRatings: { a: 3 } }, 'a')).toBe(3);
    expect(myRatingOf({ myRatings: {} }, 'a')).toBe(null);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/ratings.test.mjs`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/ratings.js`**

```js
// Pure helpers for per-user ratings + the denormalized aggregate.
export function aggregateAvg(item) {
  const count = item?.ratingCount ?? 0;
  if (!count) return null;
  return Math.round(((item.ratingSum ?? 0) / count) * 10) / 10;
}
export function isTopAggregate(item) {
  const avg = aggregateAvg(item);
  return avg != null && avg >= 4;
}
export function myRatingOf(state, slug) {
  return state?.myRatings?.[slug] ?? null;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/ratings.test.mjs`
Expected: PASS.

- [ ] **Step 5: Rewrite `putRating` + the rating control in `src/app.js`**

At the top of `src/app.js` add the import:

```js
import { aggregateAvg, isTopAggregate, myRatingOf } from './ratings.js';
```

Replace `putRating` (the `// --- ratings ---` block) with a per-user version that posts `{ value }` and updates local state from the response:

```js
  async function putRating(track, value) {
    const res = await fetch(`/api/${namespace}/${track.id}/rating`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });
    if (!res.ok) throw new Error(`save failed: ${res.status}`);
    const saved = await res.json(); // { you, avg, count }
    state.myRatings = { ...state.myRatings, [track.id]: saved.you };
    track.ratingSum = saved.count ? Math.round(saved.avg * saved.count) : 0;
    track.ratingCount = saved.count;
  }
```

Replace the rating-control render block (the `const rate = ...; for (let n=1;n<=5;n++)` section) with a control bound to the caller's own rating plus an aggregate badge:

```js
      const rate = document.createElement('div');
      rate.className = 'rate';
      const mine = myRatingOf(state, track.id);
      const signedIn = !!myProfileId;
      for (let n = 1; n <= 5; n++) {
        const b = document.createElement('button');
        b.className = 'block' + (mine != null && n <= mine ? ' on' : '');
        b.title = signedIn ? `${n}/5` : 'sign in to rate';
        b.disabled = !signedIn;
        b.addEventListener('click', async () => {
          const cur = myRatingOf(state, track.id);
          try {
            await putRating(track, cur === n ? null : n);
          } catch (err) { console.error(err); flashError(card); return; }
          renderTracks();
        });
        rate.appendChild(b);
      }
      const badge = document.createElement('span');
      badge.className = 'agg';
      const avg = aggregateAvg(track);
      badge.textContent = avg != null ? `★ ${avg} · ${track.ratingCount}` : 'unrated';
      badge.title = avg != null ? `${track.ratingCount} rating(s)` : 'no ratings yet';
      rate.appendChild(badge);
```

- [ ] **Step 6: Add the `ratings` subscription + filters**

In `src/app.js`, initialize `state.myRatings = {}` where `state` is created (next to `state.playsBySlug`). In the `onUser` block, alongside the plays subscription, add a ratings subscription keyed by the resolved profile id (mirror the plays pattern):

```js
              const ratingsUnsub = db.subscribeQuery(
                { ratings: { $: { where: { 'profile.id': pid, namespace } } } },
                (r) => {
                  const map = {};
                  for (const rr of r.data?.ratings ?? []) map[rr.slug] = rr.value;
                  state.myRatings = map;
                  renderTracks();
                },
              );
```

Track and clean up `ratingsUnsub` the same way `playsUnsub` is tracked (add a `stopRatings` analogous to `stopPlays`, call it where `stopPlays()` is called, and reset `state.myRatings = {}` on sign-out).

Update the two filters (the `state.filter === 'unrated'` / `'top'` lines):

```js
      if (state.filter === 'unrated') return myRatingOf(state, t.id) == null;
      if (state.filter === 'top') return isTopAggregate(t);
```

- [ ] **Step 7: Verify the build + helper tests**

Run:

```bash
npx vitest run test/ratings.test.mjs
npm run build
```

Expected: tests PASS; build succeeds (no missing-import errors).

- [ ] **Step 8: Commit**

```bash
git add src/ratings.js src/app.js test/ratings.test.mjs
git commit -m "feat(client): per-user rating control + aggregate badge + filters"
```

---

## Task 12: Client — owner-gated notes/lessons

**Files:**
- Modify: `src/app.js`
- Modify: `src/song.js`

**Interfaces:**
- Consumes: each item's `author` (has-one list → `[0].id`) vs `myProfileId`; a `putNotes` POSTing to `/api/:ns/:id/notes`.
- Produces: editable notes/lesson textareas only for the owner; read-only "creator's notes" (notes only) for everyone else on the song page.

- [ ] **Step 1: Add `putNotes` and gate the textareas in `src/app.js`**

Add a `putNotes` helper next to `putRating`:

```js
  async function putNotes(track, patch) {
    const res = await fetch(`/api/${namespace}/${track.id}/notes`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`save failed: ${res.status}`);
    const saved = await res.json();
    track.notes = saved.notes;
    track.lesson = saved.lesson;
  }
```

In the `autosaveArea` helper, change the save call from `putRating(track, { [field]: ta.value })` to `putNotes(track, { [field]: ta.value })`.

Wrap the two `autosaveArea(...)` calls (notes + lesson) so they only render for the owner. Compute ownership where the card is built:

```js
      const ownerId = track.author?.[0]?.id ?? null;
      const isOwner = myProfileId != null && ownerId === myProfileId;
      if (isOwner) {
        meta.appendChild(autosaveArea('notes', 'notes — what works, what to change… (this track only)', track.notes, 'notes'));
        meta.appendChild(autosaveArea('notes lesson', 'lesson for future tracks — applies to every new batch…', track.lesson, 'lesson'));
      }
```

(Adjust to match the existing append pattern; the key change is the `if (isOwner)` gate. The subscription query already includes `author: {}`, so `track.author` is present — verify `mapRow` preserves it; if `mapRow` strips fields, add `author` to its output.)

- [ ] **Step 2: Verify `mapRow` carries `author`, `ratingSum`, `ratingCount`, `remixOf`**

Read `mapRow` in `src/app.js`. Ensure the returned object includes `author`, `ratingSum`, `ratingCount`, and `remixOf` (add them if `mapRow` allowlists fields). These are needed by the owner gate, aggregate badge, and backlink.

- [ ] **Step 3: Show read-only creator's notes on the song page (`src/song.js`)**

In `src/song.js`, where the song metadata renders, add a read-only notes block when `item.notes` is non-empty (the song page is public; lessons are NOT shown):

```js
  if (item.notes) {
    const notes = document.createElement('p');
    notes.className = 'creator-notes';
    notes.textContent = item.notes;
    // prepend a small label
    const label = document.createElement('span');
    label.className = 'creator-notes-label';
    label.textContent = "creator's notes";
    container.appendChild(label);
    container.appendChild(notes);
  }
```

(Match `song.js`'s existing element-creation style and the actual container variable name.)

- [ ] **Step 4: Verify the build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/app.js src/song.js
git commit -m "feat(client): owner-only notes/lessons + public creator's notes on song page"
```

---

## Task 13: Client — remix entry point + backlink

**Files:**
- Modify: `src/app.js`
- Modify: `src/song.js`

**Interfaces:**
- Consumes: `POST /api/jobs { type:'remix', namespace, slug, instructions }` (carries the bearer token via the patched `fetch`); the jobs UI for progress.
- Produces: a "Remix" action on each card (shown under the same gate as the generate panel) that prompts for instructions and posts a remix job; a "remixed from \<original\>" backlink wherever `remixOf` is set.

- [ ] **Step 1: Add a Remix button to each card in `src/app.js`**

Next to the existing share button in the export row, add a remix button. Gate it on the same signal that reveals the generate panel (the generate panel is mounted via `jobs-ui.js`; reuse its visibility — e.g. only show when `#gen-prompt` exists / the user is allowlisted). Minimal version: show for signed-in users and let the server 403 non-allowlisted, but prefer gating on the generate panel's presence:

```js
      if (document.querySelector('#gen-prompt')) { // generate panel present ⇒ allowlisted UI
        const remixBtn = document.createElement('button');
        remixBtn.className = 'export remix';
        remixBtn.textContent = '⎋ remix';
        remixBtn.title = 'remix this into a new song you own';
        remixBtn.addEventListener('click', async () => {
          const instructions = prompt(`Remix "${track.title}" — describe the changes:`);
          if (!instructions || !instructions.trim()) return;
          if (instructions.includes('"')) { flashError(card); return; }
          try {
            const res = await fetch('/api/jobs', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ type: 'remix', namespace, slug: track.id, instructions: instructions.trim() }),
            });
            if (!res.ok) { flashError(card); return; }
          } catch { flashError(card); }
        });
        exportRow.appendChild(remixBtn);
      }
```

- [ ] **Step 2: Render the "remixed from" backlink**

Where card metadata renders (and in `src/song.js`), when `track.remixOf` is set add a backlink to the source song page (the song page route is `/song/<slug>` — reuse `src/song-url.js` if it builds these):

```js
      if (track.remixOf) {
        const from = document.createElement('a');
        from.className = 'remix-from';
        from.href = `/song/${track.remixOf}`;
        from.textContent = `remixed from ${track.remixOf}`;
        meta.appendChild(from);
      }
```

(If `src/song-url.js` exposes a slug→URL helper, use it instead of the literal template.)

- [ ] **Step 3: Verify the build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Manual end-to-end verification (local)**

Run the full suite and a manual smoke against the dev server:

```bash
npx vitest run
```

Expected: entire suite PASS. Then manually (or via Playwright): sign in, rate a song (badge updates, your blocks fill), confirm a second account sees the aggregate move and its own blocks empty; as a non-owner confirm no notes textareas; trigger a remix and confirm a new item appears with a "remixed from" backlink and the original is unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/app.js src/song.js
git commit -m "feat(client): remix action + remixed-from backlink"
```

---

## Final verification

- [ ] Run the full test suite: `npx vitest run` — all green.
- [ ] Build: `npm run build` — succeeds.
- [ ] Confirm `instant.schema.ts` no longer has `rating`; `ratings` + aggregate + `remixOf` present.
- [ ] Confirm perms pushed: `ratings` view owner-only; `lesson` field hidden from non-owners.
- [ ] Deploy note (separate from this plan): merge the worktree branch into the main worktree's branch, run `npm run build`, then `sudo systemctl restart vimsical-crate`.
