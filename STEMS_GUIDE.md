# Strudel Stem Writing Guide

You are writing one STEM as a JSON file in `stems/`. A stem is NOT a track: it is
ONE designed sound — a single star voice with deep sound design — that loops
forever with a built-in morph arc. Think "bass morph", "alien formant", "screaming
riser": something a producer would drop into their own track. Follow this guide
exactly — the validator (`node scripts/validate.mjs stems/<id>.json`) enforces
most of it.

## Stem file format

`stems/<id>.json` — ALL fields required (same schema as tracks):

```json
{
  "id": "<batch>-<NN>",
  "title": "Short Evocative Name",
  "prompt": "<the user's sound prompt, verbatim>",
  "batch": "<batch id you were given>",
  "description": "<1-3 sentences: what the sound is and how it morphs over the loop>",
  "meta": {
    "bpm": <integer matching your setcpm>,
    "genre": "<sound family, e.g. 'fm bass', 'formant lead', 'noise riser'>",
    "mood": "<e.g. menacing, liquid, hollow>",
    "key": "<musical key if pitched, e.g. 'C minor'; 'atonal' if not>",
    "instruments": ["<the star sound, listener-facing, e.g. 'fm sine bass'>"],
    "energy": <1-5: 1 = airy/ambient texture · 5 = aggressive/peak>
  },
  "code": "<strudel code as a single JSON string, \\n for newlines>",
  "createdAt": "<ISO timestamp, e.g. from `date -u +%Y-%m-%dT%H:%M:%SZ`>"
}
```

`meta.bpm` MUST equal the BPM in your `setcpm(<bpm>/4)`; no `setcpm` → bpm 120.

## Stem rules (hard requirements)

1. **Shape:** optional `setcpm(<bpm>/4)` on the first line, then ONE final
   `stack(...)` expression. **No `arrange()`** — stems are loops, not arrangements.
   No `$:` labels, no variable assignments, no `samples()`, no `await`, no visual
   functions (`.pianoroll()`, `.scope()`, …).
2. **ONE star sound.** A single voice carries the stem. At most ONE subtle support
   layer (gain ≤ 0.4) and only if it serves the star (e.g. a sine sub under a
   formant lead). No drum kits, no basslines-plus-pads — that's a track.
3. **Built-in morph arc.** The loop must evolve over 8–32 cycles and then repeat:
   use `<...>/N` step patterns and slow LFOs (`sine.slow(16).range(a, b)`) so one
   full pass takes ~15–65 seconds (one cycle = 240/bpm seconds: at 120 BPM,
   16 cycles = 32 s). A static 1-bar loop will be rated down.
4. **Modulate at least 3 dimensions** — pick from pitch (penv/accelerate/vib),
   timbre (fm/vowel/crush/shape/noise), filter (lpf/bpf + lpenv + resonance),
   space (room/delay/pan), motion (tremolo/speed/degrade). A raw waveform with one
   filter sweep is not sound design.
5. **Double quotes** for all pattern strings. **Sounds** only from
   `scripts/sounds.json`. **First 8 cycles must produce sound.** Per-stack-layer
   `.gain()` between 0.3 and 1.2 (support layer 0.3–0.4); echo copies inside
   `.off()`/`.jux()` chains may sit lower.
6. **Original sound.** Never leave a default tone untouched; transform the source
   until it's yours. Detune-thicken with `.off(0.01, x => x.add(note(0.1)))`,
   stereo-split with `.jux(rev)`, dirty up with `.shape()`/`.crush()` — make
   something a preset browser doesn't have.
7. **Start from your seed, then transform and EXTEND it.** You are given one synthesis
   seed (a source + a signature move) and a set of extension constraints (which
   dimensions to modulate, the motion mechanism, the tail, and explicit forbids). Build a
   complete, original stem around the seed — do NOT paste it unchanged, and do NOT
   collapse into a generic `sine.slow` filter-sweep-into-reverb. The seed is where you
   begin; the constraints are how you stay different from your siblings.

