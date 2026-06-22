import { describe, it, expect } from 'vitest';
import { readViewParams, buildSearch } from '../src/view-url.js';

const PROFILE = '11111111-2222-3333-4444-555555555555'; // an author profile id
const ENTITY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; // a song entity id

describe('readViewParams', () => {
  it('parses each param', () => {
    expect(readViewParams('?batch=2026-06-16-uk-garage&filter=top&user=' + PROFILE + '&play=' + ENTITY)).toEqual({
      batch: '2026-06-16-uk-garage',
      filter: 'top',
      user: PROFILE,
      play: ENTITY,
    });
  });

  it('returns null for every absent param', () => {
    expect(readViewParams('')).toEqual({ batch: null, filter: null, user: null, play: null });
    expect(readViewParams('?')).toEqual({ batch: null, filter: null, user: null, play: null });
  });

  it('normalizes batch=all and filter=all to null', () => {
    const r = readViewParams('?batch=all&filter=all');
    expect(r.batch).toBe(null);
    expect(r.filter).toBe(null);
  });

  it('treats an invalid filter as absent', () => {
    expect(readViewParams('?filter=mine').filter).toBe(null);
    expect(readViewParams('?filter=bogus').filter).toBe(null);
  });

  it('accepts the valid filter values', () => {
    expect(readViewParams('?filter=unrated').filter).toBe('unrated');
    expect(readViewParams('?filter=top').filter).toBe('top');
  });
});

describe('buildSearch', () => {
  it('emits an empty string for a clean view', () => {
    expect(buildSearch({})).toBe('');
    expect(buildSearch({ batch: 'all', filter: 'all', user: null, play: null })).toBe('');
    expect(buildSearch()).toBe('');
  });

  it('omits defaults and nulls', () => {
    expect(buildSearch({ batch: 'all', filter: 'top', user: null, play: null })).toBe('?filter=top');
  });

  it('drops an invalid filter value', () => {
    expect(buildSearch({ filter: 'mine' })).toBe('');
  });

  it('uses a stable key order (batch, filter, user, play)', () => {
    const s = buildSearch({ play: ENTITY, user: PROFILE, filter: 'top', batch: 'b1' });
    expect(s).toBe(`?batch=b1&filter=top&user=${PROFILE}&play=${ENTITY}`);
  });
});

describe('round-trip', () => {
  it('readViewParams(buildSearch(x)) preserves non-default fields', () => {
    const x = { batch: '2026-06-16-uk-garage', filter: 'unrated', user: PROFILE, play: ENTITY };
    expect(readViewParams(buildSearch(x))).toEqual(x);
  });

  it('round-trips a partial state', () => {
    const x = { batch: null, filter: 'top', user: null, play: ENTITY };
    expect(readViewParams(buildSearch(x))).toEqual(x);
  });
});
