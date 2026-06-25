---
name: generate-tracks
description: Generate a batch of validated Strudel tracks in parallel from a style prompt. Use when the user asks to generate tracks, songs, beats, or music. Args: "<style prompt>" [count]
---

# Generate Strudel Tracks

Generate `count` (default 12, max 30) Strudel tracks matching the style prompt, in
parallel, each validated before it counts. Unless the prompt says otherwise, every
track is a COMPLETE 3–6 minute piece with an intro, an elaborate middle, and an
outro (see the guide's arrange() default).

Generation is **two-stage**: first design a bespoke **instrument kit** for the
batch (Stage 1 — this is where open sound discovery happens), then compose every
track from that shared kit (Stage 2 — coherence + per-track variation). The kit is
designed fresh for every batch; never reuse a previous batch's kit.

## Workflow

0. **Revise from notes first:** run the `revise-from-notes` skill with argument
   `tracks` to bring any noted tracks up to date with a new version before
   generating the new batch. (It is a no-op if nothing is noted.)

1. **Read `STRUDEL_GUIDE.md`** in full (Read tool). Agents must read it themselves
   too — your prompt tells them to.

2. **Collect feedback:** run `node scripts/feedback.mjs`. This is the cross-track
   lessons digest only — per-song ratings and notes stay with their own song and are
   never included. Lessons are per-user: the digest is scoped to the requesting
   user's own songs, so one user's lessons never steer another's generations.
   Capture the output — it is injected into every agent prompt. If it
   says "No lessons yet", inject the literal text "none yet".

   Then run `node scripts/kit-feedback.mjs` and capture its output as `{kit_digest}`.
   This is the **anti-convergence kit memo**: it lists the sample banks, synthesis
   techniques, and roles that recent batches' kits already mined, plus any kit lessons
   the user left. It is injected into the Stage-1 kit-design agent ONLY (not the
   compose agents), to steer the fresh kit toward unexplored territory and away from
   re-mining the same banks.

   Then read `shared/banks-digest.md` and capture it as `{bank_digest}`. This is the
   **bank discovery digest**: a category-grouped list of REAL, loadable Strudel sample
   banks crawled from public GitHub repos (far more than the handful named in the
   guide). It is injected into the Stage-1 kit-design agent ONLY, so the agent can reach
   past the base palette to banks that actually exist instead of relying on recall. If
   the file is missing, inject the literal text "none yet".

3. **Compute the batch id:** `YYYY-MM-DD-<slug>` where slug = the prompt lowercased,
   non-alphanumerics → `-`, trimmed to ≤ 40 chars (e.g. `2026-06-03-dark-hypnotic-techno`).
   If `node scripts/list-slugs.mjs tracks | grep <batch>` shows the batch already exists, append `-b2`, `-b3`, ….
   Track ids are `<batch>-01` … `<batch>-NN`. Get the timestamp with
   `date -u +%Y-%m-%dT%H:%M:%SZ`.

4. **Write the batch style brief, then assign each track a variation directive.**

   First, write ONE **style brief** for the whole batch from the prompt — the shared DNA
   every track must honor (≈4–8 lines), using what you know about the named artist /
   genre / vibe. Cover: tempo & feel; groove (e.g. 2-step swing, four-on-floor, broken,
   breakbeat); signature sounds, naming concrete available sounds — including the sampled
   vocal/pad sounds (`swpad`, `numbers`, `alphabet`, `breath`, `think`, …) and `piano`;
   signature techniques (e.g. "center the track on a chopped/pitched vocal", "sidechain
   the pads with a gain LFO", "lo-fi felt piano", a specific reverb/space); mood; and what
   to AVOID. This single brief is injected into every agent (`{style_brief}`) and is the
   dominant anchor — the per-track directives below only vary tracks WITHIN it.

   Then assign each track a variation directive so the batch is diverse, by combining
   axes (vary at least two axes between any two tracks):
   - energy: sparse/minimal · mid groove · dense/driving
   - register focus: bass-led · chord-led · melody-led · percussion-led
   - palette: one drum-machine bank + one synth · piano-centric · sampled/dirt textures
   - tempo: pick within whatever range fits the style prompt
   - arc shape: slow-burn build · early peak then deconstruction · two peaks with a
     valley · continuous evolution
   - mood modifier: e.g. darker, dreamier, rawer, funkier (fit to prompt)

   Then assign each track its **seed and extension constraints** (read
   `shared/track-seeds.json`):
   - **seed:** one `source (groove) × signature (harmonic engine)` pair (compatible per
     `appliesTo`). No two tracks in a wave share a pair; spread grooves and engines
     evenly across the batch. **Bias selection toward seeds compatible with the style
     brief** (a 2-step/garage brief → broken/breakbeat sources, not four-on-floor) — the
     seed is a starting groove the agent adapts to the brief, not an override of it.
   - **drum bank:** pick ONE bank from the guide's menu, varied across the batch (don't
     let RolandTR909 dominate).
   - **development dimensions:** which layers/parameters evolve across sections (≥3:
     e.g. filter opening, layer add/drop, progression shift, space change).
   - **motion mechanism:** one of {slow LFO, stepped `<…>/N`, envelope, euclid/ply,
     perlin/rand} — not `sine.slow` for the majority.
   - **tail:** one of {dry, room-only, delay-only, room+delay}.
   - **forbids:** e.g. "not RolandTR909", "no `sawtooth` acid bass", "`sine.slow` may not
     be your primary filter motion" — spread these so the batch doesn't converge.

5. **STAGE 1 — design the batch kit (fresh, from the brief).** Read `KIT_GUIDE.md`
   in full. The kit is a set of 5–7 named, designed voice fragments (a kick/perc, a
   bass, a lead, a pad/choir, a vocal-chop and/or a texture) — each a validated
   Strudel sub-expression that may load its own banks with `samples('github:user/repo')`.
   This is the batch's identity; design it to match the brief and to REACH past the
   base palette (the whole point is range — discover and load sounds that fit).

   Run ONE kit-design agent (or a small fan-out of one agent per voice if you want
   parallelism — then assemble their `frag`s into one palette file). Dispatch this
   agent with NO model override so it inherits the orchestrator's Opus model
   (`model: opus` effectively) — kit/sound design is taste-heavy and stays on the
   high tier. Its prompt:

   ```
   You are designing ONE bespoke instrument kit for a batch of Strudel tracks. Work
   in <repo root> (absolute paths for every file/command; do not cd elsewhere).

   1. Read KIT_GUIDE.md COMPLETELY (and STEMS_GUIDE.md for the sound-design
      vocabulary it points to). Each kit voice is designed like a stem — one
      transformed, original sound — but written as a bare sub-expression.
   2. BATCH SOUND BRIEF — design the kit to sound like THIS, and reach past the base
      palette to do it (load banks with samples('github:user/repo') where the brief
      wants sounds the base set lacks):
      {style_brief}
      Cross-track lessons to honor: {digest}

      ANTI-CONVERGENCE — recent batches' kits already mined the territory in this
      memo. Push for RANGE: load DIFFERENT banks than the ones listed, lean on
      techniques NOT already over-used, and consider the under-explored roles it
      names. Do not re-mine the same ground — fresh kit, fresh territory:
      {kit_digest}

      LOADABLE BANKS — these are REAL public Strudel banks (crawled from GitHub),
      far more than the guide names. Reach past the base palette: pick banks that
      fit the brief and load them with samples('<ref>'). Before you write a
      samples() load, grep data/banks.json for that bank to confirm its EXACT sound
      names (the digest lists banks, not every sound). Prefer banks here over recall
      — a bank you only half-remember may not exist and will fail validation:
      {bank_digest}
   3. Run `mkdir -p staging`, then write staging/{batch}.json as a palette:
      { "batch": "{batch}", "brief": "<the brief above>", "createdAt": "{timestamp}",
        "samples": [<batch-level bank sources, optional>],
        "voices": [ { "role": <kick|perc|bass|lead|pad|vocal|texture>, "name": "<unique>",
                      "samples": [<this voice's bank sources>], "frag": "<Strudel sub-expression>",
                      "note": "<how to use it>" }, … ] }
      Need >=4 voices spanning >=3 distinct roles; aim for 5–7. Voices must cohere
      as ONE kit (shared space, shared tonal centre for pitched voices).
   4. Run: node scripts/save-palette.mjs staging/{batch}.json
      This validates every voice like a stem, vendors the banks, and writes
      palettes/{batch}.json. On FAIL, fix the named voice and re-run (up to 3 tries).
   5. Reply with EXACTLY one line: OK kit {batch} (<n> voices) — or — FAILED kit {batch} <reason>
   ```

   After Stage 1 passes, **read `palettes/{batch}.json`** yourself. You will inject
   its voice fragments into every compose agent (Stage 2). Build:
   - `{kit_preamble}` = one `samples(...)` line per source in the kit's effective
     sample set (the union of the top-level `samples` and every voice's `samples`).
   - `{kit_voices}` = the voice list rendered as `role · name · note → frag`, one
     per line, verbatim, so agents can paste/adapt each `frag` as a stack layer.

6. **STAGE 2 — fan out compose agents:** dispatch ALL agents for a wave in a SINGLE
   message (parallel tool calls), waves of at most 8. **Dispatch every compose
   agent on the cheaper Sonnet tier (`model: sonnet` on each Task call)** — they
   implement an already-designed kit against a tight spec that the validator and
   character gate enforce, so the high tier is not needed here. **Substitute `<repo root>`
   below with the ABSOLUTE path of your current working directory (run `pwd`
   first).** In a git worktree that is the worktree path, NOT the main checkout — a
   relative or wrong path makes agents write files and `git commit` in the wrong
   checkout. Each agent gets this prompt, placeholders filled:

   ```
   You are writing exactly one Strudel track file. Work in <repo root> (use this
   absolute path for every file path and every git command; do not cd elsewhere).

   1. Read STRUDEL_GUIDE.md COMPLETELY and follow every rule in it — including the
      default: a complete 3–6 minute track with intro, elaborate middle, and outro,
      built with arrange(); and the HARD character requirement — your track MUST use
      moves from at least 3 of the 4 categories (harmonic, rhythmic, timbral,
      transform). On-grid triads under a single filter sweep will be REJECTED by the
      validator.
   2. STYLE BRIEF — the dominant creative anchor; make the track sound like THIS:
      {style_brief}
      Your per-track variation directive (vary WITHIN the brief, never abandon it): {directive}.
      Your SEED is one starting groove (groove + harmonic engine): {seed} ({seed_note}).
      ADAPT the seed to the brief — override or replace it wherever it conflicts with the
      brief's signature. Do NOT paste the seed unchanged; do NOT collapse into a
      sawtooth + sine.slow sweep + reverb default.
      Extension constraints you MUST obey: drum bank: {drum_bank}; develop these
      dimensions across sections: {development_dimensions}; motion mechanism:
      {motion_mechanism}; tail: {tail}; forbids: {forbids}.

      BATCH KIT — this batch shares ONE bespoke instrument kit; build your track FROM it.
      Put these sample loads at the very TOP of your code, before setcpm (one per line):
      {kit_preamble}
      Kit voices (paste/adapt each frag as a stack() layer — they are your kit, not the
      whole arrangement; you choose which to use per section, may retune/re-rhythm them to
      your seed and directive, and may add tasteful extra layers):
      {kit_voices}
      Use the kit as the batch's shared identity. Your seed + directive shape HOW you
      arrange and vary the kit across sections; do not abandon the kit's sounds.

      Cross-track lessons to apply (honor every lesson listed under
      "Lessons for all future tracks"):
      {digest}
   3. Run `mkdir -p staging` (in case the dir does not exist), then write
      staging/{id}.json with all required fields:
      id "{id}", batch "{batch}", prompt (the original style prompt verbatim: "{prompt}"),
      title (short, evocative, unique), createdAt "{timestamp}",
      description (1-3 listener-facing sentences),
      meta { bpm (must match your setcpm), genre, mood, key,
             instruments (sounds you used), energy (1-5) },
      code (your Strudel code — follow the guide's shape rules).
   4. Run: node scripts/save-track.mjs staging/{id}.json
      This validates AND saves the track to the database (with you as author).
      If it prints FAIL: read the reason, fix staging/{id}.json, re-run. Up to 3 attempts.
      - unknown sounds → the sound resolves nowhere: it is not in the base palette
        AND not in a bank you loaded. Add the kit's `samples()` preamble (you may
        have dropped a line), `samples('github:…')` a bank that has it, or pick a
        resolving name. (Kit voices already carry their own loads — keep the
        preamble intact.)
      - "lacks character" → add an off-grid groove (euclid/swing), dirt
        (crush/shape/vowel), richer harmony, or a transform until >=3 categories.
      If still failing after 3 attempts: delete the file (rm staging/{id}.json).
      On PASS the track is live; do NOT also run validate.mjs.
   5. Reply with EXACTLY one line:
      OK {id} "<title>"   — or —   FAILED {id} <one-line reason>
   ```

7. **Report:** after all waves, echo the **batch style brief** AND a one-line summary
   of the **batch kit** (the voice names/roles) you used, so the user sees the shared
   DNA. Then output a table (id · title · status), the count of valid tracks written,
   any failures with reasons. Remind the user:
   `npm run dev` → http://localhost:5173 to listen and rate.

## Notes

- Two-stage contract: Stage 1 `save-palette.mjs` writes `palettes/<batch>.json`
  (validates every voice like a stem + vendors banks); Stage 2 `save-track.mjs`
  validates AND persists each track. A track only exists if `save-track.mjs` passes.
- The composed track is still ONE `arrange()`/`stack()` expression with the kit's
  `samples()` preamble hoisted to the top — it validates via the dynamic validator
  with no special support. Kit voices are code fragments in the prompt, not runtime
  variables.
- Never edit `scripts/sounds.json` to make a track pass — change the track. The base
  palette is a floor, not a ceiling: load banks to reach past it.
- If the user gives a count > 30, cap at 30 and say so.

## Kit feedback & anti-convergence (Phase 3)

- `node scripts/kit-feedback.mjs [limit]` builds the **kit digest** from the disk
  artifacts the pipeline already writes (`palettes/<batch>.json`) plus an optional
  human sidecar (`data/kit-lessons/<batch>.json`). It reports which sample banks,
  synthesis techniques, and roles recent kits mined, and surfaces kit lessons — so
  Stage-1 kit design can steer toward fresh territory (range) and away from
  re-mining the same banks (anti-convergence). It is injected as `{kit_digest}` into
  the Stage-1 prompt ONLY. Like `feedback.mjs`, only the `lesson` text crosses into
  the digest — a kit's rating and notes stay with that kit.
- **Kit-lessons sidecar** (`data/kit-lessons/<batch>.json`): `{ "batch": "<batch>",
  "lesson": "<cross-batch guidance, e.g. 'the choir pad was the best part — more
  ensemble vocals'>", "rating": <n|null>, "notes": "<per-kit, never injected>",
  "updatedAt": "<ISO>" }`. Mirrors `data/ratings/` exactly; only `lesson` feeds the
  digest. Write one when a batch's KIT (not a single track) taught something about
  the territory to pursue or avoid.
- **Deferred — "rate kits in the UI":** the spec's Phase 3 item (1) wants kits rated
  in the same UI as stems. That UI + its InstantDB storage are owned by the
  social-ratings/notes/remix session and were intentionally NOT touched here. The
  clean seam left for a future coordinated change: a kit-ratings store that writes
  the same `{ batch, rating, notes, lesson, updatedAt }` shape into
  `data/kit-lessons/<batch>.json` (or an InstantDB `kits`/`kitRatings` namespace
  that a small exporter mirrors to that sidecar). `kit-feedback.mjs` already consumes
  that shape via `loadKitLessons()`, so wiring a UI later requires no change to the
  digest — only the producer side.

## Bank discovery (loadable-bank index)

- `npm run crawl-banks` (`scripts/crawl-banks.mjs`) crawls GitHub code search for
  public Strudel banks (`filename:strudel.json`), light-validates each
  (fetch+parse, a bank-shape guard — `isSampleBank`: rejects the
  npm/package-manifest shape (`name`+`version`+`description`, or a lone generic
  container key like `resources`/`files`/`assets`/`samples`) and requires a strong
  majority of the manifest's string leaves to look like audio file paths, which
  rejects app-config/data/packaged-asset `strudel.json` files — then ≥1 sound),
  categorizes it, and writes
  a committed `data/banks.json` index plus a compact `shared/banks-digest.md`. It is
  the ONLY networked unit and
  uses the authed `gh` CLI. A weekly systemd timer (`vimsical-crate-crawl-banks`)
  re-runs it and commits the diff; see the design spec's deploy notes.
- **`shared/banks-digest.md`** is injected as `{bank_digest}` into the Stage-1
  kit-design prompt ONLY (see step 2 + the Stage-1 prompt). It is a discovery aid,
  not a trust boundary — the dynamic validator (`scripts/validate.mjs`) and
  cache-on-save remain the source of truth at save time, so a stale/broken indexed
  bank still gets rejected there.
- **`data/banks.json`** is the full index (every bank's exact sound names). Agents
  grep it for a bank's sound names before writing a `samples()` load. Pure helpers
  live in `scripts/lib/bank-index.mjs` (unit-tested, offline). This is separate from
  `shared/sample-banks.json` (the always-loaded boot prebake), which is unchanged.
