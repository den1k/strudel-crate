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
export function createPlayLimiter({ cooldownMs = 3000, perIpPerMin = 60, maxKeys = 10000, now = () => Date.now() } = {}) {
  const lastByKey = new Map(); // `${ip}:${ns}:${slug}` -> last allowed timestamp
  const hitsByIp = new Map();  // ip -> [timestamps within the last 60s]

  // Drop entries that can no longer affect a decision: cooldowns that have
  // elapsed and ip windows with no recent hits. Keeps both maps bounded without
  // a background timer; only runs once the combined size crosses maxKeys.
  function sweep(t) {
    for (const [k, ts] of lastByKey) if (t - ts >= cooldownMs) lastByKey.delete(k);
    for (const [ipKey, arr] of hitsByIp) {
      const live = arr.filter((ts) => t - ts < 60000);
      if (live.length) hitsByIp.set(ipKey, live);
      else hitsByIp.delete(ipKey);
    }
  }

  return function allow(ip, namespace, slug) {
    const id = ip ?? 'anon';
    const t = now();
    if (lastByKey.size + hitsByIp.size > maxKeys) sweep(t);

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
