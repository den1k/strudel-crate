---
name: generate-stems
description: Generate a batch of validated Strudel sound-design stems in parallel from a sound prompt. Use when the user asks to generate stems, sounds, textures, or sound design. Args: "<sound prompt>" [count]
---

# Generate Strudel Stems

Generate `count` (default 30, max 30) Strudel STEMS matching the sound prompt, in
parallel, each validated before it counts. A stem is ONE designed sound — a single
star voice with deep sound design — looping with a built-in 15–60 s morph arc.
Quality bar: original, transformed sound; nothing that sounds like a stock preset.

## Workflow

0. **Revise from notes first:** run the `revise-from-notes` skill with argument
   `stems` to bring any noted stems up to date with a new version before
   generating the new batch. (It is a no-op if nothing is noted.)

1. **Read `STEMS_GUIDE.md`** in full (Read tool). Agents must read it themselves
   too — your prompt tells them to.

2. **Collect feedback:** run `node scripts/feedback.mjs stems`. This is the
   cross-track lessons digest only — per-stem ratings and notes stay with their own
   stem and are never included. Capture the output — it is injected into every agent
   prompt. If it says "No lessons yet", inject the literal text "none yet".

3. **Compute the batch id:** `YYYY-MM-DD-<slug>` where slug = the prompt lowercased,
   non-alphanumerics → `-`, trimmed to ≤ 40 chars (e.g. `2026-06-04-alien-sound`).
   If `ls stems/ | grep <batch>` shows the batch already exists, append `-b2`, `-b3`, ….
   Stem ids are `<batch>-01` … `<batch>-NN`. Get the timestamp with
   `date -u +%Y-%m-%dT%H:%M:%SZ`.

4. **Assign each stem a variation directive** so the batch covers wildly different
   sonic territory. Combine axes — any two stems must differ on at least two axes,
   and in a 30-batch every sound family appears at least 3 times:
   - sound family: sub/808 bass · reese-or-fm bass · lead · pad/texture ·
     designed percussion hit · riser/noise · formant/vocal-ish · sample-mangle
   - synthesis core: FM (sine + fm/fmh) · subtractive (sawtooth/supersaw + filter
     env) · formant (vowel) · noise sculpting (white/pink/brown) · sample
     mangling (chop/striate/speed on dirt samples) · layered detune (off/jux)
   - motion engine: slow filter journey · pitch-envelope morph (penv/accelerate) ·
     rhythmic gating (tremolo/ply/euclid) · stereo drift (pan LFOs/jux) ·
     degradation arc (crush/coarse ramps) · reverse/speed play
   - register: sub · low · mid · high · full-spectrum
   - character (fit to prompt): e.g. wet/cavernous · dry/clicky · metallic ·
     hollow · screaming · liquid · broken

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

5. **Fan out agents:** dispatch ALL agents for a wave in a SINGLE message (parallel
   tool calls), waves of at most 8. **Substitute `<repo root>` below with the
   ABSOLUTE path of your current working directory (run `pwd` first).** In a git
   worktree that is the worktree path, NOT the main checkout — a relative or wrong
   path makes agents write files and `git commit` in the wrong checkout. Each
   agent gets this prompt, placeholders filled:

   ```
   You are writing exactly one Strudel STEM file. Work in <repo root> (use this
   absolute path for every file path and every git command; do not cd elsewhere).

   1. Read STEMS_GUIDE.md COMPLETELY and follow every rule in it — ONE star
      sound, a built-in 8–32 cycle morph arc (~15–60 s), at least 3 modulated
      dimensions, original transformed sound.
   2. Sound brief: "{prompt}". Your variation directive: {directive}.
      Your SEED (your starting point — transform and EXTEND it; do NOT paste it
      unchanged, do NOT collapse into a generic sine.slow filter-sweep into reverb):
      {seed}
      ({seed_note})
      Extension constraints you MUST obey: modulate these dimensions: {modulation_set};
      motion mechanism: {motion_mechanism}; tail: {tail}; forbids: {forbids}.
      Cross-track lessons to apply (honor every lesson listed under
      "Lessons for all future tracks"):
      {digest}
   3. Write stems/{id}.json with all required fields:
      id "{id}", batch "{batch}", prompt (the sound brief verbatim),
      title (short, evocative, unique), createdAt "{timestamp}",
      description (1-3 sentences: the sound and how it morphs),
      meta { bpm (must match your setcpm), genre (sound family), mood,
             key ("atonal" if unpitched), instruments (the star sound),
             energy (1-5) },
      code (your Strudel code — single stack(), no arrange()).
   4. Run: node scripts/validate.mjs stems/{id}.json
      If FAIL: read the error, fix the code (for unknown sounds, grep
      scripts/sounds.json for valid names), re-run. Up to 3 attempts total.
      If still failing after 3 attempts: delete the file (rm stems/{id}.json).
   5. Reply with EXACTLY one line:
      OK {id} "<title>"   — or —   FAILED {id} <one-line reason>
   ```

6. **Report:** after all waves, output a table (id · title · status), the count of
   valid stems written, any failures with reasons. Remind the user:
   `npm run dev` → http://localhost:5173/stems to listen and rate.

## Notes

- Validation is the contract: a stem only exists if `validate.mjs` passes it.
- Never edit `scripts/sounds.json` to make a stem pass — change the stem.
- If the user gives a count > 30, cap at 30 and say so.
