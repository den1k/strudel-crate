---
name: remix
description: Generate a new remix of one existing stem/track honoring the remixer's instructions, owned by the remixer and linked to the source via remixOf. Never touches the original. Args: <stems|tracks> <slug> "<instructions>"
---

# Remix

Produce ONE new item: a remix of an existing stem/track that honors the
remixer's instructions. The new item is a fresh row owned by the remixer (via
CRATE_AUTHOR_PROFILE_ID) and carries `remixOf` = the source's root slug. The
original is read-only input — never edit or overwrite it.

## Workflow

1. **Parse args:** `<collection> <slug> "<instructions>"`. Collection is `stems`
   or `tracks`. Set guide/singular/save script:
   - stems → guide `STEMS_GUIDE.md`, singular `STEM`, save `save-stem.mjs`
   - tracks → guide `STRUDEL_GUIDE.md`, singular `TRACK`, save `save-track.mjs`

2. **Read the guide** (`STEMS_GUIDE.md` or `STRUDEL_GUIDE.md`) COMPLETELY and
   follow every rule in it.

3. **Get the source + new id:** run
   `node scripts/remix-source.mjs <collection> <slug>`. It prints JSON
   `{ root, newId, namespace, title, batch, prompt, code, meta }`. If it errors
   (source not found), report that and STOP.

4. **Get a timestamp:** `date -u +%Y-%m-%dT%H:%M:%SZ`.

5. **Run `pwd`** to get the absolute repo root; use it for every path below.

6. **Write the remix:** revise the source `code` to honor the instructions while
   keeping it a coherent {singular}. Change enough to genuinely realize the
   instructions; do not just copy. Run `mkdir -p staging`, then write
   `<repo root>/staging/{newId}.json` with ALL required fields PLUS the remix link:
   - id `{newId}`, remixOf `{root}`, batch `{batch}`, prompt `"<instructions>"`,
     title `{title} (remix)`, createdAt `{timestamp}`,
   - description (1-3 sentences: the sound and how this remix realizes the
     instructions),
   - meta (the full required meta object per the guide),
   - code (your revised Strudel code).

7. **Validate + save:** run `node scripts/{save_script} staging/{newId}.json`.
   On FAIL read the reason, fix the file (grep `scripts/sounds.json` for unknown
   sounds), re-run — up to 3 attempts. If still failing, `rm staging/{newId}.json`.
   On PASS the remix is live and owned by the remixer.

8. **Report** exactly one line:
   `OK {newId} "{title} (remix)"`  — or —  `FAILED {newId} <one-line reason>`

## Notes

- The save script is the contract: it validates AND persists with the remixer as
  author (CRATE_AUTHOR_PROFILE_ID), setting remixOf so the item shows a "remixed
  from" backlink. The source row is never modified.
- Never edit `scripts/sounds.json` to make a file pass — change the file.
