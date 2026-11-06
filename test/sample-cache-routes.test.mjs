import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
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

  describe('serves only regular files physically inside', () => {
    let outside;
    beforeEach(async () => {
      outside = await mkdtemp(join(tmpdir(), 'crate-outside-'));
      await writeFile(join(outside, '.env'), 'TOKEN=dummy-secret');
      await mkdir(join(cacheDir, 'banks', 'b'), { recursive: true });
      await writeFile(join(cacheDir, 'banks', 'b', 'a.wav'), 'RIFF');
    });
    afterEach(() => rm(outside, { recursive: true, force: true }));

    it('still serves a regular file', async () => {
      expect((await request(app).get('/sample-cache/banks/b/a.wav')).status).toBe(200);
    });
    it('refuses a symlink to a file outside', async () => {
      await symlink(join(outside, '.env'), join(cacheDir, 'banks', 'b', 'x.wav'));
      const res = await request(app).get('/sample-cache/banks/b/x.wav');
      expect(res.status).toBe(404);
      expect(res.text ?? '').not.toContain('dummy-secret');
    });
    it('refuses a symlinked directory on the way there', async () => {
      await symlink(outside, join(cacheDir, 'banks', 'out'));
      await writeFile(join(outside, 'y.wav'), 'dummy-secret');
      expect((await request(app).get('/sample-cache/banks/out/y.wav')).status).toBe(404);
    });
    it('refuses an encoded path through a symlink', async () => {
      await symlink(join(outside, '.env'), join(cacheDir, 'banks', 'b', 'x.wav'));
      expect((await request(app).get('/sample-cache/banks/b/%78.wav')).status).toBe(404);
    });
    it('does not open a FIFO', async () => {
      expect(spawnSync('/usr/bin/mkfifo', [join(cacheDir, 'banks', 'b', 'p.wav')]).status).toBe(0);
      expect((await request(app).get('/sample-cache/banks/b/p.wav').timeout(3000)).status).toBe(404);
    });
    it('an ordinary miss stays an ordinary 404', async () => {
      expect((await request(app).get('/sample-cache/banks/b/none.wav')).status).toBe(404);
    });
  });
});
