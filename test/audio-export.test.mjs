import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeAdmin } from './fake-admin.mjs';
import { createAudioCache } from '../server/audio-cache.mjs';
import { createAudioExport } from '../server/audio-export.mjs';

let dir, adminDb, cache;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'audio-export-'));
  adminDb = fakeAdmin({
    tracks: [{ id: 't1', slug: 'demo-01', code: 'note("c3")', meta: { bpm: 120 } }],
    stems: [],
  });
  cache = createAudioCache({ dir });
});

// A renderer that counts calls and returns deterministic bytes.
function fakeRenderer() {
  let calls = 0;
  return {
    get calls() { return calls; },
    render: async () => { calls += 1; await new Promise((r) => setTimeout(r, 10)); return Buffer.from('AUDIO'); },
  };
}

describe('createAudioExport.getOrRender', () => {
  it('renders + caches on miss, keyed by entity id, filename uses slug', async () => {
    const renderer = fakeRenderer();
    const ex = createAudioExport({ adminDb, cache, renderer });
    const out = await ex.getOrRender('tracks', 'demo-01', 'mp3');
    expect(out.path).toBe(join(dir, 'tracks', 't1.mp3'));
    expect(out.filename).toBe('demo-01.mp3');
    expect(await readFile(out.path, 'utf8')).toBe('AUDIO');
    expect(renderer.calls).toBe(1);
  });

  it('serves cache hit without re-rendering', async () => {
    const renderer = fakeRenderer();
    const ex = createAudioExport({ adminDb, cache, renderer });
    await ex.getOrRender('tracks', 't1', 'mp3'); // resolve by entity id too
    await ex.getOrRender('tracks', 'demo-01', 'mp3');
    expect(renderer.calls).toBe(1);
  });

  it('dedups concurrent identical requests into one render', async () => {
    const renderer = fakeRenderer();
    const ex = createAudioExport({ adminDb, cache, renderer });
    await Promise.all([
      ex.getOrRender('tracks', 'demo-01', 'wav'),
      ex.getOrRender('tracks', 'demo-01', 'wav'),
    ]);
    expect(renderer.calls).toBe(1);
  });

  it('returns null for an unknown item or namespace', async () => {
    const ex = createAudioExport({ adminDb, cache, renderer: fakeRenderer() });
    expect(await ex.getOrRender('tracks', 'nope', 'wav')).toBeNull();
    expect(await ex.getOrRender('widgets', 'demo-01', 'wav')).toBeNull();
  });

  it('prewarm renders in the background and swallows errors', async () => {
    const renderer = { render: async () => { throw new Error('boom'); } };
    const ex = createAudioExport({ adminDb, cache, renderer });
    await ex.prewarm('tracks', 'demo-01', 'mp3'); // must not throw
    expect(true).toBe(true);
  });
});