## Sound-design arsenal (all verified to work here)

| Technique | Controls |
|---|---|
| FM synthesis | `.fm(index)` `.fmh(harmonicity)` — both patternable/LFO-able; `fm` 2–15 is wild territory |
| Pitch envelope | `.penv(semitones).pattack(t).pdecay(t)` — 808 knocks, laser drops, risers (negative penv falls) |
| Filter envelope | `.lpenv(depth).lpattack(t).lpdecay(t)` + `.ftype("ladder")` for acid squelch |
| Filters | `.lpf(hz)` `.hpf(hz)` `.bpf(hz)` + `.resonance(0–20)`; sweep with LFOs |
| Vibrato | `.vib(hz).vibmod(semitones)` — slow+deep = seasick, fast+shallow = nervous |
| Formants | `.vowel("<a e i o u>")` — instant alien vocal character |
| Phaser | `.phaser(hz).phaserdepth(0–1)` |
| Tremolo | `.tremolosync(cyclesPerCycle).tremolodepth(0–1)` — rhythmic gating |
| Noise | `.noise(0–1)` blends noise into a synth voice; `s("white")`/`"pink"`/`"brown"` as sources |
| Degradation | `.coarse(n)` downsample · `.crush(bits)` · `.shape(0–1)` soft drive · `.distort(n)` hard · `.squiz(n)` pitch-mangle |
| Space | `.room(0–1)` · `.delay("wet:time:feedback")` e.g. `"0.5:0.375:0.7"` · `.orbit(n)` separate fx bus |
| Motion | `.pan(LFO)` · `.speed(n)` (negative = reverse) · `.accelerate(n)` pitch glide · `.detune(n)` |
| Sample mangling | `.chop(n)` granulate · `.striate(n)` interleave · `.cut(1)` choke · `.n(i)` variant — on dirt samples (`space`, `metal`, `wind`, `insect`, `east`, `numbers`, `crow`, `jazz`, `arpy`, `casio`) |
| Structure | `.off(t, f)` echo-copies · `.jux(rev)` stereo split · `.sometimesBy(p, f)` · `.every(n, f)` · `.ply(n)` · `.mask("...")` · `.degradeBy(p)` |
| LFOs | `sine` `saw` `tri` `square` `rand` `perlin` + `.range(a, b).slow(n)` — the morph arc's engine |

## Recipes by sound family

*These are idea-prompts, not the only answer — your assigned seed is your real starting
point. Treat a recipe as one possible direction, never as a template to reproduce.*

- **FM morph bass:** `sine` + `.fm(sine.slow(16).range(2, 14))` + stepped `.fmh("<1 1.5 2 0.5>/4")` + `.penv` click + ladder filter env.
- **Formant alien:** `sawtooth` + `.vowel("<a e i o u>/3")` + `.vib`/`.vibmod` + slow `.bpf` sweep + `.sometimesBy(0.15, x => x.speed(-1))`.
- **Noise riser/texture:** `s("white*2")` + `.lpf(saw.slow(8).range(200, 6000))` + high `.resonance` + `.pan(rand)`.
- **Sample mangle:** dirt sample + `.chop(16)` + `.speed("<1 -1 0.5>")` + `.striate(4)` — granular clouds from one hit.
- **Designed percussion:** short-decay synth + `.penv(24).pdecay(0.05)` + `.lpenv` + `.shape` — ONE sculpted hit pattern, not a kit.

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

## Common validator failures

- `unknown sounds: X` → X isn't in `scripts/sounds.json`; grep it for alternatives.
- `evaluation failed: ...` → unbalanced `[ ] < > ( )` in mini-notation, or a typo'd
  function name.
- `did not evaluate to a Pattern` → code doesn't end with the `stack(...)` expression.
- `no events` → everything is `~`/`silence`, or a mask that is all `0`.
