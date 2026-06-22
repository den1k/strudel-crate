# Open Sound Discovery & Bespoke Per-Batch Kits — Design

**Date:** 2026-06-22
**Status:** Design — pending implementation plan
**Topic:** Unlock the full range and originality of crate's generated music by
replacing the closed, hand-curated sound allowlist with an open, agent-driven
discovery pipeline, and by giving every batch a bespoke instrument kit designed
fresh from scratch.

---

## 1. Problem

crate generates Strudel tracks, but the output feels limited on four axes the
user named, all at once:

1. **Too samey / synthy** — tracks lean on the same handful of synths and drum
   machines.
2. **No real vocals / acoustic** — no convincing vocals, choirs, or organic
   textures.
3. **Genres / structures repeat** — everything drifts toward four-on-floor
   electronic grooves.
4. **Outputs converge / unoriginal** — within a batch, tracks resemble each
   other; agents fall into defaults.

The root cause is that the pipeline is **closed by construction**:

- `shared/sample-banks.json` — a fixed set of 7 prebaked banks.
- `scripts/sounds.json` — a static **1083-name allowlist** generated from those
  banks; the validator **rejects any sound not in it**.
- `STRUDEL_GUIDE.md` — a hand-curated palette listing a small subset of those
  sounds.
- `shared/track-seeds.json` — only **5 grooves × 4 harmonic engines = 20
  combos**, all electronic.

Agents can only use sounds the guide names, drawn from a fixed bank set, gated by
a static allowlist. Range is capped by human curation at every step.

### Goal

Make the system **open**: agents discover and load whatever samples and
synthesis fit the vibe, the system validates openly instead of restricting up
front, and every batch gets a **bespoke instrument kit designed fresh**. The
guide becomes a springboard (a map of the territory + how to find more), never a
fence.

### Non-goals

- **Agents recording/generating brand-new audio files.** "Open" means *load any
  fetchable sample bank + unlimited synthesis design*. Recording new audio needs
  hosting infrastructure and is out of scope. Original timbres come from
  synthesis (FM, wavetable, formant, etc.), which needs no samples.
- **Sung acapella hooks / lyrics.** Strudel cannot synthesize singing. Vocals in
  scope are: chops & textures, choir/ensemble pads, and robotic/formant
  (`vowel()`) timbres. Not looped copyrighted acapellas.
- No change to the rating/feedback storage model beyond extending it to kits
  (Phase 3).

---

## 2. Current architecture (for reference)

```
shared/sample-banks.json  ──build-sounds.mjs──▶  scripts/sounds.json (static allowlist)
                                                          │
generate-tracks SKILL ── style brief + track-seeds.json + variation directives
                                                          │
                              parallel compose agents ────┤
                                                          ▼
                          scripts/save-track.mjs ── validate.mjs (gate: every
                          referenced sound MUST be in the static allowlist;
                          code must produce sound in first 8 cycles)
                                                          │
                                                          ▼
                              InstantDB  ◀── webapp prebakes sample-banks.json,
                                              plays track code
```

`generate-stems` is the same architecture for single designed sounds, with its
own `STEMS_GUIDE.md`, `stem-seeds.json`, and `save-stem.mjs`. **Stems are already
self-contained, validated, single-voice Strudel code fragments** — this is what
makes the bespoke-kit idea cheap to build.

---

## 3. Target architecture

Two structural shifts:

### Shift A — Open, self-declared sound loading with dynamic validation

The static allowlist stops being a ceiling. Tracks and stems **self-declare**
their sample sources in their own code via `samples('github:user/repo')` (or any
URL exposing a `strudel.json`). Validation flips from *"is every sound in the
static list?"* to *"does every referenced sound resolve in what THIS track
actually loads, and does the code produce sound?"*

```
track/stem code (may include its own samples() calls)
        │
        ▼
validate.mjs (dynamic):
  1. execute the code's samples() loads in the Node Strudel env
  2. effective sound set = base prebake  ∪  what THIS track loaded
  3. verify every referenced sound resolves in the effective set
  4. verify the code produces events in the first cycles (unchanged)
  5. on PASS → cache/vendor every referenced sample locally (see Shift C)
        │
        ▼
save-track.mjs persists (unchanged contract: validates AND saves)
```

