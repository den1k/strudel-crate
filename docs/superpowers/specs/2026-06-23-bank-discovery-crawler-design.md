# Strudel Bank Discovery Crawler — Design

**Date:** 2026-06-23
**Status:** Design — pending implementation plan
**Topic:** Crawl GitHub for public Strudel sample banks and build a categorized
index that Stage-1 kit-design agents use to discover far more sounds than the
handful currently hardcoded in the guide.

---

## 1. Problem

The open sound pipeline (Phase 1) lets generated tracks/kits load any bank via
`samples('github:user/repo')`, but **there is no lookup of which banks exist**.
Agents rely on: (a) the base allowlist `scripts/sounds.json`, (b) a hardcoded
list of ~4 known banks in `STRUDEL_GUIDE.md`, and (c) their own training-time
recall of the Strudel/Tidal ecosystem. That last path is unreliable — agents can
only name banks they happen to remember, and may hallucinate banks that don't
exist (caught by the validator, but at the cost of a retry).

GitHub code search for `filename:strudel.json` returns ~176 public bank repos —
far more than agents currently reach. We want to **crawl that corpus into a
categorized index** so agents discover real banks by browsing, not by recall.

### Goal

A scheduled crawler that discovers public Strudel banks on GitHub, validates
them lightly, categorizes them, and writes a committed `data/banks.json` index
plus a compact in-prompt digest that Stage-1 kit-design agents consume.

### Non-goals

- **Not** a trust boundary. The index is a *discovery aid*. The existing dynamic
  validator (`scripts/validate.mjs`) and cache-on-save remain the source of truth
  at track-save time; a broken crawled bank is still rejected there.
- **Not** the webapp's boot-time prebake. `shared/sample-banks.json` (the
  always-loaded base set) stays separate and unchanged.
- **Not** full Strudel-env validation of every bank during the crawl (too slow);
  only a cheap fetch+parse+has-sounds liveness check.
- No multi-source crawling in v1 (no account enumeration, topic search, or
  curated-list merging) — GitHub code search only. Those are future extensions.

---

## 2. Architecture & data flow

```
GitHub code search (filename:strudel.json)              ← discovery (gh api, authed)
        │  paginate (100/page), throttle to 30/min, dedupe by owner/repo
        ▼
for each repo: fetch raw strudel.json
        │  liveness: HTTP 200 · parses as JSON · >=1 sound (key != _base)
        │  extract sound names · count
        │  resolve loadable ref (github:owner/repo if root+main, else full raw URL)
        │  categorize (heuristic from sound-name tokens) · templated description
        ▼
data/banks.json   ← full categorized index (committed)
        │
        ├──▶ shared/banks-digest.md   ← compact category-grouped digest (generated)
        │         injected as {bank_digest} into the Stage-1 kit-design prompt
        │
        └──▶ agents grep data/banks.json for exact sound names before a samples() load
```

**Two consumers, two granularities:** the **digest** tells agents *what exists*
(cheap, in-prompt); the **full index** lets them look up *exact sound names* on
demand (grep). Discovery aid only — never a trust boundary.

---

## 3. Components

All crawl logic lives in `scripts/`, with pure helpers in `scripts/lib/` so the
non-network parts are unit-testable.

| Unit | Responsibility | Depends on |
|---|---|---|
| `scripts/crawl-banks.mjs` | Orchestrator: search → fetch → filter → enrich → write index + digest. The only unit that touches the network. | `gh` CLI, fetch, lib helpers |
| `scripts/lib/bank-index.mjs` | Pure helpers: `parseManifest`, `extractSounds`, `resolveRef`, `categorize`, `describe`, `buildDigest`. No I/O. | — |
| `data/banks.json` (new, committed) | The full categorized index. | crawler |
| `shared/banks-digest.md` (new, generated) | Compact category-grouped digest injected into the kit-design prompt. | crawler |
| `.claude/skills/generate-tracks/SKILL.md` | Inject `{bank_digest}` into the Stage-1 prompt; instruct agents to grep `data/banks.json`. | digest |
| systemd timer `vimsical-crate-crawl-banks` | Weekly: run crawl, regenerate files, commit the diff. | crawler |

### 3.1 Discovery (`crawl-banks.mjs`)

- Query `gh api '/search/code?q=filename:strudel.json&per_page=100&page=N'`,
  paginating until exhausted or the result cap is hit.
