# Strudel Track Writing Guide

You are writing one track as a JSON file in `tracks/`. Follow this guide exactly —
the validator (`node scripts/validate.mjs tracks/<id>.json`) enforces most of it.

## Track file format

`tracks/<id>.json` — ALL fields required:

```json
{
  "id": "<batch>-<NN>",
  "title": "Short Evocative Name",
  "prompt": "<the user's style prompt, verbatim>",
  "batch": "<batch id you were given>",
  "description": "<1-3 sentences for a listener: what it sounds like, how it develops>",
  "meta": {
    "bpm": <integer matching your setcpm>,
    "genre": "<e.g. dub techno>",
    "mood": "<e.g. hypnotic, cavernous>",
    "key": "<e.g. F minor>",
    "instruments": ["<sounds/banks you actually used>"],
    "energy": <1-5>
  },
  "code": "<strudel code as a single JSON string, \\n for newlines>",
  "createdAt": "<ISO timestamp, e.g. from `date -u +%Y-%m-%dT%H:%M:%SZ`>"
}
```

## Metadata rules

- `meta.bpm` MUST equal the BPM in your `setcpm(<bpm>/4)` — the validator cross-checks.
  No `setcpm` in the code → bpm must be 120 (the default).
- `energy`: 1 = ambient/beatless · 2 = downtempo · 3 = head-nod groove · 4 = dancefloor ·
  5 = peak-time. Match what the code actually does.
- `instruments`: the sounds you actually used, listener-facing (e.g. "RolandTR909 kit",
  "sawtooth bass", "piano") — not every control name.
- `key`: the musical key implied by your `scale()`/`note()` choices (e.g. "C minor").
- `description`: 1–3 sentences for a listener — what it sounds like and how it
  develops. No code talk.

## Code rules (hard requirements)

1. **Shape:** optional `setcpm(<bpm>/4)` on the first line, then ONE final expression:
   `stack(...)` for a loop-based sketch, or `arrange(...)` of stack sections for a
   full track. Nothing else. No `$:` labels, no variable assignments, no `samples()`,
   no `await`, no visual functions (`.pianoroll()`, `.scope()`, `.punchcard()`, …).
2. **Double quotes** for all pattern strings (they become mini-notation). Never single quotes.
3. **Sounds:** only names listed in `scripts/sounds.json`. The validator rejects anything else. The check covers the entire arrangement, including late sections.
4. **Tempo:** `setcpm(130/4)` = 130 BPM with 4 beats per cycle. Without it, tempo is ~120bpm.
5. Keep per-layer `.gain()` between 0.3 and 1.2.
6. **The first 8 cycles must produce sound** — the validator queries cycles 0-8; an
   arrangement that opens with silence fails.
7. **Start from your seed, then arrange and EXTEND it.** You are given one track seed (a
   groove + a harmonic engine) and extension constraints (dimensions to develop, motion
   mechanism, tail, forbids). Grow it into a complete 3–6 min `arrange()` — do NOT paste
   the seed unchanged, and do NOT collapse into a `sawtooth` + `sine.slow` sweep + reverb
   default. The seed is your start; the constraints keep you different from your siblings.

## Sound palette

- **Synths** (use with `note(...)` or `n(...).scale(...)`): `sine`, `square`, `triangle`,
  `sawtooth`, `supersaw`; noise: `white`, `pink`, `brown`.
- **Drums** (use with `s(...)` + `.bank(...)`): `bd` kick, `sd` snare, `hh` closed hat,
  `oh` open hat, `cp` clap, `rim` rimshot, `lt mt ht` toms, `cr` crash, `rd` ride.
  Banks (pick ONE per track for coherence): `RolandTR808`, `RolandTR909`, `RolandTR707`,
  `RolandTR606`, `LinnDrum`, `AkaiLinn`, `OberheimDMX`, `CasioRZ1`.
  The validator checks `<Bank>_<sound>` combos against `scripts/sounds.json`.
- **Sampled instruments:** `piano` (velvety felt piano). Classic dirt-samples without a
  bank: `casio`, `jvbass`, `arpy`, `space`, `numbers`, `insect`, `wind`, `crow`, `metal`,
  `jazz`, `east` — check `scripts/sounds.json` when in doubt; many have multiple variants
  selectable with `.n(2)`.
- **Do NOT use** `gm_*` soundfonts (not loaded by the webapp).

## Mini-notation cheatsheet

