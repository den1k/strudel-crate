import { describe, it, expect } from 'vitest';
import { groupVersions, pendingRevisions } from '../src/versions.js';

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

describe('pendingRevisions', () => {
  it('selects a single-version stem whose latest has a note → -v2', () => {
    const work = pendingRevisions([
      stem('a', { title: 'Aaa', notes: 'more harmonic', code: 's("bd")', batch: 'bt', prompt: 'pr' }),
    ]);
    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({
      root: 'a', nextId: 'a-v2', version: 2,
      note: 'more harmonic', code: 's("bd")', batch: 'bt', prompt: 'pr', title: 'Aaa',
    });
  });

  it('numbers the next version off the latest and titles off the ROOT', () => {
    const work = pendingRevisions([
      stem('a', { title: 'Aaa', createdAt: '2026-06-08T00:00:00Z' }),
      stem('a-v2', { versionOf: 'a', title: 'Aaa v2', createdAt: '2026-06-08T01:00:00Z', notes: 'darker' }),
    ]);
    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({ root: 'a', nextId: 'a-v3', version: 3, note: 'darker', title: 'Aaa' });
  });

  it('ignores a note on a non-latest version', () => {
    const work = pendingRevisions([
      stem('a', { createdAt: '2026-06-08T00:00:00Z', notes: 'old note on v1' }),
      stem('a-v2', { versionOf: 'a', createdAt: '2026-06-08T01:00:00Z' }), // latest, no note
    ]);
    expect(work).toEqual([]);
  });

  it('skips whitespace-only and empty notes', () => {
    const work = pendingRevisions([
      stem('a', { notes: '   ' }),
      stem('b', { notes: '' }),
      stem('c', {}),
    ]);
    expect(work).toEqual([]);
  });

  it('trims the note in the work item', () => {
    const work = pendingRevisions([stem('a', { notes: '  punchier  ' })]);
    expect(work[0].note).toBe('punchier');
  });

  it('returns one work item per qualifying family', () => {
    const work = pendingRevisions([
      stem('a', { notes: 'x' }),
      stem('b', {}),
      stem('c', { notes: 'y' }),
    ]);
    expect(work.map((w) => w.root)).toEqual(['a', 'c']);
  });
});
