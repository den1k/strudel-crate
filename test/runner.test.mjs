// test/runner.test.mjs
import { describe, it, expect } from 'vitest';
import { buildArgv, collectionFor, diffNew, batchOf } from '../server/runner.mjs';

describe('collectionFor', () => {
  it('maps generate types to their dir', () => {
    expect(collectionFor('generate-stems')).toBe('stems');
    expect(collectionFor('generate-tracks')).toBe('tracks');
  });
  it('uses the prompt as the collection for revise', () => {
    expect(collectionFor('revise-from-notes', 'stems')).toBe('stems');
    expect(collectionFor('revise-from-notes', 'tracks')).toBe('tracks');
  });
});

describe('buildArgv', () => {
  it('builds a generate-stems invocation', () => {
    const argv = buildArgv({ type: 'generate-stems', prompt: 'alien pads', count: 4 });
    expect(argv[0]).toBe('-p');
    expect(argv[1]).toBe('/generate-stems "alien pads" 4');
    expect(argv).toContain('--output-format');
    expect(argv).toContain('json');
    expect(argv).toContain('--allowedTools');
  });
  it('builds a generate-tracks invocation', () => {
    const argv = buildArgv({ type: 'generate-tracks', prompt: 'dark techno', count: 12 });
    expect(argv[1]).toBe('/generate-tracks "dark techno" 12');
  });
  it('builds a revise invocation with the collection arg', () => {
    const argv = buildArgv({ type: 'revise-from-notes', prompt: 'stems' });
    expect(argv[1]).toBe('/revise-from-notes stems');
  });
});

describe('diffNew', () => {
  it('returns ids present in after but not before, sorted', () => {
    const before = new Set(['a', 'b']);
    const after = new Set(['b', 'c', 'a', 'd']);
    expect(diffNew(before, after)).toEqual(['c', 'd']);
  });
});

describe('batchOf', () => {
  it('strips the trailing -NN to find the shared batch', () => {
    expect(batchOf(['2026-06-15-pads-01', '2026-06-15-pads-02'])).toBe('2026-06-15-pads');
  });
  it('returns null when ids do not share a batch', () => {
    expect(batchOf(['2026-06-15-pads-01', '2026-06-15-bass-01'])).toBeNull();
  });
  it('returns null for an empty list', () => {
    expect(batchOf([])).toBeNull();
  });
});
