import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';

let app, tracksDir;
beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'strudel-api-'));
  tracksDir = join(base, 'tracks');
  await mkdir(tracksDir, { recursive: true });
  app = createApp(createStore({ tracksDir, ratingsDir: join(base, 'ratings') }));
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
