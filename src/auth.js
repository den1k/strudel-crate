// InstantDB magic-code auth for crate.
//
// Playback stays public; this module gates the *mutating* endpoints
// (generation + rating). It attaches the signed-in user's token to every
// /api/* request via a fetch wrapper, so the existing fetch call sites need no
// changes. The server verifies the token AND an email allowlist — client-side
// gating alone is bypassable, so the server is the real gate.
import { db } from './db.js';
import { familyCount } from './versions.js';

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
