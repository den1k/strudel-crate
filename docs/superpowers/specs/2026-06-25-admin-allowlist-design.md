# Admin-managed allowlist, stored in InstantDB

**Date:** 2026-06-25
**Status:** Approved design

## Problem

The email allowlist that gates who can generate music and rate is currently a
static env var (`CRATE_ALLOWED_EMAILS`), read once at server startup. Changing it
requires editing `.env` and restarting the service. We want the sole admin
(`kalavox@gmail.com`) to add/remove allowed emails himself from the app's user
settings, with the list persisted in InstantDB.

## Constraints discovered during design

- **All app writes currently route through the server admin SDK**, which is why
  every entity's perms are `create/update/delete: false`. The server is the
  enforcement point.
- **The headline gated action — generating tracks/stems — is not an InstantDB
  transaction.** `POST /api/jobs` spawns a `claude -p` subprocess
  (`server/app.mjs:163-165`); the server writes the resulting rows afterward.
  InstantDB permissions govern Instant reads/writes only, so they **cannot** gate
  a subprocess. Therefore the server must keep reading the allowlist to decide who
  can generate. Enforcement stays server-side by necessity.
- InstantDB permission rules can only use `data.ref` (refs from the row being
  written) and `auth.ref` (refs starting at `$user`) — **no arbitrary cross-entity
  queries**. The admin-email check needs neither, so *management* is fully solvable
  with permissions.

## Split of responsibilities

| Concern | Owner |
|---|---|
| **Store** the allowlist | InstantDB `allowlist` entity |
| **Manage** (admin add/remove) | InstantDB **permissions**, client-direct writes — no server route |
| **Enforce** on generate / profile / lessons | Server reads the Instant list (cached) |

## 1. Schema

New entity in `instant.schema.ts`:

```ts
allowlist: i.entity({
  email: i.string().unique().indexed(),  // always stored lowercased
  addedAt: i.string().indexed(),         // ISO 8601
  addedBy: i.string(),                   // admin email, for a light audit trail
}),
```

Standalone email rows — deliberately **not** linked to `$user` — so an email can be
allowed before that person has ever signed in (matching today's env-list behavior),
and so the server can match incoming auth emails directly.

## 2. Permissions

Add to `instant.perms.ts`. Management is pure InstantDB; only the admin's browser
can read or mutate the list:

```ts
allowlist: {
  allow: {
    view:   "auth.ref('$user.email')[0] == 'kalavox@gmail.com'",
    create: "auth.ref('$user.email')[0] == 'kalavox@gmail.com'",
    delete: "auth.ref('$user.email')[0] == 'kalavox@gmail.com'",
    update: "false",
  },
},
```

- The admin email is a **literal** here because CEL cannot import constants.
- The server uses the admin SDK, which bypasses permissions, so server reads are
  unaffected by the `view` restriction.
- `update` is `false`: the list is add/remove only.

## 3. Client UI

A new "access" section inside `mountProfileModal` in `src/auth.js`, rendered **only
when `currentUser.email === ADMIN_EMAIL`** (a hardcoded constant in `auth.js`).
Uses the existing vanilla `@instantdb/core` SDK:

- `db.subscribeQuery({ allowlist: {} })` → live-rendered list of allowed emails,
  each row with a remove (×) button.
- A text input + "add" button → lowercases + trims + validates the email, then
  `db.transact(db.tx.allowlist[id()].create({ email, addedAt, addedBy }))`.
- Remove → `db.transact(db.tx.allowlist[id].delete())`.
- The admin's own row renders **without** a remove button (can't lock yourself out
  from the UI).
- Non-admins never see the section; even a forged write is rejected by Instant's
  perms.

## 4. Server enforcement

`server/index.mjs` currently builds a static `allowedEmails` array from
`CRATE_ALLOWED_EMAILS`. Replace that with a small cached reader backed by the admin
SDK:

- Query the `allowlist` entity from Instant; cache the lowercased email set in
  memory with a **60s TTL**. New additions become effective within a minute;
  per-request latency stays ~0ms.
- `CRATE_ADMIN_EMAIL` (default `kalavox@gmail.com`) is **always** treated as
  allowed — a bootstrap so the admin can never be locked out even if the list is
  empty or a query fails.
- The existing gates (`buildRequireAuth`, `buildResolveUser` in `server/auth.mjs`)
  keep their shape but consult the cached set instead of a fixed array. The
  factories currently take `allowedEmails`; they will take an `isAllowed(email)`
  function (or equivalent provider) so the dynamic source is injected without
  changing call sites' intent.
- On a transient Instant query failure, the cache serves its last good value (and
  the admin is always allowed regardless), so enforcement degrades safely rather
  than locking everyone out.

## 5. Migration

One-time seed script (admin SDK, under `scripts/`):

- Read the current `CRATE_ALLOWED_EMAILS` (the existing emails, including the
  recently added `jakewrfoster@gmail.com`).
- Create an `allowlist` row per email (lowercased, `addedBy` = admin email),
  skipping any that already exist (idempotent on the unique `email`).

After seeding, **InstantDB is the single source of truth**. `CRATE_ALLOWED_EMAILS`
is retired from enforcement; only `CRATE_ADMIN_EMAIL` remains as the bootstrap.

## Decisions (locked)

1. **60s TTL cache** for the server read — not per-request querying. Bounded
   staleness, cheap.
2. **Admin email in 3 places** — perms CEL (required), `CRATE_ADMIN_EMAIL` on the
   server, `ADMIN_EMAIL` in the client. The value is stable; each use is small.
3. **Email-row model**, not role-linked-to-`$user`, so pre-signup emails work — at
   the cost that the enforcement read stays server-side (which it must be anyway,
   because generation is a subprocess).

## Testing

- **Perms:** a non-admin signed-in user cannot create or delete `allowlist` rows
  (Instant rejects); the admin can.
- **Server cache:** `isAllowed` reflects a freshly added email after the TTL; the
  admin email is allowed even when the list is empty; a simulated query failure
  falls back to the last good set rather than denying everyone.
- **Migration:** seeding is idempotent — re-running creates no duplicates.
- **Enforcement unchanged for existing routes:** `POST /api/jobs`, profile, and
  lessons still 403 for non-allowlisted emails and 200 for allowlisted ones.
- Existing server/auth unit tests adapt to the injected `isAllowed` provider.
```
