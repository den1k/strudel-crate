# Shareable View State in the URL

**Date:** 2026-06-22
**Status:** Approved — ready for implementation plan

## Problem

The crate (`/`) and stems (`/stems`) list pages hold meaningful view state —
which batch is selected, the rating filter, and which song is playing — entirely
in memory (plus a `sessionStorage` snapshot used only for Back/Forward scroll
restore). Only `?batch=` is read from the URL, and it is never written back.

There is no way to send another person "look at *this* view": a specific batch,
filtered a particular way, cued to the song you're listening to. The address bar
does not reflect the state, so it can't be copied and shared.

Additionally there is no way to filter the list to a single author's catalogue.
The existing `mine` button is the only author-aware control and it is a bespoke
filter value rather than a reusable "by this author" axis.

## Goal

Make the address bar the single shareable representation of list-page view
state, and add an author filter:

- Each batch / author / rating-filter combination is its own copyable URL.
- The currently playing song travels in the URL so a recipient lands cued to it.
- Add an author filter (dropdown). The `mine` button becomes a one-click
  shortcut into that same author axis.

Pasting a shared URL into a fresh tab reproduces the sender's view.

## Design

### URL parameters

Query params on `/` and `/stems`:

| Param    | Value                                   | Omitted when      |
|----------|-----------------------------------------|-------------------|
| `batch`  | batch id (e.g. `2026-06-16-uk-garage`)  | "all"             |
| `filter` | `all` \| `unrated` \| `top`             | "all"             |
| `user`   | author **profile id**                   | no author filter  |
| `play`   | playing song's **entityId**             | nothing playing   |

Defaults are omitted so a clean view yields a clean URL (`/`, not
`/?batch=all&filter=all`). The `play` value is the globally-unique Instant entity
id, consistent with `songUrl()` in `song-url.js` (a track and a stem can share a
slug, so the entity id is the unambiguous key).

#### Why profile id for `user` (not the auth `$users` id)

`tracks.author` / `stems.author` link to `profiles`, which link to `$users` via
`userProfile`. `profiles` are publicly viewable (`view: 'true'`), but `$users`
uses Instant's default perm (`auth.id == data.id`) — a client can only read its
*own* `$users` row, and `$users` also holds emails. A shareable `?user=` filter
must work for the recipient (often not the author, possibly logged out), so it
keys on the publicly-readable **profile id**. This is also what the existing
`mine` logic already compares against (`authorProfileId`).

### Two independent filter axes

- **Rating axis** → `state.filter` ∈ `{ all, unrated, top }`, mutually exclusive,
  driven by the `all` / `unrated` / `top` segment buttons.
- **Author axis** → `state.user` ∈ `{ null, <profileId> }`, driven by *both* the
  new author dropdown and the `mine` button, kept in sync.

The axes compose with AND in `visibleFamilies()`.

### New module — `src/view-url.js` (pure, unit-tested)

Mirrors `song-url.js`: no DOM, no Instant, so it unit-tests directly and is the
single source of truth for the query-string shape.

- `readViewParams(search)` → `{ batch, filter, user, play }`. Each field is
  `null` when the param is absent. `filter` is validated against
  `['all','unrated','top']`; any other value → `null`. `batch=all` / `filter=all`
  normalize to `null` (treated as "no filter").
- `buildSearch({ batch, filter, user, play })` → a canonical query string
  (leading `?` or empty string), omitting defaults/nulls, with a stable key
  order (`batch`, `filter`, `user`, `play`) so equal state always produces an
  identical URL.

### `app.js` changes

1. **State** gains `user` (default `null`).

2. **Load (URL is authoritative).** Replace the current `?batch=` read with
   `readViewParams(location.search)`. Precedence for `batch` / `filter` / `user`:
   URL param → `sessionStorage` restore (Back/Forward only) → default. `play` is
   read only from the URL (used for cueing). `sessionStorage` continues to own
   scroll position and per-family version selection.

   Because filters are now written to the URL via `replaceState`, returning to a
   list page from a song page (browser Back) restores the URL with its query
   string intact, so the URL naturally reproduces the left-on view.

