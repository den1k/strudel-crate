# Artist/Style Fidelity — Vocal Samples + Per-Prompt Style Brief — Design

**Date:** 2026-06-16
**Branch:** `worktree-style-fidelity`
**Status:** Approved design (user fast-forwarded to writing-plans)

## Problem

Tracks generated for a named artist (e.g. "fred again") land in the right genre but
don't sound like the artist. Root-caused (2026-06-16, `/debug`) to two independent
gaps:

1. **The defining instrument is missing.** Fred Again's signature is the chopped,
   pitched, intimate **vocal sample**. `scripts/sounds.json` has effectively no vocal
   material and `STRUDEL_GUIDE.md` forbids `samples()`, so the agent cannot produce it.
2. **The pipeline has no artist-fidelity mechanism.** The prompt string ("fred again")
   is the *only* artist signal, and it is surrounded by style-agnostic scaffolding —
   generic seeds, generic variation axes, the character gate — plus the diversify
   system actively fans the batch apart. The model's latent knowledge gets the genre
   right, but nothing reinforces or specifies the artist.

## Approach (decisions locked with the user)

- **Samples mechanism: curated preloaded banks.** `shared/sample-banks.json` already
  drives BOTH the webapp's `samples(...)` preload AND `scripts/build-sounds.mjs`'s
  allowlist generation, so adding a bank there makes its sounds playable AND
  allowlisted with no contract drift. Agents use the new sounds **by name** (e.g.
  `s("swpad").chop(8)`); the `samples()` *call* stays unnecessary (and forbidden,
  because it loads nothing in the headless validator and breaks the validated⇒playable
  contract). "Don't ban samples" is delivered by making the **sounds available**, not
  by allowing arbitrary `samples('github:…')` calls (rejected for contract/security).
- **Style brief: shared brief + intra-style variation.** One concise style brief per
  batch, written by the orchestrator from the prompt, pins the artist DNA and is shared
  by ALL tracks. The existing per-track variation directives vary energy/arc/register
  *within* that DNA.

## Key facts (verified)

- `shared/sample-banks.json` entries are either `{ "shorthand": "github:user/repo" }`
  (build-sounds fetches `raw.githubusercontent.com/user/repo/main/strudel.json`; webapp
  calls `samples(shorthand)`) or `{ "json": "<url>", "base": "<url>", ... }`.
- In the validator, `samples` is stubbed to a no-op and `checkSounds` rejects any sound
  name not in `sounds.json`. So a sampled sound only validates if its name is in the
  allowlist — which `build-sounds.mjs` guarantees for banks listed in
  `sample-banks.json`.
- Probed candidate banks that fetch cleanly (2026-06-16):
  - `github:switchangel/pad` → key `swpad` (lush pads — serves Fred's sidechained-pad
    sound). VERIFIED fetch.
  - `github:yaxu/clean-breaks` → 32 choppable break/vocal-phrase keys (`think`,
    `useme`, `sesame`, `apache`, …). VERIFIED fetch.
  - Spoken-vocal material already in the allowlist: `numbers`, `alphabet`, `breath`
    (from dirt-samples).
- Current agent prompt already has a `Style brief: "{prompt}".` line — it injects the
  raw prompt. The feature replaces this with a real generated brief.

## Design

### Part A — Curated sample banks (capability)

- Add to `shared/sample-banks.json`:
  - `{ "shorthand": "github:switchangel/pad" }`
  - `{ "shorthand": "github:yaxu/clean-breaks" }`
- Regenerate the allowlist: `node scripts/build-sounds.mjs` (fetches the new manifests,
  rewrites `scripts/sounds.json`). Commit the regenerated `sounds.json`.
- **Verify (deaf-headless rule):** the new names validate
  (`node scripts/validate.mjs --code 's("swpad")'` → PASS) AND **actually play** in the
  browser (capture `console`, confirm no "not found"/getTrigger errors) — a sample that
  validates but is silent is still a failure. Use the browser-verification recipe from
  project memory.
