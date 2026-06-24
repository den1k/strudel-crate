import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeAdmin } from './fake-admin.mjs';
import { createApp } from '../server/app.mjs';
import { createJobStore } from '../server/jobs.mjs';

const requireAuth = (req, _res, next) => { req.user = { id: 'u1', email: 'kalavox@gmail.com' }; next(); };
const requireUser = (req, _res, next) => { req.user = { id: 'u1', email: 'kalavox@gmail.com' }; next(); };

let app, adminDb;
beforeEach(() => {
  adminDb = fakeAdmin({
    tracks: [
      { id: 't1', slug: 'demo-01', ratingSum: 0, ratingCount: 0, notes: '', lesson: '', author: [{ id: 'p1', user: [{ id: 'u1' }] }] },
      { id: 't2', slug: 'rated-01', ratingSum: 5, ratingCount: 1, notes: '', lesson: '', author: [{ id: 'p9', user: [{ id: 'u9' }] }] },
    ],
    stems: [{ id: 's1', slug: 'stem-01', ratingSum: 0, ratingCount: 0, notes: '', lesson: '', author: [{ id: 'p1', user: [{ id: 'u1' }] }] }],
    profiles: [{ id: 'p1', artistName: 'kalavox', user: { id: 'u1' } }],
    ratings: [],
    plays: [],
  });
  app = createApp({ adminDb, namespaces: ['tracks', 'stems'], requireAuth, requireUser, allowedEmails: ['kalavox@gmail.com'] });
});

describe('rating API', () => {
  it('PUT /api/tracks/:id/rating records the caller rating + aggregate', async () => {
    const res = await request(app).put('/api/tracks/demo-01/rating').send({ value: 4 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ you: 4, avg: 4, count: 1 });
  });
  it('clears with value null', async () => {
    const res = await request(app).put('/api/tracks/demo-01/rating').send({ value: null });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
  });
  it('404s an unknown id', async () => {
    const res = await request(app).put('/api/tracks/missing/rating').send({ value: 5 });
    expect(res.status).toBe(404);
  });
  it('rejects out-of-range', async () => {
    const res = await request(app).put('/api/tracks/demo-01/rating').send({ value: 9 });
    expect(res.status).toBe(400);
  });
  it('rejects path-char ids', async () => {
    const res = await request(app).put('/api/tracks/..%2Fevil/rating').send({ value: 3 });
    expect(res.status).toBe(400);
  });
});

describe('profile API', () => {
  it('GET /api/profile returns the caller profile', async () => {
    const res = await request(app).get('/api/profile');
    expect(res.status).toBe(200);
    expect(res.body.artistName).toBe('kalavox'); // email local part, auto-created
  });

  it('PUT /api/profile sets the artist name', async () => {
    const res = await request(app).put('/api/profile').send({ artistName: 'DJ Test' });
    expect(res.status).toBe(200);
    expect(res.body.artistName).toBe('DJ Test');
  });

  it('PUT /api/profile rejects empty artistName', async () => {
    const res = await request(app).put('/api/profile').send({ artistName: '' });
    expect(res.status).toBe(400);
  });

  it('PUT /api/profile rejects a missing artistName', async () => {
    const res = await request(app).put('/api/profile').send({});
    expect(res.status).toBe(400);
  });
});

