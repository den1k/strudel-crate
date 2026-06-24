import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import express from 'express';
import { collectionFor } from './runner.mjs';
import { setRating, setNotes, itemOwnerProfileId, ensureProfile, getProfile, setArtistName, recordPlay } from './instant.mjs';
import { createPlayLimiter } from './rate-limit.mjs';

const ID_RE = /^[A-Za-z0-9_-]+$/; // rating files are written as <id>.json — no path chars

// Real client ip behind nginx (X-Forwarded-For), falling back to the socket.
// Trustworthy only because nginx is the guaranteed ingress in production and
// rewrites the header; a directly-exposed instance could spoof it.
const clientIp = (req) =>
  req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'anon';

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
  // /api/* always wins; the /stems clean URL mirrors vite.config.js's rewrite.
  if (opts.distDir) {
    app.get(['/stems', '/stems/'], (_req, res) => res.sendFile(join(opts.distDir, 'stems.html')));
    app.get('/song/:slug', (_req, res) => res.sendFile(join(opts.distDir, 'song.html')));
    app.use(express.static(opts.distDir));
  }

  // JSON error responses (body-parser 400s and async store failures land here).
  app.use((err, _req, res, _next) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });

  return app;
}
