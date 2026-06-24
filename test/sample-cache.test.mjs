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
  pruneManifestPaths,
  cacheTrackSamples,
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

  it('aborts and removes the dir on a transient (non-404) sample failure', async () => {
    const manifest = { _base: 'https://fake.test/banks/', kit: ['kit/a.wav', 'kit/flaky.wav'] };
    const flakyFetch = async (url) => {
      if (url.includes('.json')) return { ok: true, status: 200, json: async () => manifest };
      if (url.includes('flaky')) return { ok: false, status: 500 }; // transient → must abort
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('RIFF').buffer };
    };
    const slug = bankSlug('github:fake/flaky');
    const res = await cacheBank('github:fake/flaky', { cacheDir: dir, fetchImpl: flakyFetch });
    expect(res.ok).toBe(false);
    await expect(stat(join(dir, 'banks', slug))).rejects.toThrow();
    expect(await isBankCached('github:fake/flaky', { cacheDir: dir })).toBe(false);
  });

  it('skips 404 samples, caches the rest, and prunes them from the manifest', async () => {
    const manifest = { _base: 'https://fake.test/banks/', cp: ['cp/a.wav', 'cp/missing.wav'] };
    const fetch404 = async (url) => {
      if (url.includes('.json')) return { ok: true, status: 200, json: async () => manifest };
      if (url.includes('missing')) return { ok: false, status: 404 };
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('RIFF').buffer };
    };
    const slug = bankSlug('github:fake/holey');
    const res = await cacheBank('github:fake/holey', { cacheDir: dir, fetchImpl: fetch404 });
    expect(res.ok).toBe(true);
    expect(res.files).toBe(1);
    expect(res.skipped).toEqual(['cp/missing.wav']);
    // The fetched file is on disk; the 404'd one is not.
    expect((await stat(join(dir, 'banks', slug, 'cp/a.wav'))).size).toBeGreaterThan(0);
    await expect(stat(join(dir, 'banks', slug, 'cp/missing.wav'))).rejects.toThrow();
    // The cached manifest lists only the kept path.
    const cached = JSON.parse(await readFile(join(dir, 'banks', slug, 'strudel.json'), 'utf8'));
    expect(cached._base).toBe('./');
    expect(cached.cp).toEqual(['cp/a.wav']);
  });

  it('aborts (no cache) when every referenced sample 404s', async () => {
    const manifest = { _base: 'https://fake.test/banks/', cp: ['cp/x.wav', 'cp/y.wav'] };
    const allGone = async (url) =>
      url.includes('.json')
        ? { ok: true, status: 200, json: async () => manifest }
        : { ok: false, status: 404 };
    const slug = bankSlug('github:fake/empty');
    const res = await cacheBank('github:fake/empty', { cacheDir: dir, fetchImpl: allGone });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/all 2 samples 404/i);
    await expect(stat(join(dir, 'banks', slug))).rejects.toThrow();
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

  it('cacheTrackSamples reports skipped samples per bank', async () => {
    const manifest = { _base: 'https://fake.test/banks/', cp: ['cp/a.wav', 'cp/missing.wav'] };
    const fetch404 = async (url) => {
      if (url.includes('.json')) return { ok: true, status: 200, json: async () => manifest };
      if (url.includes('missing')) return { ok: false, status: 404 };
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('RIFF').buffer };
    };
    const code = `samples('github:fake/holey')\n`;
    const out = await cacheTrackSamples('track-skip', code, { cacheDir: dir, fetchImpl: fetch404 });
    expect(out.ok).toBe(true);
    expect(out.banks[0].skipped).toEqual(['cp/missing.wav']);
  });
});

describe('pruneManifestPaths', () => {
  it('drops paths not in the keep set and removes emptied keys', () => {
    const manifest = {
      _base: 'https://x/',
      cp: ['cp/a.wav', 'cp/b.wav'],
      bd: ['bd/gone.wav'],
      hh: 'hh/closed.wav',
    };
    const out = pruneManifestPaths(manifest, new Set(['cp/a.wav', 'hh/closed.wav']));
    expect(out._base).toBe('https://x/');     // metadata preserved
    expect(out.cp).toEqual(['cp/a.wav']);     // partially kept array filtered
    expect(out.bd).toBeUndefined();           // fully-missing array key dropped
    expect(out.hh).toBe('hh/closed.wav');     // kept string stays a string
  });

  it('drops a string key whose only path was skipped', () => {
    const out = pruneManifestPaths({ kick: 'kick/x.wav' }, new Set());
    expect(out.kick).toBeUndefined();
  });

  it('preserves non-string, non-array values verbatim', () => {
    const out = pruneManifestPaths({ _base: './', _meta: { bpm: 120 }, n: 5 }, new Set());
    expect(out._meta).toEqual({ bpm: 120 });
    expect(out.n).toBe(5);
  });
});
