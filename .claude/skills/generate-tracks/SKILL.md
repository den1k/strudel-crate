---
name: generate-tracks
description: Generate a batch of validated Strudel tracks in parallel from a style prompt. Use when the user asks to generate tracks, songs, beats, or music. Args: "<style prompt>" [count]
---

# Generate Strudel Tracks

Generate `count` (default 12, max 30) Strudel tracks matching the style prompt, in
parallel, each validated before it counts. Unless the prompt says otherwise, every
track is a COMPLETE 3–6 minute piece with an intro, an elaborate middle, and an
outro (see the guide's arrange() default).

## Workflow

0. **Revise from notes first:** run the `revise-from-notes` skill with argument
   `tracks` to bring any noted tracks up to date with a new version before
   generating the new batch. (It is a no-op if nothing is noted.)

1. **Read `STRUDEL_GUIDE.md`** in full (Read tool). Agents must read it themselves
   too — your prompt tells them to.

2. **Collect feedback:** run `node scripts/feedback.mjs`. This is the cross-track
   lessons digest only — per-song ratings and notes stay with their own song and are
   never included. Capture the output — it is injected into every agent prompt. If it
   says "No lessons yet", inject the literal text "none yet".

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

5. **Fan out agents:** dispatch ALL agents for a wave in a SINGLE message (parallel
   tool calls), waves of at most 8. **Substitute `<repo root>` below with the
   ABSOLUTE path of your current working directory (run `pwd` first).** In a git
   worktree that is the worktree path, NOT the main checkout — a relative or wrong
   path makes agents write files and `git commit` in the wrong checkout. Each
   agent gets this prompt, placeholders filled:

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
      - unknown sounds → grep scripts/sounds.json for valid names.
      - "lacks character" → add an off-grid groove (euclid/swing), dirt
        (crush/shape/vowel), richer harmony, or a transform until >=3 categories.
      If still failing after 3 attempts: delete the file (rm staging/{id}.json).
      On PASS the track is live; do NOT also run validate.mjs.
   5. Reply with EXACTLY one line:
      OK {id} "<title>"   — or —   FAILED {id} <one-line reason>
   ```

6. **Report:** after all waves, echo the **batch style brief** you used (so the user
   sees the shared DNA), then output a table (id · title · status), the count of valid
   tracks written, any failures with reasons. Remind the user:
   `npm run dev` → http://localhost:5173 to listen and rate.

## Notes

- `save-track.mjs` is the contract: it validates AND persists, so a track only
  exists if `save-track.mjs` passes & saves it.
- Never edit `scripts/sounds.json` to make a track pass — change the track.
- If the user gives a count > 30, cap at 30 and say so.
