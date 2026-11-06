---
name: revise-from-notes
description: Generate a new version of every stem/track whose latest version has a listener note, honoring that note. Use when the user wants to act on notes, regenerate versions from feedback, or revise noted items. Also auto-runs as Step 0 of /generate-stems and /generate-tracks. Args: <stems|tracks>
---

# Revise From Notes

For the chosen collection, generate one new VERSION of every item whose latest
version carries a non-empty note, with the new version honoring that note. A note
is a per-item request for change; the new version supersedes the noted one.

## Workflow

1. **Resolve the collection** from the argument: `stems` or `tracks` (default to
   `tracks` if absent). Set:
   - stems → guide `STEMS_GUIDE.md`, singular `STEM`, save script `save-stem.mjs`
   - tracks → guide `STRUDEL_GUIDE.md`, singular `TRACK`, save script `save-track.mjs`

2. **Read the guide** (`STEMS_GUIDE.md` or `STRUDEL_GUIDE.md`) in full (Read
   tool). Agents must read it themselves too — your prompt tells them to.

3. **Get the work list:** run `node scripts/pending-revisions.mjs <collection>`.
   It prints a JSON array; each item is
   `{ root, nextId, version, note, code, batch, prompt, title }`. Inside a job it
   holds only the requester's own song families, at most 24 at a time. If the array is
   empty, report "Nothing to revise — no noted items pending." and STOP.

4. **Get a timestamp** for the new versions: `date -u +%Y-%m-%dT%H:%M:%SZ`.

5. **Fan out agents:** dispatch ALL agents for a wave in a SINGLE message
   (parallel tool calls), waves of at most 8. Dispatch each agent with NO model
   override so it inherits the orchestrator's Opus model — revising a noted item
   is taste-heavy, like the original generation, so it stays on the high tier
   (only generate-tracks Stage-2 compose runs on Sonnet). **Substitute `<repo root>` below
   with the ABSOLUTE path of your current working directory (run `pwd` first).**
   In a git worktree that is the worktree path, NOT the main checkout — a relative
   or wrong path makes agents write files and `git commit` in the wrong checkout.
   Each agent gets this prompt with placeholders filled from one work item (and
   `{guide}`/`{singular}`/`{save_script}` from step 1):

   ```
   You are writing exactly one Strudel {singular} file: a new VERSION of an
   existing one that honors a listener note. Work in <repo root> (use this
   absolute path for every file path and every git command; do not cd elsewhere).

   1. Read {guide} COMPLETELY and follow every rule in it.
   2. This is version {version} of "{title}". The listener note to honor is:
      "{note}". The current (latest) version's code is:

      {code}

      Revise it to honor the note while keeping the same core identity. Change
      enough to genuinely address the note; do not just copy the code.
   3. Run `mkdir -p staging` (in case the dir does not exist), then write
      staging/{nextId}.json with ALL required fields PLUS the version link:
      id "{nextId}", versionOf "{root}", batch "{batch}", prompt "{prompt}",
      title "{title} v{version}", createdAt "{timestamp}",
      description (1-3 sentences: the sound/track and how this version answers
      the note), meta (the full required meta object per the guide),
      code (your revised Strudel code).
   4. Run: node scripts/{save_script} staging/{nextId}.json
      This validates AND saves the new version to the database (with you as
      author). If it prints FAIL: read the reason, fix staging/{nextId}.json
      (for unknown sounds grep scripts/sounds.json), re-run. Up to 3 attempts.
      If still failing, delete the file (rm staging/{nextId}.json).
      On PASS the version is live; do NOT also run validate.mjs.
   5. Reply with EXACTLY one line:
      OK {nextId} "{title} v{version}"  — or —  FAILED {nextId} <one-line reason>
   ```

6. **Report:** a table (nextId · title · status), the count of versions written,
   and any failures with reasons.

## Notes

- The save script is the contract: it validates AND persists, so a version only
  exists if `save-track.mjs` / `save-stem.mjs` passes & saves it.
- Never edit `scripts/sounds.json` to make a file pass — change the file.
- The new version starts with no rating/notes, so the next run will not
  re-trigger it. The original note stays on its (now superseded) version.
- Revisions are new rows (a new `nextId` with `versionOf` set); they never
  overwrite the original — there is nothing to delete from the collection.
