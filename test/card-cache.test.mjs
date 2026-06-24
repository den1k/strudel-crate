import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCardCache } from '../server/card-cache.mjs';

let dir, cache;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'card-cache-'));
  cache = createCardCache({ dir, maxBytes: 1000 });
});

describe('createCardCache', () => {
  it('returns null for a miss', async () => {
    expect(await cache.cachedPath('nope')).toBeNull();
  });
  it('stores and reads back a buffer', async () => {
    const buf = Buffer.from('PNGDATA');
    const p = await cache.store('e1-abc', buf);
    expect(p).toBe(join(dir, 'e1-abc.png'));
    const hit = await cache.cachedPath('e1-abc');
    expect(hit).toBe(p);
    expect((await readFile(p)).equals(buf)).toBe(true);
  });
  it('prunes the least-recently-used file past the byte cap', async () => {
    await cache.store('old', Buffer.alloc(600));
    // Make "old" clearly older than "new" by back-dating its atime/mtime.
    const { utimes } = await import('node:fs/promises');
    await utimes(join(dir, 'old.png'), new Date(Date.now() - 60000), new Date(Date.now() - 60000));
    await cache.store('new', Buffer.alloc(600)); // total 1200 > 1000 → evict oldest
    expect(await cache.cachedPath('old')).toBeNull();
    expect(await cache.cachedPath('new')).not.toBeNull();
  });
});