| Syntax | Meaning |
|---|---|
| `"bd sd hh sd"` | sequence within one cycle |
| `~` | rest |
| `[bd bd] sd` | subdivide a step |
| `<c2 eb2 g1>` | alternate per cycle (slowcat) — great for chord progressions |
| `bd*4` | repeat 4× within the step |
| `bd(3,8)` | euclidean rhythm: 3 hits over 8 slots |
| `[c3,e3,g3]` | chord / parallel |
| `hh?` or `hh?0.3` | random drop (degrade) |
| `c3@3 e3` | elongate (weight 3:1) |
| `"<x y>/2"` | slow alternation (one value per 2 cycles) |

## Melody & harmony

Prefer scale degrees over raw notes — they always sound in key:

```
n("0 2 4 <7 9>").scale("C3:minor").s("sawtooth")
```

Good scales: `:minor`, `:major`, `:dorian`, `:mixolydian`, `:minor:pentatonic`,
`:phrygian`. Chords: `note("<[c3,eb3,g3] [ab2,c3,eb3]>")`. Octave shift: `.add(note(12))`
or pick the register in the scale root (`"C2:minor"`).

## Shaping sound (chainable controls)

- Filter: `.lpf(800)` low-pass, `.hpf(200)` high-pass, `.resonance(10)`; sweep with an
  LFO: `.lpf(sine.slow(8).range(200, 2000))`
- Envelope: `.attack(0.01).decay(0.15).sustain(0).release(0.1)` (percussive pluck)
- Space: `.room(0.4)` reverb, `.delay(0.3)` (or `.delay(".5:.125:.7")` wet:time:feedback)
- Dirt: `.crush(6)` bitcrush, `.shape(0.4)` distortion, `.coarse(4)` downsample
- Stereo: `.pan(0.2)` or `.pan(sine.range(0.2, 0.8))`
- Sample tweaks: `.speed(2)` pitch/rate, `.n(3)` sample variant, `.cut(1)` choke group (hats!)
- Vowel filter: `.vowel("<a e o>")`

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

## Making it a COMPLETE track (3–6 minutes) — THE DEFAULT

**Every track defaults to 3–6 minutes with an intro, an elaborate middle, and an
outro.** Only write a short loop sketch if the style prompt explicitly asks for one.
Direct listener feedback: *"too slow and monotonous — give it build and movement; it
should be a complete track."*

Size the arrangement from the tempo: total cycles ≈ minutes × BPM / 4 (one cycle = one
4/4 bar). At `setcpm(130/4)`, 4 minutes ≈ 130 cycles. Budget your `arrange()` section
lengths to add up to that.

**Approach A — `arrange()` sections** (the default shape). Each section is its own
`stack(...)`; arrange plays them in sequence for the given cycle counts. Intro and
outro are mandatory; the middle should develop — add/remove layers, open filters,
shift progressions between sections:

```
setcpm(132/4)
arrange(
  [16, stack(...intro: reduced kit, filtered, sets the mood...)],
  [32, stack(...build: add bass + hats, filter opening...)],
  [32, stack(...main: full groove + melody...)],
  [16, stack(...breakdown: drop drums, pads + space...)],
  [24, stack(...peak: everything + variation/fills...)],
  [12, stack(...outro: strip back down to the intro elements...)]
)
```
(132 cycles ≈ 4 min at 132 BPM.)

**Approach B — one evolving `stack`** with long-cycle gates and sweeps:
- Gate layers in/out over a long arc: `.mask("<0!8 1!24>")` — silent 8 cycles, in for 24,
  repeating every 32. Pair with always-on layers so the track's first 8 cycles aren't empty.
- 32-cycle filter journeys: `.lpf(saw.slow(32).range(300, 3000))`
- Section-length alternation: `"<x y>/8"` patterns change every 8 cycles
- Fills at boundaries: `.every(16, x => x.ply(2))`

Either way: something must CHANGE every 8-16 cycles — a layer entering, a filter
opening, a progression shifting. Repetition without development gets rated down.

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
filter sweep into reverb just because it validates. That shape now FAILS the character
check (see "Character requirement" above): a track must use moves from ≥3 of the
4 categories — harmonic, rhythmic, timbral, transform. The drum-bank menu and the
arsenal above are yours to combine in unexpected ways.

## Common validator failures

- `unknown sounds: X` → X isn't in `scripts/sounds.json`; grep it for alternatives.
- `evaluation failed: ...` → usually unbalanced `[ ] < > ( )` in mini-notation, or a
  typo'd function name.
- `did not evaluate to a Pattern` → code doesn't end with the `stack(...)`/`arrange(...)` expression.
- `no events` → everything is `~`/`silence`, a mask that is all `0`, or an arrangement
  whose first 8 cycles are silent.
