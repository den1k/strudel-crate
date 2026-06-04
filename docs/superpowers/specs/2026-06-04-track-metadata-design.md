# Track Descriptions + Metadata — Design

**Date:** 2026-06-04
**Status:** Approved by user (conversation, 2026-06-04)

## Goal

Every generated track carries a human-readable `description` and structured `meta`
(bpm, genre, mood, key, instruments, energy) — written by generation agents,
enforced by the validator, displayed in the webapp, surfaced in the feedback digest.

## Schema (new required fields)

Track JSON (`tracks/<id>.json`) gains two required top-level fields:

```json
{
  "id": "2026-06-04-deep-dub-01",
  "title": "Pressure Lines",
  "prompt": "deep dub techno",
  "batch": "2026-06-04-deep-dub",
  "description": "Sub-heavy dub techno that opens with filtered chords and builds into a rolling half-time groove. 1-3 sentences: what it sounds like, how it develops.",
  "meta": {
    "bpm": 126,
    "genre": "dub techno",
    "mood": "hypnotic, cavernous",
    "key": "F minor",
    "instruments": ["RolandTR909 kit", "sawtooth bass", "piano"],
    "energy": 3
  },
  "code": "setcpm(126/4)\narrange(...)",
  "createdAt": "2026-06-04T00:00:00Z"
}
```

## Validator (`scripts/validate.mjs`)

New exported `validateTrack(track)` — the CLI's existing schema logic moves into it
(unit-testable), extended with:

- `description`: non-empty string.
- `meta`: object with
  - `bpm`: integer 40–220
  - `genre`, `mood`, `key`: non-empty strings
  - `instruments`: non-empty array of non-empty strings
  - `energy`: integer 1–5
- **BPM cross-check:** parse the code for `setcpm(N/4)` → declared bpm N, or
  `setcpm(N)` → declared bpm N×4. `meta.bpm` must equal the declared bpm. If no
  `setcpm` in the code, `meta.bpm` must be 120 (Strudel default ≈ 0.5 cps at 4/4).
- `validateTrack` runs the field/meta checks, then `validateCode(track.code)`.
  Return shape stays `{ok: true, events}` | `{ok: false, error}`.
- CLI `validateTarget` for `.json` files delegates to `validateTrack`.

## Webapp (`src/main.js`, `src/style.css`)

Track card additions (all via `textContent` — XSS-safe):
- `description` rendered under the title in dim text.
- Metadata chip row: `genre` · `<bpm> bpm` · `key` · energy as 1–5 filled blocks · `mood`.
- `instruments` listed inside the code `<details>` area (one line above the `<pre>`).
- Tracks missing `meta` (should not exist after backfill) render without chips — no crash
  (guard with `track.meta ?? {}`).

## Guide (`STRUDEL_GUIDE.md`)

- Track file format block updated with the two new fields.
- New short "Metadata" section: bpm MUST match your `setcpm` (validator enforces);
  energy scale (1 = ambient/beatless … 5 = peak-time); `instruments` = the sounds/banks
  actually used in the code; description written for a listener, not a programmer.

## Skill (`.claude/skills/generate-tracks/SKILL.md`)

Agent prompt template step 3 lists the new required fields (description + meta with
all six keys, bpm matching setcpm).

## Feedback digest (`scripts/feedback.mjs`)

Top-rated headers and low-rated lines gain a ` — <genre> · <bpm>bpm` suffix when
`meta` is present, so taste patterns across batches become visible.

## Backfill

All 5 existing tracks (2 seeds + 3 lofi house) get accurate `description` + `meta`
hand-written from their actual code; the whole crate must re-validate (5× PASS).

## Testing

- New unit tests for `validateTrack`: happy path; missing description; missing meta;
  bpm/setcpm mismatch; bad energy; instruments not a non-empty string array;
  no-setcpm code requiring bpm 120.
- Existing tests unaffected except any fixture that goes through the track-schema
  path (store/API fixtures bypass schema validation — no change needed).
- Webapp verified via vite build + curl checks (no browser automation), as before.

## Out of scope

- Filtering/sorting the webapp by metadata (future).
- Re-generating descriptions for failed/deleted tracks.
