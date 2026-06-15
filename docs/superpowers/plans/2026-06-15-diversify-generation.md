# Diversify Generation ("Seed, don't copy") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop stem/track generation from converging on one sonic template by removing the shared finished-instrument examples and instead injecting a distinct, validated seed plus extension constraints into each agent.

**Architecture:** A combinatorial seed pool (`source × signature`) lives in JSON read only by the orchestrator, which composes one distinct seed per agent and assigns per-agent extension constraints (modulation set, motion mechanism, tail, forbids). The guides teach structure-only. A vitest test proves every composable seed individually passes the existing `validate.mjs`.

**Tech Stack:** Node ESM, vitest, `@strudel/transpiler`/`@strudel/core` (via `scripts/validate.mjs` → `validateCode`), JSON data files, Markdown guides/skills.

**Branch:** `diversify-generation` (already created and holds the design spec commit).

**Spec:** `docs/superpowers/specs/2026-06-15-diversify-generation-design.md`

---

## File Structure

- **Create** `shared/stem-seeds.json` — `{ sources: [...], signatures: [...] }` for stems.
- **Create** `shared/track-seeds.json` — `{ sources: [...], signatures: [...] }` for tracks (sources = grooves, signatures = harmonic engines).
- **Create** `scripts/seeds.mjs` — pure helpers: `loadSeeds(kind)`, `composePairs(pool)`, `wrapStem(code)`, `wrapTrack(sourceFrag, signatureFrag)`. Imported by both the test and (documented for) the orchestrator.
- **Create** `test/seeds.test.mjs` — validates every source-alone and every compatible `source × signature` pair through `validateCode`, plus structural invariants. Auto-runs under `npm test`.
- **Modify** `STEMS_GUIDE.md` — replace full examples with an abstract skeleton; reframe recipes; add "Your seed" note.
- **Modify** `STRUDEL_GUIDE.md` — same for tracks.
- **Modify** `.claude/skills/generate-stems/SKILL.md` — seed assignment in step 4; seed/constraint injection in step 5 prompt.
- **Modify** `.claude/skills/generate-tracks/SKILL.md` — same.

`scripts/validate.mjs` exports `validateCode(code)` (already verified). No `package.json` change needed — vitest auto-discovers `test/*.test.mjs`.

---

## Task 1: Seed helpers + data + validation test (TDD)

**Files:**
- Create: `scripts/seeds.mjs`
- Create: `shared/stem-seeds.json`
- Create: `shared/track-seeds.json`
- Test: `test/seeds.test.mjs`

### Design of the data shape

Each `sources[]` entry: `{ "id", "family", "appliesTo": "synth"|"sample", "frag", "note" }`.
`frag` is a **complete, concrete, known-good** Strudel expression starting from `note(...)`/`s(...)` (NO `<...>` placeholders — real notes/sounds).

Each `signatures[]` entry: `{ "id", "appliesTo": "synth"|"sample"|"any", "frag", "note" }`.
`frag` is a chainable suffix beginning with `.` (e.g. `.vowel("<a e i o>/3")`).

Compatibility: a `source × signature` pair is valid iff `signature.appliesTo === "any"` OR `signature.appliesTo === source.appliesTo`.

> **How to guarantee frags validate:** derive each `frag` from an already-validated file in `stems/` or `tracks/` (those passed `validate.mjs`), stripped down to a single source + (for signatures) a single transform. The Task-1 test is the gate — iterate frags until green.

- [ ] **Step 1: Write `scripts/seeds.mjs`**

```js
// Pure helpers for the generation seed pools. No side effects beyond reading JSON.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Load a seed pool. kind = 'stem' | 'track'. */
export function loadSeeds(kind) {
  const file = join(ROOT, 'shared', `${kind}-seeds.json`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** True if a signature can attach to a source. */
export function compatible(source, signature) {
  return signature.appliesTo === 'any' || signature.appliesTo === source.appliesTo;
}

/** All valid source × signature pairs for a pool. */
export function composePairs(pool) {
  const pairs = [];
  for (const source of pool.sources) {
    for (const signature of pool.signatures) {
      if (compatible(source, signature)) pairs.push({ source, signature });
    }
  }
  return pairs;
}

/** Wrap a single stem expression into a minimal valid stem program. */
export function wrapStem(code) {
  return `stack(\n  ${code}.gain(0.8)\n)`;
}

/** Wrap a track groove + harmonic engine into a minimal valid track program. */
export function wrapTrack(sourceFrag, signatureFrag) {
  return `stack(\n  ${sourceFrag},\n  ${signatureFrag}\n)`;
}
```

