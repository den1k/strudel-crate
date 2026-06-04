# Feedback Lesson Channel — Design

**Date:** 2026-06-04
**Status:** Approved

## Problem

Today every note on a low-rated (≤2★) track is injected into the "avoid these
mistakes" section of the feedback digest, which is fed to every future
generation agent — regardless of style or batch. Notes are usually
track-specific ("the drums here are too loud"), so track-level critique leaks
into global guidance. There is no way to leave a note on a track without it
affecting all future tracks.

## Decision

Split feedback into two channels per track:

- **notes** — track-specific, stays attached to the track, never enters the
  digest.
- **lesson** — optional, explicitly general guidance ("keep drums under the
  synth layers"), enters the digest for all future batches regardless of the
  track's star rating.

Chosen over: a "apply to future tracks" checkbox on the single notes field
(track-specific phrasing would leak into global guidance), a separate global
lessons store (new subsystem, loses track provenance — YAGNI), and writing
lessons into track files (tracks are generated artifacts; the server is the
only ratings writer).

## Changes

### 1. Store — `server/store.mjs`

- `getRating(id)` additionally returns `lesson: r.lesson ?? ''`.
- `saveRating(id, { rating, notes, lesson })` persists `lesson: lesson ?? ''`
  in `data/ratings/<id>.json`, same shape as `notes`.

### 2. API — `server/app.mjs`

- `PUT /api/tracks/:id/rating` accepts optional `lesson`; validated exactly
  like `notes` (`400` unless `null`/`undefined` or string).

### 3. Webapp — `src/main.js`, `src/style.css`

- Each track card gets a second, visually smaller textarea below notes:
  - placeholder: `lesson for future tracks — applies to every new batch…`
  - same debounced autosave + saved-flash + error-flash behavior as notes.
- Notes placeholder updated to end with `(this track only)`.
- `putRating` round-trips `lesson` like `rating`/`notes`.

### 4. Digest — `scripts/feedback.mjs` `buildDigest()`

- **Top rated section: unchanged** — tracks rated ≥4 still contribute their
  code as "emulate" examples (notes of top tracks no longer shown).
- **Low-rated notes section: removed.** Track notes never appear in the
  digest.
- **New final section** `## Lessons for all future tracks`: one bullet per
  non-empty `lesson`, from any track regardless of rating, in track-listing
  order. Bullet format: `- <lesson> (from "<title>")`.
- Digest is non-empty when there are rated tracks **or** any lessons; the
  "No ratings yet" fallback only fires when both are absent.

### 5. Out of scope / unchanged

- `.claude/skills/generate-tracks/SKILL.md` — already injects whatever
  `feedback.mjs` prints; no change.
- **No migration** of the two existing notes ("Felt Hammer",
  "Druqks Engine"): they stay track-only and stop influencing future batches
  unless re-entered as lessons via the UI.
- Validator, track schema, generation flow: untouched.

## Testing

Extend the existing suites:

- `store.test.mjs` — lesson round-trips through `saveRating`/`listTracks`;
  missing lesson defaults to `''`; old rating files without `lesson` still
  load.
- `api.test.mjs` — PUT with `lesson` saves and echoes it; non-string lesson
  → 400; omitting `lesson` leaves prior value handling consistent with
  current notes semantics (full-record overwrite, client sends all fields).
- `feedback.test.mjs` — lesson on a 3★ (and unrated) track appears in the
  digest; track notes never appear; digest with lessons but zero ratings is
  non-empty; no-lessons digest omits the Lessons section; top-rated code
  section unchanged.
