# Social layer: per-user ratings, owner notes/lessons, remix

**Date:** 2026-06-22
**Status:** Approved design, ready for planning

## Problem

Today `rating`, `notes`, and `lesson` are single fields on each item (track/stem),
writable by anyone on the email allowlist. There is no notion of *whose* rating it
is, no community aggregate, and no way for a logged-in user to derive their own
version of someone else's song without touching the original.

We want to split these into three distinct social concerns:

1. **Ratings** — any logged-in user can rate a song (1–5). Show an aggregate
   average across all users *and* make the current user's own rating clear.
2. **Notes & lessons** — only the song's **owner** (its linked author) may write
   notes/lessons on their own song. Notes are publicly readable; lessons are private.
3. **Remix** — a logged-in user can remix a song or stems with their own
   instructions, producing a brand-new item they own. The original is never affected.

## Decisions (from brainstorming)

- **Remix mechanics:** AI regeneration job. Reuses the existing `claude -p` jobs
  pipeline; produces a new remixer-owned item linked to the original.
- **Remix guardrails:** Keep the existing email allowlist for remix *this round*
  (no new abuse surface). May widen to all logged-in users later.
- **Rating filters:** `unrated` = songs *you* haven't rated; `top` = *aggregate*
  average ≥ 4.
- **Notes visibility:** Public read-only ("creator's notes"); owner-writable only.
  Lessons stay private (cross-batch internal signal).
- **Remix placement:** Public item in the main feed, owned by the remixer, with a
  separate `remixOf` backlink (NOT `versionOf`) so the original's version stack is
  untouched.
- **`/remix` headless command:** OK to add a new slash command (peer of
  `/revise-from-notes`).
- **Unowned items:** Items with no linked author fall back to allowlist-admin
  editing for notes/lessons, so notes are never permanently locked.

## Auth gates

Today there is one gate: `requireAuth` = valid Instant token **+ email allowlist**.
We add a lighter gate:

- **`requireUser`** *(new)* — valid Instant token + has a profile. Any logged-in user.
- **`requireAuth`** *(existing)* — allowlist.

| Action | Gate |
|---|---|
| Rate a song | `requireUser` |
| Edit notes/lessons | `requireUser` + owner check (fallback allowlist if item unowned) |
| Remix | `requireAuth` (allowlist, this round) |
| Generate (existing) | `requireAuth` |

`resolveUser` middleware (already present) supplies the requesting user's `$user`
and resolved `profile` id, needed for the owner check and rating upsert.

## Data model (`instant.schema.ts`)

**New `ratings` entity** (mirrors `plays`):

```ts
ratings: i.entity({
  namespace: i.string(),      // 'tracks' | 'stems'
  slug: i.string().indexed(), // which item was rated
  value: i.number(),          // 1–5
  updatedAt: i.string(),      // ISO 8601
}),
```

**New link** `ratingsProfile`:

```ts
ratingsProfile: {
  forward: { on: 'ratings', has: 'one', label: 'profile', onDelete: 'cascade' },
  reverse: { on: 'profiles', has: 'many', label: 'ratings' },
},
```

**Item field changes** (applied to `itemFields`, shared by tracks & stems):

- Add `ratingSum: i.number().optional()` — denormalized sum of all ratings.
- Add `ratingCount: i.number().optional()` — denormalized count of ratings.
- Add `remixOf: i.string().indexed().optional()` — source root slug for remixes.
- **Remove** the old single `rating` field (after migration).
- Keep `notes` and `lesson`.

*Rationale for the denormalized aggregate (vs computing client-side): each user's
individual rating stays private — the client never receives everyone's ratings —
while the average remains a cheap public read. Same pattern as `playCount`.*

## Permissions (`instant.perms.ts`)

- **`ratings`**: `view` = owner-only
  (`auth.id != null && auth.id in data.ref('profile.user.id')`); `create`/`update`/
  `delete` = `false` (server-only). Your rating is visible to you; others' are never
  exposed.
- **`tracks` / `stems`**: keep `ownerOrPublic` entity view. Add a **field rule** that
  hides `lesson` from non-owners:

  ```
  fields: { lesson: "auth.id != null && auth.id in data.ref('author.user.id')" }
  ```

  `notes`, `ratingSum`, `ratingCount` remain publicly viewable via the entity rule.

## Server endpoints (`server/app.mjs`, `server/instant.mjs`)

The current combined `PUT /api/:ns/:id/rating` (which bundles rating + notes +
lesson) is **split**:

