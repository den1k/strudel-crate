# Profile Chip + Settings Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bare artist-name input crammed into the section nav with a right-aligned user cluster: a name chip that opens a polished profile settings modal (name editing, email, generation stats, sign out).

**Architecture:** A new `.user` cluster div is added to the masthead (far right) on both pages. `auth.js` renders a `sign in` button (signed out) or a name chip (signed in) into it, and gains a second modal — the profile settings modal — styled by reusing the existing `.auth-modal`/`.auth-card` classes. Generation stats are computed client-side via a one-off Instant `queryOnce` filtered by the author's profile id, counting version-families through a new pure `familyCount` helper in `versions.js`.

**Tech Stack:** Vanilla JS (ES modules), Vite, `@instantdb/core`, Vitest, plain CSS with custom properties.

## Global Constraints

- Artist name: 1–60 characters, trimmed; empty is rejected (server enforces this in `server/app.mjs:37`). The client must mirror it.
- No server changes. Stats are computed client-side only.
- Single shared Instant client is `db` from `src/db.js` (may be `null` when Instant is unconfigured — all entry points already guard on it).
- Tests live in `test/*.test.mjs` and run with `npm test` (`vitest run`). Source under test is imported from `../src/...`.
- CSS custom properties available: `--bg`, `--panel`, `--ink`, `--dim`, `--line`, `--acid`, `--hot`, `--display`, `--mono`.
- Match existing code idiom: lowercase UI copy, mono font, no frameworks.

---

### Task 1: `familyCount` stats helper

A pure function that counts version-families from raw Instant rows. Instant rows carry `slug` (the human id) and an optional `versionOf` (which points at a root **slug**). `groupVersions` keys families off `versionOf ?? id`, so rows must be mapped to `{ id: slug, versionOf }` before grouping.

**Files:**
- Modify: `src/versions.js` (add `familyCount` export at end of file)
- Test: `test/versions.test.mjs` (add a `describe('familyCount')` block)

**Interfaces:**
- Consumes: `groupVersions` (already exported from `src/versions.js`).
- Produces: `familyCount(rows: Array<{ slug?, id?, versionOf? }>): number` — number of distinct version-families.

- [ ] **Step 1: Write the failing test**

Add to `test/versions.test.mjs`:

```js
describe('familyCount', () => {
  const row = (slug, extra = {}) => ({ slug, ...extra });

  it('counts standalone rows as one family each', () => {
    expect(familyCount([row('a'), row('b'), row('c')])).toBe(3);
  });

  it('counts a root and its versionOf children as a single family', () => {
    expect(familyCount([
      row('a'),
      row('a-v2', { versionOf: 'a' }),
      row('a-v3', { versionOf: 'a' }),
    ])).toBe(1);
  });

  it('mixes families and standalones correctly', () => {
    expect(familyCount([
      row('a'),
      row('a-v2', { versionOf: 'a' }),
      row('b'),
    ])).toBe(2);
  });

  it('returns 0 for an empty list', () => {
    expect(familyCount([])).toBe(0);
  });

  it('falls back to id when slug is absent', () => {
    expect(familyCount([{ id: 'x' }, { id: 'y' }])).toBe(2);
  });
});
```

Also update the import line at the top of the file:

```js
import { groupVersions, pendingRevisions, familyCount } from '../src/versions.js';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- versions`
Expected: FAIL — `familyCount is not a function` (or undefined) in the new block; existing tests still pass.

- [ ] **Step 3: Write minimal implementation**

Append to `src/versions.js`:

```js
// Count distinct version-families from raw Instant rows. Rows carry `slug`
// (the human id) and optional `versionOf` (pointing at the root slug), so map
// to the {id, versionOf} shape groupVersions expects before grouping.
export function familyCount(rows) {
  return groupVersions(
    rows.map((r) => ({ id: r.slug ?? r.id, versionOf: r.versionOf })),
  ).length;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- versions`