- The implementer may swap a bank if probing finds a better melodic-vocal pack, as long
  as it fetches, regenerates cleanly, and plays.

### Part B — Per-prompt style brief (the fidelity mechanism)

In `.claude/skills/generate-tracks/SKILL.md`:

1. **New orchestrator step "Write the style brief"** (before fan-out): the orchestrator
   writes ONE concise brief (≈4–8 lines) from the prompt, covering: tempo/feel, groove,
   signature sounds (naming available sounds incl. the new vocal/pad sounds), signature
   techniques (e.g. "center the track on a chopped vocal", "sidechain the pads via a
   gain LFO", "lo-fi felt piano"), mood, and what to avoid. Generated for EVERY prompt
   (artist/genre/vibe), not special-cased. Shared across the whole batch.
2. **Seed reconciliation:** the brief outranks the seed. In the variation-directive
   step, bias seed selection toward style-compatible grooves/engines. In the agent
   prompt, reframe the seed as "a starting groove to ADAPT to the brief — override it
   where it conflicts with the brief's signature."
3. **Agent-prompt edits:** replace `Style brief: "{prompt}".` with the generated
   `{style_brief}` as the dominant creative anchor, followed by the per-track
   `{directive}` (variation WITHIN the brief), then the seed reframed per (2). Keep the
   prompt verbatim available for the track's `prompt` field.
4. **No persistence / no schema change:** the brief is injected into agent prompts and
   echoed in the orchestrator's run report. No new track-JSON field, no validator
   change.

### Part C — Guide (STRUDEL_GUIDE.md)

- Sound palette section: document the new sampled sounds (pads: `swpad`; vocal/phrase
  chops: `numbers`, `alphabet`, `breath`, `think`, `useme`, …) and how to use them
  musically — `.chop(n)`, `.slice(n, "...")`, `.speed("<…>")`, `.begin()/.end()`,
  `.fit()`, and **sidechain/pump** via a gain LFO (`.gain(saw.slow(2).range(0.2,1))`).
- Reword the `samples()` ban (line ~46) from a bare prohibition to: *no `samples()` —
  the banks are preloaded; reference their sounds by name (see palette)* — so the
  capability is discoverable and the ban has a stated reason.
- Add a short "vocal chop / sidechain" example to the character/movement guidance so the
  timbral and harmonic categories can be satisfied with the artist-signature moves.

## Testing / verification

- **Part A:** `build-sounds.mjs` regenerates `sounds.json` containing the new names;
  `validate.mjs --code 's("swpad")'` and `'s("think")'` PASS; browser playback audible.
  Existing tests still pass (adding allowlist names only widens acceptance; e.g.
  `seeds.test.mjs`/`validate.test.mjs` unaffected).
- **Part B:** skill-prompt change (no unit test). Verification is end-to-end: regenerate
  a small "fred again" batch and confirm the tracks (a) use the new vocal/pad sounds,
  (b) validate, (c) audibly lean toward the artist (listen). Also a static check: the
  agent-prompt template now contains `{style_brief}` and the seed-reframing wording.
- **Part C:** doc edits; grep verifies the palette names and reworded ban are present.

## Out of scope / deferred

- Arbitrary `samples('github:…')` calls in agent code (validator can't resolve them
  headlessly; security/contract risk).
- A dedicated sung-melodic-vocal pack beyond what probing found (implementer may add one
  if discovered).
- Persisting the style brief into track JSON / a batch sidecar (possible future).
- A critic/revision loop for style fidelity (separate, deferred).
- Applying the brief mechanism to `generate-stems` (this spec targets tracks).

## Success criteria

- A "fred again" batch can and does use vocal/pad sample sounds and shares a coherent
  artist brief across tracks, while still varying per track.
- The validated⇒playable contract holds (new sounds both validate and play).
- No regression in the existing test suite.
