import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeAdmin } from './fake-admin.mjs';
import { createApp } from '../server/app.mjs';
import { createCardCache } from '../server/card-cache.mjs';

const INDEX = '<!doctype html><html><head><title>STRUDEL/CRATE</title><!--OG--></head><body>home</body></html>';
const SONG = '<!doctype html><html><head><title>STRUDEL/SONG</title><!--OG--></head><body>song</body></html>';

let app, adminDb, dist, renderCalls;
beforeEach(async () => {
  dist = await mkdtemp(join(tmpdir(), 'crate-dist-'));
  await writeFile(join(dist, 'index.html'), INDEX);
  await writeFile(join(dist, 'song.html'), SONG);

  adminDb = fakeAdmin({
    tracks: [{
      id: 'e-1', slug: 'demo-01', title: 'Neon Rinse',
      description: 'Rolling sub bass.', code: 's("bd*4")',
      meta: { genre: 'dark techno', bpm: 140, key: 'F#min', mood: 'moody', energy: 4, instruments: ['acid'] },
      author: [{ id: 'p1', artistName: 'Dennnis' }],
    }],
    stems: [],
  });

  renderCalls = 0;
  const cardRenderer = { render: async () => { renderCalls += 1; return Buffer.from('PNGDATA'); }, close: async () => {} };
  const cardCache = createCardCache({ dir: join(dist, 'card-cache'), maxBytes: 10_000_000 });

  app = createApp({
    adminDb, namespaces: ['tracks', 'stems'],
    distDir: dist, cardRenderer, cardCache,
    publicOrigin: 'https://crate.vimsical.com',
  });
});

describe('home meta injection', () => {
  it('GET / injects brand OG tags', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('og:site_name" content="STRUDEL/CRATE"');
    expect(res.text).toContain('https://crate.vimsical.com/og/home.jpg');
    expect(res.text).toContain('twitter:card" content="summary_large_image"');
  });
});

describe('song meta injection', () => {
  it('GET /song/<entityId> injects per-song tags + card url', async () => {
    const res = await request(app).get('/song/e-1');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Neon Rinse — STRUDEL/CRATE');
    expect(res.text).toContain('og:type" content="music.song"');
    expect(res.text).toContain('/api/tracks/e-1/card.jpg?v=');
  });
  it('GET /song/<slug> still resolves (legacy links)', async () => {
    const res = await request(app).get('/song/demo-01');
    expect(res.text).toContain('Neon Rinse');
  });
  it('GET /song/<unknown> falls back to brand tags', async () => {
    const res = await request(app).get('/song/missing');
    expect(res.status).toBe(200);
    expect(res.text).toContain('og:site_name" content="STRUDEL/CRATE"');
  });
  it('escapes a hostile song title in the meta block', async () => {
    adminDb._store.tracks[0].title = '"><script>alert(1)</script>';
    const res = await request(app).get('/song/e-1');
    expect(res.text).not.toContain('<script>alert(1)</script>');
  });
});

describe('card image route', () => {
  it('GET /api/tracks/:id/card.jpg returns a JPEG and caches it', async () => {
    const r1 = await request(app).get('/api/tracks/e-1/card.jpg');
    expect(r1.status).toBe(200);
    expect(r1.headers['content-type']).toContain('image/jpeg');
    expect(r1.body.equals(Buffer.from('PNGDATA'))).toBe(true);
    const r2 = await request(app).get('/api/tracks/e-1/card.jpg');
    expect(r2.status).toBe(200);
    expect(renderCalls).toBe(1); // second request served from cache
  });
  it('404s an unknown id', async () => {
    const res = await request(app).get('/api/tracks/nope/card.jpg');
    expect(res.status).toBe(404);
  });
  it('404s an unknown namespace', async () => {
    const res = await request(app).get('/api/bogus/e-1/card.jpg');
    expect(res.status).toBe(404);
  });
  it('GET /og/home.jpg returns the brand JPEG', async () => {
    const res = await request(app).get('/og/home.jpg');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
  });
});
