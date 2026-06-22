import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import express from 'express';
import { collectionFor } from './runner.mjs';
import { saveRating, getProfile, setArtistName, recordPlay } from './instant.mjs';

const ID_RE = /^[A-Za-z0-9_-]+$/; // rating files are written as <id>.json — no path chars

// Express 4 doesn't catch async handler rejections — route them to the error handler.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// One rating route per collection at /api/<name>/:id/rating (id = slug).
// Listing is retired — the client reads Instant directly.
function collectionRoutes(app, name, adminDb, requireAuth, resolveUser) {
  app.put(`/api/${name}/:id/rating`, requireAuth, wrap(async (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'invalid id' });
    const { rating, notes, lesson } = req.body ?? {};
    if (rating != null && !(Number.isInteger(rating) && rating >= 1 && rating <= 5)) {
      return res.status(400).json({ error: 'rating must be an integer 1-5' });
    }
    if (notes != null && typeof notes !== 'string') return res.status(400).json({ error: 'notes must be a string' });
    if (lesson != null && typeof lesson !== 'string') return res.status(400).json({ error: 'lesson must be a string' });
    const saved = await saveRating(adminDb, name, id, { rating, notes, lesson });
    if (!saved) return res.status(404).json({ error: 'not found' });
    res.json(saved);
  }));

  // Public, token-aware: anyone's play bumps the total; a signed-in allowlisted
  // user also gets a per-user record. id = slug.
  app.post(`/api/${name}/:id/play`, resolveUser, wrap(async (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'invalid id' });
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
function jobRoutes(app, jobStore, runner, progressFor, requireAuth) {
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
    if (type === 'revise-from-notes') {
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
  const adminDb = opts.adminDb;
  const namespaces = opts.namespaces ?? ['tracks', 'stems'];

  if (adminDb) {
    for (const name of namespaces) collectionRoutes(app, name, adminDb, requireAuth, resolveUser);
    profileRoutes(app, adminDb, requireAuth);
  }

  if (opts.jobStore && opts.runner) jobRoutes(app, opts.jobStore, opts.runner, opts.progressFor, requireAuth);

  // Production: serve the built SPA (dev uses Vite). Defined AFTER the API so
  // /api/* always wins; the /stems clean URL mirrors vite.config.js's rewrite.
  if (opts.distDir) {
    app.get(['/stems', '/stems/'], (_req, res) => res.sendFile(join(opts.distDir, 'stems.html')));
    app.use(express.static(opts.distDir));
  }

  // JSON error responses (body-parser 400s and async store failures land here).
  app.use((err, _req, res, _next) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });

  return app;
}
