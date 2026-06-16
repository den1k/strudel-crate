# Tracks & Stems in InstantDB — Design

**Date:** 2026-06-16
**Status:** Approved (design)
**Repo:** `/home/builder/apps/crate` (strudel-ai / crate)

## Goal

Move tracks and stems out of on-disk JSON files and into InstantDB as the single
source of truth. Every track and stem is owned by an **author** (a user profile
with an artist name). All items are **public by default**, so anyone can browse
and play every public track/stem, and a signed-in user can additionally filter
to "mine". Add a **user profile** with an editable artist name shown alongside
the items that user generated.

## Decisions (locked in brainstorming)

1. **Full disk retirement.** Instant is the source of truth. The generation
   pipeline (skills, `validate.mjs`, `feedback.mjs`, `revise-from-notes`,
   `pending-revisions.mjs`) reads/writes Instant. A gitignored `staging/` dir is
   the only disk use during generation — ephemeral scratch for the validate step,
   deleted immediately after a successful transact.
2. **Client reads Instant directly** via `@instantdb/core` `subscribeQuery`
   (real-time, public reads enforced by permissions). The `GET /api/tracks` and
   `GET /api/stems` endpoints and the disk `listTracks` store are retired.
3. **All writes stay server-side** (admin SDK), preserving the existing
   `CRATE_ALLOWED_EMAILS` gate — Instant permissions can't read that env list, so
   keeping writes on the server keeps one consistent gate.
4. **Existing data → kalavox.** A one-time migration imports the ~65 tracks +
   ~91 stems and their disk ratings, linked to kalavox's profile, `isPublic: true`.
5. **Stay vanilla JS.** No framework rewrite; `@instantdb/core` + `subscribeQuery`.
6. **Two entities** (`tracks`, `stems`), not one `items` entity with a `kind`
   field — cleaner per-namespace queries and permissions, and the existing client
   and server code already parameterize cleanly over a namespace string.

## Data model

There is currently **no** `instant.schema.ts` (Instant is used only for auth).
We create the schema and permissions and push them.

### Entities

```
$users (built-in)   — email (private, default perms)

profiles
  artistName : string  (indexed)
  createdAt  : string  (ISO; indexed)

tracks
  slug        : string  (unique, indexed)   — human id, e.g. "2026-06-03-seed-01"
  title       : string
  prompt      : string
  batch       : string  (indexed)
  description : string
  code        : string
  meta        : json                          — { bpm, genre, mood, key, instruments[], energy }
  createdAt   : string  (indexed)             — ISO 8601; sorts chronologically lexicographically
  isPublic    : boolean (indexed)             — default true
  versionOf   : string  (indexed, optional)   — root slug for v2+, absent for v1
  rating      : number  (optional)            — 1–5 or null
  notes       : string                        — per-item notes (default "")
  lesson      : string                        — cross-batch lesson (default "")

stems — identical shape to tracks
```

### Links

```
tracksAuthor : tracks.author  (has one)  <->  profiles.tracks  (has many)
stemsAuthor  : stems.author   (has one)  <->  profiles.stems   (has many)
userProfile  : profiles.user  (has one)  <->  $users.profile   (has one, onDelete cascade)
```

No cascade from author→items (deleting a profile must not delete its tracks).

### Why these field choices

- **`slug` separate from the entity `id`.** Instant entity ids are UUIDs (`id()`).
  The human-readable id (`2026-06-03-seed-01`) becomes `slug` (unique). The client
  maps each fetched entity to `{ ...fields, id: slug }`, so existing client code
  that treats `id` as the human slug (DOM keys, editor map, export filenames,
  `groupVersions`, version compare, display, rating URL) works unchanged.
- **`createdAt` as indexed ISO string.** ISO 8601 sorts lexicographically =
  chronologically, so `order: { createdAt: 'desc' }` works and all existing
  date-display code (`new Date(iso)`) is unchanged.
- **`meta` as `json`.** Matches the current nested object incl. `instruments[]`.
- **rating/notes/lesson as fields on the item**, not a separate entity — they are
  global (shared, not per-user) and 1:1 with the item, exactly how the server
  merges them today. Written only by the server (admin), so no client write perm
  is needed for them.
- **`versionOf`** already exists in the data (a v2 stem carries
  `versionOf: <root slug>`); `groupVersions` keys families by `versionOf ?? id`
  (which is `versionOf ?? slug` after the client mapping).

## Permissions (`instant.perms.ts`)

```
tracks.view  : "data.isPublic == true || (auth.id != null && auth.id in data.ref('author.user.id'))"
tracks.create/update/delete : "false"     // server admin bypasses perms
stems  : same as tracks
profiles.view : "true"                      // artist names must show to logged-out visitors
profiles.create/update/delete : "false"
$users : default (email stays private)
```

All mutations (generation ingest, rating, profile edits) go through the server's
admin SDK, which bypasses permissions. `false` client-side perms are therefore
correct, not a bug.

## Write path (server, admin SDK)

