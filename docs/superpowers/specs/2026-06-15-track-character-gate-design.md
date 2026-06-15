# Track Character Gate — Design

**Date:** 2026-06-15
**Branch:** `worktree-track-character-gate`
**Status:** Approved design, pending implementation plan

## Problem

Generated tracks "lack complexity" and "sound generic." This is distinct from the
sonic-convergence problem that `diversify-generation` already fixed (tracks sounding
like *each other*). The new complaint is that each *individual* track is bland.

Inspecting a recent track ("Felt Rain on Concrete") confirms the shape of the problem.
The track is competently *arranged* — six `arrange()` sections, layers entering and
leaving, a real arc — but generic in specific ways:

- **Harmonically safe:** nothing but diatonic C-minor triads and stepwise square-wave
  melodies. No tension, characterful intervals, modulation, or surprise.
- **Rhythmically square:** everything on the grid (`bd ~ ~ ~ sd ~ ~ ~`, `hh*8`). No
  syncopation, polyrhythm, swing, micro-timing, or ratcheting.
- **One kind of movement everywhere:** a slow triangle LFO on the low-pass filter, on
  nearly every layer. The whole "movement" arsenal collapses to filter sweeps.
- **Timbrally thin:** the dirt/character tools (`crush`, `shape`, `coarse`, `vowel`,
  speed tricks, `jux`, `off`) are barely touched.

### Root cause

The pipeline rewards *safe + validates + different-from-siblings*, but nothing pushes
toward *interesting*. Concretely:

1. The guide's "what makes it interesting" section is a **menu, not a requirement** —
   agents cherry-pick the single cheapest move (a filter sweep) and stop.
2. **Validation only checks playability** (sounds allowlisted, bpm matches, not silent).
   A bland track passes exactly as easily as a brilliant one. There is no quality gate.

"Generic" is therefore the local optimum the system is designed to find.

## Approach

Chosen: **raise the floor** (prompt/guide level) **with light validator teeth**.
Rejected for now: a critic/revision loop (deferred as a possible Phase 2 — only worth
paying for if the floor alone proves insufficient).

The validator gains a cheap **static character check** that gates *track files only*.
The guide and agent prompt are rewritten to state the requirement forcefully. Seeds are
left unchanged (enrichment was considered and dropped to avoid re-introducing sibling
convergence and to keep the change minimal).

## Key constraint discovered

Stems and tracks **share the exact same JSON shape** and **both route through
`validateTrack`** in `scripts/validate.mjs`. The only discriminator is the directory
(`tracks/` vs `stems/`). Stems are *not* the generic problem (a sampled stem uses FM +
pitch-envelope modulation — genuinely rich sound design). Therefore the character gate
**must apply to track files only**, keyed on the file path, and must leave stems, the
`--code` CLI path, and the existing `validateCode`/seed tests untouched.

## Design

### 1. Validator: static character check (track files only)

Add to `scripts/validate.mjs`:

**`characterCheck(code)` → `{ ok, present: string[], missing: string[] }`**

Scans the code string for markers in 4 categories; `ok` iff **≥3 of 4** present.

| Category | Present if code contains… | Does NOT count |
|---|---|---|
| **harmonic** | a 4+ note chord `[a,b,c,d]`; `.add(note(…))`; a characterful mode (`:dorian` `:phrygian` `:lydian` `:mixolydian` `:locrian` `:harmonic` `:melodic`); a `<…>` progression of ≥4 entries | plain 3-note triads, bare `:minor`/`:major` |
| **rhythmic** | euclid `(n,m)`; `.swingBy`/`.swing`/`.nudge`/`.early`/`.late`; odd multiples `*3 *5 *7` | `*4`, `*8`, on-grid `bd ~ ~ ~` |
| **timbral** | `.crush` `.shape` `.coarse` `.vowel` `.fm`/`.fmh` `.speed(` (non-1) `.distort` | `.lpf`/`.hpf`/`.room`/`.delay`, incl. the generic filter sweep |
| **transform** | `.every` `.off` `.jux` `.sometimesBy`/`.often`/`.rarely` `.ply` `.mask` `.degradeBy` `.iter` `.chunk` `.palindrome` | — |

