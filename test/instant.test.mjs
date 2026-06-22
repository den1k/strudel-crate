import { describe, it, expect } from 'vitest';
import { fakeAdmin } from './fake-admin.mjs';
import {
  ensureProfile, getProfile, setArtistName, saveRating, itemSlugs, itemsBySlug, insertItem, recordPlay, setRating,
  setNotes, itemOwnerProfileId,
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

describe('recordPlay', () => {
  it('bumps the total and treats absent playCount as 0 (anonymous)', async () => {
    const db = fakeAdmin({ tracks: [{ id: 't1', slug: 's-01' }] });
    const res = await recordPlay(db, 'tracks', 's-01', undefined);
    expect(res).toEqual({ playCount: 1, you: undefined });
    expect(db._txs[0]).toMatchObject({ ns: 'tracks', id: 't1', update: { playCount: 1 } });
    expect(db._txs.some((o) => o.ns === 'plays')).toBe(false);
  });

  it('increments an existing total (anonymous)', async () => {
    const db = fakeAdmin({ stems: [{ id: 's1', slug: 'st-01', playCount: 4 }] });
    const res = await recordPlay(db, 'stems', 'st-01', undefined);
    expect(res.playCount).toBe(5);
    expect(db._txs[0]).toMatchObject({ ns: 'stems', id: 's1', update: { playCount: 5 } });
  });

  it('returns null for an unknown slug', async () => {
    const db = fakeAdmin({ tracks: [] });
    expect(await recordPlay(db, 'tracks', 'nope', undefined)).toBeNull();
  });

  it('creates a per-user plays record (count 1) when none exists', async () => {
    const db = fakeAdmin({
      tracks: [{ id: 't1', slug: 's-01', playCount: 0 }],
      profiles: [{ id: 'p1', user: { id: 'u1' } }],
      plays: [],
    });
    const res = await recordPlay(db, 'tracks', 's-01', { id: 'u1', email: 'kalavox@gmail.com' });
    expect(res).toMatchObject({ playCount: 1, you: 1 });
    const playOp = db._txs.find((o) => o.ns === 'plays');
    expect(playOp.update).toMatchObject({ namespace: 'tracks', slug: 's-01', count: 1 });
    expect(playOp.link).toEqual({ profile: 'p1' });
  });

  it('increments an existing per-user plays record', async () => {
    const db = fakeAdmin({
      tracks: [{ id: 't1', slug: 's-01', playCount: 5 }],
      profiles: [{ id: 'p1', user: { id: 'u1' } }],
      plays: [{ id: 'pl1', namespace: 'tracks', slug: 's-01', count: 3, profile: { id: 'p1' } }],
    });
    const res = await recordPlay(db, 'tracks', 's-01', { id: 'u1', email: 'kalavox@gmail.com' });
    expect(res.you).toBe(4);
    const playOp = db._txs.find((o) => o.ns === 'plays' && o.id === 'pl1');
    expect(playOp.update).toMatchObject({ count: 4 });
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

describe('setRating', () => {
  const seed = () => fakeAdmin({
    tracks: [{ id: 't1', slug: 'demo-01', ratingSum: 0, ratingCount: 0 }],
    profiles: [{ id: 'p1' }, { id: 'p2' }],
    ratings: [],
  });

  it('returns null for an unknown slug', async () => {
    const db = seed();
    expect(await setRating(db, 'tracks', 'nope', 'p1', 5)).toBe(null);
  });

  it('adds a first rating: count 0→1, sum=value', async () => {
    const db = seed();
    const out = await setRating(db, 'tracks', 'demo-01', 'p1', 4);
    expect(out).toEqual({ you: 4, avg: 4, count: 1 });
    const itemTx = db._txs.find((t) => t.ns === 'tracks');
    expect(itemTx.update).toEqual({ ratingSum: 4, ratingCount: 1 });
    const ratingTx = db._txs.find((t) => t.ns === 'ratings');
    expect(ratingTx.update).toMatchObject({ namespace: 'tracks', slug: 'demo-01', value: 4 });
    expect(ratingTx.link).toEqual({ profile: 'p1' });
  });

  it('changes an existing rating: sum adjusts, count unchanged', async () => {
    const db = fakeAdmin({
      tracks: [{ id: 't1', slug: 'demo-01', ratingSum: 4, ratingCount: 1 }],
      profiles: [{ id: 'p1' }],
      ratings: [{ id: 'r1', namespace: 'tracks', slug: 'demo-01', value: 4, profile: { id: 'p1' } }],
    });
    const out = await setRating(db, 'tracks', 'demo-01', 'p1', 2);
    expect(out).toEqual({ you: 2, avg: 2, count: 1 });
    const itemTx = db._txs.find((t) => t.ns === 'tracks');
    expect(itemTx.update).toEqual({ ratingSum: 2, ratingCount: 1 });
    const ratingTx = db._txs.find((t) => t.ns === 'ratings' && t.id === 'r1');
    expect(ratingTx.update).toMatchObject({ value: 2 });
  });

  it('clears a rating: count 1→0, sum back to 0, row deleted', async () => {
    const db = fakeAdmin({
      tracks: [{ id: 't1', slug: 'demo-01', ratingSum: 4, ratingCount: 1 }],
      profiles: [{ id: 'p1' }],
      ratings: [{ id: 'r1', namespace: 'tracks', slug: 'demo-01', value: 4, profile: { id: 'p1' } }],
    });
    const out = await setRating(db, 'tracks', 'demo-01', 'p1', null);
    expect(out).toEqual({ you: null, avg: null, count: 0 });
    const itemTx = db._txs.find((t) => t.ns === 'tracks');
    expect(itemTx.update).toEqual({ ratingSum: 0, ratingCount: 0 });
    const ratingTx = db._txs.find((t) => t.ns === 'ratings' && t.id === 'r1');
    expect(ratingTx.delete).toBe(true);
  });

  it('aggregates two distinct users', async () => {
    const db = fakeAdmin({
      tracks: [{ id: 't1', slug: 'demo-01', ratingSum: 5, ratingCount: 1 }],
      profiles: [{ id: 'p1' }, { id: 'p2' }],
      ratings: [{ id: 'r1', namespace: 'tracks', slug: 'demo-01', value: 5, profile: { id: 'p2' } }],
    });
    const out = await setRating(db, 'tracks', 'demo-01', 'p1', 4);
    expect(out).toEqual({ you: 4, avg: 4.5, count: 2 });
    const itemTx = db._txs.find((t) => t.ns === 'tracks');
    expect(itemTx.update).toEqual({ ratingSum: 9, ratingCount: 2 });
  });
});

describe('itemOwnerProfileId', () => {
  it('unwraps the has-one author list', async () => {
    const db = fakeAdmin({ tracks: [{ id: 't1', slug: 'demo-01', author: [{ id: 'p1' }] }] });
    expect(await itemOwnerProfileId(db, 'tracks', 'demo-01')).toBe('p1');
  });
  it('returns null when unowned', async () => {
    const db = fakeAdmin({ tracks: [{ id: 't1', slug: 'demo-01' }] });
    expect(await itemOwnerProfileId(db, 'tracks', 'demo-01')).toBe(null);
  });
  it('returns null for a missing item', async () => {
    const db = fakeAdmin({ tracks: [] });
    expect(await itemOwnerProfileId(db, 'tracks', 'nope')).toBe(null);
  });
});

describe('setNotes', () => {
  it('patches only the provided keys and echoes merged values', async () => {
    const db = fakeAdmin({ tracks: [{ id: 't1', slug: 'demo-01', notes: 'old', lesson: 'keep' }] });
    const out = await setNotes(db, 'tracks', 'demo-01', { notes: 'new' });
    expect(out).toEqual({ notes: 'new', lesson: 'keep' });
    const tx = db._txs.find((t) => t.ns === 'tracks');
    expect(tx.update).toEqual({ notes: 'new' });
  });
  it('returns null for a missing item', async () => {
    const db = fakeAdmin({ tracks: [] });
    expect(await setNotes(db, 'tracks', 'nope', { notes: 'x' })).toBe(null);
  });
});
