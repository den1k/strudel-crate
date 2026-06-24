import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';

let app, cacheDir;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'crate-cacheroutes-'));
  app = createApp({ sampleCacheDir: cacheDir });
});
afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

describe('sample cache routes', () => {
  it('reports an empty index when nothing is cached', async () => {
    const res = await request(app).get('/sample-cache/index.json');
    expect(res.status).toBe(200);
    expect(res.body.slugs).toEqual([]);
  });

  it('lists cached bank slugs and serves a vendored manifest', async () => {
    const slug = 'github-fake-bank';
    await mkdir(join(cacheDir, 'banks', slug), { recursive: true });
    await writeFile(join(cacheDir, 'banks', slug, 'strudel.json'), JSON.stringify({ _base: './', x: ['x/a.wav'] }));

    const index = await request(app).get('/sample-cache/index.json');
    expect(index.body.slugs).toContain(slug);

    const manifest = await request(app).get(`/sample-cache/banks/${slug}/strudel.json`);
    expect(manifest.status).toBe(200);
    expect(manifest.body._base).toBe('./');
  });

  it('excludes partially-vendored banks that lack a strudel.json manifest', async () => {
    // A vendor that failed partway leaves sample files but no manifest. Such an
    // orphan must NOT be advertised as cached, or the client rewrites samples()
    // to a local URL that 404s instead of falling back to upstream github.
    const orphan = 'github-mot4i-garden';
    await mkdir(join(cacheDir, 'banks', orphan, 'garden_cp'), { recursive: true });
    await writeFile(join(cacheDir, 'banks', orphan, 'garden_cp', 'clap01.wav'), 'fake');

    const good = 'github-fake-bank';
    await mkdir(join(cacheDir, 'banks', good), { recursive: true });
    await writeFile(join(cacheDir, 'banks', good, 'strudel.json'), JSON.stringify({ _base: './' }));

    const index = await request(app).get('/sample-cache/index.json');
    expect(index.body.slugs).toContain(good);
    expect(index.body.slugs).not.toContain(orphan);
  });
});
