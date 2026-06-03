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
  "code": "<strudel code as a single JSON string, \\n for newlines>",
  "createdAt": "<ISO timestamp, e.g. from `date -u +%Y-%m-%dT%H:%M:%SZ`>"
}
```

## Code rules (hard requirements)

1. **Shape:** optional `setcpm(<bpm>/4)` on the first line, then ONE final expression:
   `stack(...)` for a loop-based sketch, or `arrange(...)` of stack sections for a
   full track. Nothing else. No `$:` labels, no variable assignments, no `samples()`,
   no `await`, no visual functions (`.pianoroll()`, `.scope()`, `.punchcard()`, …).
2. **Double quotes** for all pattern strings (they become mini-notation). Never single quotes.
3. **Sounds:** only names listed in `scripts/sounds.json`. The validator rejects anything else.
4. **Tempo:** `setcpm(130/4)` = 130 BPM with 4 beats per cycle. Without it, tempo is ~120bpm.
5. Keep per-layer `.gain()` between 0.3 and 1.2.
6. **The first 8 cycles must produce sound** — the validator queries cycles 0-8; an
   arrangement that opens with silence fails.

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

## Making it a COMPLETE track (3–5 minutes), not a loop

Listeners rate these as tracks. Direct listener feedback: *"too slow and monotonous —
give it build and movement; it should be a complete track, 3-5 minutes."* At
`setcpm(130/4)` one cycle ≈ 1.8s, so a 3.5-minute track ≈ 110+ cycles of evolution.

**Approach A — `arrange()` sections** (preferred for full tracks). Each section is its
own `stack(...)`; arrange plays them in sequence for the given cycle counts:

```
setcpm(132/4)
arrange(
  [16, stack(...intro: drums + filtered bass...)],
  [32, stack(...main groove: add melody, open the filter...)],
  [16, stack(...breakdown: drop drums, pads + space...)],
  [32, stack(...peak: everything + variation...)],
  [16, stack(...outro: strip back down...)]
)
```

**Approach B — one evolving `stack`** with long-cycle gates and sweeps:
- Gate layers in/out over a long arc: `.mask("<1!8 0!24>/32")` (layer exits at cycle 8)
- 32-cycle filter journeys: `.lpf(saw.slow(32).range(300, 3000))`
- Section-length alternation: `"<x y>/8"` patterns change every 8 cycles
- Fills at boundaries: `.every(16, x => x.ply(2))`

Either way: something must CHANGE every 8-16 cycles — a layer entering, a filter
opening, a progression shifting. Repetition without development gets rated down.

## Complete examples (these validate)

Driving acid techno sketch (loop-based):

```
setcpm(130/4)
stack(
  s("bd*4").bank("RolandTR909").gain(1.1),
  s("[~ hh]*4").bank("RolandTR909").gain(0.7).pan(sine.range(0.3, 0.7)),
  s("~ cp ~ cp").bank("RolandTR909").room(0.3),
  note("<c2 c2 eb2 g1>*8").s("sawtooth").lpf(sine.slow(4).range(200, 1800)).resonance(12).decay(0.12).sustain(0).gain(0.8)
)
```

Arranged techno track (full-track shape):

```
setcpm(132/4)
arrange(
  [8, stack(
    s("bd*4").bank("RolandTR909").gain(1.1),
    s("[~ hh]*4").bank("RolandTR909").gain(0.6)
  )],
  [16, stack(
    s("bd*4").bank("RolandTR909").gain(1.1),
    s("[~ hh]*4").bank("RolandTR909").gain(0.6),
    note("<c2 eb2 g1 bb1>*8").s("sawtooth").lpf(saw.slow(16).range(300, 2500)).decay(0.1).sustain(0).gain(0.8)
  )],
  [8, stack(
    note("<c2 eb2>*4").s("sawtooth").lpf(600).room(0.4).gain(0.7),
    s("~ cp ~ cp").bank("RolandTR909").room(0.5).gain(0.6)
  )]
)
```

## Common validator failures

- `unknown sounds: X` → X isn't in `scripts/sounds.json`; grep it for alternatives.
- `evaluation failed: ...` → usually unbalanced `[ ] < > ( )` in mini-notation, or a
  typo'd function name.
- `did not evaluate to a Pattern` → code doesn't end with the `stack(...)`/`arrange(...)` expression.
- `no events` → everything is `~`/`silence`, a mask that is all `0`, or an arrangement
  whose first 8 cycles are silent.