- [ ] **Step 2: Write the failing test `test/seeds.test.mjs`**

```js
import { describe, it, expect } from 'vitest';
import { validateCode } from '../scripts/validate.mjs';
import { loadSeeds, composePairs, wrapStem, wrapTrack, compatible } from '../scripts/seeds.mjs';

describe('stem seeds', () => {
  const pool = loadSeeds('stem');

  it('has at least 5 distinct synthesis families', () => {
    const fams = new Set(pool.sources.map((s) => s.family));
    expect(fams.size).toBeGreaterThanOrEqual(5);
  });

  it('every source validates on its own', async () => {
    for (const s of pool.sources) {
      const res = await validateCode(wrapStem(s.frag));
      expect(res.ok, `source ${s.id}: ${res.error}`).toBe(true);
    }
  });

  it('every compatible source × signature pair validates', async () => {
    for (const { source, signature } of composePairs(pool)) {
      const res = await validateCode(wrapStem(source.frag + signature.frag));
      expect(res.ok, `${source.id} × ${signature.id}: ${res.error}`).toBe(true);
    }
  });

  it('yields at least 30 distinct composable seeds', () => {
    expect(composePairs(pool).length).toBeGreaterThanOrEqual(30);
  });
});

describe('track seeds', () => {
  const pool = loadSeeds('track');

  it('every compatible groove × engine pair validates', async () => {
    for (const { source, signature } of composePairs(pool)) {
      const res = await validateCode(wrapTrack(source.frag, signature.frag));
      expect(res.ok, `${source.id} × ${signature.id}: ${res.error}`).toBe(true);
    }
  });

  it('yields at least 20 distinct composable seeds', () => {
    expect(composePairs(pool).length).toBeGreaterThanOrEqual(20);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/seeds.test.mjs`
Expected: FAIL — `shared/stem-seeds.json` does not exist (ENOENT) / `loadSeeds` throws.

- [ ] **Step 4: Write `shared/stem-seeds.json`**

Start from this draft (≥8 sources spanning ≥6 families, ≥6 signatures). Every `frag` must be derived from a validated `stems/*.json` so it is known-good; the Step-5 run is the gate.