Detection is regex on the source string. To keep categories meaningfully distinct,
operators that could span two families (`.off`, `.ply`) are counted under **transform**
only, not rhythmic — rhythmic stays strictly euclid/swing/nudge/odd-multiple so that
"3 of 4" genuinely means three different kinds of move.

**Threshold:** ≥3 of 4 (approved). Validation against the known-generic track:
"Felt Rain on Concrete" scores **1/4** (only `.every(...rev())` + `.degradeBy`, both
transform) → correctly fails.

**Wiring:**
- `validateTrack(track, opts = {})` runs the character check only when `opts.character`
  is truthy, and only *after* `validateCode(track.code)` returns ok (a track must be
  playable first). Default (no opts) preserves current behavior — so seed tests and any
  stem validation that calls `validateTrack` directly are unaffected.
- `validateTarget(arg)` sets `character: true` **only when the resolved file path is
  under a `tracks/` directory**. `stems/…` and `--code` never trigger it.

**Failure message** (specific, so the agent can fix within its 3 attempts):
```
lacks character: present [harmonic, transform]; need ≥3 of
{harmonic, rhythmic, timbral, transform} — add e.g. an off-grid groove
(euclid/swing) or dirt (crush/shape/vowel)
```

**Acknowledged crudeness:** the check rewards *using* the operators, not *using them
well* — an agent could game it. Accepted: the goal is only to make the laziest possible
track (on-grid triads under one filter sweep) no longer pass, forcing reach into the
arsenal. Quality-of-use is what a deferred critic loop would judge.

### 2. Guide: menu → hard requirement

Rewrite `STRUDEL_GUIDE.md`'s "Movement & variation (what makes it interesting)" section
into **"Character requirement (HARD — the validator enforces it)"**:
- List the 4 categories with 2–3 concrete code examples each.
- State explicitly: *a track of on-grid triads under a filter sweep is a FAILURE even
  though it would otherwise validate.*
- Note that the generic filter sweep does **not** satisfy the timbral category.

### 3. Agent prompt: state the bar

In `.claude/skills/generate-tracks/SKILL.md` agent prompt:
- Add a requirement: the track MUST include character moves from **≥3 of the 4 distinct
  families** (harmonic, rhythmic, timbral, transform).
- Add "lacks character" to step 4's list of validator failures to read and fix on
  re-validation.

### 4. Seeds

No change. (Enrichment considered and dropped.)

### 5. Tests

`test/validate.test.mjs`:
- `characterCheck` detects each category from crafted snippets (one positive per
  category, one negative that should NOT trip it — e.g. `*8` and bare `:minor`).
- The known-generic track scores <3 and fails.
- A rich track (extended chord + euclid + crush + `.every`) passes.
- `validateTrack` *without* `character` opt passes a plain stem-shaped object
  (stems not gated).
- `validateTrack` *with* `character: true` fails the generic track and passes the rich
  one.

Regression: existing valid stems still pass through the CLI path (`validateTarget` does
not gate `stems/…`).

## Out of scope / deferred

- **Critic/revision loop (Phase 2):** an agent that scores harmonic/rhythmic/timbral/
  motif *quality* and sends weak tracks back for one revision. Only build if the floor
  alone proves insufficient after listening to a regenerated batch.
- **Seed enrichment.**
- Any change to stem generation.

## Success criteria

- The known-generic track fails the gate; a richer track passes.
- A freshly generated batch (smoke test) shows audibly more harmonic/rhythmic/timbral
  variety than the pre-change baseline, with no regression in validation pass rate that
  isn't attributable to genuinely lazy tracks being correctly rejected and revised.
- Stems and the `--code` path are entirely unaffected.
