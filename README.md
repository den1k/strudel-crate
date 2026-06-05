# strudel-ai

Generate [Strudel](https://strudel.cc) tracks with Claude Code, in parallel; listen,
rate, and annotate them in a local webapp; ratings feed back into the next batch.

## Use

1. In a Claude Code session in this repo: `/generate-tracks "dark hypnotic techno" 12`
2. `npm run dev` → open http://localhost:5173 (first load fetches sample banks — give it a minute)
3. Play tracks, rate 1–5, leave notes on what to change.
4. Generate the next batch — agents read your ratings/notes and steer toward what you liked.
5. Sound sorcery: `/generate-stems "alien sound"` writes 30 single-sound,
   sound-design stems to `stems/` — listen and rate them at
   http://localhost:5173/stems (nav links crate ↔ stems).

By default every generated track is a complete 3–6 minute piece with an intro,
an elaborate middle, and an outro.

## Commands

- `npm run dev` — API (:3001) + webapp (:5173)
- `npm test` — unit tests
- `node scripts/validate.mjs tracks/<id>.json` — validate a track headlessly
- `npm run feedback` — print the ratings digest agents see
- `node scripts/feedback.mjs stems` — the same digest for stem ratings
- `npm run build-sounds` — regenerate the sound allowlist (only needed if `shared/sample-banks.json` changes)

## How a track is "valid"

`scripts/validate.mjs` runs the code through Strudel's own transpiler/evaluator in
Node, requires it to produce events in its first 8 cycles, and checks every sound referenced across the full arrangement (512-cycle scan)
against `scripts/sounds.json` — which is generated from the exact sample banks the
webapp loads. If it validates, the webapp can play it.