```json
{
  "sources": [
    { "id": "fm-sine-bass", "family": "FM", "appliesTo": "synth",
      "frag": "note(\"<c1 c1 eb1 g0>*4\").s(\"sine\").fm(8).fmh(1.5)",
      "note": "FM sine bass. Push fm/fmh on different clocks; add a penv click." },
    { "id": "supersaw-reese", "family": "subtractive", "appliesTo": "synth",
      "frag": "note(\"<f1 f1 ab1 c2>*4\").s(\"supersaw\").unison(5).detune(0.3)",
      "note": "Detuned reese. Drive with distortion or a stepped filter env, not only a sine sweep." },
    { "id": "saw-formant-lead", "family": "formant", "appliesTo": "synth",
      "frag": "note(\"<c4 [c4 d4] f4 eb4>/2\").s(\"sawtooth\")",
      "note": "Formant lead base. Cycle vowels + vibrato; keep it mid/high." },
    { "id": "noise-texture", "family": "noise-sculpt", "appliesTo": "synth",
      "frag": "s(\"white*2\").lpf(1200).resonance(14)",
      "note": "Noise sculpt. Sweep the filter with saw/perlin; pan-scatter for width." },
    { "id": "triangle-pluck", "family": "pluck", "appliesTo": "synth",
      "frag": "note(\"<c3 eb3 g3 bb3>*4\").s(\"triangle\").attack(0.001).decay(0.18).sustain(0)",
      "note": "Short pluck. Motion via penv/ply/euclid rather than a slow LFO." },
    { "id": "square-sub", "family": "sub", "appliesTo": "synth",
      "frag": "note(\"<c1 c1 g0 c1>*2\").s(\"square\").lpf(400)",
      "note": "Sub voice. Keep it dark; add subtle tremolo or degradation, avoid big reverb." },
    { "id": "metal-mangle", "family": "sample-mangle", "appliesTo": "sample",
      "frag": "s(\"metal*4\")",
      "note": "Metallic sample. Mangle with chop/striate/speed for a granular cloud." },
    { "id": "east-mangle", "family": "sample-mangle", "appliesTo": "sample",
      "frag": "s(\"east*2\")",
      "note": "Pitched dirt sample. Striate + speed play; let it stutter." }
  ],
  "signatures": [
    { "id": "vowel-morph", "appliesTo": "synth", "frag": ".vowel(\"<a e i o>/3\")",
      "note": "Formant character; cycles vowels across the loop." },
    { "id": "crush-ramp", "appliesTo": "any", "frag": ".crush(saw.slow(32).range(16, 5))",
      "note": "Degradation arc; bit depth falls over 32 cycles." },
    { "id": "hard-fm", "appliesTo": "synth", "frag": ".fm(\"<2 6 11 4>/8\").fmh(\"<1 1.5 0.5>/4\")",
      "note": "Stepped FM index — metallic, evolving without an LFO." },
    { "id": "seasick-vib", "appliesTo": "synth", "frag": ".vib(\"<3 5 7>/8\").vibmod(0.9)",
      "note": "Slow deep vibrato; unstable pitch." },
    { "id": "tremolo-gate", "appliesTo": "any", "frag": ".tremolosync(\"<4 8 16>/8\").tremolodepth(0.7)",
      "note": "Rhythmic gating; motion engine on its own." },
    { "id": "chop-cloud", "appliesTo": "sample", "frag": ".chop(16).speed(\"<1 -1 0.5>\")",
      "note": "Granular cloud from one hit; reverse play." },
    { "id": "striate-weave", "appliesTo": "sample", "frag": ".striate(8).pan(perlin.range(0.1, 0.9))",
      "note": "Interleaved grains scattered across the stereo field." }
  ]
}
```

- [ ] **Step 5: Run the stem-seed tests; fix frags until green**

Run: `npx vitest run test/seeds.test.mjs -t "stem seeds"`
Expected: PASS. If any pair fails, read the `res.error` in the assertion message and fix that `frag` (unknown sound → grep `scripts/sounds.json`; eval error → unbalanced brackets). Re-run until green.

- [ ] **Step 6: Write `shared/track-seeds.json`**

Sources = groove fragments (drums), signatures = harmonic-engine fragments. Derive each from a validated `tracks/*.json`.

```json
{
  "sources": [
    { "id": "four-on-floor-909", "family": "four-on-floor", "appliesTo": "any",
      "frag": "s(\"bd*4\").bank(\"RolandTR909\").gain(1.1)",
      "note": "Driving 4/4 kick. Pair with any harmonic engine; vary the bank per batch." },
    { "id": "broken-808", "family": "broken", "appliesTo": "any",
      "frag": "s(\"bd ~ [~ bd] ~\").bank(\"RolandTR808\").gain(1.1)",
      "note": "Broken/syncopated kick; trap or downtempo feel." },
    { "id": "breakbeat-linn", "family": "breakbeat", "appliesTo": "any",
      "frag": "s(\"bd ~ sd [bd bd]\").bank(\"LinnDrum\").gain(1.0)",
      "note": "Breakbeat skeleton; add ghost hats." },
    { "id": "half-time-dmx", "family": "half-time", "appliesTo": "any",
      "frag": "s(\"bd ~ ~ ~ sd ~ ~ ~\").bank(\"OberheimDMX\").gain(1.0)",
      "note": "Half-time heavy groove." },
    { "id": "no-drums-pad", "family": "beatless", "appliesTo": "any",
      "frag": "note(\"<c2 ab1>/2\").s(\"sawtooth\").lpf(500).room(0.5).gain(0.5)",
      "note": "Beatless pad bed; ambient starting point with no kit at all." }
  ],
  "signatures": [
    { "id": "dub-chord-stabs", "appliesTo": "any",
      "frag": "note(\"~ <[c3,eb3,g3]> ~ <[ab2,c3,eb3]>\").s(\"sawtooth\").lpf(900).room(0.5).gain(0.5)",
      "note": "Off-beat dub chord stabs." },
    { "id": "arp-engine", "appliesTo": "any",
      "frag": "n(\"0 2 4 7\").scale(\"C3:minor\").s(\"square\").decay(0.1).sustain(0).gain(0.5)",
      "note": "Driving arpeggio." },
    { "id": "sub-bassline", "appliesTo": "any",
      "frag": "note(\"<c1 c1 eb1 g0>*4\").s(\"sine\").lpf(300).gain(0.6)",
      "note": "Rolling sub bassline." },
    { "id": "piano-led", "appliesTo": "any",
      "frag": "note(\"<[c3,eb3,g3] [ab2,c3,eb3]>\").s(\"piano\").room(0.4).gain(0.6)",
      "note": "Felt-piano chord lead." }
  ]
}
```

