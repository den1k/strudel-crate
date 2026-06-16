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

export function setupAuth() {
  if (!db) return; // Instant not configured — leave the app open
  const btn = mountButton();
  const modal = mountModal(db);

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
      btn.textContent = 'sign out';
      btn.title = user.email;
      btn.onclick = () => db.auth.signOut();
      modal.close();
    } else {
      btn.textContent = 'sign in';
      btn.title = 'sign in to generate & rate';
      btn.onclick = () => modal.open();
    }
  });
}

function mountButton() {
  const nav = document.querySelector('.nav');
  const btn = document.createElement('button');
  btn.className = 'auth-btn';
  btn.type = 'button';
  btn.textContent = 'sign in';
  nav?.appendChild(btn);
  return btn;
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
