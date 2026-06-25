# Tiered Models for Track Generation — Design

**Date:** 2026-06-25
**Status:** Approved
**Author:** Dennnis (with Claude)

## Problem

Track generation runs every Claude call — orchestration, kit design, and all N
compose agents — on the same model (the `claude -p` CLI default, effectively
Opus). Opus spend is hitting the account's **usage/spend quota**. The compose
agents dominate both call count and token volume (each re-reads the full
`STRUDEL_GUIDE.md`, ~8 KB, and may retry up to 3×), so they are where the spend
concentrates.

## Goal

Cut Opus spend on track generation by running the many **implementation**
(compose) calls on Sonnet, while keeping every **taste-bearing** decision on
Opus. Quality must be preserved, not traded away. Stems are untouched.

## Why this is low-risk (the key insight)

In `generate-tracks`, planning is already separated from implementation:

- The **orchestrator** session (the `claude -p` process) writes the batch style
  brief and assigns each track its variation directive, seed, and extension
  constraints.
- **Stage 1 — kit design** discovers and designs the batch's bespoke sound kit.
  This is where sonic taste/discovery lives.
- **Stage 2 — compose agents** are handed a tight, prescriptive spec (brief +
  seed + kit voices + constraints) and merely *arrange* the already-designed kit
  into a validated track. Their output must pass `scripts/validate.mjs` plus the
  character gate before it is saved.

Because the taste-bearing work (brief, kit, directives) stays on Opus and the
compose step is bounded by a detailed spec **and** a hard validator floor, a
cheaper model has little room to drift. That is why we move compose — and only
compose — to Sonnet.

Stems are explicitly **out of scope**: a stem worker both *designs the star
sound and writes the code*, so the creative sound design is the worker's job and
resists full specification. Tiering stems is a separate, higher-risk decision
(see Future work) to make later from data.

## Architecture — what runs on what

| Layer | Role | Model | Why |
|---|---|---|---|
| Orchestrator (`claude -p`) | Writes style brief; assigns directives/seeds/constraints | **Opus** | The creative plan |
| Stage 1 — kit design agent | Designs the batch's bespoke sound kit | **Opus** (inherited) | Sound discovery = taste |
| Stage 2 — compose agents (×N) | Arrange the kit into validated tracks | **Sonnet** | Bounded by spec + validator |
| Stems (all stages) | unchanged | **Opus** (inherited) | Worker designs the sound itself |
| Remix / revise-from-notes | unchanged | **Opus** (inherited) | Out of scope |

## Mechanism

Two layers select a model; we touch both:

1. **Orchestrator / planner model** is set by the `claude -p` invocation built in
   `server/runner.mjs` → `buildArgv`. Today it passes no `--model`, so it rides
   the CLI default. We pin it explicitly via a new `--model` argument sourced
   from `process.env.CRATE_PLANNER_MODEL || 'opus'`. This makes orchestration
   deterministic and, by inheritance, keeps kit design, stems, remix, and revise
   on Opus. The env var is the single revert/override knob.

2. **Worker model** is chosen by the orchestrator when it dispatches an agent via
   the `Task` tool (already in the runner's allowlist). The `Task` tool accepts a
   per-dispatch model. So in `.claude/skills/generate-tracks/SKILL.md` Stage 2,
   each compose agent is dispatched with the **Sonnet** model; Stage 1 (kit) is
   dispatched with **no** model override so it inherits the Opus orchestrator
   model.

## Changes (two files + one test)

1. **`server/runner.mjs`** — in `buildArgv`, add `--model ${process.env.CRATE_PLANNER_MODEL || 'opus'}`.
2. **`.claude/skills/generate-tracks/SKILL.md`** — Stage 2 (step 6) dispatch
   instructions: each compose agent dispatched with the Sonnet model; add a
   one-line note that Stage 1 (kit) takes no model override and inherits Opus.
3. **`test/runner.test.mjs`** — assert `buildArgv` output contains `--model`.

## Quality safeguards (reuse existing infrastructure — no new infra)

- The compose prompt is already highly prescriptive, so Sonnet has little room to
  drift.
- `scripts/validate.mjs` + the character gate are a hard quality floor: weak
  output is rejected and retried (≤3 attempts), so junk cannot reach the DB.
- Two existing signals reveal quality slips: the **batch report** (compose
  failure/retry counts in the job summary) and **user ratings** (via
  `feedback.mjs` over time).

## Known secondary effect to watch

Sonnet may hit the character gate more often → more retries (cheap, still Sonnet)
but possibly smaller effective batches. The batch report surfaces this.

## Revert path

One knob, two granularities:

- Roll the whole run back to single-tier by setting `CRATE_PLANNER_MODEL` and
  removing the Sonnet directive line in the skill, **or**
- Keep planning on Opus but move compose back by deleting the one Sonnet-model
  line in `generate-tracks/SKILL.md` Stage 2 (compose then inherits Opus).

## Out of scope (YAGNI)

- Prompt caching of the guides.
- Tiering stems (approach B) — decide later from data.
- Per-agent model configuration beyond the single `CRATE_PLANNER_MODEL` knob.
- Any A/B harness — existing report + ratings suffice.

## Future work

If Sonnet compose holds up on ratings, revisit stems: add an Opus "stem-spec"
planning pass that enriches each stem directive into a near-complete recipe, then
let Sonnet implement. Higher risk; gated on track-mode results.
