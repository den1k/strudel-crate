import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import express from 'express';
import { collectionFor } from './runner.mjs';
import { setRating, setNotes, itemOwnerProfileId, ensureProfile, getProfile, setArtistName, recordPlay, resolvePublicItem } from './instant.mjs';
import { createPlayLimiter } from './rate-limit.mjs';
import { songMetaTags, brandMetaTags, injectMeta, cardHash } from './og.mjs';
import { songCardHtml, brandCardHtml } from './og-card.mjs';

const ID_RE = /^[A-Za-z0-9_-]+$/; // rating files are written as <id>.json — no path chars

// Real client ip behind nginx (X-Forwarded-For), falling back to the socket.
// Trustworthy only because nginx is the guaranteed ingress in production and
// rewrites the header; a directly-exposed instance could spoof it.
const clientIp = (req) =>
  req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'anon';

// Absolute origin for crawler URLs: the configured public origin, else derived
// from the (proxy-aware) request. Behind nginx, app.set('trust proxy', true)
// makes req.protocol reflect X-Forwarded-Proto.
const originFor = (req, configured) => configured || `${req.protocol}://${req.get('host')}`;

// Express 4 doesn't catch async handler rejections — route them to the error handler.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// One rating route per collection at /api/<name>/:id/rating (id = slug).
// Listing is retired — the client reads Instant directly.
function collectionRoutes(app, name, adminDb, requireUser, resolveUser, playLimiter, allowedEmails) {
  app.put(`/api/${name}/:id/rating`, requireUser, wrap(async (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'invalid id' });
    const { value } = req.body ?? {};
    if (value != null && !(Number.isInteger(value) && value >= 1 && value <= 5)) {
      return res.status(400).json({ error: 'value must be an integer 1-5 or null' });
    }
    const profileId = await ensureProfile(adminDb, req.user);
    const out = await setRating(adminDb, name, id, profileId, value ?? null);
    if (!out) return res.status(404).json({ error: 'not found' });
    res.json(out);
  }));

  app.put(`/api/${name}/:id/notes`, requireUser, wrap(async (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'invalid id' });
    const { notes, lesson } = req.body ?? {};
    if (notes != null && typeof notes !== 'string') return res.status(400).json({ error: 'notes must be a string' });
    if (lesson != null && typeof lesson !== 'string') return res.status(400).json({ error: 'lesson must be a string' });

    const exists = (await adminDb.query({ [name]: { $: { where: { slug: id } } } }))[name][0];
    if (!exists) return res.status(404).json({ error: 'not found' });
    const owner = await itemOwnerProfileId(adminDb, name, id);
    const callerProfile = await ensureProfile(adminDb, req.user);
    const email = req.user?.email?.toLowerCase();
    const isOwner = owner != null && owner === callerProfile;
    const isAdminOnUnowned = owner == null && email && allowedEmails.includes(email);
    if (!isOwner && !isAdminOnUnowned) return res.status(403).json({ error: 'not your song' });

    const out = await setNotes(adminDb, name, id, { notes, lesson });
    if (!out) return res.status(404).json({ error: 'not found' });
    res.json(out);
  }));

  // Public, token-aware: anyone's play bumps the total; a signed-in allowlisted
  // user also gets a per-user record. id = slug.
  app.post(`/api/${name}/:id/play`, resolveUser, wrap(async (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'invalid id' });
    if (!playLimiter(clientIp(req), name, id)) return res.status(429).json({ error: 'too many plays' });
    const result = await recordPlay(adminDb, name, id, req.user);
    if (!result) return res.status(404).json({ error: 'not found' });
    res.json(result);
  }));
}

function profileRoutes(app, adminDb, requireAuth) {
  app.get('/api/profile', requireAuth, wrap(async (req, res) => {
    res.json(await getProfile(adminDb, req.user));
  }));
  app.put('/api/profile', requireAuth, wrap(async (req, res) => {
    const { artistName } = req.body ?? {};
    const name = typeof artistName === 'string' ? artistName.trim() : '';
    if (!name || name.length > 60) {
      return res.status(400).json({ error: 'artistName required (1-60 chars)' });
    }
    res.json(await setArtistName(adminDb, req.user, name));
  }));
}

