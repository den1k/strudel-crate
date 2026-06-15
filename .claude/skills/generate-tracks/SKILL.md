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
   If `ls tracks/ | grep <batch>` shows the batch already exists, append `-b2`, `-b3`, ….
   Track ids are `<batch>-01` … `<batch>-NN`. Get the timestamp with
   `date -u +%Y-%m-%dT%H:%M:%SZ`.

4. **Assign each track a variation directive** so the batch is diverse, by combining
   axes (vary at least two axes between any two tracks):
   - energy: sparse/minimal · mid groove · dense/driving
   - register focus: bass-led · chord-led · melody-led · percussion-led
   - palette: one drum-machine bank + one synth · piano-centric · sampled/dirt textures
   - tempo: pick within whatever range fits the style prompt
   - arc shape: slow-burn build · early peak then deconstruction · two peaks with a
     valley · continuous evolution
   - mood modifier: e.g. darker, dreamier, rawer, funkier (fit to prompt)

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
      built with arrange().
   2. Style brief: "{prompt}". Your variation directive: {directive}.
      Cross-track lessons to apply (honor every lesson listed under
      "Lessons for all future tracks"):
      {digest}
   3. Write tracks/{id}.json with all required fields:
      id "{id}", batch "{batch}", prompt (the style brief verbatim),
      title (short, evocative, unique), createdAt "{timestamp}",
      description (1-3 listener-facing sentences),
      meta { bpm (must match your setcpm), genre, mood, key,
             instruments (sounds you used), energy (1-5) },
      code (your Strudel code — follow the guide's shape rules).
   4. Run: node scripts/validate.mjs tracks/{id}.json
      If FAIL: read the error, fix the code (for unknown sounds, grep
      scripts/sounds.json for valid names), re-run. Up to 3 attempts total.
      If still failing after 3 attempts: delete the file (rm tracks/{id}.json).
   5. Reply with EXACTLY one line:
      OK {id} "<title>"   — or —   FAILED {id} <one-line reason>
   ```

6. **Report:** after all waves, output a table (id · title · status), the count of
   valid tracks written, any failures with reasons. Remind the user:
   `npm run dev` → http://localhost:5173 to listen and rate.

## Notes

- Validation is the contract: a track only exists if `validate.mjs` passes it.
- Never edit `scripts/sounds.json` to make a track pass — change the track.
- If the user gives a count > 30, cap at 30 and say so.
