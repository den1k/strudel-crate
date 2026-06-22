# List scroll + filter restoration on Back

**Date:** 2026-06-22
**Branch:** `feat/list-scroll-restore`
**App:** crate (`crate.vimsical.com`)

## Problem

The crate listing pages (`index.html` → tracks, `stems.html` → stems) are
multi-page-app routes. Clicking a song title navigates to `/song/<slug>` via a
real `<a href>`, which is a full document load. Pressing **Back** returns the
browser to a freshly-booted `index.html`: the InstantDB subscription re-runs,
the list re-renders from scratch, and both the user's **filter state** and
**scroll position** are lost. The user lands at the top of an unfiltered list
instead of looking at the song they just clicked.

iOS Safari's back/forward cache (bfcache) *sometimes* restores the page intact,
but the live InstantDB websocket makes eviction likely, so we cannot rely on it.

## Goal

When the user clicks a song, visits `/song`, and presses Back, they return to:

1. The **same scroll position** (looking at the song they just clicked), and
2. The **same filters applied** (batch dropdown, all/unrated/top/mine segment,
   and which version each family was expanded to).

This must hold on both desktop and mobile (iOS Safari / Android Chrome), and
must not regress the mobile experience. It applies to both the tracks page and
the stems page, since both are driven by `initApp()` in `src/app.js`.

## Non-goals

- No change to `song.js`, the Express server, or the URL scheme.
- No restoration on a deliberate fresh reload or a brand-new tab — only on a
  genuine Back/Forward navigation.
- No bookmarkable/shareable filter URLs (decided against; sessionStorage keeps
  URLs clean and scroll position has no business in a URL).

## Approach

State is persisted to `sessionStorage` and restored only when the page load is
a back/forward navigation. Chosen over URL params because it is invisible,
robust across the MPA reload on iOS, and the natural home for a scroll offset.

### New module: `src/list-state.js`

A small, dependency-free, unit-testable module that owns the snapshot shape and
its serialization. Storage is injected so tests run without a real DOM.

```js
// snapshot shape
{ batch: string, filter: string, selectedByFamily: [[famId, verId], ...], scrollY: number }

export function saveListState(namespace, snapshot, storage = sessionStorage)
export function loadListState(namespace, storage = sessionStorage)  // -> snapshot | null
```

- Key is `crate:list:<namespace>` so `tracks` and `stems` never collide.
- `loadListState` tolerates missing keys and malformed JSON by returning `null`
  (wrapped in try/catch); a corrupt entry never throws into boot.
- `selectedByFamily` is serialized as `[...map.entries()]` and rehydrated by the
  caller into a `Map`.

### Wiring in `src/app.js`

1. **Take control of scroll.** At the top of `initApp`, set
   `history.scrollRestoration = 'manual'` (guarded for support) so the browser
   does not fight our restore on a list whose height is not known at load time.

2. **Decide whether to restore.** Compute once at boot:
   ```js
   const navType = performance.getEntriesByType('navigation')[0]?.type;
   const isBackForward = navType === 'back_forward';
   const restored = isBackForward ? loadListState(namespace) : null;
   ```
   On a fresh reload / new tab `restored` is `null` → current default behavior
   is completely unchanged.

3. **Seed filters before the first render.** If `restored` is present:
   - `state.batch = restored.batch` — *unless* the existing `?batch=` URL param
     is set, which still wins (preserves deep-link behavior).
   - `state.filter = restored.filter`.
   - Rehydrate `selectedByFamily` from `restored.selectedByFamily` so cards
     mount on the version the user had chosen.
   - Reflect this in the controls: set the batch `<select>` value (already
     handled by `renderBatchFilter()` reading `state.batch`) and move the `.on`
     class to the matching segment button.

4. **Restore scroll after the list has height.** `applyRows()` runs on every
   InstantDB push. A one-shot flag restores scroll only on the first render that
   produced content:
   ```js
   if (restored && pendingScrollRestore && families-rendered) {
     pendingScrollRestore = false;
     requestAnimationFrame(() => window.scrollTo(0, restored.scrollY));
   }
   ```
   Clearing the flag means subsequent live updates (a play count tick, a new
   batch arriving) never yank the user's scroll.

5. **Snapshot on leave.** A single `pagehide` listener (fires reliably on iOS
   Safari Back, including into bfcache) writes the current snapshot:
   ```js
   window.addEventListener('pagehide', () => {
     saveListState(namespace, {
       batch: state.batch,
       filter: state.filter,
       selectedByFamily: [...selectedByFamily.entries()],
       scrollY: window.scrollY,
     });
   });
   ```
   `pagehide` (not `beforeunload`, which iOS ignores, and not the title-link
   click, which would miss other navigations) is the iOS-correct primitive.

### Edge cases

- **`filter === 'mine'` while logged out:** restored as-is; `visibleFamilies()`
  already yields an empty list until `myProfileId` resolves, then fills in.
  Acceptable and matches the state the user left.
- **A saved family/version that no longer exists:** `trackCard()` already falls
  back to `family.latest` when the selected version id is absent. No new guard.
- **Saved `scrollY` past a now-shorter list:** `window.scrollTo` clamps to the
  document height; lands at the bottom, which is the closest valid position.
- **bfcache hit:** our code never runs; the page is restored perfectly. Our
  saved snapshot is simply unused. No conflict.

## Testing

- **Unit (`test/list-state.test.mjs`, vitest):** round-trip save→load; namespace
  key isolation; `null` on missing key; `null` on malformed JSON;
  `selectedByFamily` entries survive serialization. Uses an in-memory storage
  stub, mirroring the existing `song-url.test.mjs` pure-helper pattern.
- **Manual (required — touches scroll/focus/navigation):** on a ≤430px viewport
  and a real phone, set a batch + segment filter, scroll mid-list, open a song,
  press Back → verify filters and scroll are restored and the clicked card is in
  view. Then confirm a manual reload starts clean at the top.

## Deploy

The live service runs from the **main** worktree at `/home/builder/apps/crate`
(systemd `vimsical-crate`, port 3008). To ship: merge `feat/list-scroll-restore`
into `main` there, `npm run build`, then `sudo systemctl restart vimsical-crate`.
