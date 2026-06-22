# Strudel Kit Design Guide (Stage 1 — bespoke per-batch kits)

You are designing ONE batch's **instrument kit**: a small set of named, designed
voice fragments — a kick, a bass, a lead, a pad/choir, maybe a vocal-chop and a
texture — that every track in the batch will be built from. This is where the
batch's sonic identity and originality live. A fresh kit is designed for **every**
batch from the batch's sound brief; you do not reuse a previous batch's kit or the
stems library.

The kit is saved as `palettes/<batch>.json`. The validator
(`node scripts/save-palette.mjs staging/<batch>.json`) validates **every voice
like a stem** and only saves a kit where all voices pass.

## How a kit voice relates to a stem

Each kit voice is, sonically, a **stem** — one designed sound — but written as a
bare Strudel **sub-expression** (no `setcpm`, no `arrange`, no outer `stack`): just
the voice itself, e.g. `s("crate_bd*4").gain(1.0)` or
`note("<c1 eb1>").s("sine").fm(4).fmh(2).lpf(...)...`. The validator wraps each
`frag` in a one-layer `stack(...)` (plus its `samples()` preamble) and runs the
Phase 1 dynamic validator on it.

**Read `STEMS_GUIDE.md` for the sound-design vocabulary** — FM, formant/`vowel`,
vibrato (`.vib`/`.vibmod`), wavetables, dirt (`crush`/`shape`/`coarse`/`distort`),
filter/pitch envelopes, sample mangling, the LFO motion engine, and the open
sound-loading rules (`samples('github:user/repo')`). Every technique there is
verified against the installed build and applies directly to kit voices.

## Open sound discovery (the point of designing fresh)

The base palette (`scripts/sounds.json`) is a floor, not a ceiling. To give the
batch real range, **load banks that fit the brief** at the top of a voice's `frag`
or declare them in the voice's `samples` array — `samples('github:user/repo')`
loads any bank exposing a `strudel.json` (its top-level keys are the sound names).
Original timbres also come from **synthesis** (no samples needed). Reach past the
defaults: a bespoke kit that only uses `bd/sd/hh` under a filter is not bespoke.

## Palette file format

`palettes/<batch>.json` — write it to `staging/<batch>.json` first, then save:

```json
{
  "batch": "<the batch id you were given>",
  "brief": "<the batch sound brief this kit was designed from>",
  "createdAt": "<ISO timestamp from `date -u +%Y-%m-%dT%H:%M:%SZ`>",
  "samples": ["github:user/repo"],
  "voices": [
    { "role": "kick", "name": "Vinyl Thump",
      "samples": ["github:eddyflux/crate"],
      "frag": "s(\"crate_bd*4\").gain(1.0)",
      "note": "<one line: the design intent / how it should be used>" },
    { "role": "bass", "name": "Round Sub", "samples": [],
      "frag": "note(\"<c1 eb1>*2\").s(\"sine\").lpf(280).gain(0.6)",
      "note": "warm sub bed" }
    /* … */
  ]
}
```

### Field rules

- **`role`** — one of: `kick`, `perc`, `bass`, `lead`, `pad`, `vocal`, `texture`.
  Roles may repeat (e.g. two `texture` voices) but the kit must span ≥3 distinct
  roles. Adapt the set sensibly to the brief (a beatless ambient brief might skip
  `kick`/`perc` and bring two `pad`s and two `texture`s).
- **`name`** — short, evocative, unique within the kit.
- **`frag`** — a single Strudel sub-expression, double-quoted strings only. NO
  `setcpm`, NO `arrange`, NO outer `stack` — just the voice. It may begin with its
  own `samples()` declared in `samples` (preferred) or inline at the top of `frag`.
- **`samples`** — array of bank sources this voice loads (`github:user/repo` or a
  `strudel.json` URL). The batch's effective sample set is the union of the
  top-level `samples` and every voice's `samples`.
- **`note`** — one line of design intent, so compose agents know how to use it.

### Kit requirements (the validator enforces structure; you enforce quality)

- **≥4 voices, ≥3 distinct roles.** Aim for 5–7: a kick/perc, a bass, a lead, a
  pad/choir, and a colour voice (vocal-chop and/or texture).
- **Every voice validates like a stem** — it must produce sound in the first 8
  cycles and reference only sounds that resolve (base palette ∪ what it loads).
- **Coherence is your job:** the voices should sound like ONE kit — a shared space
  (room/delay character), a shared tonal centre for pitched voices, complementary
  registers. This shared identity is what makes a batch hang together.
- **Originality is your job:** design, don't default. Each voice should be
  transformed past a stock preset (see STEMS_GUIDE's "Original sound" rule).

## Saving

```
mkdir -p staging
# write staging/<batch>.json
node scripts/save-palette.mjs staging/<batch>.json
```

`save-palette.mjs` validates every voice, vendors the kit's sample banks
(cache-on-save), writes `palettes/<batch>.json`, and prints
`PASS <batch> (<n> voices)` or `FAIL <batch> — <reason>`. On FAIL, fix the named
voice and re-run.

## Common failures

- `voice "<name>" failed: unknown sounds: X` → X resolves nowhere; `samples()` a
  bank that has it or pick a resolving name.
- `voice "<name>" failed: pattern produced no events` → the frag is silent in the
  first 8 cycles (all `~`, an all-`0` mask, or a too-slow gate). Make it sound now.
- `a kit must span at least 3 distinct roles` → diversify the `role`s.
- `voice N must have a frag` → every voice needs a Strudel sub-expression.
