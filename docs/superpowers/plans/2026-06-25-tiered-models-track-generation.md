# Tiered Models for Track Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run track-compose Claude calls on Sonnet while keeping orchestration and kit design on Opus, to cut Opus spend without trading away quality.

**Architecture:** Track generation already splits planning (orchestrator writes the brief + per-track directives; Stage 1 designs the sound kit) from implementation (Stage 2 compose agents arrange the kit into validated tracks). We pin the orchestrator to Opus via a new `--model` arg in `server/runner.mjs`, and instruct the `generate-tracks` skill to dispatch Stage-2 compose agents on Sonnet while Stage-1 kit design inherits Opus. Stems and the other skills are untouched and inherit Opus.

**Tech Stack:** Node.js (ESM `.mjs`), Vitest, Claude Code CLI (`claude -p`) + Task-tool sub-agents, Markdown skill files.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-25-tiered-models-track-generation-design.md`.
- Only `generate-tracks` Stage 2 (compose) moves to Sonnet. Stage 1 (kit design), stems, remix, and revise-from-notes stay on Opus.
- Planner model is configurable via `process.env.CRATE_PLANNER_MODEL`, defaulting to `'opus'`. This is the single revert/override knob.
- Worker (Sonnet) model is selected per-dispatch in the skill via the `Task` tool's model parameter — no new code path.
- No new infrastructure: quality is policed by the existing `scripts/validate.mjs` + character gate and the existing batch report / `feedback.mjs` ratings.
- Test command: `npx vitest run <file>` (the repo's `npm test` is `vitest run`).
- Reuse model aliases `opus` / `sonnet` (version-resilient), never pinned model IDs.

---

### Task 1: Pin the planner/orchestrator model in `buildArgv`

Add a `--model` argument to the headless `claude -p` invocation so the orchestrator (and every sub-agent that does not override its model) runs on a known model, defaulting to Opus and overridable via `CRATE_PLANNER_MODEL`.

**Files:**
- Modify: `server/runner.mjs` (function `buildArgv`, ~lines 34-46)
- Test: `test/runner.test.mjs` (the existing `describe('buildArgv', …)` block, ~line 16)

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildArgv(job)` now returns an argv array that additionally contains `'--model'` followed by `process.env.CRATE_PLANNER_MODEL || 'opus'`. Argument order is otherwise unchanged; consumers (the `spawn('claude', buildArgv(job), …)` call in `runClaude`) need no change.

- [ ] **Step 1: Write the failing tests**

Add these two tests inside the existing `describe('buildArgv', () => { … })` block in `test/runner.test.mjs` (place them after the last existing `it(...)` in that block, before its closing `});`):

```js
  it('pins the planner model to opus by default', () => {
    const argv = buildArgv({ type: 'generate-tracks', prompt: 'dark techno', count: 12 });
    const i = argv.indexOf('--model');
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe('opus');
  });
  it('honors CRATE_PLANNER_MODEL override', () => {
    const prev = process.env.CRATE_PLANNER_MODEL;
    process.env.CRATE_PLANNER_MODEL = 'sonnet';
    try {
      const argv = buildArgv({ type: 'generate-tracks', prompt: 'dark techno', count: 12 });
      const i = argv.indexOf('--model');
      expect(argv[i + 1]).toBe('sonnet');
    } finally {
      if (prev === undefined) delete process.env.CRATE_PLANNER_MODEL;
      else process.env.CRATE_PLANNER_MODEL = prev;
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/runner.test.mjs -t "planner model"`
Expected: FAIL — `--model` is not present (`expect(i).toBeGreaterThan(-1)` fails because `indexOf` returns `-1`).

- [ ] **Step 3: Implement the change in `buildArgv`**

In `server/runner.mjs`, change the `return` at the end of `buildArgv` from:

```js
  return ['-p', prompt, '--output-format', 'json', '--allowedTools', ALLOWED_TOOLS];
```

to:

```js
  // Pin the orchestrator (planner) model. Sub-agents inherit this unless they
  // override it per-dispatch — generate-tracks Stage 2 dispatches compose
  // agents on Sonnet; everything else (kit design, stems, remix, revise) stays
  // on this model. Override via CRATE_PLANNER_MODEL; default Opus.
  const plannerModel = process.env.CRATE_PLANNER_MODEL || 'opus';
  return ['-p', prompt, '--model', plannerModel, '--output-format', 'json', '--allowedTools', ALLOWED_TOOLS];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/runner.test.mjs`
Expected: PASS — the two new tests pass and all pre-existing `buildArgv` tests still pass (they use `toContain`, so the extra args do not break them).

- [ ] **Step 5: Commit**

```bash
git add server/runner.mjs test/runner.test.mjs
git commit -m "feat(crate): pin planner model in buildArgv (default opus, CRATE_PLANNER_MODEL override)"
```

---

### Task 2: Dispatch Stage-2 compose agents on Sonnet (kit design stays on Opus)

Instruct the `generate-tracks` skill to dispatch each Stage-2 compose agent with the Sonnet model and to leave Stage-1 kit design with no model override (so it inherits the Opus orchestrator). Lock the directive in with a guard test so it cannot be silently dropped.

