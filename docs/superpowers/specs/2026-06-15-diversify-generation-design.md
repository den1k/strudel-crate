# Diversify generation — "Seed, don't copy" (amplified)

**Date:** 2026-06-15
**Status:** Approved design, pre-implementation
**Applies to:** stems (`generate-stems`, `STEMS_GUIDE.md`) **and** tracks (`generate-tracks`, `STRUDEL_GUIDE.md`)

## Problem

Generated sounds are too similar to each other, *across unrelated briefs*. Measured on the
corpus on disk:

Stems (122 files):
- 100% use a `sine.slow(N).range(...)` LFO
- 100% wrap in `stack(`
- 99% end with `.room(`
- 76% use `.ftype("ladder")`
- 46% use the `.off(1/8, x => x.add(note(12)))` octave doubler

Tracks (67 files):
- 100% use `.room(`
- 97% use an `lpf(sine|saw .slow)` filter sweep
- 69% use a `sawtooth` voice

An "alien sound", a "beachy reggaeton mallet" and a "roaring bass" come out with the *same
signal chain* — only the note register and `s()` source differ.

### Root cause

Three reinforcing mechanisms (full diagnosis in conversation, 2026-06-15):

1. **Shared finished instruments.** Each guide ends with 2–3 *complete, copy-paste,
   known-good* code blocks. LLM agents anchor hard on concrete example code, so the
   example's signature moves (ladder filter, `sine.slow` sweep, `.room`, octave `.off`)
   propagate into nearly every output.
2. **Rules prescribe one motion device.** "Modulate ≥3 dimensions" + "use slow LFOs
   `sine.slow(16).range(a,b)`" + the "prime-ish LFO periods" tip funnel every agent to the
   *same* device: a slow sine sweeping a lowpass into a reverb tail.
3. **Validate-or-delete selects for the safe idiom.** A stem/track only survives if
   `validate.mjs` passes; failing agents get 3 tries then `rm`. So agents gravitate to the
   known-good template rather than risk deletion.

The per-item **variation directive** (skill step 4) is meant to counter this but is
overpowered by the concrete shared example.

### Evidence the cure works

The tracks guide lists 8 drum-machine banks as a **menu** ("pick ONE"). Result: banks are
*evenly spread* (TR909 only 27%, the rest 5–13%). A per-agent **menu** diversifies; a
shared **full example** homogenizes. The design turns synthesis choice into the same kind
of per-agent menu and removes the shared finished instrument.

## Goal

Maximum **musical, in-brief** variety — as varied as possible while every output still (a)
matches the brief and (b) passes `validate.mjs`. Not literal maximum (= noise).

## Design

Core mechanic: **stop handing agents a finished instrument to copy.** Instead:

- The guide teaches **structure/grammar only** (an abstract skeleton + the existing
  technique/menu tables), no copyable synthesis chain.
- The orchestrator hands each agent a **distinct, composed seed** (a *starting point*, not
  a finished sound) plus **extension constraints** that diversify *how* the agent develops
  the sound — because the convergence lives in the extension, not the source.

### Component 1 — combinatorial seed pools (new JSON, read by the orchestrator only)

`shared/stem-seeds.json` and `shared/track-seeds.json`. **Read by the orchestrator and
injected one-per-agent — never placed in the guide** (the guide is read wholesale by every
agent, which would recreate "everyone sees the same example").

Combinatorial, not a fixed list, so a 30-batch never repeats a starting point:

**Stem seeds:**
```jsonc
{
  "sources": [        // ~10, one+ per synthesis-core family
    { "id": "fm-sine", "family": "FM", "appliesTo": "synth",
      "frag": "note(\"<...>\").s(\"sine\").fm(8)", "note": "FM bass core; push fm/fmh on different clocks" },
    { "id": "supersaw", "family": "subtractive", "appliesTo": "synth", "frag": "...", "note": "..." },
    { "id": "noise-white", "family": "noise-sculpt", "appliesTo": "synth", "frag": "s(\"white*2\")", "note": "..." },
    { "id": "dirt-metal", "family": "sample-mangle", "appliesTo": "sample", "frag": "s(\"metal\")", "note": "..." }
    // ... formant, pluck/physical, layered-detune, wavetable-ish, sub, ...
  ],
  "signatures": [     // ~8, the 1-2 defining transforms
    { "id": "vowel", "appliesTo": "any", "frag": ".vowel(\"<a e i o>/3\")", "note": "formant character" },
    { "id": "chop", "appliesTo": "sample", "frag": ".chop(16).speed(\"<1 -1 0.5>\")", "note": "granular" },
    { "id": "crush-ramp", "appliesTo": "any", "frag": ".crush(saw.slow(32).range(16,5))", "note": "degradation arc" }
    // ... phaser, hard fm, vib seasick, tremolo gate, ...
  ]
}
```
Each agent's seed = one `source` × one *compatible* `signature` (compatibility via
`appliesTo`: sample-only signatures pair only with sample sources). Effective space ≈
10 × 8 ≈ 80 combos → easily 30 distinct.