3. **`syncUrl()`** — `history.replaceState(null, '', location.pathname +
   buildSearch({ batch, filter, user, play }))`. `play` resolves the current
   `state.playingId` (a slug) to its `entityId` via `state.tracks`. Called
   whenever `batch`, `filter`, or `user` changes, and on play / stop.
   `replaceState` (not `pushState`) so filtering never spams Back history.

4. **Author dropdown `#user-filter`** (new). `renderUserFilter()` builds the
   option list from authors present in `state.tracks`: a `profileId → artistName`
   map, sorted by name, default option "all artists" (value `all`). The
   signed-in user's own entry is suffixed "(you)" and sorted to the top.
   Reflects `state.user`. Names come from the public `profiles` data already on
   each row, so labels render correctly for logged-out viewers.

5. **`mine` button** — kept, auth-gated as today (shown only when signed in;
   needs `myProfileId`). It now drives the *author* axis: clicking sets
   `state.user = myProfileId`, or toggles back to all-authors if already active.
   It no longer participates in the rating segment's mutual exclusion; its `.on`
   state reflects `state.user === myProfileId`. The dropdown and the `mine`
   button stay in sync (selecting another author or "all artists" turns `mine`
   off). `myProfileId` is still resolved (for per-user play counters and the
   "(you)" label).

6. **`visibleFamilies()`** gains an author predicate:
   `if (state.user && fam.latest.authorProfileId !== state.user) return false;`
   The rating predicate drops the `mine` case (no longer a filter value).

7. **Cue on load.** After the first render that produces content (reuse the
   existing `pendingScrollRestore` first-content hook), if `play` is set: map the
   `entityId` to its row in `state.tracks`, select that version within its family
   (`selectedByFamily`), scroll the card into view, and add a `.cued` highlight
   class. No autoplay is attempted (browsers block it without a gesture); one
   click on the card's ▶ starts playback and clears the autoplay gate. If the
   `play` target is filtered out or not found, cueing is silently skipped.

### Supporting changes

- **`index.html` + `stems.html`:** add `<select id="user-filter"
  aria-label="filter by artist">` in `.filters` (next to `#batch-filter`); keep
  the `mine` button.
- **`list-state.js`:** add `user` to the persisted snapshot shape (and rehydrate
  it) so Back/Forward restore covers the author axis alongside batch/filter.
- **`style.css`:** `.track.cued` highlight ring (a brief pulse settling into a
  persistent ring until played).

### Testing

- Unit tests for `view-url.js`:
  - `readViewParams` parses each param; absent → `null`; `batch=all` /
    `filter=all` → `null`; invalid `filter` → `null`.
  - `buildSearch` omits defaults/nulls, emits empty string for a clean view, and
    is stable in key order.
  - Round-trip: `readViewParams(buildSearch(x))` preserves non-default fields.
- Manual: open a list page, set batch + filter + author + play; copy the URL;
  open in a fresh tab → same batch/filter/author selected, target song scrolled
  to and `.cued`, one click starts it.

## Edge cases & non-goals

- **`?user=<id>` for a private catalogue:** perms already restrict non-public
  items; a recipient sees only the author's public items. No special handling.
- **`play` target hidden by the shared filters:** cueing is skipped silently
  (it shouldn't normally happen — the sender was playing it within that view).
- **No autoplay:** out of scope by design; cue + one-click only.
- **No `/batch/<id>` path routes:** query params satisfy "unique URL per batch"
  with zero nginx/routing changes; path-based routing is not pursued.
- **No "share this view" button:** the live-updating address bar is the share
  surface; the existing per-song share button is unchanged.
- **`/song/<id>` page:** unchanged; not part of this work.