- [ ] **Step 7: Run the full seeds test; fix frags until green**

Run: `npx vitest run test/seeds.test.mjs`
Expected: PASS (all describe blocks). Fix any failing `frag` per its error message; re-run.

- [ ] **Step 8: Commit**

```bash
git add scripts/seeds.mjs shared/stem-seeds.json shared/track-seeds.json test/seeds.test.mjs
git commit -m "feat: combinatorial seed pools + validation test for generation"
```

---

## Task 2: Rewrite STEMS_GUIDE.md examples → structure-only

**Files:**
- Modify: `STEMS_GUIDE.md` (the "Complete examples (these validate)" section, lines ~90–127; the "Recipes by sound family" section, lines ~82–88)

- [ ] **Step 1: Replace the "Complete examples (these validate)" section**

Replace the entire section (from the `## Complete examples (these validate)` heading through the "Pro move … the loop feels alive." paragraph) with:

````markdown
## Shape skeleton (NOT an instrument to copy)

Your stem must fit this shape. The comments mark the slots YOU fill — do not copy any
specific synthesis chain; that is exactly what makes every stem sound the same.

```
setcpm(<bpm>/4)
stack(
  note("<…your pitch pattern…>").s("<…your source…>")
    // start from your assigned SEED, then build it out:
    // • modulate your assigned dimensions (≥3), each on its own slow clock
    //   (prime-ish periods: 7, 11, 13, 16, 23, 29, 32 — so they don't realign)
    // • use your assigned MOTION MECHANISM for the morph arc (8–32 cycles)
    // • finish with your assigned TAIL; per-layer .gain() 0.3–1.2
    // • honor your FORBIDS — do not fall back to a generic sine.slow filter
    //   sweep into reverb
)
```

The arsenal table above is your menu. Combine its techniques in ways the menu doesn't
spell out — surprising combinations are the whole point.
````

- [ ] **Step 2: Reframe the "Recipes by sound family" section**

Immediately under the `## Recipes by sound family` heading, insert this line before the bullet list:

```markdown
*These are idea-prompts, not the only answer — your assigned seed is your real starting
point. Treat a recipe as one possible direction, never as a template to reproduce.*
```

- [ ] **Step 3: Add a "Your seed" note**

After rule 6 in "## Stem rules (hard requirements)", add a new rule:

```markdown
7. **Start from your seed, then transform and EXTEND it.** You are given one synthesis
   seed (a source + a signature move) and a set of extension constraints (which
   dimensions to modulate, the motion mechanism, the tail, and explicit forbids). Build a
   complete, original stem around the seed — do NOT paste it unchanged, and do NOT
   collapse into a generic `sine.slow` filter-sweep-into-reverb. The seed is where you
   begin; the constraints are how you stay different from your siblings.
```

- [ ] **Step 4: Verify the guide still scans**

Run: `grep -n "Complete examples (these validate)" STEMS_GUIDE.md`
Expected: no output (section removed). Then `grep -n "Shape skeleton" STEMS_GUIDE.md` → one match.

- [ ] **Step 5: Commit**

```bash
git add STEMS_GUIDE.md
git commit -m "docs: STEMS_GUIDE teaches structure-only, not a copyable instrument"
```

---

## Task 3: Rewrite STRUDEL_GUIDE.md examples → structure-only

**Files:**
- Modify: `STRUDEL_GUIDE.md` (the "Complete examples (these validate)" section, lines ~159–192)

- [ ] **Step 1: Replace the "Complete examples (these validate)" section**