Expected: PASS — all `familyCount` and existing `groupVersions`/`pendingRevisions` tests green.

- [ ] **Step 5: Commit**

```bash
git add src/versions.js test/versions.test.mjs
git commit -m "feat: familyCount helper for profile stats"
```

---

### Task 2: Add `.user` cluster to the masthead

Add an empty host div the auth module will render into. Both pages share the same masthead markup.

**Files:**
- Modify: `index.html` (after the `.filters` div, before `</header>`)
- Modify: `stems.html` (same location)

**Interfaces:**
- Produces: a `<div class="user">` element present in the DOM of both pages, queryable via `document.querySelector('.user')`.

- [ ] **Step 1: Add the host div to `index.html`**

In `index.html`, the `.filters` div ends at line 31 (`</div>`) followed by `</header>` at line 32. Insert the user cluster between them so the masthead children read `brand · nav · filters · user`:

```html
    </div>
    <div class="user"></div>
  </header>
```

(The first `</div>` shown is the existing close of `.filters`; add only the `<div class="user"></div>` line.)

- [ ] **Step 2: Add the host div to `stems.html`**

In `stems.html`, the `.filters` div ends at line 31 (`</div>`) followed by `</header>` at line 32. Insert identically:

```html
    </div>
    <div class="user"></div>
  </header>
```

- [ ] **Step 3: Verify the markup**

Run: `grep -n 'class="user"' index.html stems.html`
Expected: one match in each file.

- [ ] **Step 4: Commit**

```bash
git add index.html stems.html
git commit -m "feat: add .user cluster host to masthead"
```

---

### Task 3: Render chip + sign-in into `.user`; remove nav profile input

Rewrite `src/auth.js` so the auth button and profile editor no longer append into `.nav`. Instead a `mountUserCluster()` renders a `sign in` button and a name chip into `.user`, toggling between them on auth state. The old `mountProfile()` (the nav input) is removed; name editing moves to the modal in Task 4. The sign-in modal (`mountModal`) is unchanged.

This task is DOM wiring with no unit test (verified by running the app). The profile modal is added in Task 4; in this task the chip's click handler is wired to a placeholder that Task 4 replaces.

**Files:**
- Modify: `src/auth.js`

**Interfaces:**
- Consumes: `db` (`src/db.js`), `displayName` (defined here).
- Produces:
  - `displayName(user, artistName): string` — chip/label text; `artistName` when non-empty, else email local-part, else `'artist'`.
  - `mountUserCluster(): { setSignedIn(text), setSignedOut(), setName(text), signInBtn, chip }` — renders into `.user`.
  - `setupAuth()` wires `signInBtn.onclick` → sign-in modal, `chip.onclick` → profile modal (added Task 4).

- [ ] **Step 1: Add the `displayName` helper and `mountUserCluster`**

In `src/auth.js`, after the `setUser` function (around line 28), add:

```js
// Chip/label text: prefer the artist name, fall back to the email local-part.
export function displayName(user, artistName) {
  const n = (artistName || '').trim();
  if (n) return n;
  if (user?.email) return user.email.split('@')[0];
  return 'artist';
}
```

Then replace the `mountButton` function (lines 61-69) with `mountUserCluster`:

```js
function mountUserCluster() {
  const host = document.querySelector('.user');
  const signInBtn = document.createElement('button');
  signInBtn.className = 'auth-btn';
  signInBtn.type = 'button';
  signInBtn.textContent = 'sign in';
  signInBtn.title = 'sign in to generate & rate';

  const chip = document.createElement('button');
  chip.className = 'user-chip';
  chip.type = 'button';
  chip.hidden = true;
  chip.innerHTML =
    '<span class="user-chip-name"></span><span class="user-chip-caret" aria-hidden="true">▾</span>';

  host?.append(signInBtn, chip);
  const nameEl = chip.querySelector('.user-chip-name');

  return {
    signInBtn,
    chip,
    setName: (text) => { nameEl.textContent = text; },
    setSignedIn: (text) => { signInBtn.hidden = true; chip.hidden = false; nameEl.textContent = text; },
    setSignedOut: () => { chip.hidden = true; signInBtn.hidden = false; },
  };
}
```

