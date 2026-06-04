import { describe, it, expect } from 'vitest';
import { buildDigest } from '../scripts/feedback.mjs';

const track = (id, rating, notes, code = `code-${id}`) => ({
  id, title: `Title ${id}`, prompt: 'p', batch: 'b', code,
  createdAt: 'x', rating, notes,
});

describe('buildDigest', () => {
  it('says so when nothing is rated', () => {
    const digest = buildDigest([track('a', null, '')]);
    expect(digest).toMatch(/no ratings yet/i);
  });

  it('includes code of top-rated tracks and notes of low-rated ones', () => {
    const digest = buildDigest([
      track('hi', 5, 'love the bass', 'TOP_CODE'),
      track('lo', 1, 'too harsh', 'LOW_CODE'),
      track('mid', null, ''),
    ]);
    expect(digest).toContain('TOP_CODE');
    expect(digest).toContain('love the bass');
    expect(digest).toContain('too harsh');
    expect(digest).not.toContain('LOW_CODE');
    expect(digest).toMatch(/1 unrated/);
  });

  it('caps top tracks at 5', () => {
    const tracks = Array.from({ length: 8 }, (_, i) => track(`t${i}`, 5, '', `CODE${i}`));
    const digest = buildDigest(tracks);
    expect((digest.match(/CODE\d/g) ?? []).length).toBe(5);
  });

  it('appends genre and bpm when meta is present', () => {
    const digest = buildDigest([
      { ...track('hi', 5, ''), meta: { genre: 'techno', bpm: 130 } },
      { ...track('lo', 1, 'meh'), meta: { genre: 'house', bpm: 100 } },
    ]);
    expect(digest).toContain('— techno · 130bpm');
    expect(digest).toContain('— house · 100bpm');
  });
});