Replace the entire section (from `## Complete examples (these validate)` through the final `arrange(...)` code block) with:

````markdown
## Shape skeleton (NOT a track to copy)

Your track must fit one of these shapes. The comments mark the slots YOU fill — do not
copy any specific instrument or groove; that is what makes every track sound the same.
Start from your assigned SEED (a groove + a harmonic engine) and arrange it out.

Full track (the default):

```
setcpm(<bpm>/4)
arrange(
  [16, stack( /* intro: your seed, stripped back + filtered */ )],
  [32, stack( /* build: add layers from your assigned dimensions */ )],
  [32, stack( /* main: full groove + your harmonic engine */ )],
  [16, stack( /* breakdown: drop drums, your assigned tail/space */ )],
  [24, stack( /* peak: everything + your motion mechanism for variation */ )],
  [12, stack( /* outro: strip back to the intro elements */ )]
)
```

Honor your FORBIDS — do not fall back to a `sawtooth` acid bass under a `sine.slow`
filter sweep into reverb just because it validates. The drum-bank menu and the arsenal
above are yours to combine in unexpected ways.
````

- [ ] **Step 2: Add a "Your seed" note**

After rule 6 in "## Code rules (hard requirements)", add:

```markdown
7. **Start from your seed, then arrange and EXTEND it.** You are given one track seed (a
   groove + a harmonic engine) and extension constraints (dimensions to develop, motion
   mechanism, tail, forbids). Grow it into a complete 3–6 min `arrange()` — do NOT paste
   the seed unchanged, and do NOT collapse into a `sawtooth` + `sine.slow` sweep + reverb
   default. The seed is your start; the constraints keep you different from your siblings.
```

- [ ] **Step 3: Verify**

Run: `grep -n "Complete examples (these validate)" STRUDEL_GUIDE.md`
Expected: no output. Then `grep -n "Shape skeleton" STRUDEL_GUIDE.md` → one match.

- [ ] **Step 4: Commit**

```bash
git add STRUDEL_GUIDE.md
git commit -m "docs: STRUDEL_GUIDE teaches structure-only, not a copyable track"
```

---

## Task 4: generate-stems SKILL.md — seed assignment + injection

**Files:**
- Modify: `.claude/skills/generate-stems/SKILL.md` (step 4 block, lines ~33–46; step 5 prompt template, lines ~48–80)

- [ ] **Step 1: Extend step 4 with seed + constraint assignment**

After the existing step-4 axis bullet list (the line ending "...hollow · screaming · liquid · broken"), add:

```markdown

   Then assign each stem its **seed and extension constraints** (read
   `shared/stem-seeds.json`):
   - **seed:** one `source × signature` pair (compatible per `appliesTo`) whose
     `source.family` fits the stem's synthesis-core axis. No two stems in a wave share a
     pair; spread sources and signatures as evenly as the pool allows across the batch.
   - **modulation set:** a distinct subset of ≥3 dimensions from {pitch, timbre, filter,
     space, motion, degradation}. The lazy trio (filter + pan + shape) may go to at most
     ~2 stems in a 30-batch; everyone else gets a different subset.
   - **motion mechanism:** one of {slow LFO (sine/saw/tri/square), stepped `<…>/N`,
     envelope-driven, euclid/ply, perlin/rand} — and NOT `sine.slow` for the majority.
   - **tail:** one of {dry, room-only, delay-only, room+delay, granular/no-reverb}.
   - **forbids:** derive bans from the above, e.g. "no `.room()`" for dry/no-reverb
     tails, "`sine.slow` may not be your primary motion" for stepped/envelope mechanisms.
```

- [ ] **Step 2: Inject the seed + constraints into the agent prompt (step 5)**

In the fenced agent-prompt template, replace the line:

```
   2. Sound brief: "{prompt}". Your variation directive: {directive}.
```

with:

```
   2. Sound brief: "{prompt}". Your variation directive: {directive}.
      Your SEED (your starting point — transform and EXTEND it; do NOT paste it
      unchanged, do NOT collapse into a generic sine.slow filter-sweep into reverb):
      {seed}
      ({seed_note})
      Extension constraints you MUST obey: modulate these dimensions: {modulation_set};
      motion mechanism: {motion_mechanism}; tail: {tail}; forbids: {forbids}.
```

