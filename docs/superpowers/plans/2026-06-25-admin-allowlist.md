# Admin-managed Allowlist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the sole admin (`kalavox@gmail.com`) add/remove allowed emails from the app's user settings, with the list stored in InstantDB and enforced server-side.

**Architecture:** The allowlist becomes an InstantDB `allowlist` entity. InstantDB **permissions** restrict create/delete to the admin, so his browser edits the list client-direct with no server route. The server keeps enforcing access on its routes (generation is a subprocess, not an Instant write, so it can't move to permissions) by reading the Instant list through a small 60s-TTL in-memory cache instead of the old env array.

**Tech Stack:** Node/Express server, `@instantdb/admin` (server), `@instantdb/core` (vanilla client), vitest, InstantDB CLI for schema/perms push.

## Global Constraints

- Admin email is `kalavox@gmail.com`, lowercased, used in three places: the perms CEL literal, `CRATE_ADMIN_EMAIL` (server, default `kalavox@gmail.com`), and `ADMIN_EMAIL` in `src/auth.js`.
- Emails are always stored and compared **lowercased + trimmed**.
- The admin is **always** treated as allowed by the server, even if absent from the list or if the Instant query fails (bootstrap — can never be locked out).
- Server read cache TTL: **60s**. On a transient query failure, serve the last good set.
- The `allowlist` entity is **not** linked to `$user` (standalone email rows), so pre-signup emails can be allowed.
- App id and admin token live in `/home/builder/apps/crate/.env` (`INSTANT_APP_ID`, `INSTANT_ADMIN_TOKEN`). App id: `3fd2fb5d-93ad-4af5-8367-e2190d17eae8`.
- Follow existing patterns: server factories are pure (no module-level env); client uses `db.subscribeQuery` / `db.transact` like `src/app.js`.

---

## File Structure

- `instant.schema.ts` — **modify**: add `allowlist` entity.
- `instant.perms.ts` — **modify**: add admin-only `allowlist` rules.
- `server/allowlist.mjs` — **create**: `createAllowlist({ adminDb, adminEmail, ttlMs, now })` → `{ isAllowed, refresh }`. The Instant-backed, cached, admin-always-allowed source of truth for the server.
- `server/auth.mjs` — **modify**: factories take `isAllowed` (async fn) instead of `allowedEmails` (array).
- `server/app.mjs` — **modify**: `createApp` / `collectionRoutes` take `isAllowed` instead of `allowedEmails`.
- `server/index.mjs` — **modify**: construct the provider from `adminDb` + `CRATE_ADMIN_EMAIL`, pass `isAllowed` everywhere.
- `src/email.js` — **create**: pure `normalizeEmail(raw)` helper (lowercase/trim/validate).
- `src/auth.js` — **modify**: admin-only "access" section in the profile modal; client-direct add/remove.
- `scripts/seed-allowlist.mjs` — **create**: one-time idempotent migration of the env list into Instant.
- Tests: `test/allowlist.test.mjs` (create), `test/email.test.mjs` (create), `test/auth.test.mjs` (modify), `test/api.test.mjs` (modify).

---

## Task 1: Schema + permissions for `allowlist`

**Files:**
- Modify: `instant.schema.ts` (entities block, after `ratings`)
- Modify: `instant.perms.ts` (rules object)

**Interfaces:**
- Produces: an `allowlist` Instant entity with `email` (unique, indexed string), `addedAt` (indexed string), `addedBy` (string); perms allowing only the admin to view/create/delete.

This task is InstantDB configuration. It has no vitest unit test; it is verified by a successful CLI push and a permission spot-check (a non-admin transaction is rejected).

- [ ] **Step 1: Add the entity to the schema**

In `instant.schema.ts`, inside `entities: { ... }` after the `ratings` entity (around line 59), add:

```ts
    allowlist: i.entity({
      email: i.string().unique().indexed(),  // lowercased
      addedAt: i.string().indexed(),          // ISO 8601
      addedBy: i.string(),                    // admin email, light audit trail
    }),
```

- [ ] **Step 2: Add the permission rules**

In `instant.perms.ts`, inside the `rules` object (after `profiles`), add:

```ts
  allowlist: {
    allow: {
      view: "auth.ref('$user.email')[0] == 'kalavox@gmail.com'",
      create: "auth.ref('$user.email')[0] == 'kalavox@gmail.com'",
      delete: "auth.ref('$user.email')[0] == 'kalavox@gmail.com'",
      update: "false",
    },
  },
```

- [ ] **Step 3: Push schema, then perms**

Run from the worktree root (token/app id are in `.env`):

```bash
set -a; . ./.env; set +a
npx instant-cli push schema --app "$INSTANT_APP_ID" --token "$INSTANT_ADMIN_TOKEN" --yes
npx instant-cli push perms  --app "$INSTANT_APP_ID" --token "$INSTANT_ADMIN_TOKEN" --yes
```

Expected: both commands report success; schema push lists `allowlist.email`, `allowlist.addedAt`, `allowlist.addedBy` as additions.

- [ ] **Step 4: Verify the entity exists**

Run:

```bash
set -a; . ./.env; set +a
node -e "import('@instantdb/admin').then(async ({init})=>{const db=init({appId:process.env.INSTANT_APP_ID,adminToken:process.env.INSTANT_ADMIN_TOKEN});console.log(JSON.stringify(await db.query({allowlist:{}})))})"
```

Expected: `{"allowlist":[]}` (empty list, no error — the entity is live).

- [ ] **Step 5: Commit**

```bash
git add instant.schema.ts instant.perms.ts
git commit -m "feat(crate): allowlist entity + admin-only perms"
```

---

## Task 2: Server allowlist provider (cached, Instant-backed)

**Files:**
- Create: `server/allowlist.mjs`
- Test: `test/allowlist.test.mjs`

**Interfaces:**
- Consumes: an admin-SDK-shaped object with `async query(q)` returning `{ allowlist: [{ email }, ...] }` (the real `adminDb`, or `fakeAdmin` in tests).
- Produces:
  - `createAllowlist({ adminDb, adminEmail, ttlMs = 60000, now = Date.now }) → { isAllowed, refresh }`
  - `isAllowed(email): Promise<boolean>` — lowercases input; returns `true` for the admin email always; otherwise refreshes the cache if older than `ttlMs` and returns whether the email is in the set. On query failure, keeps serving the last good set.
  - `refresh(): Promise<void>` — forces a re-query now.
  - If `adminDb` is null, `isAllowed` returns `true` only for the admin email (server runs degraded/open elsewhere; this keeps the admin working).

- [ ] **Step 1: Write the failing test**

Create `test/allowlist.test.mjs`:

```js
// test/allowlist.test.mjs — the cached, admin-always-allowed server allowlist.
import { describe, it, expect } from 'vitest';
import { createAllowlist } from '../server/allowlist.mjs';

const ADMIN = 'kalavox@gmail.com';

// adminDb stub: query() returns the current `rows`, counting calls. `fail`
// makes the next query throw, to exercise stale-serving.
function stubDb(rows) {
  const db = {
    queries: 0,
    fail: false,
    rows,
    async query() {
      db.queries++;
      if (db.fail) throw new Error('instant down');
      return { allowlist: db.rows };
    },
  };
  return db;
}

describe('createAllowlist', () => {
  it('always allows the admin email, without querying', async () => {
    const db = stubDb([]);
    const al = createAllowlist({ adminDb: db, adminEmail: ADMIN });
    expect(await al.isAllowed('KalaVox@Gmail.com')).toBe(true);
    expect(db.queries).toBe(0);
  });

  it('allows an email present in the Instant list', async () => {
    const db = stubDb([{ email: 'jakewrfoster@gmail.com' }]);
    const al = createAllowlist({ adminDb: db, adminEmail: ADMIN });
    expect(await al.isAllowed('JakeWRFoster@gmail.com')).toBe(true);
    expect(await al.isAllowed('stranger@example.com')).toBe(false);
  });

  it('caches within the TTL and refreshes after it expires', async () => {
    let t = 1000;
    const db = stubDb([{ email: 'a@x.com' }]);
    const al = createAllowlist({ adminDb: db, adminEmail: ADMIN, ttlMs: 100, now: () => t });
    expect(await al.isAllowed('a@x.com')).toBe(true); // first query
    expect(db.queries).toBe(1);
    db.rows = [{ email: 'b@x.com' }];
    await al.isAllowed('a@x.com');                    // still cached
    expect(db.queries).toBe(1);
    t = 1200;                                          // past TTL
    expect(await al.isAllowed('b@x.com')).toBe(true); // re-queried
    expect(db.queries).toBe(2);
  });

  it('serves the last good set when a refresh query fails', async () => {
    let t = 1000;
    const db = stubDb([{ email: 'a@x.com' }]);
    const al = createAllowlist({ adminDb: db, adminEmail: ADMIN, ttlMs: 100, now: () => t });
    expect(await al.isAllowed('a@x.com')).toBe(true);
    t = 2000; db.fail = true;
    expect(await al.isAllowed('a@x.com')).toBe(true); // stale-but-good
    expect(await al.isAllowed('nope@x.com')).toBe(false);
  });

  it('rejects everyone but the admin when adminDb is null', async () => {
    const al = createAllowlist({ adminDb: null, adminEmail: ADMIN });
    expect(await al.isAllowed(ADMIN)).toBe(true);
    expect(await al.isAllowed('a@x.com')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/allowlist.test.mjs`
Expected: FAIL — `createAllowlist` is not exported / module not found.

- [ ] **Step 3: Implement the provider**

Create `server/allowlist.mjs`:

```js
// server/allowlist.mjs
// The server's source of truth for "is this email allowed to generate/rate".
// Backed by the Instant `allowlist` entity, cached in memory with a short TTL so
// the hot auth path adds ~no latency. The admin email is ALWAYS allowed (bootstrap
// — can never be locked out), and a failed refresh serves the last good set rather
// than locking everyone out. Pure factory: no module-level env or side effects.
export function createAllowlist({ adminDb, adminEmail, ttlMs = 60000, now = Date.now }) {
  const admin = (adminEmail || '').toLowerCase();
  let set = new Set();      // lowercased allowed emails (excludes admin; admin is implicit)
  let loadedAt = -Infinity; // timestamp of the last successful load
  let inflight = null;      // dedupes concurrent refreshes

  async function load() {
    const { allowlist } = await adminDb.query({ allowlist: {} });
    set = new Set((allowlist ?? []).map((r) => (r.email || '').toLowerCase()).filter(Boolean));
    loadedAt = now();
  }

  async function ensureFresh() {
    if (!adminDb) return;
    if (now() - loadedAt < ttlMs) return;
    if (!inflight) {
      inflight = load()
        .catch(() => { /* keep last good set; retry next call past TTL */ loadedAt = now(); })
        .finally(() => { inflight = null; });
    }
    await inflight;
  }

  async function isAllowed(email) {
    const e = (email || '').toLowerCase();
    if (!e) return false;
    if (e === admin) return true;
    await ensureFresh();
    return set.has(e);
  }

  async function refresh() { loadedAt = -Infinity; await ensureFresh(); }

  return { isAllowed, refresh };
}
```

Note: on failure we set `loadedAt = now()` so we don't hammer Instant on every request during an outage; the next refresh happens one TTL later. The admin stays allowed throughout.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/allowlist.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/allowlist.mjs test/allowlist.test.mjs
git commit -m "feat(crate): cached Instant-backed allowlist provider"
```

---

## Task 3: Switch the auth gates from `allowedEmails` to `isAllowed`

**Files:**
- Modify: `server/auth.mjs` (`buildRequireAuth`, `buildResolveUser`)
- Test: `test/auth.test.mjs`

**Interfaces:**
- Consumes: `isAllowed: (email) => Promise<boolean>` from Task 2 (or a trivial inline stub in tests).
- Produces: `buildRequireAuth({ adminDb, isAllowed })` and `buildResolveUser({ adminDb, isAllowed })` — same return shape and behavior as before, but they `await isAllowed(email)` instead of `allowedEmails.includes(email)`. `buildRequireUser` is unchanged.

- [ ] **Step 1: Update the tests to the new signature (these are the failing tests)**

In `test/auth.test.mjs`, replace the `allow` constant and every `allowedEmails: allow` with an `isAllowed` stub. At the top, change:

```js
const allow = ['kalavox@gmail.com'];
```
to:
```js
// async allow-checker stub matching the real provider's contract
const mkAllow = (list) => async (e) => list.map((s) => s.toLowerCase()).includes((e || '').toLowerCase());
const isAllowed = mkAllow(['kalavox@gmail.com']);
```

Then replace every occurrence of `allowedEmails: allow` with `isAllowed` (there are several across the `buildRequireAuth` and `buildResolveUser` describe blocks). For the `buildResolveUser` block, do the same substitution.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/auth.test.mjs`
Expected: FAIL — `buildRequireAuth`/`buildResolveUser` still read `allowedEmails`, so allowlisted users are now rejected (or `isAllowed` is ignored).

- [ ] **Step 3: Update the factories**

In `server/auth.mjs`:

`buildRequireAuth` — change the signature and the check:
```js
export function buildRequireAuth({ adminDb, isAllowed }) {
```
```js
      const email = user?.email?.toLowerCase();
      if (!email || !(await isAllowed(email))) return res.status(403).json({ error: 'account not allowed' });
```

`buildResolveUser` — change the signature and the check:
```js
export function buildResolveUser({ adminDb, isAllowed }) {
```
```js
        const email = user?.email?.toLowerCase();
        if (email && (await isAllowed(email))) req.user = user;
```

Leave `buildRequireUser` untouched.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/auth.test.mjs`
Expected: PASS (all cases, including the case-insensitive and 403 cases).

- [ ] **Step 5: Commit**

```bash
git add server/auth.mjs test/auth.test.mjs
git commit -m "refactor(crate): auth gates consult isAllowed(email) provider"
```

---

## Task 4: Thread `isAllowed` through the app + wire the real provider

**Files:**
- Modify: `server/app.mjs` (`createApp`, `collectionRoutes`)
- Modify: `server/index.mjs`
- Test: `test/api.test.mjs`

**Interfaces:**
- Consumes: `isAllowed` from Task 2/3.
- Produces: `createApp({ ..., isAllowed })` (replaces the `allowedEmails` opt); `collectionRoutes(app, name, adminDb, requireUser, resolveUser, playLimiter, isAllowed)`.

- [ ] **Step 1: Update the API tests to the new option (failing tests)**

In `test/api.test.mjs`, replace each `allowedEmails: ['kalavox@gmail.com']` (and the `allowedEmails: emails` case around line 204) with an `isAllowed` stub. Add near the top of the file:

```js
const mkAllow = (list) => async (e) => list.map((s) => s.toLowerCase()).includes((e || '').toLowerCase());
```

Then:
- line ~25: `isAllowed: mkAllow(['kalavox@gmail.com'])`
- line ~171: `isAllowed: mkAllow(['kalavox@gmail.com'])`
- line ~204: `isAllowed: mkAllow(emails)`

- [ ] **Step 2: Run the API tests to verify they fail**

Run: `npx vitest run test/api.test.mjs`
Expected: FAIL — `createApp` still reads `opts.allowedEmails`, so the admin-on-unowned path mis-evaluates.

- [ ] **Step 3: Update `createApp` and `collectionRoutes`**

In `server/app.mjs`:

At the `createApp` options (around line 242), replace:
```js
  const allowedEmails = opts.allowedEmails ?? [];
```
with:
```js
  const isAllowed = opts.isAllowed ?? (async () => false);
```

Update the `collectionRoutes` call (around line 248) to pass `isAllowed` instead of `allowedEmails`:
```js
    for (const name of namespaces) collectionRoutes(app, name, adminDb, requireUser, resolveUser, playLimiter, isAllowed);
```

Change the `collectionRoutes` signature (line 29):
```js
function collectionRoutes(app, name, adminDb, requireUser, resolveUser, playLimiter, isAllowed) {
```

And the admin-on-unowned check (line 56) — note the handler is already `async`:
```js
    const isAdminOnUnowned = owner == null && email && (await isAllowed(email));
```

- [ ] **Step 4: Run the API tests to verify they pass**

Run: `npx vitest run test/api.test.mjs`
Expected: PASS.

- [ ] **Step 5: Wire the real provider in `server/index.mjs`**

In `server/index.mjs`:

Add the import near the other server imports (top of file):
```js
import { createAllowlist } from './allowlist.mjs';
```

Replace the static array (lines 19-20):
```js
const allowedEmails = (process.env.CRATE_ALLOWED_EMAILS ?? '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
```
with the provider (placed after `adminDb` is constructed, around line 26):
```js
const adminEmail = (process.env.CRATE_ADMIN_EMAIL ?? 'kalavox@gmail.com').toLowerCase();
const { isAllowed } = createAllowlist({ adminDb, adminEmail });
```

(Move the `adminEmail`/`createAllowlist` lines to AFTER the `const adminDb = ...` block, since the provider needs `adminDb`.)

Update the three consumers:
- line ~28: `const requireAuth = buildRequireAuth({ adminDb, isAllowed });`
- line ~29: `const resolveUser = buildResolveUser({ adminDb, isAllowed });`
- line ~58 (the `createApp({...})` opts): replace `allowedEmails,` with `isAllowed,`.

- [ ] **Step 6: Run the full server test suite**

Run: `npx vitest run test/auth.test.mjs test/api.test.mjs test/allowlist.test.mjs`
Expected: PASS across all three.

- [ ] **Step 7: Commit**

```bash
git add server/app.mjs server/index.mjs test/api.test.mjs
git commit -m "feat(crate): server reads allowlist from Instant via isAllowed provider"
```

---

## Task 5: One-time migration seed script

**Files:**
- Create: `scripts/seed-allowlist.mjs`

**Interfaces:**
- Consumes: `CRATE_ALLOWED_EMAILS`, `INSTANT_APP_ID`, `INSTANT_ADMIN_TOKEN` from `.env`.
- Produces: an `allowlist` row per env email (lowercased), idempotent — re-running creates no duplicates.

This script is verified by running it (and re-running it to confirm idempotency), not by a vitest unit (it is a one-shot operational script that talks to live Instant).

- [ ] **Step 1: Write the seed script**

Create `scripts/seed-allowlist.mjs`:

```js
// scripts/seed-allowlist.mjs
// One-time migration: copy the legacy CRATE_ALLOWED_EMAILS env list into the
// Instant `allowlist` entity. Idempotent — skips emails that already exist.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { init, id } from '@instantdb/admin';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(join(repoRoot, '.env')); } catch { /* env already set */ }

const { INSTANT_APP_ID, INSTANT_ADMIN_TOKEN } = process.env;
if (!INSTANT_APP_ID || !INSTANT_ADMIN_TOKEN) { console.error('missing Instant env'); process.exit(1); }

const adminEmail = (process.env.CRATE_ADMIN_EMAIL ?? 'kalavox@gmail.com').toLowerCase();
const emails = (process.env.CRATE_ALLOWED_EMAILS ?? '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const db = init({ appId: INSTANT_APP_ID, adminToken: INSTANT_ADMIN_TOKEN });

const { allowlist } = await db.query({ allowlist: {} });
const existing = new Set(allowlist.map((r) => (r.email || '').toLowerCase()));

const toAdd = emails.filter((e) => !existing.has(e));
if (toAdd.length === 0) { console.log('allowlist already seeded; nothing to do'); process.exit(0); }

const now = new Date().toISOString();
await db.transact(toAdd.map((email) => db.tx.allowlist[id()].update({ email, addedAt: now, addedBy: adminEmail })));
console.log(`seeded ${toAdd.length} email(s): ${toAdd.join(', ')}`);
```

- [ ] **Step 2: Run the seed**

```bash
node scripts/seed-allowlist.mjs
```

Expected: `seeded N email(s): ...` listing the current env emails (including `jakewrfoster@gmail.com`).

- [ ] **Step 3: Verify idempotency**

Run it again:

```bash
node scripts/seed-allowlist.mjs
```

Expected: `allowlist already seeded; nothing to do`.

- [ ] **Step 4: Verify the list in Instant**

```bash
set -a; . ./.env; set +a
node -e "import('@instantdb/admin').then(async ({init})=>{const db=init({appId:process.env.INSTANT_APP_ID,adminToken:process.env.INSTANT_ADMIN_TOKEN});const {allowlist}=await db.query({allowlist:{}});console.log(allowlist.map(r=>r.email).sort().join('\n'))})"
```

Expected: the six emails, one per line.

- [ ] **Step 5: Commit**

```bash
git add scripts/seed-allowlist.mjs
git commit -m "feat(crate): one-time allowlist seed from env list"
```

---

## Task 6: Client admin UI (email helper + access section)

**Files:**
- Create: `src/email.js`
- Test: `test/email.test.mjs`
- Modify: `src/auth.js`

**Interfaces:**
- Produces: `normalizeEmail(raw): string | null` — trims, lowercases, returns the email if it matches a basic `x@y.z` shape, else `null`.
- Consumes (client): `db.subscribeQuery({ allowlist: {...} })`, `db.transact(db.tx.allowlist[id()].create(...))`, `db.transact(db.tx.allowlist[rowId].delete())`, `id` from `@instantdb/core`.

- [ ] **Step 1: Write the failing email-helper test**

Create `test/email.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { normalizeEmail } from '../src/email.js';

describe('normalizeEmail', () => {
  it('lowercases and trims a valid email', () => {
    expect(normalizeEmail('  JakeWRFoster@Gmail.com ')).toBe('jakewrfoster@gmail.com');
  });
  it('returns null for malformed input', () => {
    expect(normalizeEmail('not-an-email')).toBeNull();
    expect(normalizeEmail('a@b')).toBeNull();
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/email.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `src/email.js`:

```js
// src/email.js — normalize/validate an email for the allowlist UI. Pure; no DOM.
const RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function normalizeEmail(raw) {
  const e = (raw || '').trim().toLowerCase();
  return RE.test(e) ? e : null;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/email.test.mjs`
Expected: PASS.

- [ ] **Step 5: Add the admin constant and imports to `src/auth.js`**

At the top of `src/auth.js`, add the imports and constant (alongside the existing imports):

```js
import { id } from '@instantdb/core';
import { normalizeEmail } from './email.js';

const ADMIN_EMAIL = 'kalavox@gmail.com';
```

- [ ] **Step 6: Add the access section markup**

In `mountProfileModal`, inside the `el.innerHTML` template, add a new section immediately before the `<button class="profile-signout">` line:

```html
      <section class="profile-access" hidden>
        <h3>access <span class="lessons-hint">— who can generate &amp; rate</span></h3>
        <ul class="access-list"></ul>
        <form class="access-add">
          <input type="email" name="email" placeholder="add email…" autocomplete="off" />
          <button type="submit" class="access-add-btn">add</button>
        </form>
      </section>
```

- [ ] **Step 7: Wire the access section logic**

Inside `mountProfileModal`, after the existing element lookups (near `const signOutBtn = ...`), add:

```js
  const accessSection = el.querySelector('.profile-access');
  const accessList = el.querySelector('.access-list');
  const accessAdd = el.querySelector('.access-add');
  let accessUnsub = null;

  function renderAllowlist(rows, adminEmail) {
    accessList.replaceChildren();
    for (const row of rows) {
      const li = document.createElement('li');
      li.className = 'access-row';
      const span = document.createElement('span');
      span.textContent = row.email;
      li.appendChild(span);
      if (row.email !== adminEmail) {          // can't remove yourself
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'access-del';
        del.setAttribute('aria-label', `remove ${row.email}`);
        del.textContent = '×';
        del.onclick = () => db.transact(db.tx.allowlist[row.id].delete());
        li.appendChild(del);
      }
      accessList.appendChild(li);
    }
  }

  function startAccessAdmin(adminEmail) {
    accessSection.hidden = false;
    if (accessUnsub) return;
    accessUnsub = db.subscribeQuery(
      { allowlist: { $: { order: { addedAt: 'desc' } } } },
      (res) => { if (res.data) renderAllowlist(res.data.allowlist ?? [], adminEmail); },
    );
  }

  function stopAccessAdmin() {
    accessSection.hidden = true;
    if (accessUnsub) { accessUnsub(); accessUnsub = null; }
    accessList.replaceChildren();
  }

  accessAdd.onsubmit = (e) => {
    e.preventDefault();
    const email = normalizeEmail(accessAdd.elements.email.value);
    if (!email) { flash(accessAdd.elements.email); return; }
    db.transact(db.tx.allowlist[id()].create({
      email, addedAt: new Date().toISOString(), addedBy: ADMIN_EMAIL,
    }));
    accessAdd.elements.email.value = '';
  };
```

(`flash` already exists in this module from the lessons UI; reuse it.)

- [ ] **Step 8: Toggle the section on open/close by admin identity**

In the `open` function of `mountProfileModal` (where `currentUser`/the passed user is available), add a check that shows the section only for the admin. Find where `open` sets up the modal for a user and add:

```js
    if ((user?.email || '').toLowerCase() === ADMIN_EMAIL) startAccessAdmin(ADMIN_EMAIL);
    else stopAccessAdmin();
```

In `close`, also call `stopAccessAdmin();` so the subscription is torn down when the modal closes.

- [ ] **Step 9: Build to verify it compiles**

Run: `npm run build`
Expected: build succeeds; no import/syntax errors.

- [ ] **Step 10: Manual verification (browser)**

Run the dev server (`npm run dev`) and, signed in as `kalavox@gmail.com`, open the profile modal:
- the "access" section is visible, listing the seeded emails;
- adding a valid email makes a row appear instantly (live query); an invalid email flashes the input and adds nothing;
- the × on a non-admin row removes it instantly; the admin's own row has no ×.
Sign in as a non-admin allowlisted account → the access section is absent.

- [ ] **Step 11: Commit**

```bash
git add src/email.js test/email.test.mjs src/auth.js
git commit -m "feat(crate): admin-only allowlist manager in profile modal"
```

---

## Task 7: Style the access section

**Files:**
- Modify: `src/style.css`

**Interfaces:** none (presentation only). Match the existing `.profile-lessons` / `.lessons-list` / `.lesson-del` styling so the new section feels native.

- [ ] **Step 1: Add styles**

In `src/style.css`, near the `.profile-lessons` rules, add styles for `.profile-access`, `.access-list`, `.access-row`, `.access-del`, and `.access-add` mirroring the lessons section (list spacing, row layout with the × button right-aligned, input + add-button row). Reuse existing design tokens/colors already used by `.lesson-del` and `.lesson-add`.

- [ ] **Step 2: Build and eyeball**

Run: `npm run build`
Expected: build succeeds. Visually confirm in the browser that the access list and add-row align with the lessons section above it (including at the ≤760px mobile width, per the profile-modal mobile rules already in the stylesheet).

- [ ] **Step 3: Commit**

```bash
git add src/style.css
git commit -m "style(crate): allowlist manager section styling"
```

---

## Task 8: Full verification + deploy

**Files:** none (operational).

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: all suites pass (the pre-existing flaky `seeds`/`runner` cases noted in repo memory may need the extended timeout; the allowlist/auth/api/email suites must pass clean).

- [ ] **Step 2: Confirm the env still carries the admin bootstrap**

`/home/builder/apps/crate/.env` should keep `CRATE_ALLOWED_EMAILS` (harmless now) and may add `CRATE_ADMIN_EMAIL=kalavox@gmail.com`. The server no longer enforces from `CRATE_ALLOWED_EMAILS`; Instant is the source of truth. (Leaving the env line in place is fine — it's only read by the seed script.)

- [ ] **Step 3: Deploy (per CLAUDE.md — live services run from the main worktree)**

Merge this branch into the main worktree's branch, rebuild, and restart:

```bash
# from the main worktree at /home/builder/apps/crate
git merge <this-branch> --no-edit
npm run build
sudo systemctl restart vimsical-crate.service
systemctl is-active vimsical-crate.service   # → active
```

(Schema + perms were already pushed in Task 1; the seed was run in Task 5. If deploying to a fresh Instant app, re-run both there.)

- [ ] **Step 4: Production smoke test**

- `https://crate.vimsical.com/` returns 200.
- Signed in as `kalavox@gmail.com`: the access section appears; add a throwaway email, confirm it appears, then remove it.
- A newly added email can sign in and the generate panel works within ~60s (the server cache TTL).
- A non-allowlisted email is still 403'd on generate.

---

## Self-Review notes

- **Spec coverage:** schema (Task 1), permissions/management-via-perms (Task 1 + Task 6 client-direct writes), client UI (Tasks 6-7), server cached enforcement with 60s TTL + admin bootstrap + stale-on-failure (Tasks 2-4), migration seed (Task 5), testing (each task + Task 8). All spec sections map to tasks.
- **Type/name consistency:** `isAllowed(email) => Promise<boolean>` is defined in Task 2 and consumed unchanged in Tasks 3-4; `createAllowlist` signature is stable; `normalizeEmail` defined in Task 6 Step 3 and used in Step 7; the entity fields `email`/`addedAt`/`addedBy` match across schema (Task 1), seed (Task 5), and client create (Task 6).
- **Admin email** literal `kalavox@gmail.com` appears exactly where the Global Constraints say (perms CEL, `CRATE_ADMIN_EMAIL`, client `ADMIN_EMAIL`).
