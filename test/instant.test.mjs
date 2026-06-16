import { describe, it, expect } from 'vitest';
import { fakeAdmin } from './fake-admin.mjs';
import {
  ensureProfile, getProfile, setArtistName, saveRating, itemSlugs, itemsBySlug, insertItem,
} from '../server/instant.mjs';

describe('ensureProfile', () => {
  it('returns the existing profile id when one is linked', async () => {
    const db = fakeAdmin({ profiles: [{ id: 'p1', artistName: 'Neo', user: { id: 'u1' } }] });
    expect(await ensureProfile(db, { id: 'u1', email: 'neo@x.com' })).toBe('p1');
    expect(db._txs).toHaveLength(0);
  });

  it('creates a profile (artistName = email local part) when none exists', async () => {
    const db = fakeAdmin({ profiles: [] });
    const id = await ensureProfile(db, { id: 'u2', email: 'kalavox@gmail.com' });
    expect(id).toBeTruthy();
    const op = db._txs[0];
    expect(op.ns).toBe('profiles');
    expect(op.update.artistName).toBe('kalavox');
    expect(op.link).toEqual({ user: 'u2' });
  });
});

describe('setArtistName', () => {
  it('updates the existing profile name', async () => {
    const db = fakeAdmin({ profiles: [{ id: 'p1', artistName: 'old', user: { id: 'u1' } }] });
    const res = await setArtistName(db, { id: 'u1', email: 'a@b.c' }, 'New Name');
    expect(res).toEqual({ id: 'p1', artistName: 'New Name' });
    expect(db._txs.at(-1)).toMatchObject({ ns: 'profiles', id: 'p1', update: { artistName: 'New Name' } });
  });
});

describe('saveRating', () => {
  it('patches rating/notes/lesson on the matching slug', async () => {
    const db = fakeAdmin({ tracks: [{ id: 't1', slug: 's-01', rating: null, notes: '', lesson: '' }] });
    const res = await saveRating(db, 'tracks', 's-01', { rating: 4, notes: 'nice' });
    expect(res).toEqual({ rating: 4, notes: 'nice', lesson: '' });
    expect(db._txs[0]).toMatchObject({ ns: 'tracks', id: 't1', update: { rating: 4, notes: 'nice' } });
    expect(db._txs[0].update).not.toHaveProperty('lesson');
  });

  it('returns null for an unknown slug', async () => {
    const db = fakeAdmin({ tracks: [] });
    expect(await saveRating(db, 'tracks', 'nope', { rating: 1 })).toBeNull();
  });

  it('clears a rating when rating is explicitly null', async () => {
    const db = fakeAdmin({ tracks: [{ id: 't1', slug: 's-01', rating: 5 }] });
    const res = await saveRating(db, 'tracks', 's-01', { rating: null });
    expect(res.rating).toBeNull();
  });
});

describe('itemSlugs / itemsBySlug', () => {
  it('itemSlugs returns a set of slugs', async () => {
    const db = fakeAdmin({ stems: [{ slug: 'a' }, { slug: 'b' }] });
    expect(await itemSlugs(db, 'stems')).toEqual(new Set(['a', 'b']));
  });
  it('itemsBySlug filters by $in', async () => {
    const db = fakeAdmin({ stems: [{ slug: 'a', batch: 'B1' }, { slug: 'b', batch: 'B2' }] });
    const rows = await itemsBySlug(db, 'stems', ['b']);
    expect(rows).toEqual([{ slug: 'b', batch: 'B2' }]);
  });
});

describe('insertItem', () => {
  const track = {
    id: '2026-06-16-x-01', title: 'X', prompt: 'p', batch: '2026-06-16-x',
    description: 'd', code: 'setcpm(120/4)', createdAt: '2026-06-16T00:00:00Z',
    meta: { bpm: 120, genre: 'g', mood: 'm', key: 'C', instruments: ['s'], energy: 3 },
  };

  it('transacts a new item with slug, defaults and author link', async () => {
    const db = fakeAdmin({ tracks: [] });
    const res = await insertItem(db, 'tracks', track, 'p1');
    expect(res.ok).toBe(true);
    const op = db._txs[0];
    expect(op.ns).toBe('tracks');
    expect(op.update).toMatchObject({ slug: '2026-06-16-x-01', isPublic: true, rating: null, notes: '', lesson: '' });
    expect(op.update.versionOf).toBeUndefined();
    expect(op.link).toEqual({ author: 'p1' });
  });

  it('rejects a duplicate slug', async () => {
    const db = fakeAdmin({ tracks: [{ slug: '2026-06-16-x-01' }] });
    const res = await insertItem(db, 'tracks', track, 'p1');
    expect(res.ok).toBe(false);
    expect(db._txs).toHaveLength(0);
  });

  it('sets versionOf when present', async () => {
    const db = fakeAdmin({ tracks: [] });
    await insertItem(db, 'tracks', { ...track, id: '2026-06-16-x-01-v2', versionOf: '2026-06-16-x-01' }, 'p1');
    expect(db._txs[0].update.versionOf).toBe('2026-06-16-x-01');
  });
});

describe('getProfile', () => {
  it('returns the stored profile for an existing user', async () => {
    const db = fakeAdmin({ profiles: [{ id: 'p1', artistName: 'Neo', user: { id: 'u1' } }] });
    expect(await getProfile(db, { id: 'u1', email: 'neo@x.com' })).toEqual({ id: 'p1', artistName: 'Neo' });
  });

  it('falls back to email local part for a brand-new user', async () => {
    const db = fakeAdmin({ profiles: [] });
    const res = await getProfile(db, { id: 'u9', email: 'freshuser@gmail.com' });
    expect(res.artistName).toBe('freshuser');
    expect(res.id).toBeTruthy();
  });
});
