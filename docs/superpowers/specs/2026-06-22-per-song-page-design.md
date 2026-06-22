# Per-song page + share links — design

Date: 2026-06-22
Status: approved (design); pending spec review

## Goal

Let users share a link to an individual song. Opening that link lands on a
dedicated single-song page (`/song/<slug>`) with a big player, the expanded
Strudel code, a metadata panel, and the version history for that song's family.
Each card in the main tracks/stems lists gets a share button that produces the
link.

All tracks/stems are already public (`isPublic: true` on every insert; perms
gate `view` to `isPublic == true || owner`), so shared links work for
logged-out visitors with no auth wall. This feature adds no new permissions.

## 1. URL & routing

Share URL is path-style: **`/song/<slug>`**
(e.g. `/song/2026-06-16-uk-garage-dubstep-09`).

`/song/<slug>` is wired like the existing `/stems` clean URL, in both places
that handle routing:

- **Dev** — `vite.config.js` middleware: rewrite any request whose path starts
  with `/song/` to `/song.html` (mirror the existing `rewriteStems` plugin with
  a `rewriteSong` sibling). The slug is *not* passed through; the client reads
  it from `location.pathname`.
- **Prod** — `server/app.mjs`: add `app.get('/song/:slug', (_req, res) =>
  res.sendFile(join(opts.distDir, 'song.html')))` next to the existing
  `/stems` route, before `express.static`.

`song.html` is added as a new entry in `vite.config.js`
`build.rollupOptions.input` (alongside `main`, `stems`, `exportRender`).

Vite's default asset base is `/` (absolute), so assets referenced from the
deeper `/song/<slug>` path still resolve correctly — no base config change.

## 2. The song page

New files: `song.html` (entry, mirrors `stems.html`'s head/shell) and
`src/song.js` (page logic). `song.html` imports `src/song.js` and pulls in
`src/style.css` plus any song-specific styles.

Layout, top → bottom:

- **Header** — brand + a "← back to crate" link. Links to `/` for a track,
  `/stems` for a stem.
- **Big player** — large title, artist name, and a prominent play/stop button.
  Reuses `mountEditor` (from `src/editor.js`) so playback runs on the same
  Strudel engine as the lists. The footer seek scrubber may be reused if it
  drops in cleanly; otherwise a play/stop button is sufficient for v1.
- **Expanded Strudel code** — the `mountEditor` CodeMirror view, shown expanded
  and read-only. This *is* the code display (no separate, drift-prone code
  block).
- **Metadata panel** — BPM, genre, mood, key, instruments, energy (from
  `meta`), plus `description` and the original `prompt`.
- **Version history** — other versions in the same family, computed with the
  existing, already-tested `groupVersions` (`src/versions.js`). Each version
  links to its own `/song/<slug>`. Hidden when the family has only one member.

States:

- **Loading** — shown while the Instant query resolves.
- **Not found** — unknown/missing slug → friendly "song not found" message with
  a back-to-crate link.

## 3. Reuse / targeted refactor

The Strudel bootstrap is currently inline in `app.js`'s `initApp`:
`initAudioOnFirstClick()`, `enableSilentSwitchPlayback()`, then an async
`evalScope(core, mini, tonal, webaudio)` + `registerSynthSounds()` + `banks`
sample loading.

Extract this into **`src/strudel-boot.js`** exporting a single function (e.g.
`bootStrudel()` returning the `ready` promise). `app.js` and `song.js` both
import it. This avoids duplicating ~20 lines of fragile init and keeps one
source of truth for which sample banks load. No behavior change to `app.js`
beyond the extraction.

## 4. Resolving the item

`song.js` reads the slug from `location.pathname` (strip the `/song/` prefix,
decode). It queries Instant for one item by `slug`, including `author`:

- Query `tracks` filtered by `{ slug }` (slug is unique + indexed).
- If no match, query `stems` by `{ slug }`.
- Render whichever matches; remember which namespace it came from (drives the
  back link and the version-family query).

Slugs are date-prefixed and distinct across namespaces in practice; the
tracks-then-stems fallback is a documented simplification. If both ever held the
same slug, the track wins.

Version family: query the same namespace for items whose `versionOf` equals the
item's root slug (or the item's own slug if it is the root), then pass through
`groupVersions` and render the matching family.

## 5. Share affordance on list cards

In `app.js`'s card rendering, add a small **share button** to each card (both
tracks and stems lists). On click:

- If `navigator.share` exists (mobile / supporting browsers) → call it with the
  song title and the absolute `/song/<slug>` URL.
- Otherwise → `navigator.clipboard.writeText(url)` and show a brief "Copied!"
  toast.

URL is built by a small pure helper `songUrl(slug)` → `/song/${slug}`
(absolute path; callers prepend `location.origin` when an absolute URL is
needed for sharing).

## 6. Testing

- New vitest `.mjs` test in `test/` for the pure helpers:
  - `songUrl(slug)` builds `/song/<slug>` and encodes correctly.
  - slug parsing from a `/song/<slug>` pathname returns the decoded slug (and
    handles trailing slash / missing slug).
- `groupVersions` is already tested; reused as-is for the version list.
- Manual verification: load `/song/<known-slug>` in dev, confirm play, code,
  metadata, version links, back link, and the not-found path.

## Out of scope (YAGNI)

- No auto-play (mobile blocks it without a gesture; the big play button covers
  it).
- No new permissions or private/unlisted songs.
- No server-side rendering or per-song meta tags / OG cards (could be a future
  enhancement; v1 is client-rendered).
- No edit/delete from the song page.
