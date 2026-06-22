// InstantDB magic-code auth for crate.
//
// Playback stays public; this module gates the *mutating* endpoints
// (generation + rating). It attaches the signed-in user's token to every
// /api/* request via a fetch wrapper, so the existing fetch call sites need no
// changes. The server verifies the token AND an email allowlist — client-side
// gating alone is bypassable, so the server is the real gate.
import { db } from './db.js';

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
