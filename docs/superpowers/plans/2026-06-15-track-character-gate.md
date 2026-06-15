# Track Character Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `validate.mjs` reject "generic" tracks by requiring character moves from ≥3 of 4 categories (harmonic, rhythmic, timbral, transform), gated on track files only, and update the guide + agent prompt to state the requirement.

**Architecture:** A pure `characterCheck(code)` scans the Strudel source string with regexes for markers in 4 categories. `validateTrack` runs it only when `opts.character` is set, after playability passes. A pure `isTrackPath(arg)` decides routing, and `validateTarget` sets `character: true` only for files under `tracks/`. Stems, the `--code` path, and the existing `validateCode`/`validateTrack(track)` callers are unaffected.

**Tech Stack:** Node ESM (`scripts/validate.mjs`), Vitest (`test/validate.test.mjs`), Markdown docs (`STRUDEL_GUIDE.md`, `.claude/skills/generate-tracks/SKILL.md`).

**Spec:** `docs/superpowers/specs/2026-06-15-track-character-gate-design.md`

---

### Task 1: `characterCheck` pure function + unit tests

**Files:**
- Modify: `scripts/validate.mjs` (add exported `characterCheck`)
- Test: `test/validate.test.mjs` (new `describe('characterCheck')` block)

- [ ] **Step 1: Write the failing tests**

