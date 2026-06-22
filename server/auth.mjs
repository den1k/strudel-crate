// The actual security gate for mutating routes: verify an Instant session token
// and enforce the email allowlist. Kept as a pure factory (no module-level env or
// side effects) so it can be unit-tested without booting the server.
export function buildRequireAuth({ adminDb, allowedEmails }) {
  if (!adminDb) {
    console.warn('[crate] Instant auth not configured — mutating routes are OPEN');
    return undefined;
  }
  return async (req, res, next) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'sign in required' });
    try {
      const user = await adminDb.auth.verifyToken(token);
      const email = user?.email?.toLowerCase();
      if (!email || !allowedEmails.includes(email)) return res.status(403).json({ error: 'account not allowed' });
      req.user = user;
      next();
    } catch {
      return res.status(401).json({ error: 'invalid or expired session' });
    }
  };
}

// Lightweight gate for routes open to ANY logged-in user (e.g. rating): verify
// the Instant session token and attach req.user. No allowlist. Pass-through-less
// like buildRequireAuth: returns undefined (routes open) when adminDb is missing.
export function buildRequireUser({ adminDb }) {
  if (!adminDb) {
    console.warn('[crate] Instant auth not configured — user-gated routes are OPEN');
    return undefined;
  }
  return async (req, res, next) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'sign in required' });
    try {
      req.user = await adminDb.auth.verifyToken(token);
      next();
    } catch {
      return res.status(401).json({ error: 'invalid or expired session' });
    }
  };
}

// Soft auth for public-but-personalized routes (e.g. play counts): if a valid,
// allowlisted Bearer token is present, attach req.user; otherwise proceed
// anonymously. NEVER rejects. Pass-through when adminDb is missing.
export function buildResolveUser({ adminDb, allowedEmails }) {
  if (!adminDb) return (_req, _res, next) => next();
  return async (req, _res, next) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (token) {
      try {
        const user = await adminDb.auth.verifyToken(token);
        const email = user?.email?.toLowerCase();
        if (email && allowedEmails.includes(email)) req.user = user;
      } catch { /* ignore — proceed anonymously */ }
    }
    next();
  };
}
