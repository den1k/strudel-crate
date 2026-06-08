# Stem Versioning with Version-Navigation UI

**Date:** 2026-06-08
**Status:** Approved

## Goal

Let a stem have multiple versions while keeping the original. Add a webapp UI to
navigate between a stem's versions — each version shows its creation date and
carries its own rating + notes. Concretely, create a more-harmonic v2 of
"Hollow Engine" (`2026-06-08-alien-sounds-04`) in response to its listener note
("initially sounds great but needs to be more harmonic") and surface both
versions on one card.

## Decisions

- **Data model:** versions are sibling stem files linked by an optional
  `versionOf` field. No `versions[]` array, no subfolders. Chosen because it
  preserves every existing contract (one-file-per-stem validation, the store's
  flat `readdir`, ratings-keyed-by-id) and gives per-version notes for free.
- **Default version shown:** latest (newest `createdAt`).
- **Generation scope:** hand-generate this one v2 now; document the file
  convention so future versions follow it. No new `/version` command yet.
- **Grouping location:** client-side, in the webapp. The API and store are
  unchanged.
- **Execution:** in a new git worktree.

## Data model

A version is an ordinary stem JSON file with one new **optional** field:

- `versionOf: "<root stem id>"` — the id of the original (version 1) stem.
  Absent ⇒ the stem is its own root / version 1.

`family = versionOf ?? id`. All members of a family share the same `family`
value (the root id). Version order within a family is by `createdAt` ascending;
the version number is the 1-based position.

The new file:

- Path: `stems/2026-06-08-alien-sounds-04-v2.json`
- `id`: `"2026-06-08-alien-sounds-04-v2"`
- `versionOf`: `"2026-06-08-alien-sounds-04"`
- `batch`: `"2026-06-08-alien-sounds"` (same as root)
- `createdAt`: fresh ISO timestamp (newer than the root)
- `code`: revised — see "The v2 content"
- all other required fields per the stem schema

Because the validator (`validateTrack`) only checks required fields + `meta` and
ignores unknown keys, `versionOf` needs no validator change; the v2 file
validates as a normal stem. All 60 existing stems remain valid (field is
optional).

Ratings/notes are written to `data/stem-ratings/<id>.json`. Since each version
has its own id, each version automatically gets its own rating + notes with no
store change.

## Grouping (pure helper)

A new pure function groups the flat list returned by `/api/stems` into families:

- Input: array of stem objects (each already merged with its rating/notes by the
  store).
- Output: array of family objects `{ family, versions: [...sorted by createdAt],
  latest }` where `versions[i].version` is the 1-based number and `latest` is the
  newest member.
- Single-version stems produce a family of one (so the rest of the UI is
  uniform).

This helper is unit-tested independently of the DOM.

## UI

The webapp groups stems into families before rendering, then renders **one card
per family** (replacing today's one-card-per-stem). Within a card:

- The selected version (default: latest) drives the card's title, description,
  meta chips, code editor, play, export buttons, and the rating stars + notes
  box. The notes box and stars bind to the **selected version's id**, so saving
  writes to that version's rating file.
- When a family has more than one version, a compact switcher renders — one
  control per version labeled `v{n}` with its creation date (e.g.
  `v2 · Jun 8`). Selecting a version re-renders the card body for that version.
  The active version is visually marked.
- Single-version families render with no switcher and look exactly as cards do
  today.

Switching versions must not disrupt other cards' unsaved notes (the existing
code already updates in place rather than full-re-rendering for that reason; the
switcher re-renders only its own card's body).

## The v2 content

One generation agent revises "Hollow Engine" to honor the note "needs to be more
harmonic." The original leans on inharmonic FM ratios (`fmh "<1 1.5 2.01 0.5
3.99>/5"`); the v2 moves toward harmonic-integer ratios and adds musical
interval/chord-tone stacking so the tone reads as pitched and consonant, while
keeping the same star-sound identity (FM sine bass, ladder filter, morph arc).
The agent writes the file above and validates it with
`node scripts/validate.mjs`.

## Testing

- **Unit:** the grouping helper — families formed by `versionOf`, members sorted
  by `createdAt`, version numbers assigned, latest selected, single-version
  passthrough.
- **Regression:** existing store/API/validate tests stay green (no changes to
  those modules).
- **Validation:** the actual v2 file passes `node scripts/validate.mjs`.
- **Browser (Playwright):** on the stems page, the Hollow Engine card shows a
  v1/v2 switcher with dates; switching swaps the editor code and the notes shown;
  a single-version card shows no switcher; saving a note on v2 persists to
  `data/stem-ratings/2026-06-08-alien-sounds-04-v2.json` without touching v1's.

## Out of scope

- A repeatable `/version` command or skill.
- Versioning for tracks (the same helper could later be reused, but this spec
  targets stems only).
- Deleting or reordering versions.
- Server-side grouping or any API/store change.
