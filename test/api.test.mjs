import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';
import { createJobStore } from '../server/jobs.mjs';

let app, tracksDir, stemsDir;
beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'strudel-api-'));
  tracksDir = join(base, 'tracks');
  stemsDir = join(base, 'stems');
  await mkdir(tracksDir, { recursive: true });
  await mkdir(stemsDir, { recursive: true });
  app = createApp({
    tracks: createStore({ tracksDir, ratingsDir: join(base, 'ratings') }),
    stems: createStore({ tracksDir: stemsDir, ratingsDir: join(base, 'stem-ratings') }),
  });
});

describe('API', () => {
  it('GET /api/tracks returns tracks merged with ratings', async () => {
    await writeFile(join(tracksDir, 'a.json'), JSON.stringify({
      id: 'a', title: 'T', prompt: 'p', batch: 'b', code: 's("bd")', createdAt: 'x',
    }));
    const res = await request(app).get('/api/tracks');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: 'a', rating: null });
  });

  it('PUT /api/tracks/:id/rating saves and returns the record', async () => {
    const res = await request(app)
      .put('/api/tracks/a/rating')
      .send({ rating: 5, notes: 'banger' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'a', rating: 5, notes: 'banger' });
  });

  it('rejects out-of-range ratings', async () => {
    const res = await request(app).put('/api/tracks/a/rating').send({ rating: 9 });
    expect(res.status).toBe(400);
  });

  it('rejects ids with path characters', async () => {
    const res = await request(app).put('/api/tracks/..%2Fevil/rating').send({ rating: 3 });
    expect(res.status).toBe(400);
  });

  it('PUT saves and echoes lesson', async () => {
    const res = await request(app)
      .put('/api/tracks/a/rating')
      .send({ rating: 3, notes: 'n', lesson: 'less reverb on pads' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'a', rating: 3, notes: 'n', lesson: 'less reverb on pads' });
  });

  it('rejects non-string lesson', async () => {
    const res = await request(app).put('/api/tracks/a/rating').send({ lesson: 42 });
    expect(res.status).toBe(400);
  });
});

describe('stems API', () => {
  const item = (id) => JSON.stringify({
    id, title: 'S', prompt: 'p', batch: 'b', code: 's("bd")', createdAt: 'x',
  });

  it('GET /api/stems lists stems without bleeding into tracks', async () => {
    await writeFile(join(stemsDir, 's.json'), item('s'));
    const stems = await request(app).get('/api/stems');
    expect(stems.status).toBe(200);
    expect(stems.body).toHaveLength(1);
    expect(stems.body[0]).toMatchObject({ id: 's', rating: null });
    const tracks = await request(app).get('/api/tracks');
    expect(tracks.body).toHaveLength(0);
  });

  it('keeps stem ratings separate from track ratings for the same id', async () => {
    await writeFile(join(tracksDir, 'x.json'), item('x'));
    await writeFile(join(stemsDir, 'x.json'), item('x'));
    await request(app).put('/api/tracks/x/rating').send({ rating: 2 });
    await request(app).put('/api/stems/x/rating').send({ rating: 5, notes: 'gnarly' });
    const tracks = await request(app).get('/api/tracks');
    const stems = await request(app).get('/api/stems');
    expect(tracks.body[0].rating).toBe(2);
    expect(stems.body[0]).toMatchObject({ rating: 5, notes: 'gnarly' });
  });

  it('rejects out-of-range stem ratings', async () => {
    const res = await request(app).put('/api/stems/x/rating').send({ rating: 0 });
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
    jobApp = createApp(
      {
        tracks: createStore({ tracksDir: join(base, 'tracks'), ratingsDir: join(base, 'r1') }),
        stems: createStore({ tracksDir: join(base, 'stems'), ratingsDir: join(base, 'r2') }),
      },
      { jobStore, runner },
    );
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
    const app2 = createApp(
      {
        tracks: createStore({ tracksDir: join(base, 'tracks'), ratingsDir: join(base, 'r1') }),
        stems: createStore({ tracksDir: join(base, 'stems'), ratingsDir: join(base, 'r2') }),
      },
      { jobStore, runner, progressFor },
    );
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
