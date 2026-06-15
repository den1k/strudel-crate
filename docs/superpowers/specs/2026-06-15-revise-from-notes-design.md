# Revise-From-Notes: Note-Driven Version Regeneration

**Date:** 2026-06-15
**Status:** Approved

## Goal

When a stem or track has a listener **note**, automatically generate a new
version that honors it. Provide a command `/revise-from-notes <stems|tracks>`
that revises every item needing it, and run that same flow automatically as the
first step of `/generate-stems` and `/generate-tracks` (and any future
generation command).

## Decisions

- **Trigger:** for each version family, if the **latest** version has a
  non-empty `notes` field, generate the next version honoring it. (Version
  chains are linear, so "latest with a note" == "a noted item that hasn't had a
  newer version generated yet.")
- **Any non-empty note triggers** — no intent detection. Praise-only notes
  produce a faithful refinement. The user controls it by leaving the note empty.
  Whitespace-only notes are treated as empty (skipped).
- **Idempotent:** the generated child version has a new id and therefore no
  rating file and no note, so it never re-triggers. The original note stays on
  its (now superseded) version as history.
- **Stars alone never trigger** — only the `notes` field does.
- **Per-collection target:** the command takes `stems` or `tracks`; it only
  touches that collection. Auto-runs pass the matching collection.
- **Command name:** `/revise-from-notes`.

## Architecture

A model-driven skill orchestrates parallel agents (same shape as
`/generate-stems`), backed by a pure selection helper and a thin CLI that
produces the work list.

### `pendingRevisions(items)` — `src/versions.js`

Pure function added beside `groupVersions` (reuses it). Input: the flat list of
items from the store (each merged with its `rating`/`notes`/`lesson`). Output:
one work item per family whose latest version has a non-empty note:

```
{ root, nextId, version, note, code, batch, prompt, title }
```

- `root` = `family` (the root id; v1's id).
- `version` = `latest.version + 1` (the new version number).
- `nextId` = `${root}-v${version}` (single-version family → `-v2`; a family
  whose latest is v2 → `-v3`).
- `note`, `code` come from the **latest** version (what the user is reacting to).
- `batch`, `prompt` come from the latest version (same across a family).
- `title` is the **root (v1) title** (the clean base, e.g. "Hollow Engine"), so
  the generated title is `${title} v${version}` ("Hollow Engine v3") rather than
  doubling a suffix off "Hollow Engine v2".

Families whose latest note is empty/whitespace are excluded. Notes on
non-latest versions are ignored (they were already superseded).

### `scripts/pending-revisions.mjs <stems|tracks>` — CLI

Thin wrapper mirroring `scripts/feedback.mjs`: selects the store
(`stems`+`data/stem-ratings` or `tracks`+`data/ratings`; default/unknown arg →
tracks), calls `pendingRevisions(await store.listTracks())`, and prints the work
list as JSON to stdout. Prints `[]` when nothing is pending.

### `.claude/skills/revise-from-notes/SKILL.md` — skill

Workflow:
1. Resolve the collection from the argument (`stems` or `tracks`); read its
   guide (`STEMS_GUIDE.md` for stems, `STRUDEL_GUIDE.md` for tracks).
2. Run `node scripts/pending-revisions.mjs <collection>`; parse the JSON work
   list. If empty, report "nothing to revise" and stop.
3. Dispatch one agent per work item, in parallel waves of at most 8. Each agent
   is given: the collection's guide (to read in full), the latest version's
   `code`, its `note`, and the target `nextId`/`root`. It writes
   `<collection>/<nextId>.json` with all required fields PLUS
   `versionOf: "<root>"`, a fresh `createdAt`, `batch`/`prompt` copied from the
   work item, `title` = `${work.title} v${work.version}`, a revised `code` that
   honors the note, then runs
   `node scripts/validate.mjs <collection>/<nextId>.json`, fixing until it
   passes (≤3 attempts; on continued failure delete the file).
4. Report a table: nextId · title · status, plus any failures.

### Generation-command integration

`generate-stems` and `generate-tracks` SKILL.md each get a new **Step 0**:
before collecting feedback / generating the new batch, run the revise-from-notes
flow for this collection (invoke the `revise-from-notes` skill with the matching
collection) so noted items are brought up to date first. The new batch then
proceeds as today. Any future generation command must include the same Step 0;
`revise-from-notes` is the single source of the revision logic.

## Data flow

note on latest version → `pendingRevisions` lists it → agent writes a validated
`<root>-v{N+1}.json` with `versionOf` → the webapp's existing `groupVersions`
folds it into the family as the new latest → its empty note means the next run
skips it.

## Error handling

- Empty work list → clean "nothing to revise"; auto-run continues to the batch.
- Whitespace-only note → excluded by `pendingRevisions`.
- Validation fails after 3 attempts → delete the file, report FAILED for that
  item; other items are unaffected.
- Unknown collection arg to the CLI → defaults to tracks (matches
  `feedback.mjs`).

## Testing

- **Unit (`test/versions.test.mjs`)** for `pendingRevisions`: latest-with-note
  selected; correct `nextId` for a single-version family (`-v2`) and a
  multi-version family (`-v3`); note on a non-latest version ignored;
  whitespace-only and empty notes skipped; no-note family produces no work item.
- Existing `groupVersions` tests stay green.
- **Manual/observed:** run `/revise-from-notes stems` against the crate with a
  noted item present and confirm a validated `-vN.json` with the correct
  `versionOf` appears and shows in the webapp switcher. The agent generation and
  the SKILL.md edits are verified this way (not unit-testable).

## Out of scope

- Intent classification of notes (any non-empty note triggers).
- Branching version trees (chains are linear).
- A note-"consumed" marker (the empty-note-on-child rule replaces it).
- Auto-running on non-generation commands (build/test/validate plumbing).
- Track versioning UI changes (the existing version switcher already handles any
  collection).

## Execution

In a new git worktree (consistent with recent features).
