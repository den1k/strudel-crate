import { describe, it, expect } from 'vitest';
import { groupVersions } from '../src/versions.js';

const stem = (id, extra = {}) => ({
  id, batch: 'b', title: id, prompt: 'p',
  createdAt: '2026-06-08T00:00:00Z', code: 's("bd")', meta: {}, ...extra,
});

describe('groupVersions', () => {
  it('makes each standalone stem its own single-version family', () => {
    const fams = groupVersions([stem('a'), stem('b')]);
    expect(fams.map((f) => f.family)).toEqual(['a', 'b']);
    expect(fams[0].versions).toHaveLength(1);
    expect(fams[0].versions[0].version).toBe(1);
    expect(fams[0].latest.id).toBe('a');
  });

  it('groups a root with its versionOf children into one family', () => {
    const root = stem('a', { createdAt: '2026-06-08T00:00:00Z' });
    const v2 = stem('a-v2', { versionOf: 'a', createdAt: '2026-06-08T01:00:00Z' });
    const fams = groupVersions([root, v2]);
    expect(fams).toHaveLength(1);
    expect(fams[0].family).toBe('a');
    expect(fams[0].versions.map((v) => v.id)).toEqual(['a', 'a-v2']);
    expect(fams[0].versions.map((v) => v.version)).toEqual([1, 2]);
    expect(fams[0].latest.id).toBe('a-v2');
  });

  it('orders versions by createdAt regardless of input order', () => {
    const v2 = stem('a-v2', { versionOf: 'a', createdAt: '2026-06-08T02:00:00Z' });
    const root = stem('a', { createdAt: '2026-06-08T00:00:00Z' });
    const fams = groupVersions([v2, root]); // child first
    expect(fams[0].versions.map((v) => v.id)).toEqual(['a', 'a-v2']);
    expect(fams[0].latest.id).toBe('a-v2');
  });

  it('preserves first-occurrence order across families', () => {
    const fams = groupVersions([stem('b'), stem('a'), stem('b-v2', { versionOf: 'b' })]);
    expect(fams.map((f) => f.family)).toEqual(['b', 'a']);
  });

  it('forms a family from an orphan version whose root is absent', () => {
    const fams = groupVersions([stem('x-v2', { versionOf: 'x' })]);
    expect(fams).toHaveLength(1);
    expect(fams[0].family).toBe('x');
    expect(fams[0].versions[0].version).toBe(1);
    expect(fams[0].latest.id).toBe('x-v2');
  });
});