describe('jobs API', () => {
  let jobApp, enqueued;
  beforeEach(async () => {
    const base = await mkdtemp(join(tmpdir(), 'strudel-jobsapi-'));
    enqueued = [];
    const jobStore = createJobStore({ jobsDir: join(base, 'jobs') });
    const runner = { enqueue: async (job) => { enqueued.push(job); } };
    jobApp = createApp({ adminDb, namespaces: ['tracks', 'stems'], requireAuth, jobStore, runner });
  });

  it('POST /api/jobs enqueues a generate-stems job', async () => {
    const res = await request(jobApp).post('/api/jobs').send({ type: 'generate-stems', prompt: 'alien pads', count: 4 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ type: 'generate-stems', prompt: 'alien pads', count: 4, collection: 'stems', status: 'queued' });
    expect(enqueued).toHaveLength(1);
  });

  it('clamps count to 1..30', async () => {
    const res = await request(jobApp).post('/api/jobs').send({ type: 'generate-tracks', prompt: 'techno', count: 999 });
    expect(res.body.count).toBe(30);
  });

  it('rejects an unknown type', async () => {
    const res = await request(jobApp).post('/api/jobs').send({ type: 'rm-rf', prompt: 'x' });
    expect(res.status).toBe(400);
  });

  it('rejects a missing prompt for generate', async () => {
    const res = await request(jobApp).post('/api/jobs').send({ type: 'generate-stems' });
    expect(res.status).toBe(400);
  });

  it('rejects a generate prompt containing a double quote', async () => {
    const res = await request(jobApp).post('/api/jobs').send({ type: 'generate-tracks', prompt: 'dark "techno"', count: 4 });
    expect(res.status).toBe(400);
    expect(enqueued).toHaveLength(0);
  });

  it('accepts revise-from-notes with a collection prompt', async () => {
    const res = await request(jobApp).post('/api/jobs').send({ type: 'revise-from-notes', prompt: 'stems' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ type: 'revise-from-notes', collection: 'stems' });
  });

  it('rejects revise-from-notes with a bad collection', async () => {
    const res = await request(jobApp).post('/api/jobs').send({ type: 'revise-from-notes', prompt: 'drums' });
    expect(res.status).toBe(400);
  });

  it('GET /api/jobs lists queued jobs and GET /:id fetches one', async () => {
    const created = (await request(jobApp).post('/api/jobs').send({ type: 'generate-stems', prompt: 'p', count: 1 })).body;
    const list = await request(jobApp).get('/api/jobs');
    expect(list.body).toHaveLength(1);
    const one = await request(jobApp).get(`/api/jobs/${created.id}`);
    expect(one.status).toBe(200);
    expect(one.body.id).toBe(created.id);
  });

  it('GET /api/jobs attaches produced for running jobs via progressFor', async () => {
    const base = await mkdtemp(join(tmpdir(), 'strudel-jobsprog-'));
    const jobStore = createJobStore({ jobsDir: join(base, 'jobs') });
    const runner = { enqueue: async () => {} };
    const progressFor = async (j) => (j.status === 'running' ? 7 : undefined);
    const app2 = createApp({ adminDb, namespaces: ['tracks', 'stems'], requireAuth, jobStore, runner, progressFor });
    await jobStore.write({
      id: 'run1', type: 'generate-stems', prompt: 'p', count: 4, collection: 'stems',
      status: 'running', createdAt: '2026-06-15T00:00:00Z', startedAt: '2026-06-15T00:00:01Z',
      finishedAt: null, summary: null, error: null, batch: null, newItems: [],
    });
    await jobStore.write({
      id: 'q1', type: 'generate-stems', prompt: 'p', count: 4, collection: 'stems',
      status: 'queued', createdAt: '2026-06-15T00:00:02Z', startedAt: null,
      finishedAt: null, summary: null, error: null, batch: null, newItems: [],
    });
    const list = await request(app2).get('/api/jobs');
    const running = list.body.find((j) => j.id === 'run1');
    const queued = list.body.find((j) => j.id === 'q1');
    expect(running.produced).toBe(7);
    expect(queued.produced).toBeUndefined();
  });

  it('GET /api/jobs/:id returns 404 for missing job', async () => {
    const res = await request(jobApp).get('/api/jobs/does-not-exist');
    expect(res.status).toBe(404);
  });
});

describe('remix jobs', () => {
  let jobApp, runner, store;
  beforeEach(async () => {
    store = createJobStore({ jobsDir: await mkdtemp(join(tmpdir(), 'jobs-')) });
    runner = { enqueue: async () => {} };
    jobApp = createApp({
      adminDb, namespaces: ['tracks', 'stems'], requireAuth, requireUser,
      allowedEmails: ['kalavox@gmail.com'], jobStore: store, runner,
    });
  });

  it('enqueues a remix job for an existing source', async () => {
    const res = await request(jobApp).post('/api/jobs')
      .send({ type: 'remix', namespace: 'tracks', slug: 'demo-01', instructions: 'make it darker' });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe('remix');
    expect(res.body.sourceSlug).toBe('demo-01');
    expect(res.body.collection).toBe('tracks');
    expect(res.body.prompt).toBe('make it darker');
  });
  it('400s an unknown source slug', async () => {
    const res = await request(jobApp).post('/api/jobs')
      .send({ type: 'remix', namespace: 'tracks', slug: 'nope', instructions: 'x' });
    expect(res.status).toBe(400);
  });
  it('400s a bad namespace', async () => {
    const res = await request(jobApp).post('/api/jobs')
      .send({ type: 'remix', namespace: 'songs', slug: 'demo-01', instructions: 'x' });
    expect(res.status).toBe(400);
  });
  it('400s instructions containing a double quote', async () => {
    const res = await request(jobApp).post('/api/jobs')
      .send({ type: 'remix', namespace: 'tracks', slug: 'demo-01', instructions: 'say "hi"' });
    expect(res.status).toBe(400);
  });
});

