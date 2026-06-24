import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile, stat, utimes, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAudioCache } from '../server/audio-cache.mjs';

let dir;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'audio-cache-')); });

describe('createAudioCache', () => {
  it('store writes <dir>/<ns>/<id>.<ext> and cachedPath finds it', async () => {
    const cache = createAudioCache({ dir });
    const p = await cache.store('tracks', 't1', 'mp3', Buffer.from('abc'));
    expect(p).toBe(join(dir, 'tracks', 't1.mp3'));
    expect(await readFile(p, 'utf8')).toBe('abc');
    expect(await cache.cachedPath('tracks', 't1', 'mp3')).toBe(p);
  });

  it('maps stems format to a .zip extension', async () => {
    const cache = createAudioCache({ dir });
    const p = await cache.store('stems', 's1', 'stems', Buffer.from('zip'));
    expect(p).toBe(join(dir, 'stems', 's1.zip'));
  });

  it('cachedPath returns null for a miss', async () => {
    const cache = createAudioCache({ dir });
    expect(await cache.cachedPath('tracks', 'nope', 'wav')).toBeNull();
  });

  it('cachedPath bumps atime on a hit', async () => {
    const cache = createAudioCache({ dir });
    const p = await cache.store('tracks', 't1', 'mp3', Buffer.from('x'));
    const old = new Date('2020-01-01T00:00:00Z');
    await utimes(p, old, old);
    await cache.cachedPath('tracks', 't1', 'mp3');
    const after = (await stat(p)).atime.getTime();
    expect(after).toBeGreaterThan(old.getTime());
  });

  it('prune evicts least-recently-accessed files until under maxBytes', async () => {
    // Write three 100-byte files directly (bypassing store()'s auto-prune) so we
    // control atimes before pruning. Cap 250 → the single oldest-atime file goes.
    const cache = createAudioCache({ dir, maxBytes: 250 });
    await mkdir(join(dir, 'tracks'), { recursive: true });
    const big = Buffer.alloc(100, 1);
    for (const id of ['old', 'mid', 'new']) {
      await writeFile(join(dir, 'tracks', `${id}.wav`), big);
    }
    await utimes(join(dir, 'tracks', 'old.wav'), new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
    await utimes(join(dir, 'tracks', 'mid.wav'), new Date('2021-01-01T00:00:00Z'), new Date('2021-01-01T00:00:00Z'));
    await utimes(join(dir, 'tracks', 'new.wav'), new Date('2022-01-01T00:00:00Z'), new Date('2022-01-01T00:00:00Z'));
    const freed = await cache.prune();
    expect(freed).toBe(100);
    expect(await cache.cachedPath('tracks', 'old', 'wav')).toBeNull();
    expect(await cache.cachedPath('tracks', 'mid', 'wav')).not.toBeNull();
    expect(await cache.cachedPath('tracks', 'new', 'wav')).not.toBeNull();
  });

  it('store triggers prune automatically (cap enforced on write)', async () => {
    const cache = createAudioCache({ dir, maxBytes: 150 });
    await cache.store('tracks', 'a', 'wav', Buffer.alloc(100, 1));
    const ta = new Date('2020-01-01T00:00:00Z');
    await utimes(join(dir, 'tracks', 'a.wav'), ta, ta);
    await cache.store('tracks', 'b', 'wav', Buffer.alloc(100, 1)); // now 200 > 150 → evict 'a'
    expect(await cache.cachedPath('tracks', 'a', 'wav')).toBeNull();
    expect(await cache.cachedPath('tracks', 'b', 'wav')).not.toBeNull();
  });
});
