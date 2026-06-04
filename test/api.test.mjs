import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';

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