describe('notes API', () => {
  const asUser = (user, emails = ['kalavox@gmail.com']) =>
    createApp({ adminDb, namespaces: ['tracks', 'stems'],
      requireAuth, allowedEmails: emails,
      requireUser: (req, _res, next) => { req.user = user; next(); } });

  it('owner can write notes + lesson', async () => {
    const a = asUser({ id: 'u1', email: 'kalavox@gmail.com' });
    const res = await request(a).put('/api/tracks/demo-01/notes').send({ notes: 'tight', lesson: 'more swing' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ notes: 'tight', lesson: 'more swing' });
  });
  it('non-owner is forbidden', async () => {
    const a = asUser({ id: 'u9', email: 'stranger@example.com' });
    // u9 maps to a different profile; seed it so ensureProfile finds it
    adminDb._store.profiles.push({ id: 'p9', user: { id: 'u9' } });
    const res = await request(a).put('/api/tracks/demo-01/notes').send({ notes: 'mine now' });
    expect(res.status).toBe(403);
  });
  it('404s unknown id', async () => {
    const a = asUser({ id: 'u1', email: 'kalavox@gmail.com' });
    const res = await request(a).put('/api/tracks/missing/notes').send({ notes: 'x' });
    expect(res.status).toBe(404);
  });
  it('rejects non-string notes', async () => {
    const a = asUser({ id: 'u1', email: 'kalavox@gmail.com' });
    const res = await request(a).put('/api/tracks/demo-01/notes').send({ notes: 42 });
    expect(res.status).toBe(400);
  });
});

describe('play API', () => {
  it('POST /api/tracks/:id/play (anonymous) bumps the total only', async () => {
    const res = await request(app).post('/api/tracks/demo-01/play');
    expect(res.status).toBe(200);
    expect(res.body.playCount).toBe(1);
    expect(res.body.you).toBeUndefined();
  });

  it('404s for an unknown slug', async () => {
    const res = await request(app).post('/api/tracks/missing/play');
    expect(res.status).toBe(404);
  });

  it('rejects ids with path characters', async () => {
    const res = await request(app).post('/api/tracks/..%2Fevil/play');
    expect(res.status).toBe(400);
  });

  it('records a per-user play when signed in', async () => {
    const resolveUser = (req, _res, next) => { req.user = { id: 'u1', email: 'kalavox@gmail.com' }; next(); };
    const db2 = fakeAdmin({
      tracks: [{ id: 't1', slug: 'demo-01', playCount: 0 }],
      profiles: [{ id: 'p1', user: { id: 'u1' } }],
      plays: [],
    });
    const signedApp = createApp({ adminDb: db2, namespaces: ['tracks', 'stems'], requireAuth, resolveUser });
    const res = await request(signedApp).post('/api/tracks/demo-01/play');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ playCount: 1, you: 1 });
    expect(db2._txs.some((o) => o.ns === 'plays')).toBe(true);
  });

  it('returns 429 when the play limiter denies the request', async () => {
    const limited = createApp({ adminDb, namespaces: ['tracks', 'stems'], requireAuth, playLimiter: () => false });
    const res = await request(limited).post('/api/tracks/demo-01/play');
    expect(res.status).toBe(429);
  });
});

describe('audio export API', () => {
  it('GET /api/:ns/:id/audio.:fmt streams the file with a download filename', async () => {
    const d = await mkdtemp(join(tmpdir(), 'audio-api-'));
    await mkdir(join(d, 'tracks'), { recursive: true });
    const p = join(d, 'tracks', 't1.mp3');
    await writeFile(p, 'MP3BYTES');
    const audioExport = {
      getOrRender: async (ns, id, fmt) =>
        ns === 'tracks' && id === 'demo-01' && fmt === 'mp3' ? { path: p, filename: 'demo-01.mp3' } : null,
    };
    const app2 = createApp({ adminDb, namespaces: ['tracks', 'stems'], requireAuth, requireUser, audioExport });
    const res = await request(app2).get('/api/tracks/demo-01/audio.mp3');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('audio/mpeg');
    expect(res.headers['content-disposition']).toContain('filename="demo-01.mp3"');
    expect(res.body.toString()).toBe('MP3BYTES');
  });

  it('404s when the item cannot be rendered/resolved', async () => {
    const audioExport = { getOrRender: async () => null };
    const app2 = createApp({ adminDb, namespaces: ['tracks', 'stems'], requireAuth, requireUser, audioExport });
    const res = await request(app2).get('/api/tracks/missing/audio.wav');
    expect(res.status).toBe(404);
  });

  it('404s an unsupported format', async () => {
    const audioExport = { getOrRender: async () => null };
    const app2 = createApp({ adminDb, namespaces: ['tracks', 'stems'], requireAuth, requireUser, audioExport });
    const res = await request(app2).get('/api/tracks/demo-01/audio.flac');
    expect(res.status).toBe(404);
  });
});