A new `server/instant.mjs` module exposes pure-ish helpers that take an injected
`adminDb` (injectable so tests pass a fake):

- `ensureProfile(adminDb, { id, email })` → returns `profileId`. Looks up the
  profile linked to the user; if absent, creates one with
  `artistName = email.split('@')[0]` and links `user`. Idempotent.
- `saveRating(adminDb, namespace, slug, { rating, notes, lesson })` → looks up the
  item by slug, transacts the patched fields, returns `{ rating, notes, lesson }`.
- `itemSlugs(adminDb, namespace)` → `Set<slug>` (for the runner's before/after
  diff, replacing the disk `readdir`).
- `itemsBySlug(adminDb, namespace, slugs)` → array of items (for the runner's
  `readBatch`, replacing disk reads).
- `queryItems(adminDb, namespace)` → all items in a namespace with
  `{ rating, notes, lesson, ... }` (for `feedback.mjs` / `pending-revisions.mjs`).

### Server endpoints (`server/app.mjs`)

- **Retire** `GET /api/tracks`, `GET /api/stems` (client reads Instant directly).
- **Repoint** `PUT /api/:coll/:id/rating` (already `requireAuth` + allowlist) to
  `saveRating(adminDb, coll, id, ...)`. `id` is the slug. Validation of
  rating/notes/lesson unchanged.
- **Add** `GET /api/profile` (requireAuth) → ensures + returns the caller's
  `{ id, artistName }`.
- **Add** `PUT /api/profile` (requireAuth) → `{ artistName }` (1–60 chars,
  non-empty string); ensures the profile, transacts `artistName`, returns it.

`createApp` gains an injected `adminDb` (and the store object shrinks to just
rating/profile concerns). Default no-op/fake keeps existing tests open.

### Generation author attribution (`server/runner.mjs`)

- Jobs store `userId` and `userEmail` (captured from `req.user` at creation in
  `POST /api/jobs`).
- `runOne`: `profileId = await ensureProfile(adminDb, { id: job.userId, email: job.userEmail })`,
  then spawn `claude` with `env: { ...process.env, CRATE_AUTHOR_PROFILE_ID: profileId }`.
  The agent's `node scripts/save-*.mjs` inherits this env var.
- Before/after item detection uses `itemSlugs(adminDb, namespace)` instead of
  `idsIn(dir)`; `readBatch` uses `itemsBySlug`. `diffNew`/`liveProduced` logic is
  unchanged (sets of slugs instead of file ids).
- `server/index.mjs` `progressFor` uses `itemSlugs` instead of `idsIn`.

## Generation pipeline (full disk retirement)

### Shared script env loader

`scripts/lib/instant.mjs`: at import, `try { process.loadEnvFile('.env') } catch {}`
(Node 24 has `process.loadEnvFile`; the runner-spawned agents already inherit env
through the process tree, so this only matters for manual CLI runs). Exports an
`adminDb` built from `INSTANT_APP_ID` + `INSTANT_ADMIN_TOKEN`, plus re-exports the
`server/instant.mjs` helpers for script use.

### Save scripts

- `scripts/save-track.mjs <staging/file.json>`: read JSON, `validateTrack(track,
  { character: true })` (imported from `validate.mjs`), and on pass transact to
  Instant `tracks`: `id()`, all fields, `slug = track.id`, `versionOf` (if
  present), `isPublic: true`, defaults `rating: null, notes: '', lesson: ''`,
  linking `author` to `process.env.CRATE_AUTHOR_PROFILE_ID`. Reject if a track
  with that slug already exists (idempotent re-runs). Delete the staging file.
  Print `PASS <slug>` / `FAIL <slug> — <reason>` (exit 0/1) so the agent contract
  is unchanged.
- `scripts/save-stem.mjs`: same with namespace `stems` and `{ character: false }`.

### Skills (`.claude/skills/*/SKILL.md`)

- `generate-tracks`, `generate-stems`: agents now **write `staging/{id}.json`**
  (instead of `tracks/{id}.json`) and run **`node scripts/save-track.mjs
  staging/{id}.json`** (instead of `validate.mjs`). On failure they fix and
  re-run; after 3 fails they delete the staging file. The "batch already exists"
  check switches from `ls tracks/ | grep <batch>` to
  `node scripts/list-slugs.mjs <namespace>` (a new helper that prints every slug
  in a namespace, one per line, via `itemSlugs`) piped to `grep <batch>`.
  Everything else (style brief, directives, seeds) is unchanged.
- `revise-from-notes`: reads the work list from `node scripts/pending-revisions.mjs
  <namespace>` (now Instant-backed), writes each v2 to `staging/` and saves via the
  save script (which sets `versionOf`).

### Feedback / pending-revisions

- `scripts/feedback.mjs`: `buildDigest` is unchanged (pure, over an array of
  items); the CLI path swaps `createStore(...).listTracks()` for
  `queryItems(adminDb, namespace)`.
- `scripts/pending-revisions.mjs`: swaps the store for `queryItems`, still feeds
  `pendingRevisions()` from `src/versions.js` (pure, unchanged).

