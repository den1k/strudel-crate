import { describe, it, expect } from 'vitest';
import { fakeAdmin } from './fake-admin.mjs';

describe('fakeAdmin nested where', () => {
  it('filters by a two-level nested key (profile.id)', async () => {
    const db = fakeAdmin({
      plays: [
        { id: 'pl1', slug: 'a', profile: { id: 'p1' } },
        { id: 'pl2', slug: 'b', profile: { id: 'p2' } },
      ],
    });
    const res = await db.query({ plays: { $: { where: { 'profile.id': 'p1' } } } });
    expect(res.plays.map((r) => r.id)).toEqual(['pl1']);
  });

  it('still filters by user.id', async () => {
    const db = fakeAdmin({
      profiles: [
        { id: 'p1', user: { id: 'u1' } },
        { id: 'p2', user: { id: 'u2' } },
      ],
    });
    const res = await db.query({ profiles: { $: { where: { 'user.id': 'u1' } } } });
    expect(res.profiles.map((r) => r.id)).toEqual(['p1']);
  });

  it('combines a nested key with plain equality keys', async () => {
    const db = fakeAdmin({
      plays: [
        { id: 'pl1', namespace: 'tracks', slug: 'a', profile: { id: 'p1' } },
        { id: 'pl2', namespace: 'stems', slug: 'a', profile: { id: 'p1' } },
      ],
    });
    const res = await db.query({
      plays: { $: { where: { namespace: 'tracks', slug: 'a', 'profile.id': 'p1' } } },
    });
    expect(res.plays.map((r) => r.id)).toEqual(['pl1']);
  });
});
