# Profile chip + settings modal — design

**Date:** 2026-06-22
**App:** crate
**Goal:** Replace the ugly bare artist-name `<input>` jammed into the section nav
with a clean right-aligned user cluster: a name chip that opens a proper profile
settings modal. Sign in / sign out and profile settings all live on the right.

## Problem

Today `auth.js` `appendChild`s both the auth button and a naked
`<input placeholder="artist name">` directly into `.nav` (`src/auth.js:67,77`),
so they sit alongside the `crate` / `stems` / bell links. The name editor is an
unframed input prefilled with the artist name (e.g. "kalavox"). It looks unfinished
and is mixed in with navigation.

## Design

### 1. Layout / structure

Add a dedicated right-side user cluster to the masthead so auth + profile stop
polluting the section nav.

- **HTML** (`index.html` + `stems.html`): add an empty `<div class="user">` as the
  **last** masthead child. Row order becomes:
  `brand · nav(crate/stems/bell) · filters · user`, with `user` at the far right.
- **`auth.js`**: stop appending the auth button and profile input into `.nav`.
  Render into `.user` instead:
  - **Signed out** → a single `sign in` button that opens the existing sign-in
    modal (unchanged).
  - **Signed in** → a name-only chip: `kalavox ▾`, falling back to the email
    local-part when no name is set. Clicking opens the profile modal.
- The old `profile-edit` input is removed from the nav entirely; name editing
  moves into the modal.

### 2. Profile settings modal

A second modal in `auth.js`, styled to match the existing `.auth-modal` /
`.auth-card` (reuse those classes plus a `.profile-modal` modifier) so it inherits
the overlay, card, close-X, and open/close behavior.

Contents:
- **Heading:** `profile`
- **Artist name:** label + text input (maxlength 60), prefilled from
  `GET /api/profile`, with an explicit **save** button. On save →
  `PUT /api/profile`, show a brief "saved ✓" confirmation, and update the chip
  text live. Empty name is rejected (matches the server's 1–60 char rule).
- **Email:** shown read-only / dimmed (from `currentUser.email`).
- **Stats:** a dim line `12 tracks · 6 stems` (see §3).
- **Sign out:** a button at the bottom → `db.auth.signOut()` (closes modal; chip
  reverts to "sign in").

Open/close: same pattern as the auth modal — click-X, click-backdrop, and
`Escape` to close.

### 3. Stats computation

No server changes. The modal already calls `GET /api/profile`, which returns the
profile `id`. Reuse that id to run a one-off client Instant query against both
namespaces filtered by `author.id` (single-hop relation filter, definitely
supported — avoids a riskier two-hop `author.user.id` filter), and count
**version-families** (matching what the "mine" filter shows, not raw version
rows):

```js
db.queryOnce({
  tracks: { $: { where: { 'author.id': profileId } } },
  stems:  { $: { where: { 'author.id': profileId } } },
})
```

Then `groupVersions(...)` each list (mapping `id` ← `slug`, carrying `versionOf`)
and render `${nTracks} tracks · ${nStems} stems`. While the query is in flight,
show `…`. If it fails, hide the stats line rather than error.

Works identically on both the crate and stems pages since it queries both
namespaces directly.

### 4. Styling

- `.user` cluster: flex, right-aligned, matches masthead baseline.
- **Chip:** bordered button echoing the existing `.auth-btn` style (mono font,
  line border, acid hover), with a `▾` caret.
- **Modal:** reuses `.auth-card`; name row is `[input] [save]` flex; email +
  stats are dim small text; sign-out button is full-width subdued with a
  hot-color hover to signal it's the exit.
- **Mobile:** chip stays compact (name truncates with ellipsis past ~12 chars);
  modal already centers responsively.

### 5. Testing

Reuse the existing test setup. Extract the "group both lists → counts" logic into
a small pure function and unit-test it: given mixed rows with `versionOf` links,
it returns correct family counts. DOM wiring (modal open/close, chip text) is
verified manually in the running app.

## Out of scope (YAGNI)

- Avatars / avatar uploads.
- Account deletion, theme switching, password/email change.
- Server-side stat endpoints (counts are computed client-side).

## Affected files

- `index.html`, `stems.html` — add `<div class="user">` to the masthead.
- `src/auth.js` — render chip + sign-in button into `.user`; add profile modal;
  remove `mountProfile` nav input.
- `src/style.css` — `.user` cluster, `.user-chip`, `.profile-modal` styles;
  remove dead `.profile-edit` rules.
- `src/versions.js` (or a new small helper) — pure family-count helper + test.