// Social-preview card JPEGs. /og/home.jpg is the static brand card; the per-song
// route resolves the item, renders the code-as-art card on a cache miss, and
// serves the cached JPEG. Reads stay public (they mirror the public song pages).
function cardRoutes(app, { adminDb, namespaces, cardRenderer, cardCache }) {
  app.get('/og/home.jpg', wrap(async (_req, res) => {
    let p = await cardCache.cachedPath('brand');
    if (!p) p = await cardCache.store('brand', await cardRenderer.render(brandCardHtml()));
    res.type('jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(p);
  }));

  app.get('/api/:ns/:id/card.jpg', wrap(async (req, res) => {
    const { ns, id } = req.params;
    if (!namespaces.includes(ns)) return res.status(404).json({ error: 'not found' });
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'invalid id' });
    const found = await resolvePublicItem(adminDb, [ns], id);
    if (!found) return res.status(404).json({ error: 'not found' });
    const name = `${found.item.entityId}-${cardHash(found.item)}`;
    let p = await cardCache.cachedPath(name);
    if (!p) p = await cardCache.store(name, await cardRenderer.render(songCardHtml(found.item)));
    res.type('jpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(p);
  }));
}

// `requireAuth` gates job creation (it triggers Claude Code); reads stay public.
function jobRoutes(app, jobStore, runner, progressFor, requireAuth, adminDb) {
  app.post('/api/jobs', requireAuth, wrap(async (req, res) => {
    const { type, prompt, count } = req.body ?? {};
    if (!jobStore.TYPES.has(type)) return res.status(400).json({ error: 'invalid type' });

    const base = {
      id: randomUUID(),
      type,
      userId: req.user?.id ?? null,
      userEmail: req.user?.email ?? null,
      createdAt: new Date().toISOString(),
      status: 'queued',
      startedAt: null, finishedAt: null, summary: null, error: null,
      batch: null, newItems: [],
    };

    let job;
    if (type === 'remix') {
      const { namespace, slug, instructions } = req.body ?? {};
      if (namespace !== 'tracks' && namespace !== 'stems') {
        return res.status(400).json({ error: 'namespace must be tracks or stems' });
      }
      if (!ID_RE.test(String(slug ?? ''))) return res.status(400).json({ error: 'invalid slug' });
      if (typeof instructions !== 'string' || !instructions.trim() || instructions.length > 500) {
        return res.status(400).json({ error: 'instructions required (1-500 chars)' });
      }
      if (instructions.includes('"')) return res.status(400).json({ error: 'instructions may not contain double quotes' });
      const exists = adminDb && (await adminDb.query({ [namespace]: { $: { where: { slug } } } }))[namespace][0];
      if (!exists) return res.status(400).json({ error: 'source not found' });
      job = { ...base, type: 'remix', prompt: instructions.trim(), count: null, collection: namespace, sourceSlug: slug };
    } else if (type === 'revise-from-notes') {
      if (prompt !== 'stems' && prompt !== 'tracks') {
        return res.status(400).json({ error: 'collection must be stems or tracks' });
      }
      job = { ...base, prompt, count: null, collection: prompt };
    } else {
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 500) {
        return res.status(400).json({ error: 'prompt required (1-500 chars)' });
      }
      // The prompt is wrapped in double quotes when handed to `claude -p`; a quote
      // in the text would break the slash-command argument boundary. Reject it here.
      if (prompt.includes('"')) return res.status(400).json({ error: 'prompt may not contain double quotes' });
      const n = Math.min(30, Math.max(1, Math.floor(Number(count) || 30)));
      job = { ...base, prompt: prompt.trim(), count: n, collection: collectionFor(type) };
    }

    await jobStore.write(job);
    await runner.enqueue(job);
    res.status(201).json(job);
  }));

  app.get('/api/jobs', wrap(async (_req, res) => {
    const jobs = await jobStore.list();
    if (!progressFor) return res.json(jobs);
    const enriched = await Promise.all(jobs.map(async (job) => {
      const produced = await progressFor(job);
      return produced === undefined ? job : { ...job, produced };
    }));
    res.json(enriched);
  }));

  app.get('/api/jobs/:id', wrap(async (req, res) => {
    if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'invalid id' });
    const job = await jobStore.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'not found' });
    res.json(job);
  }));
}

