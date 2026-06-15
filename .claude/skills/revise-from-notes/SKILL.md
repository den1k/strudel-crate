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
   - stems → dir `stems/`, guide `STEMS_GUIDE.md`, singular `STEM`
   - tracks → dir `tracks/`, guide `STRUDEL_GUIDE.md`, singular `TRACK`

2. **Read the guide** (`STEMS_GUIDE.md` or `STRUDEL_GUIDE.md`) in full (Read
   tool). Agents must read it themselves too — your prompt tells them to.

3. **Get the work list:** run `node scripts/pending-revisions.mjs <collection>`.
   It prints a JSON array; each item is
   `{ root, nextId, version, note, code, batch, prompt, title }`. If the array is
   empty, report "Nothing to revise — no noted items pending." and STOP.

4. **Get a timestamp** for the new versions: `date -u +%Y-%m-%dT%H:%M:%SZ`.

5. **Fan out agents:** dispatch ALL agents for a wave in a SINGLE message
   (parallel tool calls), waves of at most 8. Each agent gets this prompt with
   placeholders filled from one work item (and `{dir}`/`{guide}`/`{singular}`
   from step 1):

   ```
   You are writing exactly one Strudel {singular} file: a new VERSION of an
   existing one that honors a listener note. Work in <repo root>.

   1. Read {guide} COMPLETELY and follow every rule in it.
   2. This is version {version} of "{title}". The listener note to honor is:
      "{note}". The current (latest) version's code is:

      {code}

      Revise it to honor the note while keeping the same core identity. Change
      enough to genuinely address the note; do not just copy the code.
   3. Write {dir}{nextId}.json with ALL required fields PLUS the version link:
      id "{nextId}", versionOf "{root}", batch "{batch}", prompt "{prompt}",
      title "{title} v{version}", createdAt "{timestamp}",
      description (1-3 sentences: the sound/track and how this version answers
      the note), meta (the full required meta object per the guide),
      code (your revised Strudel code).
   4. Run: node scripts/validate.mjs {dir}{nextId}.json
      If FAIL: read the error, fix (for unknown sounds grep scripts/sounds.json),
      re-run. Up to 3 attempts. If still failing, delete the file
      (rm {dir}{nextId}.json).
   5. Reply with EXACTLY one line:
      OK {nextId} "{title} v{version}"  — or —  FAILED {nextId} <one-line reason>
   ```

6. **Report:** a table (nextId · title · status), the count of versions written,
   and any failures with reasons.

## Notes

- Validation is the contract: a version only exists if `validate.mjs` passes it.
- Never edit `scripts/sounds.json` to make a file pass — change the file.
- The new version starts with no rating/notes, so the next run will not
  re-trigger it. The original note stays on its (now superseded) version.
- `{dir}` already ends with a slash (`stems/` or `tracks/`), so `{dir}{nextId}.json`
  is the correct path.
