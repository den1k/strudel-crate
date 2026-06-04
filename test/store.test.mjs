import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.mjs';

const track = (id, extra = {}) => ({
  id, title: `t-${id}`, prompt: 'p', batch: 'b', code: 's("bd")',
  createdAt: '2026-06-03T00:00:00Z', ...extra,
});

let dirs, store;
beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'strudel-store-'));
  dirs = { tracksDir: join(base, 'tracks'), ratingsDir: join(base, 'ratings') };
  await mkdir(dirs.tracksDir, { recursive: true });
  store = createStore(dirs);
});

describe('createStore', () => {
  it('lists tracks with null rating when unrated', async () => {
    await writeFile(join(dirs.tracksDir, 'a.json'), JSON.stringify(track('a')));
    const tracks = await store.listTracks();
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({ id: 'a', rating: null, notes: '' });
  });

  it('merges saved ratings into the listing', async () => {
    await writeFile(join(dirs.tracksDir, 'a.json'), JSON.stringify(track('a')));
    await store.saveRating('a', { rating: 4, notes: 'nice bass' });
    const tracks = await store.listTracks();
    expect(tracks[0]).toMatchObject({ rating: 4, notes: 'nice bass' });
  });

  it('returns empty list when tracks dir missing', async () => {
    const empty = createStore({ tracksDir: join(dirs.tracksDir, 'nope'), ratingsDir: dirs.ratingsDir });
    expect(await empty.listTracks()).toEqual([]);
  });

  it('saveRating returns the persisted record', async () => {
    const saved = await store.saveRating('x', { rating: 2, notes: '' });
    expect(saved).toMatchObject({ id: 'x', rating: 2, notes: '' });
    expect(saved.updatedAt).toBeTruthy();
  });

  it('round-trips lesson through saveRating/listTracks', async () => {
    await writeFile(join(dirs.tracksDir, 'a.json'), JSON.stringify(track('a')));
    await store.saveRating('a', { rating: 3, notes: 'meh mix', lesson: 'keep drums under synths' });
    const tracks = await store.listTracks();
    expect(tracks[0]).toMatchObject({ rating: 3, notes: 'meh mix', lesson: 'keep drums under synths' });
  });

  it('defaults lesson to empty string for unrated tracks and pre-lesson rating files', async () => {
    await writeFile(join(dirs.tracksDir, 'a.json'), JSON.stringify(track('a')));
    await writeFile(join(dirs.tracksDir, 'b.json'), JSON.stringify(track('b')));
    // simulate a rating file written before the lesson field existed
    await mkdir(dirs.ratingsDir, { recursive: true });
    await writeFile(join(dirs.ratingsDir, 'b.json'), JSON.stringify({ id: 'b', rating: 2, notes: 'old' }));
    const tracks = await store.listTracks();
    expect(tracks.find((t) => t.id === 'a')).toMatchObject({ rating: null, lesson: '' });
    expect(tracks.find((t) => t.id === 'b')).toMatchObject({ rating: 2, notes: 'old', lesson: '' });
  });
});