**Track seeds:** same shape, but seeds are *groove/harmonic engines*, not instruments —
e.g. a drum-pattern fragment × a harmonic-engine fragment (× a bank picked from the
existing menu). Examples of source families: broken-kick, four-on-floor, breakbeat, trap,
half-time, no-drums-pad-led. Signatures: dub-chord stabs, arp engine, sub-bass line,
piano-led, sampled-texture bed. The agent must arrange the seed into a full 3–6 min
`arrange()`.

### Component 2 — extension constraints (amplifiers 2–4), assigned per agent

Extend skill step 4 so each agent also receives, and must obey:

- **Modulation set** — a *required, distinct* subset of ≥3 dimensions from
  {pitch, timbre, filter, space, motion, degradation}. Spread subsets across the batch;
  the lazy default trio (filter+pan+shape) is allowed for at most a small minority.
- **Motion mechanism** — assigned from {slow LFO (sine/saw/tri/square), stepped `<…>/N`,
  envelope-driven, euclid/ply, perlin/rand}. **Not always `sine.slow`.**
- **Tail** — assigned from {dry, room-only, delay-only, room+delay, granular/no-reverb}.
- **Forbids** — explicit per-agent bans derived from the above, e.g. "no `.room()`" for
  dry-tail agents; "`sine.slow` may not be your primary motion" for stepped/envelope
  agents; (tracks) "not TR909", "no sawtooth acid bass" for some.

These attach the variety to the *extension*, which is where today's 99–100% convergence
lives.

### Component 3 — guide edits

`STEMS_GUIDE.md` and `STRUDEL_GUIDE.md`:

- **Replace** the "Complete examples (these validate)" full code blocks with **one abstract
  skeleton** — structure + slot comments, no copyable synthesis values. Stem example:
  ```
  setcpm(<bpm>/4)
  stack(
    note("<…your pitch…>").s("<…your source…>")
      // ≥3 modulated dims, each on its own slow clock (prime-ish periods)
      // a built-in 8–32 cycle morph arc; your own tail; gain 0.3–1.2
  )
  ```
  (Tracks: an `arrange()` skeleton with commented section roles, no concrete instruments.)
- **Keep** the technique/arsenal tables and mini-notation cheatsheet — menus, not chains.
- **Reframe** "Recipes by sound family" as idea-prompts: add one line — *"starting points,
  not the only answer; your assigned seed is your real start."*
- **Add** a short "Your seed" note: transform & **extend** the seed into a complete original
  sound; do not paste it unchanged; do not collapse into a generic `sine.slow` filter-sweep
  into reverb; obey your assigned modulation set / motion mechanism / tail / forbids.

### Component 4 — skill edits

`generate-stems` and `generate-tracks` `SKILL.md`:

- **Step 4:** add "Read the seed pool. Assign each agent one composed seed
  (source × compatible signature) whose source `family` matches the agent's synthesis-core
  axis; no two agents in a wave share a (source × signature) pair; spread sources/signatures
  evenly across the batch. Also assign the modulation set, motion mechanism, tail, and
  resulting forbids (Component 2)."
- **Step 5 prompt template:** inject `{seed}`, `{seed_note}`, `{modulation_set}`,
  `{motion_mechanism}`, `{tail}`, `{forbids}` with the "extend, don't paste, don't converge"
  instruction.

### Component 5 — seed self-validation (new `scripts/validate-seeds.mjs`, wired into `npm test`)

For each `source` alone, and each `source × compatible signature` combo, wrap into a
minimal valid stem/stack and run it through the existing `validate.mjs`. A broken seed
fails the test → cannot poison a batch. Cheap (~tens of tiny snippets).

## Data flow

orchestrator reads seed pool → composes a distinct seed per agent + assigns extension
constraints (matched to the agent's directive axes) → injects into the agent prompt → agent
reads the guide (abstract skeleton only) + its unique seed + constraints → extends the seed
along the assigned modulation set / motion mechanism / tail → `validate.mjs` → survives.

## Testing / acceptance

- `scripts/validate-seeds.mjs` green in `npm test` (every seed individually known-good).
- Regenerate a small stem batch (count 8) and a small track batch, then re-run the diagnosis
  frequency script. **Acceptance:**
  - No single signature move >~70% (vs current 97–100%): specifically `sine.slow` LFO,
    `.room`, and (tracks) `sawtooth` all drop well below 100%.
  - Synthesis cores spread across ≥5 families in a 30-batch.
  - Survival rate stays healthy (≥~24/30) — seeds keep reliability up despite more invention.

## Out of scope (YAGNI)

- **Post-batch similarity gate (#3)** — not in this pass; the per-agent-distinct seed +
  extension constraints + acceptance check are expected to suffice. Revisit if batches still
  cluster.
- **Validator's per-item contract** — untouched.
- **Feedback digest homogenization** — flagged as a residual: the cross-batch "lessons"
  digest is injected *identically* into every agent, so shared lessons re-converge a batch
  over time. A later fix (per-agent or rotated lessons) is out of scope here.

## Files touched

- New: `shared/stem-seeds.json`, `shared/track-seeds.json`, `scripts/validate-seeds.mjs`
- Edited: `STEMS_GUIDE.md`, `STRUDEL_GUIDE.md`,
  `.claude/skills/generate-stems/SKILL.md`, `.claude/skills/generate-tracks/SKILL.md`
- `package.json` test wiring for `validate-seeds.mjs`