1. **`PUT /api/:ns/:id/rating`** — gate `requireUser` + `resolveUser`.
   Body `{ value: 1–5 | null }`. `null` clears your rating.
   - Upserts the caller's `ratings` record (one per profile+namespace+slug).
   - Recomputes `ratingSum`/`ratingCount` on the item in the same transaction.
   - Returns `{ you, avg, count }`.

2. **`PUT /api/:ns/:id/notes`** — gate `requireUser` + `resolveUser` + owner check.
   Body `{ notes?: string, lesson?: string }`.
   - 403 if caller's profile ≠ item's author (unless item is unowned and caller is
     allowlisted).
   - Updates `notes` and/or `lesson`.

3. **`POST /api/jobs`** new type **`remix`** — gate `requireAuth`.
   Body `{ namespace: 'tracks'|'stems', slug, instructions }`.
   - Validates namespace, slug exists, instructions 1–500 chars, no double quotes
     (same constraints as generate prompts).
   - Enqueues a remix job carrying `{ namespace, sourceSlug, instructions, remixerProfileId }`.

`saveRating` in `server/instant.mjs` is replaced by:
- `setRating(adminDb, namespace, slug, profileId, value)` — upsert + aggregate recompute.
- `setNotes(adminDb, namespace, slug, { notes, lesson })` — owner-validated write
  (owner validation happens in the route using `resolveUser` + the item's author).

## Remix job (`server/runner.mjs`, `server/jobs.mjs`, `.claude/commands/remix.md`)

- Add `remix` to `jobStore.TYPES` and to the runner's type→collection map.
- Runner builds the headless command:
  `/remix <namespace> <sourceSlug> "<instructions>"`.
- New `.claude/commands/remix.md` slash command: reads the source item's code +
  meta, applies the instructions, writes a new item file with:
  - a fresh slug,
  - `remixOf` = source root slug,
  - `prompt` = the remixer's instructions,
  - author linked to `remixerProfileId`,
  - `isPublic = true`.
- The original item is read-only input; never updated.

## Client (`src/app.js`, `src/jobs-ui.js`, `src/song.js`, `src/db.js`)

- **Rating control:** existing 5-block control becomes **"Your rating"** (highlighted
  from the caller's `ratings` subscription). Add an **aggregate badge** beside it —
  `★ {avg} · {count}`. Logged-out users see the badge; the control is disabled with a
  "sign in to rate" affordance.
- **Subscriptions:** mirror the `plays` subscription — subscribe the signed-in user's
  `ratings` (slug → value) for "your rating"; read `ratingSum`/`ratingCount` from the
  item for the aggregate.
- **Filters:** `unrated` → items where the user's rating is absent; `top` → items
  where `ratingCount > 0 && ratingSum / ratingCount >= 4`.
- **Notes/lessons UI:** only render the editable notes/lesson textareas when the
  signed-in user owns the item (or is an unowned-item admin). For non-owners, show
  read-only "creator's notes" (notes only) on the song page.
- **Remix UI:** a "Remix" action on each item (and the song page), visible under the
  same gate as generate. Opens a small prompt for instructions, POSTs the `remix`
  job, surfaces progress through the existing jobs UI. On completion the new item
  appears in the feed with a "remixed from \<original\>" backlink.

## Migration (`scripts/`)

One-off script:
- For each track/stem with a non-null `rating`: create a `ratings` record
  (`value = rating`, `updatedAt = item.createdAt`) linked to the item's author
  profile; set `ratingSum = rating`, `ratingCount = 1`.
- Items with a `rating` but no author: skip the per-user record but still seed
  `ratingSum`/`ratingCount` so the aggregate reflects the legacy score.
- After migration verifies, push schema removing the old `rating` field.

## Testing (TDD)

Using `test/fake-admin` + perms tests:

- **Rating upsert/aggregate:** set (count 0→1, sum), change your rating (sum adjusts,
  count unchanged), clear (count 1→0, sum back to 0), two users (sum/count of both).
- **`requireUser` gate:** anonymous request → 401/403.
- **Notes owner check:** non-owner → 403; owner → 200; unowned item + allowlist → 200.
- **Field perm:** `lesson` hidden from a non-owner query; visible to owner.
- **Remix job:** produces a remixer-owned item with `remixOf` set; the original item
  is byte-for-byte unchanged; new item `isPublic = true`.
- **Client filters:** `unrated`/`top` resolve against per-user vs aggregate as specified.

## Out of scope (this round)

- Widening remix beyond the allowlist (deferred; guardrails would be added then).
- Rating history / per-rating timestamps beyond `updatedAt`.
- Notifying owners of new ratings or remixes.
