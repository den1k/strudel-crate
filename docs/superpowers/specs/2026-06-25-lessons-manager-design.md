# Lessons Manager — Design

**Date:** 2026-06-25
**Status:** Approved (data model approved section-by-section; user directed implementation)

## Problem

A "lesson" is user-level guidance that steers all of a user's future generations
("lesson for future tracks — applies to every new batch"). Today a lesson is stored
as a single optional `lesson` string on each song (`tracks`/`stems`), captured via an
inline textarea on the owner's song card. The generation digest (`scripts/feedback.mjs`)
scrapes these strings off the user's own songs.

There is no way to view, add, edit, or delete lessons as a set. Users cannot create a
standalone lesson (one not tied to a song), and there is no central place to manage them.

## Goals

- A **lessons manager** in the user profile: list, add, edit, delete lessons.
- Lessons are **first-class records** owned by a profile, with an **optional** link to the
  song they came from.
- A lesson can be **standalone** (no song).
- Lessons remain **scoped by target type** (`tracks` vs `stems`), matching current digest
  behavior — a lesson only steers generations of its target type.
- The per-song inline "lesson" box stays as a **quick-add** that reads/writes the same
  underlying lesson record for that song.
- The generation digest reads lessons from the new entity (single source of truth).

## Non-goals

- No changes to per-song **notes** (separate concept, "this track only").
- No enable/disable toggle on lessons (delete is the only removal). YAGNI.
- No dedicated profile page/routing — the manager lives in the existing profile modal.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Data model | First-class `lessons` entity, optional song link (Option A: entity is single source of truth) |
| Standalone lessons | Supported (song link optional) |
| Song-card lesson box | Keep as quick-add; writes the linked lesson record |
| Tracks vs stems scope | Keep separate; each lesson has a `target` |
| UI location | Inside the existing profile modal |
| Type picker | Per-lesson `tracks`/`stems` toggle |
| Digest sourcing | Read from the `lessons` entity only; migrate existing song `lesson` strings in |

## Data model

New entity in `instant.schema.ts`:

```ts
lessons: i.entity({
  text: i.string(),                 // lesson content
  target: i.string().indexed(),     // 'tracks' | 'stems'
  createdAt: i.string().indexed(),  // ISO 8601
  updatedAt: i.string(),            // ISO 8601
}),
```

Links:

```ts
lessonsProfile: {                   // every lesson belongs to one profile
  forward: { on: 'lessons', has: 'one', label: 'profile', onDelete: 'cascade' },
  reverse: { on: 'profiles', has: 'many', label: 'lessons' },
},
lessonsTrack: {                     // optional provenance: lesson -> source track
  forward: { on: 'lessons', has: 'one', label: 'track' },
  reverse: { on: 'tracks', has: 'one', label: 'lessonRecord' },
},
lessonsStem: {                      // optional provenance: lesson -> source stem
  forward: { on: 'lessons', has: 'one', label: 'stem' },
  reverse: { on: 'stems', has: 'one', label: 'lessonRecord' },
},
```

Notes:
- `target` is what the digest filters on, independent of any song link, so a standalone
  lesson still declares which generations it steers.
- Reverse label is `lessonRecord` (NOT `lesson`) to avoid colliding with the existing
  `lesson` string attribute on `tracks`/`stems` during migration.
- Reverse link is `has: 'one'` — a song has at most one lesson record (mirrors today's
  one-string-per-song). The song-card quick-add reads/writes this record.
- A lesson links to at most one of `track`/`stem` (or neither, if standalone).

## Migration (two schema pushes)

The old `lesson` string must be copied into records **before** the field is removed
(an Instant schema push that drops a field deletes its data).

1. **Push #1** — add `lessons` entity + the three links. Keep the old
   `itemFields.lesson` string in place.