## Client read path (vanilla, `@instantdb/core`)

### Shared db (`src/db.js`)

```js
import { init } from '@instantdb/core';
import schema from '../instant.schema.js'; // or .ts via vite
export const db = init({ appId: import.meta.env.VITE_INSTANT_APP_ID, schema });
```

`auth.js` and `app.js` both import this single instance.

### Auth (`src/auth.js`)

- Use the shared `db` instead of its own `init`.
- Expose the current user to the app: accept an `onUser(user)` callback (or a tiny
  shared `currentUser` store) so `app.js` knows the signed-in user id for the
  "mine" filter and the profile editor.

### App (`src/app.js`)

- `initApp` signature changes from `{ apiBase, ... }` to `{ namespace, ... }`
  (`'tracks' | 'stems'`); `main.js`/`stems.js` updated accordingly.
- Replace `loadTracks()` (one-shot `fetch`) with
  `db.subscribeQuery({ [namespace]: { author: {}, $: { order: { createdAt: 'desc' } } } }, ...)`.
  On each update, map entities to `{ ...item, id: item.slug, artistName:
  item.author?.artistName ?? null, authorProfileId: item.author?.id ?? null }`,
  set `state.tracks`, and re-render (existing `renderBatchFilter`/`renderTracks`/
  `renderTransport`). The existing editor-preservation via the `codeSections` map
  (keyed by `id` = slug) keeps editors alive across re-renders.
- **Artist name in the card:** render `track.artistName` (e.g. a `.by` line under
  the title) when present.
- **"mine" filter:** add a segmented-control tab `mine`. `visibleFamilies()`
  filters `fam.latest.authorProfileId === myProfileId`. `myProfileId` comes from a
  second subscription to the caller's own profile (below). The tab is hidden until
  signed in.
- **Rating writes unchanged in shape:** `putRating` still
  `fetch('/api/' + namespace + '/' + track.id + '/rating', ...)` (server, slug as
  id). The subscription reflects the write in real time; keep the optimistic local
  update too.

### Profile (artist name) UI

- A small editor near the auth button (e.g. an "artist name" field in a dropdown
  shown when signed in). On load it `GET /api/profile`; on save it
  `PUT /api/profile { artistName }`. The client also subscribes to its own profile
  (`db.subscribeQuery({ profiles: { $: { where: { 'user.id': <uid> } } } })`) to
  get `myProfileId` for the "mine" filter and to reflect name changes live.

## One-time migration (`scripts/migrate-to-instant.mjs`)

1. `process.loadEnvFile('.env')`; build `adminDb`.
2. Resolve kalavox: query `$users` by email (the single allowlisted email).
   If absent, exit with a clear message ("sign in once first").
   `profileId = ensureProfile(adminDb, kalavox)`.
3. For each of `tracks/` and `stems/`: read every `*.json` file plus its rating
   from `data/ratings/` or `data/stem-ratings/`; for any slug not already in
   Instant, transact: `id()`, all fields, `slug = file.id`, `versionOf` if
   present, `isPublic: true`, `rating/notes/lesson` from the rating file (defaults
   null/""/""), `author` linked to `profileId`.
4. Idempotent: skip slugs that already exist. Print a summary
   (created / skipped per namespace).

Run once manually after the schema is pushed and before the client switch goes
live.

## Out of scope

- **Jobs queue** (`data/jobs/`) stays on disk — transient operational state, not
  user content. The runner only changes how it *detects produced items*.
- **Per-user ratings.** Ratings remain global/shared (any allowlisted user rates;
  one rating per item) — matches today and keeps the generation feedback loop.
- **Private-item toggle UI.** `isPublic` + perms ship now; no UI to flip it yet
  (everything is public by default). YAGNI.
- **Framework rewrite.** Stays vanilla JS.

## Testing strategy

- `validateTrack`/`validateCode`/`buildDigest`/`groupVersions`/`pendingRevisions`
  stay pure and keep their existing unit tests.
- `server/instant.mjs` helpers are unit-tested with a **fake `adminDb`** (an
  object recording `query`/`transact` calls) — no live Instant in tests.
- `server/app.mjs` supertest suite injects the fake `adminDb`; the rating + profile
  routes assert the right transact calls; the retired GET routes are removed from
  the suite.
- `runner.mjs` pure helpers (`diffNew`, `liveProduced`, `buildArgv`) keep their
  tests; `buildArgv` test updated only if argv changes (it doesn't — env, not
  argv, carries the author).
- A manual end-to-end check (documented in the plan): push schema → migrate →
  `npm run dev` → browse/play (logged out sees public), sign in, set artist name,
  generate a small batch, confirm the new items appear in real time with the
  author name and under "mine", rate one and confirm persistence.

## Deployment

The live service is `vimsical-crate.service` (port 3008, `EnvironmentFile=.env`).
Work happens in a git worktree; to deploy, merge to the main worktree's branch,
`npm ci && npm run build`, then `sudo systemctl restart vimsical-crate`. The
schema/perms push and the migration are run once against the shared Instant app.