- [ ] **Step 2: Remove the old `mountProfile` nav input**

Delete the entire `mountProfile` function (lines 71-103 in the current file — from `function mountProfile() {` through its closing `}` that returns `{ show, hide }`). The modal in Task 4 replaces it.

- [ ] **Step 3: Rewrite `setupAuth` to use the cluster**

Replace the body of `setupAuth` (lines 30-59) with:

```js
export function setupAuth() {
  if (!db) return; // Instant not configured — leave the app open
  const cluster = mountUserCluster();
  const signInModal = mountModal(db);
  // profileModal is added in Task 4; until then chip clicks are a no-op.
  let openProfile = () => {};

  cluster.signInBtn.onclick = () => signInModal.open();
  cluster.chip.onclick = () => openProfile();

  // The generate panel triggers the auth-gated /api/jobs route, so it stays
  // hidden until a user is signed in.
  const gen = document.querySelector('.generate');
  if (gen) gen.hidden = true;

  db.subscribeAuth((auth) => {
    const user = auth?.user ?? null;
    token = user?.refresh_token ?? null;
    setUser(user);
    if (gen) gen.hidden = !user;
    if (user) {
      signInModal.close();
      cluster.setSignedIn(displayName(user, null));
    } else {
      cluster.setSignedOut();
    }
  });
}
```

Note: the chip initially shows the email local-part via `displayName(user, null)`; Task 4 loads the saved artist name and updates it.

- [ ] **Step 4: Verify it builds and existing tests pass**

Run: `npm run build`
Expected: build succeeds, no errors about `mountButton`/`mountProfile` references.

