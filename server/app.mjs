import { randomUUID } from 'node:crypto';
import { basename, join, sep } from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import express from 'express';
import { collectionFor } from './runner.mjs';
import { jobQuotaError } from './jobs.mjs';
import { setRating, setNotes, itemOwnerProfileId, familyOwnerProfileId, ensureProfile, getProfile, setArtistName, recordPlay, resolvePublicItem, queryLessonsByProfile, createLesson, updateLesson, deleteLesson } from './instant.mjs';
import { ALLOWED_SAMPLE_HOSTS, BANK_SOURCE_FILE, isBankComplete } from '../scripts/lib/sample-cache.mjs';
import { createPlayLimiter } from './rate-limit.mjs';
import { songMetaTags, brandMetaTags, injectMeta, cardHash } from './og.mjs';
import { songCardHtml, brandCardHtml } from './og-card.mjs';

const ID_RE = /^[A-Za-z0-9_-]+$/; // rating files are written as <id>.json — no path chars

// Real client ip behind nginx, falling back to the socket. nginx OVERWRITES
// X-Real-IP with $remote_addr but only APPENDS to X-Forwarded-For, so the leftmost
// XFF value is whatever the client sent: never key anything on it. Port 3008 is
// tailnet-only, so a direct caller setting X-Real-IP is inside the trust boundary.
const clientIp = (req) =>
  req.headers['x-real-ip']?.trim() || req.socket?.remoteAddress || 'anon';

// The stored job record is internal runner state; these reads are anonymous. Only
// the fields the public log + retry flow use go out: requester identity and raw
// agent output stay in the job file for operators.
const publicJob = ({ userId, userEmail, summary, error, costUSD, ...job }) => ({
  ...job,
  error: error ? 'generation failed' : null,
});

const memoized = (ttlMs, fn) => {
  let at = 0;
  let value = null;
  return () => {
    if (!value || Date.now() - at >= ttlMs) {
      at = Date.now();
      value = fn().catch((err) => { value = null; throw err; });
    }
    return value;
  };
};

// Absolute origin for crawler URLs: the configured public origin, else derived
// from the (proxy-aware) request. Behind nginx, app.set('trust proxy', true)
// makes req.protocol reflect X-Forwarded-Proto.
const originFor = (req, configured) => configured || `${req.protocol}://${req.get('host')}`;

// Express 4 doesn't catch async handler rejections — route them to the error handler.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// One rating route per collection at /api/<name>/:id/rating (id = slug).
// Listing is retired — the client reads Instant directly.
function collectionRoutes(app, name, adminDb, requireUser, resolveUser, playLimiter, isAllowed) {
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
    // A note asks for a change to the song, so it belongs to whoever owns the family
    // (revise-from-notes acts on the family root's owner). A lesson is private to the
    // row's own author, so it stays bound to the row.
    const owner = await familyOwnerProfileId(adminDb, name, id);
    const callerProfile = await ensureProfile(adminDb, req.user);
    const email = req.user?.email?.toLowerCase();
    const isOwner = owner != null && owner === callerProfile;
    const isAdminOnUnowned = owner == null && email && (await isAllowed(email));
    if (!isOwner && !isAdminOnUnowned) return res.status(403).json({ error: 'not your song' });
    if (lesson !== undefined) {
      const rowOwner = await itemOwnerProfileId(adminDb, name, id);
      if (rowOwner != null && rowOwner !== callerProfile) return res.status(403).json({ error: 'not your song' });
    }

    const out = await setNotes(adminDb, name, id, { notes, lesson }, callerProfile);
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

  // --- Lessons manager: caller's own profile only -------------------------
  const TARGETS = ['tracks', 'stems'];
  const cleanText = (v) => (typeof v === 'string' ? v.trim() : null);

  app.get('/api/lessons', requireAuth, wrap(async (req, res) => {
    const profileId = await ensureProfile(adminDb, req.user);
    res.json(await queryLessonsByProfile(adminDb, profileId));
  }));

  app.post('/api/lessons', requireAuth, wrap(async (req, res) => {
    const { text, target } = req.body ?? {};
    const t = cleanText(text);
    if (!t) return res.status(400).json({ error: 'text required' });
    if (!TARGETS.includes(target)) return res.status(400).json({ error: 'target must be tracks or stems' });
    const profileId = await ensureProfile(adminDb, req.user);
    res.json(await createLesson(adminDb, profileId, { text: t, target }));
  }));

  app.put('/api/lessons/:id', requireAuth, wrap(async (req, res) => {
    const { text, target } = req.body ?? {};
    const patch = {};
    if (text !== undefined) {
      const t = cleanText(text);
      if (!t) return res.status(400).json({ error: 'text must be a non-empty string' });
      patch.text = t;
    }
    if (target !== undefined) {
      if (!TARGETS.includes(target)) return res.status(400).json({ error: 'target must be tracks or stems' });
      patch.target = target;
    }
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'nothing to update' });
    const profileId = await ensureProfile(adminDb, req.user);
    const out = await updateLesson(adminDb, profileId, req.params.id, patch);
    if (out === null) return res.status(404).json({ error: 'not found' });
    if (out === 'forbidden') return res.status(403).json({ error: 'not your lesson' });
    res.json(out);
  }));

  app.delete('/api/lessons/:id', requireAuth, wrap(async (req, res) => {
    const profileId = await ensureProfile(adminDb, req.user);
    const out = await deleteLesson(adminDb, profileId, req.params.id);
    if (out === null) return res.status(404).json({ error: 'not found' });
    if (out === 'forbidden') return res.status(403).json({ error: 'not your lesson' });
    res.json({ ok: true });
  }));
}

