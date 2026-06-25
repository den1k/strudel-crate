// InstantDB magic-code auth for crate.
//
// Playback stays public; this module gates the *mutating* endpoints
// (generation + rating). It attaches the signed-in user's token to every
// /api/* request via a fetch wrapper, so the existing fetch call sites need no
// changes. The server verifies the token AND an email allowlist — client-side
// gating alone is bypassable, so the server is the real gate.
import { id } from '@instantdb/core';
import { db } from './db.js';
import { familyCount } from './versions.js';
import { normalizeEmail } from './email.js';

const ADMIN_EMAIL = 'kalavox@gmail.com';

let token = null; // signed-in user's refresh token, or null when signed out

// Patch fetch once: every /api/* call carries the bearer token when we have
// one. Reads (GET) work without it; mutations 401 without an allowlisted token.
const origFetch = window.fetch.bind(window);
window.fetch = (input, opts = {}) => {
  const url = typeof input === 'string' ? input : (input?.url ?? '');
  if (token && url.startsWith('/api')) {
    opts = { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` } };
  }
  return origFetch(input, opts);
};

let currentUser = null;
const userListeners = new Set();
// Subscribe to auth state. Fires immediately with the current user (may be null),
// then on every change. Returns an unsubscribe fn.
export function onUser(cb) { cb(currentUser); userListeners.add(cb); return () => userListeners.delete(cb); }
function setUser(u) { currentUser = u; for (const cb of userListeners) cb(u); }

// Chip/label text: prefer the artist name, fall back to the email local-part.
export function displayName(user, artistName) {
  const n = (artistName || '').trim();
  if (n) return n;
  if (user?.email) return user.email.split('@')[0];
  return 'artist';
}

export function setupAuth() {
  if (!db) return; // Instant not configured — leave the app open
  const cluster = mountUserCluster();
  const signInModal = mountModal(db);
  const profileModal = mountProfileModal(db);

  cluster.signInBtn.onclick = () => signInModal.open();
  cluster.chip.onclick = () =>
    profileModal.open(currentUser, (name) => cluster.setName(displayName(currentUser, name)));

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
      fetch('/api/profile')
        .then((res) => (res.ok ? res.json() : null))
        .then((p) => { if (p) cluster.setName(displayName(user, p.artistName)); })
        .catch(() => { /* keep the email-prefix fallback */ });
    } else {
      profileModal.close();
      cluster.setSignedOut();
    }
  });
}

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

function mountModal(db) {
  const el = document.createElement('div');
  el.className = 'auth-modal';
  el.hidden = true;
  el.innerHTML = `
    <div class="auth-card">
      <button class="auth-x" type="button" aria-label="close">×</button>
      <h2>sign in</h2>
      <p class="auth-sub">a magic code goes to your email. only allowlisted accounts can generate &amp; rate.</p>
      <form class="auth-email">
        <input type="email" name="email" placeholder="you@email.com" autocomplete="email" required />
        <button type="submit">send code</button>
      </form>
      <form class="auth-code" hidden>
        <input type="text" name="code" inputmode="numeric" placeholder="6-digit code" autocomplete="one-time-code" required />
        <button type="submit">verify</button>
      </form>
      <p class="auth-err" role="alert" hidden></p>
    </div>`;
  document.body.appendChild(el);

  const emailForm = el.querySelector('.auth-email');
  const codeForm = el.querySelector('.auth-code');
  const errEl = el.querySelector('.auth-err');
  let email = '';

  const showErr = (m) => { errEl.textContent = m || ''; errEl.hidden = !m; };
  const open = () => { el.hidden = false; emailForm.elements.email.focus(); };
  const close = () => {
    el.hidden = true;
    showErr('');
    codeForm.hidden = true; emailForm.hidden = false;
    emailForm.reset(); codeForm.reset();
  };

  el.querySelector('.auth-x').onclick = close;
  el.onclick = (e) => { if (e.target === el) close(); };

  emailForm.onsubmit = async (e) => {
    e.preventDefault();
    email = emailForm.elements.email.value.trim();
    showErr('');
    try {
      await db.auth.sendMagicCode({ email });
      emailForm.hidden = true; codeForm.hidden = false; codeForm.elements.code.focus();
    } catch (err) {
      showErr(err?.body?.message || 'could not send code — try again');
    }
  };

  codeForm.onsubmit = async (e) => {
    e.preventDefault();
    showErr('');
    try {
      // subscribeAuth fires on success and closes the modal.
      await db.auth.signInWithMagicCode({ email, code: codeForm.elements.code.value.trim() });
    } catch (err) {
      showErr(err?.body?.message || 'invalid code');
    }
  };

  return { open, close };
}

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
      <section class="profile-lessons">
        <h3>lessons <span class="lessons-hint">— applied to your future generations</span></h3>
        <ul class="lessons-list"></ul>
        <form class="lesson-add">
          <textarea name="text" rows="2" maxlength="500" placeholder="new lesson — applies to every future batch…"></textarea>
          <div class="lesson-add-row">
            <div class="lesson-target" role="group" aria-label="applies to">
              <button type="button" data-target="tracks" class="on">tracks</button>
              <button type="button" data-target="stems">stems</button>
            </div>
            <button type="submit" class="lesson-add-btn">add</button>
          </div>
        </form>
      </section>
      <section class="profile-access" hidden>
        <h3>access <span class="lessons-hint">— who can generate &amp; rate</span></h3>
        <ul class="access-list"></ul>
        <form class="access-add">
          <input type="email" name="email" placeholder="add email…" autocomplete="off" />
          <button type="submit" class="access-add-btn">add</button>
        </form>
      </section>
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

  const accessSection = el.querySelector('.profile-access');
  const accessList = el.querySelector('.access-list');
  const accessAdd = el.querySelector('.access-add');
  let accessUnsub = null;

  function renderAllowlist(rows, adminEmail) {
    accessList.replaceChildren();
    for (const row of rows) {
      const li = document.createElement('li');
      li.className = 'access-row';
      const span = document.createElement('span');
      span.textContent = row.email;
      li.appendChild(span);
      if (row.email !== adminEmail) {          // can't remove yourself
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'access-del';
        del.setAttribute('aria-label', `remove ${row.email}`);
        del.textContent = '×';
        del.onclick = () => db.transact(db.tx.allowlist[row.id].delete());
        li.appendChild(del);
      }
      accessList.appendChild(li);
    }
  }

  function startAccessAdmin(adminEmail) {
    accessSection.hidden = false;
    if (accessUnsub) return;
    accessUnsub = db.subscribeQuery(
      { allowlist: { $: { order: { addedAt: 'desc' } } } },
      (res) => { if (res.data) renderAllowlist(res.data.allowlist ?? [], adminEmail); },
    );
  }

  function stopAccessAdmin() {
    accessSection.hidden = true;
    if (accessUnsub) { accessUnsub(); accessUnsub = null; }
    accessList.replaceChildren();
  }

  accessAdd.onsubmit = (e) => {
    e.preventDefault();
    const email = normalizeEmail(accessAdd.elements.email.value);
    if (!email) { flash(accessAdd.elements.email); return; }
    db.transact(db.tx.allowlist[id()].create({
      email, addedAt: new Date().toISOString(), addedBy: ADMIN_EMAIL,
    }));
    accessAdd.elements.email.value = '';
  };

  const close = () => { el.hidden = true; savedEl.hidden = true; stopAccessAdmin(); };
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

  // --- lessons manager ----------------------------------------------------
  const lessonsList = el.querySelector('.lessons-list');
  const addForm = el.querySelector('.lesson-add');
  const addText = addForm.elements.text;
  let addTarget = 'tracks';

  // A two-button tracks/stems toggle. `onPick` fires with the chosen target.
  function wireTargetToggle(group, current, onPick) {
    for (const b of group.querySelectorAll('button')) {
      b.classList.toggle('on', b.dataset.target === current);
      b.onclick = () => {
        if (b.dataset.target === current) return;
        current = b.dataset.target;
        for (const x of group.querySelectorAll('button')) x.classList.toggle('on', x === b);
        onPick(current);
      };
    }
  }

  function lessonRow(lesson) {
    const li = document.createElement('li');
    li.className = 'lesson-row';
    li.dataset.id = lesson.id;
    li.innerHTML = `
      <textarea class="lesson-text" rows="2" maxlength="500"></textarea>
      <div class="lesson-row-meta">
        <div class="lesson-target" role="group" aria-label="applies to">
          <button type="button" data-target="tracks">tracks</button>
          <button type="button" data-target="stems">stems</button>
        </div>
        <span class="lesson-from"></span>
        <button type="button" class="lesson-del" aria-label="delete lesson">×</button>
      </div>`;
    const ta = li.querySelector('.lesson-text');
    ta.value = lesson.text;
    const from = li.querySelector('.lesson-from');
    if (lesson.song?.title) { from.textContent = `from "${lesson.song.title}"`; from.title = lesson.song.title; }

    // debounced text autosave
    let timer = null;
    ta.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const text = ta.value.trim();
        if (!text) return; // empty text isn't a valid update; use delete instead
        try {
          const res = await fetch(`/api/lessons/${lesson.id}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }),
          });
          if (!res.ok) flash(ta);
        } catch { flash(ta); }
      }, 600);
    });

    wireTargetToggle(li.querySelector('.lesson-target'), lesson.target, async (target) => {
      try {
        const res = await fetch(`/api/lessons/${lesson.id}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target }),
        });
        if (!res.ok) flash(ta);
      } catch { flash(ta); }
    });

    li.querySelector('.lesson-del').onclick = async () => {
      try {
        const res = await fetch(`/api/lessons/${lesson.id}`, { method: 'DELETE' });
        if (res.ok) li.remove(); else flash(ta);
      } catch { flash(ta); }
    };
    return li;
  }

  function flash(node) {
    node.classList.add('flash-error');
    setTimeout(() => node.classList.remove('flash-error'), 600);
  }

  async function loadLessons() {
    lessonsList.replaceChildren();
    try {
      const res = await fetch('/api/lessons');
      if (!res.ok) return;
      const lessons = await res.json();
      for (const l of lessons) lessonsList.appendChild(lessonRow(l));
    } catch { /* ignore */ }
  }

  wireTargetToggle(addForm.querySelector('.lesson-target'), addTarget, (t) => { addTarget = t; });
  addForm.onsubmit = async (e) => {
    e.preventDefault();
    const text = addText.value.trim();
    if (!text) return;
    try {
      const res = await fetch('/api/lessons', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, target: addTarget }),
      });
      if (res.ok) {
        const lesson = await res.json();
        lessonsList.insertBefore(lessonRow(lesson), lessonsList.firstChild);
        addText.value = '';
      } else flash(addText);
    } catch { flash(addText); }
  };

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
      if ((user?.email || '').toLowerCase() === ADMIN_EMAIL) startAccessAdmin(ADMIN_EMAIL);
      else stopAccessAdmin();
      el.hidden = false;
      const profileId = await loadProfile();
      input.focus();
      await Promise.all([loadStats(profileId), loadLessons()]);
    },
    close,
  };
}