export function createApp(opts = {}) {
  const app = express();
  app.use(express.json());

  // Optional auth gate for mutations. Default no-op keeps tests + local dev open;
  // production passes a middleware that verifies an Instant token + allowlist.
  const requireAuth = opts.requireAuth ?? ((_req, _res, next) => next());
  const resolveUser = opts.resolveUser ?? ((_req, _res, next) => next());
  const requireUser = opts.requireUser ?? ((_req, _res, next) => next());
  const allowedEmails = opts.allowedEmails ?? [];
  const playLimiter = opts.playLimiter ?? createPlayLimiter();
  const adminDb = opts.adminDb;
  const namespaces = opts.namespaces ?? ['tracks', 'stems'];

  if (adminDb) {
    for (const name of namespaces) collectionRoutes(app, name, adminDb, requireUser, resolveUser, playLimiter, allowedEmails);
    profileRoutes(app, adminDb, requireAuth);
  }

  if (opts.jobStore && opts.runner) jobRoutes(app, opts.jobStore, opts.runner, opts.progressFor, requireAuth, adminDb);

  if (opts.cardRenderer && opts.cardCache && adminDb) {
    cardRoutes(app, { adminDb, namespaces, cardRenderer: opts.cardRenderer, cardCache: opts.cardCache });
  }

  // Vendored sample cache (cache-on-save). Served read-only so the webapp can
  // prefer locally-cached banks over upstream github repos. /sample-cache/index.json
  // lists cached bank slugs; /sample-cache/banks/<slug>/... serves the vendored files.
  if (opts.sampleCacheDir) {
    app.get('/sample-cache/index.json', wrap(async (_req, res) => {
      const { readdir, access } = await import('node:fs/promises');
      const banksDir = join(opts.sampleCacheDir, 'banks');
      let dirs = [];
      try { dirs = await readdir(banksDir); } catch { /* none cached yet */ }
      // Only advertise banks that actually have a strudel.json manifest. A vendor
      // that failed partway leaves sample files but no manifest; advertising such
      // an orphan makes the client rewrite samples() to a local URL that 404s
      // instead of falling back to the working upstream github bank.
      const checks = await Promise.all(dirs.map(async (slug) => {
        try { await access(join(banksDir, slug, 'strudel.json')); return slug; } catch { return null; }
      }));
      res.json({ slugs: checks.filter(Boolean) });
    }));
    app.use('/sample-cache', express.static(opts.sampleCacheDir));
  }

  // Production: serve the built SPA (dev uses Vite). Defined AFTER the API so
  // /api/* always wins. `/`, `/stems`, and /song/:slug get server-injected Open
  // Graph + Twitter meta so links unfurl as rich preview cards (crawlers don't
  // run JS). The list pages unfurl their ?play=<entityId> item when present.
  if (opts.distDir) {
    app.set('trust proxy', true);
    const configuredOrigin = opts.publicOrigin;
    const sendInjected = async (res, file, tagsHtml) => {
      const html = await readFile(join(opts.distDir, file), 'utf8');
      res.type('html').send(injectMeta(html, tagsHtml));
    };

    // Tags for an item referenced by URL — the /song/:slug path param, or a list
    // page's ?play=<entityId>. Falls back to the brand card when the ref is
    // absent, fails validation, doesn't resolve, or admin isn't configured.
    const tagsForRef = async (origin, ref) => {
      if (adminDb && ref && ID_RE.test(String(ref))) {
        const found = await resolvePublicItem(adminDb, namespaces, String(ref));
        if (found) return songMetaTags(found.item, found.ns, origin);
      }
      return brandMetaTags(origin);
    };

    // List pages (`/` crate, `/stems`) unfurl the ?play=<id> item, else the brand.
    const listPage = (file) => wrap(async (req, res) => {
      const origin = originFor(req, configuredOrigin);
      await sendInjected(res, file, await tagsForRef(origin, req.query.play));
    });
    app.get('/', listPage('index.html'));
    app.get(['/stems', '/stems/'], listPage('stems.html'));

    app.get('/song/:slug', wrap(async (req, res) => {
      const origin = originFor(req, configuredOrigin);
      await sendInjected(res, 'song.html', await tagsForRef(origin, req.params.slug));
    }));

    app.use(express.static(opts.distDir));
  }

  // JSON error responses (body-parser 400s and async store failures land here).
  app.use((err, _req, res, _next) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });

  return app;
}