The `sounds.json` "allowlist" is demoted to a **base palette** — the
always-available convenience set — not a gate.

### Shift B — Bespoke per-batch kit, designed fresh (two-stage generation)

A batch's "palette" becomes a **bespoke instrument kit**: ~5–7 designed voice
fragments (a designed kick/perc, a bass patch, a lead, a pad/choir, a vocal-chop
treatment, a texture), each a validated Strudel sub-expression that may carry its
own `samples()` declarations.

```
Stage 1 — KIT DESIGN (fresh every batch):
  agents discover + load + design the kit from the batch sound brief.
  Each voice is validated like a stem. Saved as palettes/<batch>.json.
  → This is where the open exploration lives.

Stage 2 — COMPOSE:
  generate-tracks injects the kit fragments into each compose agent.
  Agents paste/adapt fragments as stack layers and arrange a full track.
  Seed + variation directive still drive intra-batch diversity.
  Final track is still ONE arrange()/stack() expression → validates via Shift A.
```

Coherence (shared kit = batch identity) and range (a new bespoke kit per batch,
drawn from the open universe) are delivered together. Because the kit is injected
as **code fragments in the prompt** — not runtime variables — the composed track
remains a single expression and needs no special validator support beyond
Shift A.

### Shift C — Cache-on-save (vendoring) for permanence

Because a saved track can now depend on an arbitrary external repo, on successful
validation the system **downloads every referenced sample to a local cache** plus
a per-track manifest, and redirects loads to the cache. A vanished upstream repo
never breaks a previously-saved track. The webapp prefers the local cache when
present.

---

## 4. Phased build

Each phase ships independently and leaves the app working.

### Phase 1 — Open the pipeline *(delivers the range upgrade on its own)*

1. **Lift the `samples()` ban** in `STRUDEL_GUIDE.md` and `STEMS_GUIDE.md`.
2. **Dynamic validator** (`scripts/validate.mjs` + `scripts/strudel-env.mjs`):
   - Execute the code's own `samples()` loads in the Node Strudel env.
   - Build the effective sound set = base prebake ∪ track-loaded.
   - Validate referenced sounds against the effective set (replaces the static
     hard-fail). Keep the "produces sound in first cycles" check.
   - Keep `scripts/sounds.json` as the always-available **base** set; it is no
     longer a ceiling.
3. **Cache-on-save / vendoring**: on PASS, download referenced samples to a local
   cache dir (e.g. `data/sample-cache/`) with a per-track manifest; redirect
   loads to the cache. Define cache layout and a cache-hit fast path.
4. **Webapp** (`src/strudel-boot.js` and playback path): confirm self-declared
   `samples()` load on play; pre-warm/await so first playback doesn't gap; prefer
   the local cache when present.
5. **Guide → springboard** (`STRUDEL_GUIDE.md`): rewrite the sound section as a
   *map of the territory + how to discover and load any bank* (the
   `github:user/repo` `strudel.json` convention, how to probe a manifest) + the
   full **synthesis vocabulary** (FM, wavetable, `vowel()`/formant, vibrato),
   each verified against the installed `@strudel` build during implementation (no
   fabricated APIs). Keep a short "base palette" quick list, framed as a starting
   point.
6. **Genre-tagged seed expansion** (`shared/track-seeds.json`): grow from 20
   combos to a genre-spanning library (hip-hop, dub, ambient, cinematic, dnb,
   footwork, jazz, world), tagged by genre so selection can match the brief.

### Phase 2 — Two-stage bespoke kit (fresh every batch)

1. **Palette artifact** `palettes/<batch>.json`: named voice fragments (designed
   kick/perc, bass, lead, pad/choir, vocal-chop, texture…), each a validated
   Strudel sub-expression with its own `samples()` declarations, plus the batch's
   effective sample set.
