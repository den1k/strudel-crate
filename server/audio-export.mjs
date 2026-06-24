// Glue between the HTTP layer, the disk cache, and the headless renderer.
// Resolves an item (by entity id, then slug), keys the cache by entity id, and
// names the download by slug. Identical concurrent renders share one promise so
// a burst of clicks renders once.
const FORMATS = new Set(['wav', 'mp3', 'stems']);

export function createAudioExport({ adminDb, cache, renderer, namespaces = ['tracks', 'stems'] }) {
  const inflight = new Map(); // `${ns}:${id}:${fmt}` -> Promise<path>

  async function resolveRow(ns, idOrSlug) {
    const byId = await adminDb.query({ [ns]: { $: { where: { id: idOrSlug } } } });
    if (byId[ns]?.[0]) return byId[ns][0];
    const bySlug = await adminDb.query({ [ns]: { $: { where: { slug: idOrSlug } } } });
    return bySlug[ns]?.[0] ?? null;
  }

  async function getOrRender(ns, idOrSlug, fmt) {
    if (!namespaces.includes(ns) || !FORMATS.has(fmt)) return null;
    const row = await resolveRow(ns, idOrSlug);
    if (!row) return null;
    const filename = `${row.slug}.${cache.EXT[fmt]}`;

    const hit = await cache.cachedPath(ns, row.id, fmt);
    if (hit) return { path: hit, filename };

    const key = `${ns}:${row.id}:${fmt}`;
    let job = inflight.get(key);
    if (!job) {
      job = (async () => {
        const track = { id: row.slug, code: row.code, meta: row.meta };
        const buffer = await renderer.render(track, fmt);
        return cache.store(ns, row.id, fmt, buffer);
      })().finally(() => inflight.delete(key));
      inflight.set(key, job);
    }
    const path = await job;
    return { path, filename };
  }

  async function prewarm(ns, idOrSlug, fmt = 'mp3') {
    try { await getOrRender(ns, idOrSlug, fmt); } catch { /* background; ignore */ }
  }

  return { getOrRender, prewarm };
}
