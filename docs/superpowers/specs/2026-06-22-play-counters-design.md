# Play counters (total + per-user) — design

**Date:** 2026-06-22
**App:** crate

## Goal

Show each song's **total** play count and the signed-in viewer's **own** play
count, and subtly mark songs the viewer hasn't played yet. Counts apply per
version (each version is its own slug), to both `tracks` and `stems`.

## Decisions (from brainstorming)

- **What counts as a play:** playback that survives **4 seconds** of continuous
  play. Pressing play then quickly stopping/skipping does not count.
- **Who counts toward the total:** everyone — anonymous listeners included. The
  per-user breakdown only exists for allowlisted signed-in users.
- **Display:** total reads `▶ N plays` inline in the card meta row; the viewer's
  own count shows on hover (`title="you: N"`). No always-visible "you" number.
- **Unplayed cue:** a small accent dot precedes the song title when the viewer is
  signed in and has **not** played that version yet; it disappears once played.

## Data model (instant.schema.ts)

- Add `playCount: i.number().optional()` to the shared `itemFields` (so both
  `tracks` and `stems` get it). Absent ⇒ treated as `0` in the UI. Unindexed.
- New `plays` entity:
  ```ts
  plays: i.entity({
    namespace: i.string(),       // 'tracks' | 'stems'
    slug: i.string().indexed(),  // which version
    count: i.number(),
    lastPlayedAt: i.string(),    // ISO
  })
  ```
- New link `playsProfile`:
  ```ts
  playsProfile: {
    forward: { on: 'plays', has: 'one', label: 'profile', onDelete: 'cascade' },
    reverse: { on: 'profiles', has: 'many', label: 'plays' },
  }
  ```
- One `plays` record per (profile, namespace, slug); the server upserts it
  (Instant has no compound-unique, so find-or-create).

## Permissions (instant.perms.ts)

- `plays`: `view` = owner-only (`auth.id in data.ref('profile.user.id')`);
  `create`/`update`/`delete` = `'false'` (all writes are server-side via the
  admin SDK, which bypasses perms — same pattern as tracks/stems).
- Total `playCount` rides on `tracks`/`stems`, already publicly viewable.

## Write path

A single public, token-aware route per namespace:
`POST /api/<namespace>/:id/play` (id = slug). It is NOT behind `requireAuth`
(anonymous must reach it), but reads the bearer token when present.

Server helper `recordPlay(adminDb, namespace, slug, user)`:
1. Look up the item by slug. Unknown slug ⇒ caller returns 404.
2. Increment the item's total: `update({ playCount: (item.playCount ?? 0) + 1 })`.
   (Read-modify-write — under concurrent plays an increment can be lost. Accepted
   for this app's scale; noted here as a known limitation.)
3. If `user` is present and allowlisted: `ensureProfile` → find the existing
   `plays` record for (profile, namespace, slug); update `count`+1 and
   `lastPlayedAt`, or create one with `count: 1` linked to the profile.
4. Return `{ playCount, you }` (you = the user's new count, or 0/undefined when
   anonymous). The body is informational; the UI updates via subscriptions.

The route resolves the user softly: if a token is present and verifies to an
allowlisted email, attach `req.user`; otherwise proceed anonymously (never
reject). Path-character ids are rejected (reuse the existing `ID_RE` guard).

## Client (src/app.js)

- **Trigger:** in `play(track)`, after starting playback, set a 4s timer (stored
  on `state.playTimer`). On fire, if `state.playingId === track.id` and
  `isStarted(track.id)` (still playing), `POST /api/<namespace>/<id>/play`
  (the auth fetch wrapper attaches the token when signed in). Clear the timer at
  the start of `play()` and inside `stop()` so stop/skip cancels a pending count.
- **Read per-user:** when signed in and `myProfileId` resolves, subscribe to
  `plays` where `'profile.id' == myProfileId`, build a `playsBySlug` map
  (`slug → count`), and re-render on change. Clear it on sign-out.
- **Render (per card, active version):**
  - Total: a `.plays` span in the meta row → `▶ ${playCount ?? 0} plays`
    (singular `1 play`).
  - Hover: set the `.plays` span `title` to `you: ${playsBySlug[slug] ?? 0}` when
    signed in.
  - Unplayed dot: when signed in and `!(playsBySlug[slug] > 0)`, prepend a
    `.unplayed-dot` span to the title `<h3>`.

## Styling (src/style.css)

- `.plays`: small, dim, mono (matches `.id`/chip muted text).
- `.unplayed-dot`: a small accent (`--acid`) dot before the title, with a little
  right margin; no layout shift when absent.

## Testing

- **Server (`test/api.test.mjs` + `test/instant.test.mjs`):**
  - `POST /api/tracks/:id/play` increments the item's `playCount` (assert the
    recorded tx update) and returns 200.
  - Unknown slug ⇒ 404; path-char id ⇒ 400.
  - Anonymous (no `req.user`) increments total only — no `plays` upsert tx.
  - Signed-in: creates a `plays` record (count 1) when none exists; increments an
    existing record's count when one does.
- **fake-admin:** generalize `matchWhere` nested-key resolution from the
  hard-coded `user.id` to any `a.b` (`row[a]?.[b]`), so `'profile.id'` queries
  work. Keep `user.id` behavior intact.
- Client render/trigger wiring is verified by build + manual run (no DOM unit
  test), consistent with the rest of the app.

## Out of scope (YAGNI)

- Sort/filter by play count; play history/timeline; unique-listener counts;
  decrementing; anonymous per-device identity.

## Affected files

- `instant.schema.ts`, `instant.perms.ts` — model + perms (pushed to Instant).
- `server/instant.mjs` — `recordPlay` helper.
- `server/app.mjs` — public token-aware `POST /api/<ns>/:id/play` route.
- `server/auth.mjs` — soft user-resolution helper (optional auth).
- `src/app.js` — trigger timer, per-user subscription, card rendering.
- `src/style.css` — `.plays`, `.unplayed-dot`.
- `test/fake-admin.mjs`, `test/api.test.mjs`, `test/instant.test.mjs` — tests.