Run: `npm test -- auth`
Expected: existing `auth` tests still pass (this module's tests exercise the fetch patch / token logic, not the DOM).

- [ ] **Step 5: Manual check**

Run `npm run dev`, open the app. Signed out: a `sign in` button sits at the far right of the masthead and opens the sign-in modal. Signed in: a chip showing your email prefix appears at the far right (clicking does nothing yet). The old artist-name input is gone from the nav.

- [ ] **Step 6: Commit**

```bash
git add src/auth.js
git commit -m "feat: render sign-in button + name chip in .user cluster"
```

---

### Task 4: Profile settings modal

Add `mountProfileModal(db)` to `src/auth.js` and wire it into `setupAuth`. The modal reuses `.auth-modal`/`.auth-card` styling, edits the artist name (`GET`/`PUT /api/profile`), shows the email and generation stats, and signs out. On save it updates the chip text live.

**Files:**
- Modify: `src/auth.js`

**Interfaces:**
- Consumes: `db.queryOnce` (`@instantdb/core`), `familyCount` (Task 1), `displayName` (Task 3), `/api/profile` GET (returns `{ id, artistName }`) and PUT (body `{ artistName }`).
- Produces: `mountProfileModal(db): { open(user, onNameChange), close() }`.

- [ ] **Step 1: Import `familyCount`**

At the top of `src/auth.js`, update the imports:

```js
import { db } from './db.js';
import { familyCount } from './versions.js';
```

- [ ] **Step 2: Add `mountProfileModal`**

Add this function near `mountModal` in `src/auth.js`:

```js
function mountProfileModal(db) {
  const el = document.createElement('div');
  el.className = 'auth-modal profile-modal';
  el.hidden = true;
  el.innerHTML = `
    <div class="auth-card">
      <button class="auth-x" type="button" aria-label="close">×</button>
      <h2>profile</h2>
      <form class="profile-name">
        <input type="text" name="artist" placeholder="artist name" maxlength="60" autocomplete="off" />
        <button type="submit">save</button>
      </form>
      <p class="profile-saved" role="status" hidden>saved ✓</p>
      <p class="profile-email"></p>
      <p class="profile-stats">…</p>
      <button class="profile-signout" type="button">sign out</button>
    </div>`;
  document.body.appendChild(el);

  const form = el.querySelector('.profile-name');
  const input = form.elements.artist;
  const savedEl = el.querySelector('.profile-saved');
  const emailEl = el.querySelector('.profile-email');
  const statsEl = el.querySelector('.profile-stats');
  const signOutBtn = el.querySelector('.profile-signout');
  let onNameChange = () => {};

  const close = () => { el.hidden = true; savedEl.hidden = true; };
  el.querySelector('.auth-x').onclick = close;
  el.onclick = (e) => { if (e.target === el) close(); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el.hidden) close(); });

  signOutBtn.onclick = () => { db.auth.signOut(); close(); };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const artistName = input.value.trim();
    if (!artistName) return;
    try {
      const res = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artistName }),
      });
      if (res.ok) {
        savedEl.hidden = false;
        setTimeout(() => { savedEl.hidden = true; }, 1200);
        onNameChange(artistName);
      }
    } catch { /* ignore */ }
  };

  async function loadProfile() {
    let profileId = null;
    try {
      const res = await fetch('/api/profile');
      if (res.ok) {
        const p = await res.json();
        input.value = p.artistName ?? '';
        profileId = p.id ?? null;
      }
    } catch { /* ignore */ }
    return profileId;
  }

  async function loadStats(profileId) {
    statsEl.hidden = false;
    statsEl.textContent = '…';
    if (!profileId) { statsEl.hidden = true; return; }
    try {
      const { data } = await db.queryOnce({
        tracks: { $: { where: { 'author.id': profileId } } },
        stems: { $: { where: { 'author.id': profileId } } },
      });
      const nTracks = familyCount(data?.tracks ?? []);
      const nStems = familyCount(data?.stems ?? []);
      statsEl.textContent =
        `${nTracks} ${nTracks === 1 ? 'track' : 'tracks'} · ${nStems} ${nStems === 1 ? 'stem' : 'stems'}`;
    } catch {
      statsEl.hidden = true;
    }
  }

  return {
    open: async (user, cb) => {
      onNameChange = cb || (() => {});
      emailEl.textContent = user?.email ?? '';
      statsEl.textContent = '…';
      el.hidden = false;
      const profileId = await loadProfile();
      input.focus();
      await loadStats(profileId);
    },
    close,
  };
}
```

- [ ] **Step 3: Wire the modal into `setupAuth`**

In `setupAuth`, replace the placeholder profile wiring. Change:

```js
  // profileModal is added in Task 4; until then chip clicks are a no-op.
  let openProfile = () => {};

  cluster.signInBtn.onclick = () => signInModal.open();
  cluster.chip.onclick = () => openProfile();
```

to:

```js
  const profileModal = mountProfileModal(db);

  cluster.signInBtn.onclick = () => signInModal.open();
  cluster.chip.onclick = () =>
    profileModal.open(currentUser, (name) => cluster.setName(displayName(currentUser, name)));
```

And in the `subscribeAuth` callback, close the profile modal on sign-out. Change the `else` branch:

```js
    } else {
      cluster.setSignedOut();
    }
```

to:

```js
    } else {
      profileModal.close();
      cluster.setSignedOut();
    }
```

- [ ] **Step 4: Verify build + tests**

Run: `npm run build`
Expected: build succeeds.

Run: `npm test`
Expected: full suite green.

- [ ] **Step 5: Manual check**

Run `npm run dev`, sign in. The chip loads your saved artist name. Click it → modal opens with name prefilled, email shown, stats resolving from `…` to `N tracks · M stems`. Edit the name + save → `saved ✓` flashes and the chip updates live. Escape / X / backdrop close the modal. Sign out from the modal → modal closes and the chip reverts to `sign in`.

- [ ] **Step 6: Commit**

```bash
git add src/auth.js
git commit -m "feat: profile settings modal (name, email, stats, sign out)"
```

---

### Task 5: Styling for cluster, chip, and profile modal

Style the new elements and remove the dead `.profile-edit` rules. The profile modal inherits `.auth-modal`/`.auth-card` (including `.auth-card form`, `.auth-card input`, `.auth-card form button`), so only the new pieces need rules.

**Files:**
- Modify: `src/style.css`

**Interfaces:**
- Consumes: existing CSS custom properties and `.auth-card`/`.auth-modal` rules.
- Produces: visual styling only; no JS contract.

- [ ] **Step 1: Remove dead `.profile-edit` rules**

In `src/style.css`, delete these two lines (393-394):

```css
.profile-edit input { font: inherit; padding: 0.25rem 0.5rem; border-radius: 6px; }
.profile-edit input.saved { outline: 2px solid #4caf50; }
```

- [ ] **Step 2: Add the cluster + chip styles**

After the `.auth-btn:hover` rule (line 350), add:

```css
/* right-aligned user cluster: sign-in button or name chip */
.user { display: flex; align-items: center; }
.user-chip {
  display: inline-flex; align-items: center; gap: 6px;
  max-width: 180px;
  background: transparent; color: var(--ink);
  border: 1px solid var(--line); font-family: var(--mono); font-size: 12px;
  padding: 6px 12px; cursor: pointer;
}
.user-chip:hover { color: var(--acid); border-color: var(--acid); }
.user-chip[hidden] { display: none; }
.user-chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.user-chip-caret { color: var(--dim); font-size: 10px; }
```

- [ ] **Step 3: Add the profile-modal styles**

After the `.auth-err` rule (where the deleted `.profile-edit` lines were), add:

```css
/* profile modal — reuses .auth-modal/.auth-card; these style the extra rows */
.profile-saved { color: var(--acid); font-size: 12px; margin-top: 10px; }
.profile-saved[hidden] { display: none; }
.profile-email { color: var(--dim); font-size: 12px; margin-top: 16px; word-break: break-all; }
.profile-stats { color: var(--dim); font-size: 12px; margin-top: 4px; }
.profile-stats[hidden] { display: none; }
.profile-signout {
  margin-top: 20px; width: 100%;
  background: transparent; color: var(--dim);
  border: 1px solid var(--line); font-family: var(--mono); font-size: 12px;
  padding: 9px; cursor: pointer;
}
.profile-signout:hover { color: var(--hot); border-color: var(--hot); }
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Manual check**

Run `npm run dev`. The chip and sign-in button sit cleanly at the far right of the masthead. The profile modal matches the sign-in modal's look (acid-bordered card on a blurred overlay); name row is `[input] [save]`, email + stats are dim, the sign-out button spans full width and turns hot-colored on hover. Long names ellipsis in the chip. Check at a narrow (mobile) width that the masthead still wraps cleanly.

- [ ] **Step 6: Commit**

```bash
git add src/style.css
git commit -m "style: user cluster chip + profile modal"
```

---

## Self-Review Notes

- **Spec coverage:** §1 layout → Tasks 2,3,5; §2 modal → Task 4; §3 stats (`author.id`, family counts) → Tasks 1,4; §4 styling → Task 5; §5 testing (pure count helper) → Task 1. All covered.
- **Type consistency:** `familyCount(rows)`, `displayName(user, artistName)`, `mountUserCluster()` returning `{ setSignedIn, setSignedOut, setName, signInBtn, chip }`, and `mountProfileModal(db).open(user, onNameChange)` are used consistently across Tasks 3–5.
- **No server changes:** confirmed — stats use client `db.queryOnce`; `/api/profile` GET/PUT already exist.