- Throttle to the search rate limit (30/min) — sleep between pages as needed.
- Dedupe to one entry per `owner/repo`; when a repo has multiple `strudel.json`,
  prefer the root-level one.
- Reuses the already-authenticated `den1k` `gh` token — no new secret to manage.

### 3.2 Fetch & light validation

- Fetch the raw `strudel.json` for each repo.
- Keep only if it **fetches (200), parses as JSON, and has >=1 sound** (a
  top-level key other than `_base`). Everything else is dropped (with a logged
  count of how many were skipped and why).

### 3.3 Resolve the loadable reference (`resolveRef`)

- Root-level manifest on the `main` branch → `github:owner/repo` shorthand.
- Otherwise → the full raw manifest URL (the `samples('https://…/strudel.json')`
  form). Guarantees every indexed bank is loadable exactly as the `ref` says.

### 3.4 Categorize & describe (pure, deterministic, no LLM)

- `categorize(sounds)` maps sound-name tokens to one of
  `{drums, bass, lead, pad, vocal, world, breaks, fx, melodic, misc}` via a
  keyword table (e.g. `bd/sd/hh/kick/snare`→drums; `vox/choir/aa/ooh/breath`→
  vocal; `break/amen/jungle`→breaks; `bass/sub/808`→bass; …). Ties resolved by a
  fixed priority order; no match → `misc`.
- `describe(entry)` is a template: `"<category> · <n> sounds · <first 3 names>…"`.

---

## 4. Index schema

`data/banks.json` — array of entries:

```json
{
  "ref": "github:eddyflux/crate",
  "repo": "eddyflux/crate",
  "category": "drums",
  "soundCount": 18,
  "sounds": ["crate_bd", "crate_sd", "crate_hh", "crate_djembe"],
  "description": "drums · 18 sounds · crate_bd, crate_sd, crate_djembe …",
  "stars": 42,
  "lastSeen": "2026-06-23"
}
```

- `ref` — exactly what an agent passes to `samples(...)`.
- `stars` — from the search result's repository data; used to rank the digest.
- `lastSeen` — crawl date; lets a future cleanup prune banks not seen in N crawls.

`shared/banks-digest.md` — category-grouped, one line per bank
(`name · ref · soundCount`), **no sound lists**, capped to the top N per category
by stars, with a footer per category: *"…and M more — grep `data/banks.json`."*

---

## 5. Agent wiring

In `generate-tracks/SKILL.md`, the Stage-1 (kit-design) prompt gains a
`{bank_digest}` placeholder, injected alongside the existing `{kit_digest}`
anti-convergence memo. Instruction to agents: these are real, loadable banks —
reach past the base palette; grep `data/banks.json` for a bank's exact sound
names before writing the `samples()` load. The compose stage is unchanged.

---

## 6. Scheduling

- A `systemd` timer `vimsical-crate-crawl-banks` runs the crawl weekly.
- It regenerates `data/banks.json` + `shared/banks-digest.md` in the live
  checkout and **commits the diff** (single-user repo; low noise). The live
  server reads these files at generation time, so no rebuild or service restart
  is needed.
- Installed under the same conventions as other vimsical units (mind the
  `/etc` read-only remount gotcha noted in project memory).

---

## 7. Error handling

- Search API failure / rate-limit (403/429) → back off and retry; if the crawl
  cannot complete, leave the existing `banks.json` untouched (never overwrite a
  good index with a partial one). Write the new index atomically (temp file →
  rename) only on a fully successful run.
- Individual repo fetch/parse failures are skipped and counted, never fatal.
- A run that yields zero banks is treated as a failure (keep the prior index).

---

## 8. Testing

- Unit-test the pure helpers in `scripts/lib/bank-index.mjs` against fixture
  manifests: `parseManifest` (valid/invalid/empty), `extractSounds` (drops
  `_base`), `resolveRef` (root+main → shorthand; subpath/branch → URL),
  `categorize` (each category + tie-breaking + misc fallback), `describe`,
  `buildDigest` (grouping, per-category cap, footer count).
- One network-gated smoke test (skipped by default) that one real search page
  fetches and parses end-to-end.
- The default `npm test` suite stays fully offline and green.

---

## 9. Open implementation questions (resolve during planning)

- Exact per-category cap N for the digest (tune to keep it prompt-sized).
- Whether to record a `branch`/`path` field for non-root manifests (only if the
  raw URL alone proves insufficient).
- Crawl cadence (weekly assumed) and whether the timer commits or just writes.
