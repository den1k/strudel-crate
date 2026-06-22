import { describe, it, expect } from 'vitest';
import { planRatingMigration } from '../src/ratings-migrate.js';

describe('planRatingMigration', () => {
  it('creates a per-user row + aggregate for an owned rated item', () => {
    const { creates, patches } = planRatingMigration([
      { slug: 'a', rating: 5, authorProfileId: 'p1', createdAt: '2026-01-01T00:00:00Z' },
    ]);
    expect(creates).toEqual([{ slug: 'a', value: 5, profileId: 'p1', updatedAt: '2026-01-01T00:00:00Z' }]);
    expect(patches).toEqual([{ slug: 'a', ratingSum: 5, ratingCount: 1 }]);
  });
  it('seeds aggregate but no row for an unowned rated item', () => {
    const { creates, patches } = planRatingMigration([
      { slug: 'b', rating: 3, authorProfileId: null, createdAt: 'x' },
    ]);
    expect(creates).toEqual([]);
    expect(patches).toEqual([{ slug: 'b', ratingSum: 3, ratingCount: 1 }]);
  });
  it('ignores unrated items', () => {
    const { creates, patches } = planRatingMigration([{ slug: 'c', rating: null, authorProfileId: 'p1' }]);
    expect(creates).toEqual([]);
    expect(patches).toEqual([]);
  });
});
