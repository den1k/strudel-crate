# Artist/Style Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make generated tracks sound like the named artist/style by (A) adding curated vocal/pad sample banks to the palette and (B) injecting a per-prompt "style brief" that pins the artist DNA across the batch.

**Architecture:** `shared/sample-banks.json` drives both the webapp's sample preload and `build-sounds.mjs`'s allowlist, so adding banks there makes new sounds playable AND validatable. The `generate-tracks` skill (markdown the orchestrator follows) gains a step that writes one shared style brief per batch and injects it as the dominant creative anchor; the existing per-track variation directives vary tracks within it.

**Tech Stack:** Node ESM (`scripts/build-sounds.mjs`, `validate.mjs`), JSON config (`shared/sample-banks.json`), Markdown (`STRUDEL_GUIDE.md`, `.claude/skills/generate-tracks/SKILL.md`), Vitest.

**Spec:** `docs/superpowers/specs/2026-06-16-style-fidelity-design.md`

**Working dir:** the worktree `/Users/den/dev/code/strudel-ai/.claude/worktrees/style-fidelity` (run `pwd`; use the absolute path). `node_modules` is symlinked.

---

### Task 1: Add curated vocal/pad sample banks + regenerate allowlist

**Files:**
- Modify: `shared/sample-banks.json`
- Regenerate (do not hand-edit): `scripts/sounds.json`

- [ ] **Step 1: Confirm the new sounds are NOT yet allowed (red)**

Run:
```bash
node scripts/validate.mjs --code 's("swpad")'
node scripts/validate.mjs --code 's("think")'
```
Expected: both FAIL with `unknown sounds (... swpad ...)` / `... think ...` — they aren't in the allowlist yet.

- [ ] **Step 2: Add the two banks**

Edit `shared/sample-banks.json`. It is currently a JSON array ending with
`{ "shorthand": "github:tidalcycles/dirt-samples" }`. Add two entries so the array becomes:

```json
[
  { "json": "https://strudel.b-cdn.net/piano.json", "base": "https://strudel.b-cdn.net/piano/", "prebake": true },
  { "json": "https://strudel.b-cdn.net/vcsl.json", "base": "https://strudel.b-cdn.net/VCSL/", "prebake": true },
  { "json": "https://strudel.b-cdn.net/tidal-drum-machines.json", "base": "https://strudel.b-cdn.net/tidal-drum-machines/machines/", "prebake": true, "tag": "drum-machines" },
  { "json": "https://strudel.b-cdn.net/mridangam.json", "base": "https://strudel.b-cdn.net/mrid/", "prebake": true, "tag": "drum-machines" },
  { "shorthand": "github:tidalcycles/dirt-samples" },
  { "shorthand": "github:switchangel/pad" },
  { "shorthand": "github:yaxu/clean-breaks" }
]
```

