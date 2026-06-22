import { describe, it, expect } from 'vitest';
import { aggregateAvg, isTopAggregate, myRatingOf } from '../src/ratings.js';

describe('ratings helpers', () => {
  it('aggregateAvg rounds to one decimal, null when no ratings', () => {
    expect(aggregateAvg({ ratingSum: 9, ratingCount: 2 })).toBe(4.5);
    expect(aggregateAvg({ ratingSum: 0, ratingCount: 0 })).toBe(null);
    expect(aggregateAvg({})).toBe(null);
  });
  it('isTopAggregate is true at avg >= 4 with at least one rating', () => {
    expect(isTopAggregate({ ratingSum: 8, ratingCount: 2 })).toBe(true);
    expect(isTopAggregate({ ratingSum: 7, ratingCount: 2 })).toBe(false);
    expect(isTopAggregate({ ratingSum: 0, ratingCount: 0 })).toBe(false);
  });
  it('myRatingOf reads the per-user map', () => {
    expect(myRatingOf({ myRatings: { a: 3 } }, 'a')).toBe(3);
    expect(myRatingOf({ myRatings: {} }, 'a')).toBe(null);
  });
});