2. **Migration script** (`scripts/migrate-lessons.mjs`): for every `tracks`/`stems` item
   with a non-empty `lesson`, create one `lessons` record:
   - `text` = the song's `lesson`
   - `target` = the song's namespace (`'tracks'` or `'stems'`)
   - `createdAt`/`updatedAt` = now (the song's `lesson` carries no timestamp)
   - link `profile` = the song's author profile (skip/log songs with no author)
   - link `track`/`stem` = the source song
   - Idempotent: skip a song that already has a linked `lessonRecord`.
3. **Push #2** — remove `lesson` from `itemFields` (deletes the now-migrated strings).

DB-wide lesson count is small; for the primary user (kalavox) it is currently 0.

## API (server)

All under `requireAuth`, scoped to the caller's own profile (via `ensureProfile`).
New helpers in `server/instant.mjs`; routes in `server/app.mjs`.

- `GET /api/lessons` → `[{ id, text, target, createdAt, updatedAt, song }]` for the
  caller's profile. `song` is `{ namespace, slug, title }` or `null`.
- `POST /api/lessons` `{ text, target, song? }` → creates a lesson linked to the caller's
  profile (and optionally to a song the caller owns). Validates `target ∈ {tracks,stems}`,
  `text` non-empty string. Returns the created lesson.
- `PUT /api/lessons/:id` `{ text?, target? }` → updates; 403 unless the lesson's profile is
  the caller's. Bumps `updatedAt`.
- `DELETE /api/lessons/:id` → deletes; 403 unless owned by caller.

Song-card quick-add: the existing `PUT /api/{ns}/:id/notes` keeps handling `notes`. The
`lesson` portion is reworked to upsert/delete the song's linked `lessonRecord` instead of
writing the (removed) string field:
- non-empty `lesson` → upsert the song's lesson record (`target` = ns, link the song)
- empty/blank `lesson` → delete the song's lesson record if present

Ownership checks reuse `itemOwnerProfileId` / `ensureProfile` exactly as today.

## Digest (generation)

`scripts/feedback.mjs`:
- `buildDigest` keeps its output format ("## Lessons for all future tracks", one bullet per
  lesson). Provenance suffix `(from "<title>")` is shown only when the lesson has a song
  link; standalone lessons render without it.
- Source changes from "scan song `lesson` strings" to "read the profile's `lessons` records
  filtered by `target` = the namespace being generated".
- `queryItemsByAuthor` usage is replaced/augmented by a `queryLessonsByProfile(adminDb,
  profileId, target)` helper in `server/instant.mjs`.
- Per-user scoping is preserved (CRATE_AUTHOR_PROFILE_ID gate unchanged): a job only sees
  its own author's lessons; manual CLI runs with no profile id fall back to all lessons.

## UI (profile modal)

In `src/auth.js` `mountProfileModal`, add a **lessons** section below stats:

- Heading "lessons — applied to your future generations".
- Scrollable list. Each row: the lesson text (inline-editable textarea, autosave on blur/
  debounced input like the song-card box), a `tracks`/`stems` toggle, an optional
  "from <song title>" provenance chip (when song-linked), and a delete (×) button.
- An "add lesson" row at the bottom: empty textarea + target toggle (default `tracks`);
  creating posts to `POST /api/lessons` (standalone — no song link).
- Loads via `GET /api/lessons` when the modal opens (alongside existing profile/stats load).
- Owner-only by nature (the modal is the signed-in user's own profile).

Song card (`src/app.js`): the inline lesson textarea stays; its autosave continues to call
`PUT /api/{ns}/:id/notes` with the `lesson` value, which now upserts/deletes the linked
lesson record. No UI change on the card itself.

## Error handling

- Server validates `target`, non-empty `text`, ownership (403), existence (404); mirrors
  the existing notes/rating routes' patterns.
- Client autosave uses the same debounce + `flashError` pattern already used for notes.
- Migration script is idempotent and logs songs skipped for missing author.

## Testing

- `server/instant.mjs` helpers: create/list/update/delete lessons; ownership enforcement;
  quick-add upsert + delete-on-empty; `queryLessonsByProfile` target filtering.
  (Extend `test/instant.test.mjs` or add `test/lessons.test.mjs`.)
- `scripts/feedback.mjs`: `buildDigest` over lesson records — provenance suffix present only
  when song-linked; target filtering; empty-state string unchanged.
  (Extend `test/feedback.test.mjs`.)
- Migration: idempotent re-run creates no duplicates; copies text/target/author/song-link.
- Manual: profile modal add/edit/delete; song-card quick-add round-trips to the manager;
  deleting in manager clears the song-card box.

## Rollout

1. Push #1 (schema add) → 2. migrate → 3. wire API + digest + UI → 4. Push #2 (drop old
   field) → 5. build (`npm run build`) → 6. restart `vimsical-crate`. Work on `main`
   (session pattern); deploy is from the main worktree.
