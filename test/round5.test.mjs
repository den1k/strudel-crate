// Round 5: playback of vendored banks, and what a job can put in a public row.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';

describe('the bank index', () => {
  let cacheDir;
  const bank = async (slug, manifest, files = []) => {
    const dir = join(cacheDir, 'banks', slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'strudel.json'), JSON.stringify(manifest));
    for (const f of files) {
      await mkdir(join(dir, f, '..'), { recursive: true });
      await writeFile(join(dir, f), 'RIFF');
    }
  };
  const slugs = async () => (await request(createApp({ sampleCacheDir: cacheDir })).get('/sample-cache/index.json').expect(200)).body.slugs;

  beforeEach(async () => { cacheDir = await mkdtemp(join(tmpdir(), 'crate-r5-')); });
  afterEach(async () => { await rm(cacheDir, { recursive: true, force: true }); });

  it('advertises a bank holding every file it lists', async () => {
    await bank('whole', { _base: './', bd: ['bd/1.wav'], hh: 'hh.wav', pad: { c3: ['pad/c3.wav'] } }, ['bd/1.wav', 'hh.wav', 'pad/c3.wav']);
    expect(await slugs()).toEqual(['whole']);
  });

  // A manifest vendored without its audio: the client would lose a sound upstream still has.
  it('leaves out a bank missing a listed file, so the client uses upstream', async () => {
    await bank('empty', { _base: './', bd: ['bd/1.wav'] });
    await bank('partial', { _base: './', bd: ['bd/1.wav', 'bd/2.wav'] }, ['bd/1.wav']);
    await bank('pitched', { _base: './', pad: { c3: ['pad/c3.wav'], c4: ['pad/c4.wav'] } }, ['pad/c3.wav']);
    expect(await slugs()).toEqual([]);
  });

  it('leaves out a manifest it can\'t read, or one naming a path outside the bank', async () => {
    await bank('escapes', { _base: './', bd: ['../whole/1.wav'] });
    await mkdir(join(cacheDir, 'banks', 'garbled'), { recursive: true });
    await writeFile(join(cacheDir, 'banks', 'garbled', 'strudel.json'), '{');
    expect(await slugs()).toEqual([]);
  });
});