Add at the end of `test/validate.test.mjs` (after the `validateTrack` describe block, before the final EOF). Update the import on line 2 to (add `characterCheck` only — `isTrackPath` is added in Task 2 so this task's test file links cleanly):

```js
import { validateCode, validateTrack, characterCheck } from '../scripts/validate.mjs';
```

Then append:

```js
describe('characterCheck', () => {
  it('detects a 4+ note chord as harmonic', () => {
    expect(characterCheck('note("[c3,e3,g3,b3]")').present).toContain('harmonic');
  });

  it('detects a characterful mode as harmonic', () => {
    expect(characterCheck('n("0 2 4").scale("C3:dorian")').present).toContain('harmonic');
  });

  it('detects a 4-entry progression as harmonic', () => {
    expect(characterCheck('note("<c2 eb2 f1 g1>")').present).toContain('harmonic');
  });

  it('does NOT count a bare triad in plain minor as harmonic', () => {
    const c = characterCheck('note("[c3,e3,g3]").s("piano")\nn("0 2 4").scale("C3:minor")');
    expect(c.present).not.toContain('harmonic');
  });

  it('detects euclid as rhythmic', () => {
    expect(characterCheck('s("bd(3,8)").bank("RolandTR909")').present).toContain('rhythmic');
  });

  it('detects swing as rhythmic', () => {
    expect(characterCheck('s("hh*8").swingBy(0.1, 8)').present).toContain('rhythmic');
  });

  it('detects an odd repeat multiple as rhythmic', () => {
    expect(characterCheck('s("hh*3")').present).toContain('rhythmic');
  });

  it('does NOT count even multiples or .range as rhythmic', () => {
    const c = characterCheck('s("hh*8").lpf(sine.slow(8).range(200, 2000))');
    expect(c.present).not.toContain('rhythmic');
  });

  it('detects dirt effects as timbral', () => {
    expect(characterCheck('s("bd*4").crush(6)').present).toContain('timbral');
    expect(characterCheck('note("c3").s("sawtooth").vowel("a")').present).toContain('timbral');
    expect(characterCheck('s("arpy").speed(2)').present).toContain('timbral');
  });

  it('does NOT count plain filter/space or .speed(1) as timbral', () => {
    const c = characterCheck('note("c3").lpf(800).hpf(200).room(0.4).delay(0.3).speed(1)');
    expect(c.present).not.toContain('timbral');
  });

  it('detects pattern transforms', () => {
    expect(characterCheck('s("bd*4").every(4, x => x.rev())').present).toContain('transform');
    expect(characterCheck('s("bd*4").off(0.125, x => x.gain(0.5))').present).toContain('transform');
  });

  it('passes a rich track (4 of 4) and fails a generic one (1 of 4)', () => {
    const rich = 'note("[c3,eb3,g3,bb3]").s("sawtooth").crush(6)\ns("bd(3,8)").bank("RolandTR909").every(4, x => x.fast(2))';
    const richResult = characterCheck(rich);
    expect(richResult.ok).toBe(true);
    expect(richResult.present.length).toBeGreaterThanOrEqual(3);

    const generic = 'note("<[c3,eb3,g3] [ab2,c3,eb3]>").s("piano").lpf(sine.slow(8).range(400,1200)).room(0.4)\ns("bd ~ ~ ~ sd ~ ~ ~").bank("CasioRZ1")\ns("hh*8").bank("CasioRZ1").degradeBy(0.2)';
    const genericResult = characterCheck(generic);
    expect(genericResult.ok).toBe(false);
    expect(genericResult.missing).toEqual(expect.arrayContaining(['harmonic', 'rhythmic', 'timbral']));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/validate.test.mjs`
Expected: FAIL — `characterCheck is not a function` (and `isTrackPath` import undefined).

- [ ] **Step 3: Implement `characterCheck`**

In `scripts/validate.mjs`, after the `validateCode` function (after line 47) and before the `// ---- CLI` comment, insert:

```js
// ---- Character gate (track files only) -------------------------------------
// A static, deliberately-crude check that a track reaches beyond the generic
// floor (on-grid triads under a filter sweep). It rewards USING operators from
// distinct families, not using them well — quality-of-use is out of scope.
// Regexes run against the raw code string. See the design doc for rationale.
const CHARACTER_CATEGORIES = {
  // Harmonic richness beyond bare triads: a 4+ note chord, a transposition/
  // voicing move, a characterful mode, or a >=4-entry progression.
  harmonic: [
    /\[[^\]]*?(?:,[^\],]*?){3,}\]/,                                  // chord with >=4 members
    /\.add\(\s*note/,                                                // .add(note(...))
    /:(?:dorian|phrygian|lydian|mixolydian|locrian|harmonic|melodic)/,
    /<[^>]*?\S+(?:\s+\S+){3,}[^>]*?>/,                               // <a b c d ...> (>=4 tokens)
  ],
  // Off-grid rhythm. Euclid is a mini-notation token `word(n,m)` NOT preceded
  // by a dot — so method calls like .range(200, 2000), .every(4, …), .pan(…)
  // and .off(…) are never mistaken for euclid (verified: a quoted-string match
  // false-positives on `.range(a,b)` between two strings).
  rhythmic: [
    /(?<!\.)\b\w+\(\s*\d+\s*,\s*\d+\s*(?:,\s*\d+\s*)?\)/,            // word(n,m[,r]) euclid
    /\.(?:swingBy|swing|nudge|early|late)\b/,
    /\*\s*(?:3|5|7|9|11|13)\b/,                                      // odd repeat multiple
  ],
  // Timbral dirt/character — NOT plain filter/space (lpf/hpf/room/delay).
  timbral: [
    /\.(?:crush|shape|coarse|vowel|distort)\b/,
    /\.fmh?\b/,                                                      // .fm / .fmh
    /\.speed\(\s*(?!1\s*\))(?!1\.0+\s*\))[^)]*\)/,                   // .speed(non-1)
  ],
  // Pattern transforms / conditional variation. .off and .ply live here only
  // (not rhythmic) so "3 of 4" means three genuinely different move types.
  transform: [
    /\.(?:every|off|jux|sometimesBy|sometimes|often|rarely|someCycles|ply|mask|degradeBy|degrade|iter|chunk|palindrome)\b/,
  ],
};

export function characterCheck(code) {
  const present = [];
  const missing = [];
  for (const [category, patterns] of Object.entries(CHARACTER_CATEGORIES)) {
    (patterns.some((re) => re.test(code)) ? present : missing).push(category);
  }
  return { ok: present.length >= 3, present, missing };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/validate.test.mjs`
Expected: PASS — the `characterCheck` block is green and the existing `validateCode`/`validateTrack` blocks still pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/validate.mjs test/validate.test.mjs
git commit -m "feat: add characterCheck() character gate for tracks

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Wire the gate into `validateTrack` + path routing

**Files:**
- Modify: `scripts/validate.mjs` (`validateTrack` signature + body; add `isTrackPath`; `validateTarget`)
- Test: `test/validate.test.mjs` (gate-wiring + `isTrackPath` tests)

- [ ] **Step 1: Write the failing tests**

First, update the import on line 2 of `test/validate.test.mjs` to add `isTrackPath`:

```js
import { validateCode, validateTrack, characterCheck, isTrackPath } from '../scripts/validate.mjs';
```

Then append to `test/validate.test.mjs`:

```js
describe('character gate wiring', () => {
  const genericTrack = () => ({
    id: 't', title: 'T', prompt: 'p', batch: 'b',
    description: 'A plain triad sketch under a filter sweep.',
    meta: { bpm: 120, genre: 'techno', mood: 'flat', key: 'C minor', instruments: ['piano'], energy: 3 },
    code: 'setcpm(120/4)\nstack(note("<[c3,eb3,g3] [ab2,c3,eb3]>").s("piano").lpf(sine.slow(8).range(400,1200)).room(0.4), s("bd ~ ~ ~ sd ~ ~ ~").bank("CasioRZ1"), s("hh*8").bank("CasioRZ1").degradeBy(0.2))',
    createdAt: 'x',
  });
  const richTrack = () => {
    const t = genericTrack();
    t.code = 'setcpm(120/4)\nstack(note("[c3,eb3,g3,bb3]").s("sawtooth").crush(6), s("bd(3,8)").bank("RolandTR909"), s("hh*8").bank("RolandTR909").every(4, x => x.fast(2)))';
    return t;
  };

  it('does NOT gate by default (existing behavior preserved)', async () => {
    expect((await validateTrack(genericTrack())).ok).toBe(true);
  });

  it('gates the generic track when character:true', async () => {
    const result = await validateTrack(genericTrack(), { character: true });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/lacks character/);
  });

  it('passes a rich track when character:true', async () => {
    expect((await validateTrack(richTrack(), { character: true })).ok).toBe(true);
  });

  it('still reports a playability error before the character error', async () => {
    const t = genericTrack();
    t.code = 'note("c3 e3"';  // syntax error
    const result = await validateTrack(t, { character: true });
    expect(result.error).toMatch(/evaluation failed/);
  });
});

describe('isTrackPath', () => {
  it('is true for files under tracks/', () => {
    expect(isTrackPath('tracks/2026-06-15-foo-01.json')).toBe(true);
    expect(isTrackPath('/abs/path/tracks/x.json')).toBe(true);
  });
  it('is false for stems and other paths', () => {
    expect(isTrackPath('stems/2026-06-15-foo-01.json')).toBe(false);
    expect(isTrackPath('/abs/path/stems/x.json')).toBe(false);
    expect(isTrackPath('foo.json')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/validate.test.mjs`
Expected: FAIL — `isTrackPath is not a function`; "does NOT gate by default" may pass but the `character:true` and `isTrackPath` tests fail.

- [ ] **Step 3: Modify `validateTrack` to accept opts and run the gate**

In `scripts/validate.mjs`, change the `validateTrack` signature (line 65) and its final return (line 88). Replace:

```js
export async function validateTrack(track) {
```
with:
```js
export async function validateTrack(track, opts = {}) {
```

Replace the final line of the function:
```js
  return validateCode(track.code);
}
```
with:
```js
  const codeResult = await validateCode(track.code);
  if (!codeResult.ok || !opts.character) return codeResult;
  const c = characterCheck(track.code);
  if (!c.ok) {
    return {
      ok: false,
      error: `lacks character: present [${c.present.join(', ') || 'none'}]; need >=3 of {harmonic, rhythmic, timbral, transform} — add e.g. an off-grid groove (euclid/swing) or dirt (crush/shape/vowel)`,
    };
  }
  return codeResult;
}
```

- [ ] **Step 4: Add `isTrackPath` and use it in `validateTarget`**

In `scripts/validate.mjs`, add this exported helper just above `validateTarget` (above line 91):

```js
// True when the path points at a track file (gated for character), not a stem.
export function isTrackPath(arg) {
  return /(?:^|\/)tracks\/[^/]+\.json$/.test(arg);
}
```

Then in `validateTarget`, change the track-validation call. Replace:
```js
    return validateTrack(track);
```
with:
```js
    return validateTrack(track, { character: isTrackPath(arg) });
```

- [ ] **Step 5: Run the full test file to verify it passes**

Run: `npx vitest run test/validate.test.mjs`
Expected: PASS — all `validateCode`, `validateTrack`, `characterCheck`, character-gate-wiring, and `isTrackPath` tests green.

- [ ] **Step 6: Manually confirm CLI routing (tracks gated, stems not)**

Run:
```bash
node scripts/validate.mjs stems/$(ls stems | head -1)
```
Expected: `PASS stems/… (N events / 8 cycles)` — stems are never gated.

- [ ] **Step 7: Commit**

```bash
git add scripts/validate.mjs test/validate.test.mjs
git commit -m "feat: gate track files on character via validateTarget routing

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Rewrite the guide section into a hard requirement

**Files:**
- Modify: `STRUDEL_GUIDE.md` (the "Movement & variation" section, lines 113-123; and the "Honor your FORBIDS" paragraph near line 184)

- [ ] **Step 1: Replace the "Movement & variation" section**

In `STRUDEL_GUIDE.md`, replace the entire section that currently reads:

```
## Movement & variation (what makes it interesting)

- `<...>` progressions: `note("<c2 c2 f1 g1>")` = 4-bar bassline
- `.every(4, x => x.rev())` — vary every 4th cycle
- `.sometimesBy(0.25, x => x.speed(2))` — sprinkle variation
- `.off(0.125, x => x.add(note(12)).gain(0.6))` — echo a transposed copy
- `.mask("<1 1 1 0>")` — drop a layer out every 4th cycle (builds tension)
- `.degradeBy(0.2)` — humanize hats
- `.jux(rev)` — stereo-split a reversed copy
- `.ply("<1 1 2 4>")` — ratchet builds
- LFOs everywhere: `sine`, `saw`, `tri`, `square`, `rand`, `perlin` + `.range(a,b).slow(n)`
```

with:

```
## Character requirement (HARD — the validator enforces it)

A track that is on-grid triads under a single filter sweep is a **FAILURE** even
though it would otherwise validate. `node scripts/validate.mjs tracks/<id>.json`
runs a character check and **rejects any track that does not use moves from at
least 3 of these 4 categories.** Reach into the arsenal; do not stop at the first
cheap move.

**1. Harmonic** — go beyond bare triads:
- Extended chords (4+ notes): `note("<[c3,eb3,g3,bb3] [ab2,c3,eb3,g3]>")`
- Voicing/transposition: `.add(note("<0 0 5 7>"))`
- Characterful modes: `.scale("C3:dorian")`, `:phrygian`, `:lydian`, `:mixolydian`
- A real progression (≥4 chords): `note("<c2 eb2 f1 g1>")`
  *(Plain `:minor`/`:major` triads alone do NOT satisfy this.)*

**2. Rhythmic** — get off the grid:
- Euclidean rhythms: `s("bd(3,8)")`, `s("hh(5,8,2)")`
- Swing / micro-timing: `.swingBy(0.1, 8)`, `.nudge(0.02)`, `.late(0.01)`
- Odd ratchets: `s("hh*3")`, `s("sd*5")`
  *(Even multiples like `*4`/`*8` and `bd ~ ~ ~` do NOT satisfy this.)*

**3. Timbral** — add dirt/character, not just a filter:
- `.crush(6)` bitcrush · `.shape(0.4)` distortion · `.coarse(4)` downsample
- `.vowel("<a e o>")` formant · `.fm(4).fmh(2)` FM · `.speed(2)` for samples
  *(A `.lpf(...).range(...)` filter sweep does NOT satisfy this — it is the
  generic move we are trying to get past.)*

**4. Transform** — vary the pattern over time:
- `.every(4, x => x.rev())` · `.off(0.125, x => x.add(note(12)).gain(0.6))`
- `.sometimesBy(0.25, x => x.speed(2))` · `.mask("<1 1 1 0>")` · `.jux(rev)`
- `.ply("<1 1 2 4>")` ratchet builds · `.degradeBy(0.2)` humanize

LFOs (`sine`, `saw`, `tri`, `perlin` + `.range(a,b).slow(n)`) are great for motion,
but a filter LFO on its own counts toward NONE of the four categories — it is the
default everyone reaches for. Pick at least three different KINDS of move.
```

- [ ] **Step 2: Reinforce the "Honor your FORBIDS" paragraph**

In `STRUDEL_GUIDE.md`, find the paragraph (near line 184) that reads:

```
Honor your FORBIDS — do not fall back to a `sawtooth` acid bass under a `sine.slow`
filter sweep into reverb just because it validates. The drum-bank menu and the arsenal
above are yours to combine in unexpected ways.
```

Replace it with:

```
Honor your FORBIDS — do not fall back to a `sawtooth` acid bass under a `sine.slow`
filter sweep into reverb just because it validates. That shape now FAILS the character
check (see "Character requirement" above): a track must use moves from ≥3 of the
4 categories — harmonic, rhythmic, timbral, transform. The drum-bank menu and the
arsenal above are yours to combine in unexpected ways.
```

- [ ] **Step 3: Verify the guide is internally consistent**

Run: `grep -n "Character requirement\|character check\|3 of" STRUDEL_GUIDE.md`
Expected: shows the new section heading and the references added in Steps 1-2.

- [ ] **Step 4: Commit**

```bash
git add STRUDEL_GUIDE.md
git commit -m "docs: make track character a hard requirement in STRUDEL_GUIDE

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: State the bar in the agent prompt

**Files:**
- Modify: `.claude/skills/generate-tracks/SKILL.md` (agent prompt step 1 area, ~lines 69-82; and step 4, ~lines 90-93)

- [ ] **Step 1: Add the character requirement to the agent prompt**

In `.claude/skills/generate-tracks/SKILL.md`, inside the fenced agent prompt, find the line:

```
   1. Read STRUDEL_GUIDE.md COMPLETELY and follow every rule in it — including the
      default: a complete 3–6 minute track with intro, elaborate middle, and outro,
      built with arrange().
```

Replace it with:

```
   1. Read STRUDEL_GUIDE.md COMPLETELY and follow every rule in it — including the
      default: a complete 3–6 minute track with intro, elaborate middle, and outro,
      built with arrange(); and the HARD character requirement — your track MUST use
      moves from at least 3 of the 4 categories (harmonic, rhythmic, timbral,
      transform). On-grid triads under a single filter sweep will be REJECTED by the
      validator.
```

- [ ] **Step 2: Add "lacks character" to step 4's failure handling**

In the same fenced prompt, find:

```
   4. Run: node scripts/validate.mjs tracks/{id}.json
      If FAIL: read the error, fix the code (for unknown sounds, grep
      scripts/sounds.json for valid names), re-run. Up to 3 attempts total.
      If still failing after 3 attempts: delete the file (rm tracks/{id}.json).
```

Replace it with:

```
   4. Run: node scripts/validate.mjs tracks/{id}.json
      If FAIL: read the error, fix the code, re-run. Up to 3 attempts total.
      - unknown sounds → grep scripts/sounds.json for valid names.
      - "lacks character" → you used too few of the 4 categories; add an off-grid
        groove (euclid/swing), dirt (crush/shape/vowel), richer harmony (extended
        chords/mode), or a pattern transform until ≥3 categories are present.
      If still failing after 3 attempts: delete the file (rm tracks/{id}.json).
```

- [ ] **Step 3: Verify the prompt mentions the requirement**

Run: `grep -n "character\|3 of the 4\|lacks character" .claude/skills/generate-tracks/SKILL.md`
Expected: shows both new references.

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/generate-tracks/SKILL.md
git commit -m "docs: require >=3 of 4 character categories in generate-tracks prompt

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Full-suite regression + real-file smoke check

**Files:** none modified (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: all suites pass (baseline was 156 tests; this plan adds ~17 to `validate.test.mjs`). 0 failures.

- [ ] **Step 2: Smoke-check the gate against a real generic track and a real stem**

Copy an existing real track into `tracks/` under this worktree to confirm the CLI gates it (the worktree's `tracks/` is empty since it branched from `main`; use a crafted file):

```bash
cat > /tmp/generic-track.json <<'JSON'
{"id":"smoke","title":"Smoke","prompt":"p","batch":"b","description":"plain","meta":{"bpm":120,"genre":"techno","mood":"flat","key":"C minor","instruments":["piano"],"energy":3},"code":"setcpm(120/4)\nstack(note(\"<[c3,eb3,g3] [ab2,c3,eb3]>\").s(\"piano\").lpf(sine.slow(8).range(400,1200)).room(0.4), s(\"bd ~ ~ ~ sd ~ ~ ~\").bank(\"CasioRZ1\"), s(\"hh*8\").bank(\"CasioRZ1\").degradeBy(0.2))","createdAt":"x"}
JSON
mkdir -p tracks && cp /tmp/generic-track.json tracks/smoke.json
node scripts/validate.mjs tracks/smoke.json
rm tracks/smoke.json
```
Expected: `FAIL tracks/smoke.json — lacks character: present [...]; need >=3 of ...`

```bash
node scripts/validate.mjs stems/$(ls stems | head -1)
```
Expected: `PASS stems/… (N events / 8 cycles)` — stems never gated.

- [ ] **Step 3: No commit (verification task)**

If any check fails, return to the relevant task. Otherwise the feature is complete and ready for `superpowers:finishing-a-development-branch`.

---

## Notes for the implementer

- **Do not** make `validateTrack` gate by default — `goodTrack()` in the existing tests has zero character markers and must keep passing. The gate is opt-in via `opts.character`.
- **Do not** touch `validateCode` — it is the shared playability core used by stems and the seed tests.
- The regexes are intentionally crude (see the spec's "Acknowledged crudeness"). Do not try to make them semantically perfect; the bar is "lazy track no longer passes."
- The worktree branches from `main`, so `tracks/` and `stems/` may differ from the shared checkout. Task 5 Step 2 crafts its own files rather than relying on existing ones; `stems/` should still contain committed example stems from `main`.
