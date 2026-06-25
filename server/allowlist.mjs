// server/allowlist.mjs
// The server's source of truth for "is this email allowed to generate/rate".
// Backed by the Instant `allowlist` entity, cached in memory with a short TTL so
// the hot auth path adds ~no latency. The admin email is ALWAYS allowed (bootstrap
// — can never be locked out), and a failed refresh serves the last good set rather
// than locking everyone out. Pure factory: no module-level env or side effects.
export function createAllowlist({ adminDb, adminEmail, ttlMs = 60000, now = Date.now }) {
  const admin = (adminEmail || '').toLowerCase();
  let set = new Set();      // lowercased allowed emails (excludes admin; admin is implicit)
  let loadedAt = -Infinity; // timestamp of the last successful load
  let inflight = null;      // dedupes concurrent refreshes

  async function load() {
    const { allowlist } = await adminDb.query({ allowlist: {} });
    set = new Set((allowlist ?? []).map((r) => (r.email || '').toLowerCase()).filter(Boolean));
    loadedAt = now();
  }

  async function ensureFresh() {
    if (!adminDb) return;
    if (now() - loadedAt < ttlMs) return;
    if (!inflight) {
      inflight = load()
        .catch(() => { /* keep last good set; retry next call past TTL */ loadedAt = now(); })
        .finally(() => { inflight = null; });
    }
    await inflight;
  }

  async function isAllowed(email) {
    const e = (email || '').toLowerCase();
    if (!e) return false;
    if (e === admin) return true;
    await ensureFresh();
    return set.has(e);
  }

  async function refresh() { loadedAt = -Infinity; await ensureFresh(); }

  return { isAllowed, refresh };
}
