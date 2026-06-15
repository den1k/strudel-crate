import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import express from 'express';
import { collectionFor } from './runner.mjs';

const ID_RE = /^[A-Za-z0-9_-]+$/; // rating files are written as <id>.json — no path chars

// Express 4 doesn't catch async handler rejections — route them to the error handler.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// One set of list + rating routes per collection (tracks, stems) at /api/<name>.
function collectionRoutes(app, name, store) {
  app.get(`/api/${name}`, wrap(async (_req, res) => {
    res.json(await store.listTracks());
  }));

  app.put(`/api/${name}/:id/rating`, wrap(async (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'invalid id' });
    const { rating, notes, lesson } = req.body ?? {};
    if (rating != null && !(Number.isInteger(rating) && rating >= 1 && rating <= 5)) {
      return res.status(400).json({ error: 'rating must be an integer 1-5' });
    }
    if (notes != null && typeof notes !== 'string') {
      return res.status(400).json({ error: 'notes must be a string' });
    }
    if (lesson != null && typeof lesson !== 'string') {
      return res.status(400).json({ error: 'lesson must be a string' });
    }
    res.json(await store.saveRating(id, { rating, notes, lesson }));
  }));
}

function jobRoutes(app, jobStore, runner, progressFor) {
  app.post('/api/jobs', wrap(async (req, res) => {
    const { type, prompt, count } = req.body ?? {};
    if (!jobStore.TYPES.has(type)) return res.status(400).json({ error: 'invalid type' });

    const base = {
      id: randomUUID(),
      type,
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

export function createApp(stores, opts = {}) {
  const app = express();
  app.use(express.json());
  for (const [name, store] of Object.entries(stores)) collectionRoutes(app, name, store);

  if (opts.jobStore && opts.runner) jobRoutes(app, opts.jobStore, opts.runner, opts.progressFor);

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
