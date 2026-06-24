import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bankSlug,
  manifestUrlFor,
  extractSampleRefs,
  cacheBank,
  isBankCached,
  writeTrackManifest,
  readTrackManifest,
} from '../scripts/lib/sample-cache.mjs';

describe('bankSlug', () => {
  it('derives a filesystem-safe slug from a github shorthand', () => {
    expect(bankSlug('github:eddyflux/crate')).toBe('github-eddyflux-crate');
  });
  it('derives a slug from a full URL', () => {
    expect(bankSlug('https://example.com/banks/foo.json')).toMatch(/^https-example-com-banks-foo/);
  });
  it('is stable (same input → same slug)', () => {
    expect(bankSlug('github:eddyflux/crate')).toBe(bankSlug('github:eddyflux/crate'));
  });
});

describe('manifestUrlFor', () => {
  it('maps a github shorthand to its raw main strudel.json', () => {
    expect(manifestUrlFor('github:eddyflux/crate')).toBe(
      'https://raw.githubusercontent.com/eddyflux/crate/main/strudel.json',
    );
  });
  it('passes a full URL through unchanged', () => {
    expect(manifestUrlFor('https://x.dev/strudel.json')).toBe('https://x.dev/strudel.json');
  });
});

describe('extractSampleRefs', () => {
  it('finds every samples() source string in track code', () => {
    const code = 'samples("github:eddyflux/crate")\nsamples("https://x.dev/s.json")\ns("crate_bd")';
    expect(extractSampleRefs(code)).toEqual(['github:eddyflux/crate', 'https://x.dev/s.json']);
  });
  it('returns [] when there are no samples() calls', () => {
    expect(extractSampleRefs('s("bd*4").bank("RolandTR909")')).toEqual([]);
  });
});

describe('cacheBank + manifests (filesystem)', () => {
  let dir;
  // A tiny fake manifest server: one bank, one sample file.
  const fakeManifest = {
    _base: 'https://fake.test/banks/',
    tk_bd: ['tk_bd/kick.wav'],
  };
  const fakeFetch = async (url) => {
    if (url.endsWith('.json') || url.includes('strudel.json')) {
      return { ok: true, status: 200, json: async () => fakeManifest, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    // a sample file
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('RIFFfake').buffer };
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'crate-cache-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('downloads the manifest + samples and rewrites _base to a relative local path', async () => {
    const res = await cacheBank('github:fake/bank', { cacheDir: dir, fetchImpl: fakeFetch });
    expect(res.ok).toBe(true);
    const slug = bankSlug('github:fake/bank');
    const localManifest = JSON.parse(await readFile(join(dir, 'banks', slug, 'strudel.json'), 'utf8'));
    // _base must be relative so the cached manifest is portable / served locally.
    expect(localManifest._base).toBe('./');
    // the referenced sample file landed in the cache
    const f = await stat(join(dir, 'banks', slug, 'tk_bd/kick.wav'));
    expect(f.size).toBeGreaterThan(0);
  });

  it('isBankCached reflects whether a bank was vendored', async () => {
    expect(await isBankCached('github:fake/bank', { cacheDir: dir })).toBe(false);
    await cacheBank('github:fake/bank', { cacheDir: dir, fetchImpl: fakeFetch });
    expect(await isBankCached('github:fake/bank', { cacheDir: dir })).toBe(true);
  });

  it('is idempotent — caching an already-cached bank does not refetch samples', async () => {
    let sampleFetches = 0;
    const counting = async (url) => {
      if (!url.includes('.json')) sampleFetches++;
      return fakeFetch(url);
    };
    await cacheBank('github:fake/bank', { cacheDir: dir, fetchImpl: counting });
    const firstCount = sampleFetches;
    await cacheBank('github:fake/bank', { cacheDir: dir, fetchImpl: counting });
    expect(sampleFetches).toBe(firstCount); // no extra sample downloads on the second call
  });

  it('writes and reads a per-track manifest of its bank dependencies', async () => {
    await writeTrackManifest('track-123', ['github:fake/bank', 'github:other/bank'], { cacheDir: dir });
    const m = await readTrackManifest('track-123', { cacheDir: dir });
    expect(m.banks).toEqual(['github:fake/bank', 'github:other/bank']);
    expect(m.slugs).toEqual([bankSlug('github:fake/bank'), bankSlug('github:other/bank')]);
  });

  it('removes the partial bank dir when a sample fetch fails (no orphan)', async () => {
    // Manifest references two samples; the second 404s upstream (real-world: a
    // manifest listing files that no longer exist in the repo).
    const manifest = { _base: 'https://fake.test/banks/', kit: ['kit/a.wav', 'kit/missing.wav'] };
    const flakyFetch = async (url) => {
      if (url.includes('.json')) return { ok: true, status: 200, json: async () => manifest };
      if (url.includes('missing')) return { ok: false, status: 404 };
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('RIFF').buffer };
    };
    const slug = bankSlug('github:fake/flaky');
    const res = await cacheBank('github:fake/flaky', { cacheDir: dir, fetchImpl: flakyFetch });
    expect(res.ok).toBe(false);
    // The bank dir must not survive as an orphan (samples present, no manifest).
    await expect(stat(join(dir, 'banks', slug))).rejects.toThrow();
    expect(await isBankCached('github:fake/flaky', { cacheDir: dir })).toBe(false);
  });

  it('bounds the number of samples downloaded per bank', async () => {
    const bigManifest = {
      _base: 'https://fake.test/banks/',
      // way more than the bound
      huge: Array.from({ length: 100000 }, (_, i) => `huge/s${i}.wav`),
    };
    const bigFetch = async (url) =>
      url.includes('.json')
        ? { ok: true, json: async () => bigManifest }
        : { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
    const res = await cacheBank('github:fake/big', { cacheDir: dir, fetchImpl: bigFetch, maxFiles: 10 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/too many|exceeds|bound/i);
  });
});
