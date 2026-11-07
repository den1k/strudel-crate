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
let cacheSources = {}; // slug -> the source it was vendored from; absent for older banks

// Kick off the index fetch without blocking anything. Safe to call repeatedly.
export function warmSampleCacheIndex(fetchImpl = fetch) {
  if (cacheIndex !== null) return;
  cacheIndex = new Set(); // optimistic empty set so callers never block
  fetchImpl('/sample-cache/index.json')
    .then((r) => (r.ok ? r.json() : { slugs: [] }))
    .then((d) => { cacheIndex = new Set(d.slugs ?? []); cacheSources = d.sources ?? {}; })
    .catch(() => { cacheIndex = new Set(); });
}

// Given a samples() source, return the local cache manifest URL if that bank is
// known to be cached, else null (caller falls back to the original source).
export function cachedManifestUrl(source) {
  if (!cacheIndex || cacheIndex.size === 0) return null;
  const slug = bankSlug(source);
  // Slugs collide (`a-b/c`, `a/b-c`): a bank vendored from another source isn't this one.
  const holder = cacheSources[slug];
  if (holder && holder.toLowerCase() !== source.toLowerCase()) return null;
  return cacheIndex.has(slug) ? `/sample-cache/banks/${slug}/strudel.json` : null;
}

// Wrap the global samples() so a single-string source prefers the local cache.
// IMPORTANT: `target` must be a WRITABLE carrier of `samples` — i.e. globalThis
// AFTER core.evalScope copies webaudio's exports onto it. The `@strudel/webaudio`
// ES module namespace is frozen; assigning onto it throws and aborts boot.
// Multi-arg forms (explicit base, inline maps) pass straight through unchanged.
// Returns the original function, or null if the carrier has no samples() yet.
export function installCacheAwareSamples(target = globalThis) {
  const original = target && target.samples;
  if (typeof original !== 'function') return null;
  target.samples = function cacheAwareSamples(source, ...rest) {
    if (rest.length === 0 && typeof source === 'string') {
      const local = cachedManifestUrl(source);
      // A vendored manifest says `_base: "./"`, which Strudel resolves against this page rather
      // than the manifest, so the bank's own directory has to be given.
      if (local) return original.call(this, local, local.slice(0, local.lastIndexOf('/') + 1));
    }
    return original.call(this, source, ...rest);
  };
  return original;
}