(`switchangel/pad` → lush pad sound `swpad`; `yaxu/clean-breaks` → choppable vocal/break
phrases `think`, `useme`, `apache`, … . Both manifest URLs were verified to fetch on
2026-06-16. If either fails to fetch at build time, see Step 3's troubleshooting.)

- [ ] **Step 3: Regenerate the allowlist**

Run: `node scripts/build-sounds.mjs`
Expected: prints a line per bank with entry counts, including the two new github banks,
then `wrote scripts/sounds.json with <N> sound names` (N larger than before).

Troubleshooting: if a github bank 404s, the repo's default branch or manifest path
differs — try the repo's `strudel.json` on GitHub to confirm, or drop that bank and
substitute another verified pack (e.g. `github:switchangel/breaks`). Do not invent URLs.

- [ ] **Step 4: Confirm the new sounds now validate (green)**

Run:
```bash
node scripts/validate.mjs --code 's("swpad")'
node scripts/validate.mjs --code 's("think")'
```
Expected: both `PASS (... events / 8 cycles)`.

- [ ] **Step 5: Confirm existing tests still pass**

Run: `npx vitest run`
Expected: all pass (adding allowlist names only widens acceptance).

- [ ] **Step 6: Commit**

```bash
git add shared/sample-banks.json scripts/sounds.json
git commit -m "feat: add vocal/pad sample banks (swpad, clean-breaks) to palette

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

(Browser playback verification of these sounds happens in Task 4 — the deaf-headless rule.)

---

### Task 2: Document the new sampled sounds + reword the samples ban (guide)

**Files:**
- Modify: `STRUDEL_GUIDE.md`

- [ ] **Step 1: Reword the `samples()` prohibition to state its reason**

Find this exact text:
```
   full track. Nothing else. No `$:` labels, no variable assignments, no `samples()`,
   no `await`, no visual functions (`.pianoroll()`, `.scope()`, `.punchcard()`, …).
```
Replace with:
```
   full track. Nothing else. No `$:` labels, no variable assignments, no `samples()`
   (the sample banks are already preloaded — reference their sounds by name, see the
   palette below), no `await`, no visual functions (`.pianoroll()`, `.scope()`, `.punchcard()`, …).
```

- [ ] **Step 2: Add a vocal/pad palette bullet with chopping + sidechain technique**

Find this exact text:
```
- **Sampled instruments:** `piano` (velvety felt piano). Classic dirt-samples without a
  bank: `casio`, `jvbass`, `arpy`, `space`, `numbers`, `insect`, `wind`, `crow`, `metal`,
  `jazz`, `east` — check `scripts/sounds.json` when in doubt; many have multiple variants
  selectable with `.n(2)`.
```
Replace with (adds a new bullet immediately after):
```
- **Sampled instruments:** `piano` (velvety felt piano). Classic dirt-samples without a
  bank: `casio`, `jvbass`, `arpy`, `space`, `numbers`, `insect`, `wind`, `crow`, `metal`,
  `jazz`, `east` — check `scripts/sounds.json` when in doubt; many have multiple variants
  selectable with `.n(2)`.
- **Vocal & pad samples** (for vocal-led / intimate styles): lush pad `swpad`; choppable
  vocal/break phrases `think`, `useme`, `sesame`, `apache`; spoken vocals `numbers`,
  `alphabet`, `breath`. Treat a vocal as an instrument: `.chop(8)` slices it into a
  rhythm, `.slice(8, "0 2 4 6")` rearranges slices, `.speed("<1 1.5 0.5>")` pitches it,
  `.begin(0.25).end(0.5)` grabs a phrase. **Sidechain/pump** a pad under the kick with a
  gain LFO: `.gain(saw.slow(2).range(0.25, 1))`.
```

- [ ] **Step 3: Verify**

Run: `grep -n "swpad\|preloaded — reference\|Sidechain/pump" STRUDEL_GUIDE.md`
Expected: shows the reworded ban and the new palette bullet. Skim surrounding lines to
confirm clean formatting.

- [ ] **Step 4: Commit**

```bash
git add STRUDEL_GUIDE.md
git commit -m "docs: document vocal/pad samples + chop/sidechain technique in guide

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Per-prompt style brief + seed reconciliation (generate-tracks skill)

**Files:**
- Modify: `.claude/skills/generate-tracks/SKILL.md`

- [ ] **Step 1: Add the style-brief sub-step to the start of step 4, and bias seed selection**

In `.claude/skills/generate-tracks/SKILL.md`, find the heading line:
```
4. **Assign each track a variation directive** so the batch is diverse, by combining
   axes (vary at least two axes between any two tracks):
```
Replace it with:
```
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
```

- [ ] **Step 2: Tell the orchestrator to pick style-compatible seeds**

In the same step 4, find this exact text:
```
   - **seed:** one `source (groove) × signature (harmonic engine)` pair (compatible per
     `appliesTo`). No two tracks in a wave share a pair; spread grooves and engines
     evenly across the batch.
```
Replace with:
```
   - **seed:** one `source (groove) × signature (harmonic engine)` pair (compatible per
     `appliesTo`). No two tracks in a wave share a pair; spread grooves and engines
     evenly across the batch. **Bias selection toward seeds compatible with the style
     brief** (a 2-step/garage brief → broken/breakbeat sources, not four-on-floor) — the
     seed is a starting groove the agent adapts to the brief, not an override of it.
```

- [ ] **Step 3: Inject `{style_brief}` into the agent prompt as the dominant anchor**

In the fenced agent prompt, find this exact text:
```
   2. Style brief: "{prompt}". Your variation directive: {directive}.
      Your SEED (groove + harmonic engine — your starting point; arrange and EXTEND it,
      do NOT paste it unchanged, do NOT collapse into sawtooth + sine.slow sweep + reverb):
      {seed}
      ({seed_note})
      Extension constraints you MUST obey: drum bank: {drum_bank}; develop these
```
Replace with:
```
   2. STYLE BRIEF — the dominant creative anchor; make the track sound like THIS:
      {style_brief}
      Your per-track variation directive (vary WITHIN the brief, never abandon it): {directive}.
      Your SEED is one starting groove (groove + harmonic engine): {seed} ({seed_note}).
      ADAPT the seed to the brief — override or replace it wherever it conflicts with the
      brief's signature. Do NOT paste the seed unchanged; do NOT collapse into a
      sawtooth + sine.slow sweep + reverb default.
      Extension constraints you MUST obey: drum bank: {drum_bank}; develop these
```

- [ ] **Step 4: Fix the `prompt` field instruction so it still uses the raw prompt**

In the fenced agent prompt, find this exact text:
```
      id "{id}", batch "{batch}", prompt (the style brief verbatim),
```
Replace with:
```
      id "{id}", batch "{batch}", prompt (the original style prompt verbatim: "{prompt}"),
```

- [ ] **Step 5: Verify**

Run: `grep -n "style_brief\|Write the batch style brief\|ADAPT the seed\|Bias selection toward seeds" .claude/skills/generate-tracks/SKILL.md`
Expected: shows the new orchestrator sub-step, the seed-bias wording, the `{style_brief}`
injection, and the seed-adaptation wording. Confirm the agent prompt's numbered list
(1–5) still reads cleanly.

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/generate-tracks/SKILL.md
git commit -m "feat: inject per-prompt style brief; seed adapts to brief in generate-tracks

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: End-to-end verification (playback + a real fred-again batch)

**Files:** none modified (verification only).

- [ ] **Step 1: Full suite green**

Run: `npx vitest run`
Expected: all pass, 0 failures.

- [ ] **Step 2: Verify the new sounds actually PLAY (deaf-headless rule)**

The headless validator cannot hear silence. Using the project's browser-verification
recipe (see memory `strudel-ai-dev-environment`): start an isolated vite
(`npx vite --port 5273 --strictPort`), drive it with the Python playwright at
`/usr/local/bin/playwright`, load a probe that evaluates
`s("swpad").slow(2)` and then `s("think").chop(8)`, wait for `#status.ready`, press play,
and **capture `console` messages** (not just `pageerror`). 
Expected: audio resolves — NO "not found" / getTrigger errors for `swpad` or `think`.
If a sound errors, it is not actually loading: revisit the bank choice in Task 1.

- [ ] **Step 3: Generate a small real "fred again" batch and inspect**

Run the generation through the updated skill for a 2-track batch:
`/generate-tracks "fred again" 2` (or invoke the generate-tracks skill with that arg).
Then inspect the written files:
```bash
for f in $(ls -t tracks/2026-*fred-again*.json | head -2); do
  python3 -c "import json; d=json.load(open('$f')); print(d['title'], '|', d['meta']['instruments']); print('  uses vocal/pad sample:', any(s in d['code'] for s in ['swpad','think','useme','numbers','alphabet','breath']))"
done
```
Expected: both tracks validated (the skill only keeps validated files), and at least one
visibly uses a vocal/pad sample and reflects the shared brief (garage/2-step feel,
intimate mood). Listen to confirm they lean toward the artist.

- [ ] **Step 4: No commit**

This task is verification only. If Step 2 shows a sound doesn't play, return to Task 1
and pick a different verified bank. If Step 3's tracks ignore the brief, revisit Task 3's
wording. Otherwise the feature is complete and ready for
`superpowers:finishing-a-development-branch`.

---

## Notes for the implementer

- Do NOT hand-edit `scripts/sounds.json` — it is generated by `build-sounds.mjs` from
  `shared/sample-banks.json`. Editing it by hand breaks the validated⇒playable contract.
- Do NOT enable arbitrary `samples('github:…')` calls in agent code (out of scope; the
  headless validator can't resolve them).
- The style brief is orchestrator-authored prose, not code — there is no unit test for
  it; its verification is the end-to-end batch in Task 4.
- Generated `tracks/*.json` from Task 4 are runtime artifacts (gitignored) — do not commit them.
