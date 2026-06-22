import { describe, it, expect, vi } from 'vitest';
import {
  bankSlug,
  cachedManifestUrl,
  warmSampleCacheIndex,
  installCacheAwareSamples,
} from '../src/sample-cache-client.js';

describe('client bankSlug matches the server', () => {
  it('produces the same slug shape as scripts/lib/sample-cache.mjs', () => {
    expect(bankSlug('github:eddyflux/crate')).toBe('github-eddyflux-crate');
  });
});

describe('cache-aware samples()', () => {
  it('redirects a cached single-string source to the local manifest URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ slugs: ['github-eddyflux-crate'] }),
    });
    warmSampleCacheIndex(fetchImpl);
    // let the lazy index fetch + its .then chain fully settle
    await vi.waitFor(() => expect(cachedManifestUrl('github:eddyflux/crate')).not.toBeNull());

    expect(cachedManifestUrl('github:eddyflux/crate')).toBe(
      '/sample-cache/banks/github-eddyflux-crate/strudel.json',
    );

    const original = vi.fn();
    const webaudio = { samples: original };
    installCacheAwareSamples(webaudio);
    webaudio.samples('github:eddyflux/crate');
    expect(original).toHaveBeenCalledWith('/sample-cache/banks/github-eddyflux-crate/strudel.json');
  });

  it('passes an uncached source straight through unchanged', () => {
    const original = vi.fn();
    const webaudio = { samples: original };
    installCacheAwareSamples(webaudio);
    webaudio.samples('github:not/cached');
    expect(original).toHaveBeenCalledWith('github:not/cached');
  });

  it('targets a writable carrier, never the frozen webaudio module (regression)', () => {
    // The real bug: @strudel/webaudio is a frozen ES module namespace, so
    // assigning onto it threw and aborted initApp. The contract is to wrap a
    // WRITABLE carrier (globalThis after evalScope), not the module.
    const frozenModule = Object.freeze({ samples: vi.fn() });
    expect(() => installCacheAwareSamples(frozenModule)).toThrow();

    const carrier = { samples: vi.fn() };
    expect(() => installCacheAwareSamples(carrier)).not.toThrow();
    expect(carrier.samples.name).toBe('cacheAwareSamples');
  });

  it('no-ops (returns null) when the carrier has no samples() yet', () => {
    expect(installCacheAwareSamples({})).toBeNull();
  });

  it('passes multi-arg samples() forms through untouched', () => {
    const original = vi.fn();
    const webaudio = { samples: original };
    installCacheAwareSamples(webaudio);
    webaudio.samples('https://x.dev/s.json', 'https://x.dev/base/', { prebake: true });
    expect(original).toHaveBeenCalledWith('https://x.dev/s.json', 'https://x.dev/base/', { prebake: true });
  });
});
