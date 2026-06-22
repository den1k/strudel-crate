// server/rate-limit.mjs
// In-memory throttle for the public play-counter route. Two guards:
//   1. per-song cooldown — the same ip can't re-count the same (namespace,slug)
//      within `cooldownMs` (kills tight replay loops on one song);
//   2. per-ip rate cap — at most `perIpPerMin` counted plays per ip in a rolling
//      60s window (kills scripted loops across many songs).
// State is process-local (resets on restart) and self-prunes the per-ip window;
// fine for a small app where counts are cosmetic. `now` is injectable for tests.
// cooldownMs defaults below the client's 4s play threshold: legit UI replays of
// one song are inherently ≥4s apart (you must hear 4s to ping), so they always
// pass, while scripted bursts on a single song are dropped.
export function createPlayLimiter({ cooldownMs = 3000, perIpPerMin = 60, now = () => Date.now() } = {}) {
  const lastByKey = new Map(); // `${ip}:${ns}:${slug}` -> last allowed timestamp
  const hitsByIp = new Map();  // ip -> [timestamps within the last 60s]

  return function allow(ip, namespace, slug) {
    const id = ip ?? 'anon';
    const t = now();

    const key = `${id}:${namespace}:${slug}`;
    const last = lastByKey.get(key);
    if (last != null && t - last < cooldownMs) return false;

    const recent = (hitsByIp.get(id) ?? []).filter((ts) => t - ts < 60000);
    if (recent.length >= perIpPerMin) {
      hitsByIp.set(id, recent); // keep the pruned window even when denying
      return false;
    }

    recent.push(t);
    hitsByIp.set(id, recent);
    lastByKey.set(key, t);
    return true;
  };
}