// Social-preview card JPEGs. /og/home.jpg is the static brand card; the per-song
// route resolves the item, renders the code-as-art card on a cache miss, and
// serves the cached JPEG. Reads stay public (they mirror the public song pages).
function cardRoutes(app, { adminDb, namespaces, cardRenderer, cardCache }) {
  // Concurrent misses on one card share a single render.
  const inflight = new Map();
  const renderAndStore = (name, html) => {
    let p = inflight.get(name);
    if (!p) {
      p = (async () => cardCache.store(name, await cardRenderer.render(html())))()
        .finally(() => inflight.delete(name));
      inflight.set(name, p);
    }
    return p;
  };

  app.get('/og/home.jpg', wrap(async (_req, res) => {
    let p = await cardCache.cachedPath('brand');
    if (!p) p = await renderAndStore('brand', () => brandCardHtml());
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
    if (!p) p = await renderAndStore(name, () => songCardHtml(found.item));
    res.type('jpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(p);
  }));
}

// `requireAuth` gates job creation (it triggers Claude Code); reads stay public.
function jobRoutes(app, jobStore, runner, progressFor, requireAuth, adminDb, jobsCacheMs = 0) {
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

    const over = await jobStore.admit(job, (jobs) => jobQuotaError(jobs, job, Date.now()));
    if (over) return res.status(429).json({ error: over });

    await runner.enqueue(job);
    res.status(201).json(job);
  }));

  // Anonymous and polled: file reads plus an Instant query per request without this.
  const jobList = memoized(jobsCacheMs, async () => {
    const jobs = await jobStore.list();
    if (!progressFor) return jobs.map(publicJob);
    const enriched = await Promise.all(jobs.map(async (job) => {
      const produced = await progressFor(job);
      return produced === undefined ? job : { ...job, produced };
    }));
    return enriched.map(publicJob);
  });
  app.get('/api/jobs', wrap(async (_req, res) => res.json(await jobList())));

  app.get('/api/jobs/:id', wrap(async (req, res) => {
    if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'invalid id' });
    const job = await jobStore.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'not found' });
    res.json(publicJob(job));
  }));
}

