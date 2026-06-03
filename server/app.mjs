import express from 'express';

const ID_RE = /^[A-Za-z0-9_-]+$/; // rating files are written as <id>.json — no path chars

// Express 4 doesn't catch async handler rejections — route them to the error handler.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function createApp(store) {
  const app = express();
  app.use(express.json());

  app.get('/api/tracks', wrap(async (_req, res) => {
    res.json(await store.listTracks());
  }));

  app.put('/api/tracks/:id/rating', wrap(async (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'invalid track id' });
    const { rating, notes } = req.body ?? {};
    if (rating != null && !(Number.isInteger(rating) && rating >= 1 && rating <= 5)) {
      return res.status(400).json({ error: 'rating must be an integer 1-5' });
    }
    if (notes != null && typeof notes !== 'string') {
      return res.status(400).json({ error: 'notes must be a string' });
    }
    res.json(await store.saveRating(id, { rating, notes }));
  }));

  // JSON error responses (body-parser 400s and async store failures land here).
  app.use((err, _req, res, _next) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });

  return app;
}