**Files:**
- Modify: `.claude/skills/generate-tracks/SKILL.md` (Stage 1 dispatch sentence ~lines 100-101; Stage 2 dispatch paragraph ~lines 150-156)
- Create: `test/generate-tracks-skill.test.mjs`

**Interfaces:**
- Consumes: the orchestrator model pinned in Task 1 (Stage 1 relies on inheriting it).
- Produces: a `generate-tracks/SKILL.md` that contains the exact token `model: sonnet` in its Stage-2 dispatch instructions and the exact token `model: opus` (or an explicit "no model override / inherits Opus") instruction in Stage 1. The guard test asserts the `model: sonnet` token is present.

- [ ] **Step 1: Write the failing guard test**

Create `test/generate-tracks-skill.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const skill = readFileSync(
  fileURLToPath(new URL('../.claude/skills/generate-tracks/SKILL.md', import.meta.url)),
  'utf8',
);

describe('generate-tracks skill model tiering', () => {
  it('dispatches Stage-2 compose agents on Sonnet', () => {
    expect(skill).toContain('model: sonnet');
  });
  it('keeps Stage-1 kit design on the inherited Opus model', () => {
    // Stage 1 must NOT push compose onto Sonnet; it inherits the orchestrator
    // model. We assert the explicit inherit note exists.
    expect(skill).toMatch(/Stage 1[\s\S]*inherit[\s\S]*Opus|no model override[\s\S]*Opus/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/generate-tracks-skill.test.mjs`
Expected: FAIL — `SKILL.md` does not yet contain `model: sonnet` nor the inherit note.

- [ ] **Step 3: Edit Stage 1 dispatch in `SKILL.md` to state it inherits Opus**

In `.claude/skills/generate-tracks/SKILL.md`, find the Stage-1 dispatch sentence (step 5):

```
   Run ONE kit-design agent (or a small fan-out of one agent per voice if you want
   parallelism — then assemble their `frag`s into one palette file). Its prompt:
```

Replace it with:

```
   Run ONE kit-design agent (or a small fan-out of one agent per voice if you want
   parallelism — then assemble their `frag`s into one palette file). Dispatch this
   agent with NO model override so it inherits the orchestrator's Opus model
   (`model: opus` effectively) — kit/sound design is taste-heavy and stays on the
   high tier. Its prompt:
```

- [ ] **Step 4: Edit Stage 2 dispatch in `SKILL.md` to use Sonnet**

In the same file, find the Stage-2 dispatch paragraph (step 6):

```
6. **STAGE 2 — fan out compose agents:** dispatch ALL agents for a wave in a SINGLE
   message (parallel tool calls), waves of at most 8. **Substitute `<repo root>`
```

Replace just that first sentence so the paragraph begins:

```
6. **STAGE 2 — fan out compose agents:** dispatch ALL agents for a wave in a SINGLE
   message (parallel tool calls), waves of at most 8. **Dispatch every compose
   agent on the cheaper Sonnet tier (`model: sonnet` on each Task call)** — they
   implement an already-designed kit against a tight spec that the validator and
   character gate enforce, so the high tier is not needed here. **Substitute `<repo root>`
```

(Leave the rest of the paragraph — the `<repo root>` / worktree warning and "Each agent gets this prompt" — unchanged.)

- [ ] **Step 5: Run the guard test to verify it passes**

Run: `npx vitest run test/generate-tracks-skill.test.mjs`
Expected: PASS — both `model: sonnet` and the Stage-1 inherit note are now present.

- [ ] **Step 6: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — no regressions across the suite.

- [ ] **Step 7: Commit**

```bash
git add .claude/skills/generate-tracks/SKILL.md test/generate-tracks-skill.test.mjs
git commit -m "feat(crate): run track-compose agents on Sonnet, keep kit design on Opus"
```

---

## Self-Review

**Spec coverage:**
- "Pin orchestrator to Opus via `--model` / `CRATE_PLANNER_MODEL`" → Task 1. ✓
- "Stage-2 compose dispatched on Sonnet; Stage-1 kit inherits Opus" → Task 2. ✓
- "Stems / remix / revise unchanged, inherit Opus" → covered by Task 1 (single pinned planner model, no skill edits to those paths) — no separate task needed. ✓
- "Reuse existing validator + report + ratings; no new infra" → no task creates infra; safeguards are pre-existing. ✓
- "Update `buildArgv` test for new `--model` arg" → Task 1 Step 1. ✓
- "Revert path = env knob / one-line skill edit" → encoded by the `CRATE_PLANNER_MODEL` default in Task 1 and the single `model: sonnet` line in Task 2. ✓

**Placeholder scan:** No TBD/TODO; every code and edit step shows exact content. ✓

**Type consistency:** `buildArgv(job)` signature unchanged; env var name `CRATE_PLANNER_MODEL` and token `model: sonnet` are used identically across the spec, plan, and guard test. ✓

**Out of scope (confirmed not planned):** prompt caching, stem tiering, per-agent model config beyond the env knob, A/B harness. ✓