2. **Stage 1 (design)**: a kit-design step in the `generate-tracks` skill —
   agents discover + load + design the kit from the batch sound brief, validated
   like stems (reuse the stem validation path), saved as the batch palette.
   Fresh every batch (no reuse of the existing stems library).
3. **Stage 2 (compose)**: `generate-tracks` injects the kit fragments into each
   compose agent's prompt; agents paste/adapt them as `stack` layers and arrange
   into full tracks. Final track validates dynamically (Phase 1).
4. **Kit-design guide**: repurpose `STEMS_GUIDE.md` content for kit voices, or a
   thin new guide pointing at it.

### Phase 3 — Originality & feedback

1. **Rate kits like stems** — extend the existing rating/feedback UI and digest
   to kits.
2. **Kit-lessons digest feeds Stage-1 discovery** — steer toward what the user
   liked and *away* from territory already mined (anti-convergence), so range
   keeps widening over batches rather than re-mining the same banks.

---

## 5. Components & interfaces

| Unit | Responsibility | Depends on |
|---|---|---|
| `scripts/strudel-env.mjs` | Node Strudel runtime; gains the ability to execute arbitrary `samples()` loads and report the resolved sound set | `@strudel/*` |
| `scripts/validate.mjs` | Dynamic validation: load → effective set → resolve check → sound check | `strudel-env.mjs` |
| sample cache module (new) | Download + store referenced samples locally; manifest; cache-hit lookup; URL redirect | filesystem, fetch |
| `scripts/save-track.mjs` / `save-stem.mjs` | Unchanged contract (validate AND save), now also trigger cache-on-save | `validate.mjs`, cache module |
| `STRUDEL_GUIDE.md` | Springboard: discovery + synthesis vocabulary + base palette | — |
| `shared/track-seeds.json` | Genre-tagged grooves/engines | — |
| `palettes/<batch>.json` (new) | Bespoke kit artifact for a batch | validator |
| `generate-tracks` SKILL | Orchestrate Stage 1 (kit design) → Stage 2 (compose) | palette artifact, guides |
| webapp playback / `strudel-boot.js` | Load self-declared + cached samples on play without gaps | cache layout |

---

## 6. Risks & mitigations

- **A track depends on an external repo that later vanishes.** → Cache-on-save
  (Shift C) vendors samples locally at validation time.
- **Boot/playback latency from many self-loaded banks.** → Strudel audio is
  lazy-loaded; only manifest JSON is fetched up front, and cached locally after
  first save. Perf gate: measure boot manifest-fetch time before/after; audio
  must stay lazy; boot must not regress meaningfully (crate runs on the user's
  phone too).
- **Open discovery yields incoherent kits.** → The shared kit + batch brief +
  seed structure anchors coherence; kit voices are validated like stems
  (originality bar enforced).
- **Fabricated Strudel synthesis APIs in the guide.** → Every technique added to
  the guide is verified against the installed `@strudel` build during
  implementation.
- **Security: agents fetch arbitrary URLs during validation.** → Validation runs
  server-side under the existing scoped tool allowlist; fetched content is audio
  samples written to a cache dir, not executed. (Note for implementation: bound
  fetch size/count per track.)

---

## 7. Testing & guardrails

- Unit tests for the dynamic validator (a track that loads an external bank
  passes; an unresolved sound fails; cache-hit path returns fast).
- Unit tests for the cache/vendoring module (download, manifest, redirect,
  re-validate offline against cache).
- Headless `validate.mjs` on sample tracks that load external banks.
- **Browser playback smoke test in a ≤430px mobile viewport** (project mobile-
  first rule): self-loaded + cached samples play; boot time does not regress.
- Existing test suite stays green.

---

## 8. Open implementation questions (resolve during planning)

- Exact cache layout and how the webapp resolves cache vs. upstream URLs.
- Whether Stage 1 kit design is one agent or a small fan-out per voice.
- Kit fragment format: raw Strudel snippet string per named voice + its
  `samples()` preamble.
- Whether `stem-seeds.json` also gets the genre-tag treatment (likely yes).
```