const SAMPLE_ORIGINS = [...ALLOWED_SAMPLE_HOSTS].map((h) => `https://${h}`).join(' ');
const SANDBOXED_PAGES = ['strudel-engine.html', 'export-render.html'];
const SANDBOX_CSP = [
  'sandbox allow-scripts',
  "default-src 'none'",
  "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob: data:", // evaluating code is the job
  "worker-src 'self' blob: data:",
  // Vendored banks and the sample hosts saves are held to. Stored code has nothing secret here,
  // but it shouldn't get to report its listeners to a host of its choosing.
  `connect-src 'self' ${SAMPLE_ORIGINS} data: blob:`,
  `media-src 'self' ${SAMPLE_ORIGINS} data: blob:`,
  "style-src 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join('; ');
// Pages never evaluate track code, so a regression fails here instead of running it on
// this origin. wasm-unsafe-eval stays for bundled wasm deps.
// A sandboxed worker writes these trees and this process doesn't run in its sandbox, so what
// it serves must be a regular file physically inside. send follows symlinks and opens FIFOs.
function onlyFilesInside(dir) {
  return async (req, res, next) => {
    let rel;
    try {
      rel = decodeURIComponent(req.path);
    } catch {
      return next(); // send answers a malformed path itself
    }
    try {
      const root = await realpath(dir);
      const real = await realpath(join(root, rel));
      const inside = real === root || real.startsWith(root + sep);
      const kind = inside ? await stat(real) : null;
      if (inside && (kind.isFile() || kind.isDirectory())) return next();
      return res.status(404).end();
    } catch {
      return next(); // doesn't exist: the ordinary 404
    }
  };
}

// frame-src: a sandboxed frame may still navigate itself, and connect-src doesn't cover that.
const PAGE_CSP = "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'self'; frame-src 'self'";

export function createApp(opts = {}) {
  const app = express();
  app.use(express.json());

  // Optional auth gate for mutations. Default no-op keeps tests + local dev open;
  // production passes a middleware that verifies an Instant token + allowlist.
  const requireAuth = opts.requireAuth ?? ((_req, _res, next) => next());
  const resolveUser = opts.resolveUser ?? ((_req, _res, next) => next());
  const requireUser = opts.requireUser ?? ((_req, _res, next) => next());
  const isAllowed = opts.isAllowed ?? (async () => false);
  const playLimiter = opts.playLimiter ?? createPlayLimiter();
  const adminDb = opts.adminDb;
  const namespaces = opts.namespaces ?? ['tracks', 'stems'];

  if (adminDb) {
    for (const name of namespaces) collectionRoutes(app, name, adminDb, requireUser, resolveUser, playLimiter, isAllowed);
    profileRoutes(app, adminDb, requireAuth);
  }

  if (opts.jobStore && opts.runner) jobRoutes(app, opts.jobStore, opts.runner, opts.progressFor, requireAuth, adminDb, opts.anonCacheMs);

  if (opts.cardRenderer && opts.cardCache && adminDb) {
    cardRoutes(app, { adminDb, namespaces, cardRenderer: opts.cardRenderer, cardCache: opts.cardCache });
  }

  // Vendored sample cache (cache-on-save). Served read-only so the webapp can
  // prefer locally-cached banks over upstream github repos. /sample-cache/index.json
  // lists cached bank slugs; /sample-cache/banks/<slug>/... serves the vendored files.
  if (opts.sampleCacheDir) {
    const cachedBanks = memoized(opts.anonCacheMs ?? 0, async () => {
      const { readdir } = await import('node:fs/promises');
      const banksDir = join(opts.sampleCacheDir, 'banks');
      let dirs = [];
      try { dirs = await readdir(banksDir); } catch { /* none cached yet */ }
      // Only advertise banks whose manifest and listed files are all there. Advertising anything
      // less makes the client rewrite samples() to a local URL that 404s instead of falling back
      // to the working upstream github bank.
      const checks = await Promise.all(dirs.map(async (slug) => (await isBankComplete(join(banksDir, slug)) ? slug : null)));
      const slugs = checks.filter(Boolean);
      const sources = {};
      await Promise.all(slugs.map(async (slug) => {
        try { sources[slug] = await readFile(join(banksDir, slug, BANK_SOURCE_FILE), 'utf8'); } catch { /* vendored before sources were recorded */ }
      }));
      return { slugs, sources };
    });
    app.get('/sample-cache/index.json', wrap(async (_req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*'); // read by the opaque-origin engine
      res.json(await cachedBanks());
    }));
    // Vendored files come from third-party repos: inert data on this origin, never a
    // document. fetch()ing audio/JSON is unaffected by the response's own CSP.
    app.use('/sample-cache', onlyFilesInside(opts.sampleCacheDir), express.static(opts.sampleCacheDir, {
      setHeaders: (res) => {
        res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
        res.setHeader('Access-Control-Allow-Origin', '*'); // read by the opaque-origin engine
      },
    }));
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
      res.setHeader('Content-Security-Policy', PAGE_CSP);
      res.type('html').send(injectMeta(html, tagsHtml));
    };

    // The only documents that evaluate track code. The header (not just the iframe
    // attribute) makes them opaque-origin however they're reached.
    for (const page of SANDBOXED_PAGES) {
      app.get(`/${page}`, (_req, res) => {
        res.setHeader('Content-Security-Policy', SANDBOX_CSP);
        res.sendFile(join(opts.distDir, page));
      });
    }
    // Module scripts and worklets load in CORS mode from those frames. Public build
    // output, no credentials.
    app.use('/assets', express.static(join(opts.distDir, 'assets'), {
      setHeaders: (res) => res.setHeader('Access-Control-Allow-Origin', '*'),
    }));

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

    // Same headers when a percent-encoded path misses the routes above but send decodes it.
    app.use(express.static(opts.distDir, {
      setHeaders: (res, file) => {
        if (SANDBOXED_PAGES.includes(basename(file))) res.setHeader('Content-Security-Policy', SANDBOX_CSP);
        else if (file.endsWith('.html')) res.setHeader('Content-Security-Policy', PAGE_CSP);
      },
    }));
  }

  // JSON error responses (body-parser 400s and async store failures land here).
  app.use((err, _req, res, _next) => {
    const status = err.status ?? 500;
    if (status >= 500 && !err.expose) console.error('[crate] request failed:', err);
    res.status(status).json({ error: status >= 500 && !err.expose ? 'internal error' : err.message });
  });

  return app;
}
