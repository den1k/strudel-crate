// Audit units deferred from run-1, established and fixed in round 2.
import { describe, it, expect } from 'vitest';
import { fakeAdmin } from './fake-admin.mjs';
import { ensureProfile, resolvePublicItem, setNotes, setRating } from '../server/instant.mjs';
import { injectMeta } from '../server/og.mjs';
import { cacheBank } from '../scripts/lib/sample-cache.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('song-linked lesson on an unowned song', () => {
  const seed = () => fakeAdmin({
    tracks: [{ id: 'e1', slug: 's', notes: '', lessonRecord: [{ id: 'l1', text: 'private', profile: [{ id: 'a' }] }] }],
    lessons: [],
  });
  it('another caller can neither read nor overwrite it', async () => {
    const admin = seed();
    const res = await setNotes(admin, 'tracks', 's', { lesson: 'mine now' }, 'b');
    expect(res.lesson).not.toBe('private');
    expect(admin._txs.some((t) => t.ns === 'lessons' && t.id === 'l1')).toBe(false);
  });
  it('another caller can\'t delete it', async () => {
    const admin = seed();
    await setNotes(admin, 'tracks', 's', { lesson: '' }, 'b');
    expect(admin._txs.some((t) => t.id === 'l1' && t.delete)).toBe(false);
  });
  it('its owner still can', async () => {
    const admin = seed();
    const res = await setNotes(admin, 'tracks', 's', { lesson: 'edited' }, 'a');
    expect(res.lesson).toBe('edited');
    expect(admin._txs.some((t) => t.id === 'l1')).toBe(true);
  });
});

describe('resolvePublicItem', () => {
  it('does not resolve a private row for anonymous OG tags and cards', async () => {
    const admin = fakeAdmin({ tracks: [{ id: 'e1', slug: 's', isPublic: false, title: 'hidden' }], stems: [] });
    expect(await resolvePublicItem(admin, ['tracks', 'stems'], 's')).toBeNull();
    expect(await resolvePublicItem(admin, ['tracks', 'stems'], 'e1')).toBeNull();
  });
  it('still resolves public rows and legacy rows without the field', async () => {
    const admin = fakeAdmin({ tracks: [{ id: 'e1', slug: 's', isPublic: true, title: 'a' }, { id: 'e2', slug: 't', title: 'b' }], stems: [] });
    expect((await resolvePublicItem(admin, ['tracks'], 's')).item.title).toBe('a');
    expect((await resolvePublicItem(admin, ['tracks'], 't')).item.title).toBe('b');
  });
});

describe('setRating under concurrency', () => {
  it('serializes per item so aggregates can\'t drift', async () => {
    const admin = fakeAdmin({ tracks: [{ id: 'e1', slug: 's', ratingSum: 0, ratingCount: 0 }], ratings: [] });
    const realQuery = admin.query.bind(admin);
    const realTransact = admin.transact.bind(admin);
    let open = 0; let maxOpen = 0;
    admin.query = async (q) => { if (q.tracks) { open += 1; maxOpen = Math.max(maxOpen, open); } await new Promise((r) => { setTimeout(r, 5); }); return realQuery(q); };
    admin.transact = async (t) => { await realTransact(t); open -= 1; };
    await Promise.all([setRating(admin, 'tracks', 's', 'p1', 3), setRating(admin, 'tracks', 's', 'p2', 5)]);
    expect(maxOpen).toBe(1);
  });
  it('a failed rating doesn\'t wedge the item', async () => {
    const admin = fakeAdmin({ tracks: [{ id: 'e1', slug: 's' }], ratings: [] });
    const realTransact = admin.transact.bind(admin);
    admin.transact = async () => { throw new Error('boom'); };
    await expect(setRating(admin, 'tracks', 's', 'p', 3)).rejects.toThrow('boom');
    admin.transact = realTransact;
    expect((await setRating(admin, 'tracks', 's', 'p', 3)).you).toBe(3);
  });
});

describe('default artist name', () => {
  it('does not publish the email local part', async () => {
    const admin = fakeAdmin({ profiles: [] });
    await ensureProfile(admin, { id: 'u', email: 'private.person@mail.test' });
    const op = admin._txs.find((t) => t.ns === 'profiles');
    expect(op.update.artistName).not.toContain('private');
  });
});

describe('injectMeta', () => {
  it('treats replacement text literally', () => {
    expect(injectMeta('<a><!--OG--></a>', "x$`y")).toBe("<a>x$`y</a>");
    expect(injectMeta('<head></head>', "x$`y")).toContain("x$`y");
  });
});

describe('cacheBank size bounds', () => {
  const big = (bytes) => async (url) => {
    if (url.endsWith('strudel.json')) {
      return new Response(JSON.stringify({ _base: 'https://raw.githubusercontent.com/a/b/main/', bd: ['bd.wav'] }));
    }
    return new Response(new Uint8Array(bytes));
  };
  it('refuses an oversized sample', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'crate-bank-'));
    const r = await cacheBank('github:a/b', { fetchImpl: big(1024), cacheDir, maxFileBytes: 512 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/too large/);
    await rm(cacheDir, { recursive: true });
  });
});