- [ ] **Step 3: Verify placeholders are consistent**

Run: `grep -n "{seed}\|{modulation_set}\|{motion_mechanism}\|{tail}\|{forbids}" .claude/skills/generate-stems/SKILL.md`
Expected: the injected lines appear. Confirm no other `{seed*}` typos.

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/generate-stems/SKILL.md
git commit -m "feat: generate-stems assigns distinct seeds + extension constraints per agent"
```

---

## Task 5: generate-tracks SKILL.md — seed assignment + injection

**Files:**
- Modify: `.claude/skills/generate-tracks/SKILL.md` (step 4 block, lines ~33–41; step 5 prompt template, lines ~50–74)

- [ ] **Step 1: Extend step 4 with seed + constraint assignment**

After the existing step-4 axis bullet list (the line ending "...darker, dreamier, rawer, funkier (fit to prompt)"), add:

```markdown

   Then assign each track its **seed and extension constraints** (read
   `shared/track-seeds.json`):
   - **seed:** one `source (groove) × signature (harmonic engine)` pair (compatible per
     `appliesTo`). No two tracks in a wave share a pair; spread grooves and engines
     evenly across the batch.
   - **drum bank:** pick ONE bank from the guide's menu, varied across the batch (don't
     let RolandTR909 dominate).
   - **development dimensions:** which layers/parameters evolve across sections (≥3:
     e.g. filter opening, layer add/drop, progression shift, space change).
   - **motion mechanism:** one of {slow LFO, stepped `<…>/N`, envelope, euclid/ply,
     perlin/rand} — not `sine.slow` for the majority.
   - **tail:** one of {dry, room-only, delay-only, room+delay}.
   - **forbids:** e.g. "not RolandTR909", "no `sawtooth` acid bass", "`sine.slow` may not
     be your primary filter motion" — spread these so the batch doesn't converge.
```

- [ ] **Step 2: Inject the seed + constraints into the agent prompt (step 5)**

Replace the line:

```
   2. Style brief: "{prompt}". Your variation directive: {directive}.
```

with:

```
   2. Style brief: "{prompt}". Your variation directive: {directive}.
      Your SEED (groove + harmonic engine — your starting point; arrange and EXTEND it,
      do NOT paste it unchanged, do NOT collapse into sawtooth + sine.slow sweep + reverb):
      {seed}
      ({seed_note})
      Extension constraints you MUST obey: drum bank: {drum_bank}; develop these
      dimensions across sections: {development_dimensions}; motion mechanism:
      {motion_mechanism}; tail: {tail}; forbids: {forbids}.
```

- [ ] **Step 3: Verify**

Run: `grep -n "{seed}\|{development_dimensions}\|{motion_mechanism}\|{tail}\|{forbids}\|{drum_bank}" .claude/skills/generate-tracks/SKILL.md`
Expected: injected lines appear; no typos.

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/generate-tracks/SKILL.md
git commit -m "feat: generate-tracks assigns distinct seeds + extension constraints per agent"
```

---

## Task 6: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: all tests pass, including `test/seeds.test.mjs`. (Note: the memory map flags a possible heap issue on very large validation runs; if `seeds.test.mjs` OOMs, run it alone with `node --max-old-space-size=4096 ./node_modules/.bin/vitest run test/seeds.test.mjs`.)

- [ ] **Step 2: Confirm guides no longer contain a copyable full instrument**

Run: `grep -rn "Complete examples (these validate)" STEMS_GUIDE.md STRUDEL_GUIDE.md`
Expected: no output.

- [ ] **Step 3: Manual acceptance (user-run, documented here)**

After merge, regenerate a small batch and re-run the diagnosis frequency check:
- `/generate-stems "complex upbeat bassline with roaring synths" 8`
- Re-run the frequency script from the diagnosis over the new batch only.
- **Acceptance:** `sine.slow` LFO usage, `.room` usage, and (tracks) `sawtooth` usage each well below 100% (target ≤~70%); synthesis cores spread across ≥5 families; survival ≥~6/8 (≥~24/30 at full size).

This step is manual and not a blocker for merging the mechanism; it measures the outcome.

- [ ] **Step 4: Final commit if any verification fixes were made** (otherwise skip)

```bash
git add -A && git commit -m "chore: verification fixes for diversify-generation"
```
