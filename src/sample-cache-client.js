// Client-side cache preference for self-declared sample banks.
//
// Tracks may call `samples('github:user/repo')` in their own code; on save the
// server vendors those banks under /sample-cache/banks/<slug>/. This module
// wraps webaudio's `samples()` so a bank that has been vendored loads from the
// local cache instead of github — surviving a vanished upstream and avoiding a
// round-trip to raw.githubusercontent.com.
//
// Boot must not regress: the cache index is fetched LAZILY and never awaited on
// the boot path. Until it resolves, samples() transparently uses the upstream
// URL (exactly today's behaviour). Audio decode stays lazy in Strudel either way.

// Mirror scripts/lib/sample-cache.mjs bankSlug() so client + server agree.
export function bankSlug(source) {
  return source.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

let cacheIndex = null; // Set<slug> once loaded, or null until the lazy fetch resolves

// Kick off the index fetch without blocking anything. Safe to call repeatedly.
export function warmSampleCacheIndex(fetchImpl = fetch) {
  if (cacheIndex !== null) return;
  cacheIndex = new Set(); // optimistic empty set so callers never block
  fetchImpl('/sample-cache/index.json')
    .then((r) => (r.ok ? r.json() : { slugs: [] }))
    .then((d) => { cacheIndex = new Set(d.slugs ?? []); })
    .catch(() => { cacheIndex = new Set(); });
}

// Given a samples() source, return the local cache manifest URL if that bank is
// known to be cached, else null (caller falls back to the original source).
export function cachedManifestUrl(source) {
  if (!cacheIndex || cacheIndex.size === 0) return null;
  const slug = bankSlug(source);
  return cacheIndex.has(slug) ? `/sample-cache/banks/${slug}/strudel.json` : null;
}

// Wrap webaudio's samples() so a single-string source prefers the local cache.
// Multi-arg forms (explicit base, inline maps) pass straight through unchanged.
export function installCacheAwareSamples(webaudio) {
  const original = webaudio.samples;
  webaudio.samples = function cacheAwareSamples(source, ...rest) {
    if (rest.length === 0 && typeof source === 'string') {
      const local = cachedManifestUrl(source);
      if (local) return original.call(this, local);
    }
    return original.call(this, source, ...rest);
  };
  return original;
}
