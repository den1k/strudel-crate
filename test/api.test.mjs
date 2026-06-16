import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeAdmin } from './fake-admin.mjs';
import { createApp } from '../server/app.mjs';
import { createJobStore } from '../server/jobs.mjs';

const requireAuth = (req, _res, next) => { req.user = { id: 'u1', email: 'kalavox@gmail.com' }; next(); };

let app, adminDb;
beforeEach(() => {
  adminDb = fakeAdmin({
    tracks: [{ id: 't1', slug: 'demo-01', rating: null, notes: '', lesson: '' }],
    stems: [{ id: 's1', slug: 'stem-01', rating: null, notes: '', lesson: '' }],
    profiles: [],
  });
  app = createApp({ adminDb, namespaces: ['tracks', 'stems'], requireAuth });
});

describe('rating API', () => {
  it('PUT /api/tracks/:id/rating persists a rating', async () => {
    const res = await request(app).put('/api/tracks/demo-01/rating').send({ rating: 5, notes: 'banger' });
    expect(res.status).toBe(200);
    expect(res.body.rating).toBe(5);
    expect(res.body.notes).toBe('banger');
  });

  it('PUT /api/tracks/:id/rating 404s for an unknown id', async () => {
    const res = await request(app).put('/api/tracks/missing/rating').send({ rating: 5 });
    expect(res.status).toBe(404);
  });

  it('PUT /api/tracks/:id/rating rejects an out-of-range rating', async () => {
    const res = await request(app).put('/api/tracks/demo-01/rating').send({ rating: 9 });
    expect(res.status).toBe(400);
  });

  it('rejects ids with path characters', async () => {
    const res = await request(app).put('/api/tracks/..%2Fevil/rating').send({ rating: 3 });
    expect(res.status).toBe(400);
  });

  it('rejects a non-string lesson', async () => {
    const res = await request(app).put('/api/tracks/demo-01/rating').send({ lesson: 42 });
    expect(res.status).toBe(400);
  });

  it('saves and echoes lesson', async () => {
    const res = await request(app).put('/api/tracks/demo-01/rating').send({ rating: 3, notes: 'n', lesson: 'less reverb' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rating: 3, notes: 'n', lesson: 'less reverb' });
  });

  it('PUT /api/stems/:id/rating persists a stem rating', async () => {
    const res = await request(app).put('/api/stems/stem-01/rating').send({ rating: 4 });
    expect(res.status).toBe(200);
    expect(res.body.rating).toBe(4);
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
      finishedAt: null, summary: null, error: null, batch: null, newItems: [], baselineCount: 2,
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
