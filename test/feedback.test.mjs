import { describe, it, expect } from 'vitest';
import { buildDigest } from '../scripts/feedback.mjs';

const track = (id, rating, notes, code = `code-${id}`, lesson = '') => ({
  id, title: `Title ${id}`, prompt: 'p', batch: 'b', code,
  createdAt: 'x', rating, notes, lesson,
});

describe('buildDigest', () => {
  it('says so when nothing is rated', () => {
    const digest = buildDigest([track('a', null, '')]);
    expect(digest).toMatch(/no ratings yet/i);
  });

  it('includes code of top-rated tracks; track notes never appear', () => {
    const digest = buildDigest([
      track('hi', 5, 'love the bass', 'TOP_CODE'),
      track('lo', 1, 'too harsh', 'LOW_CODE'),
      track('mid', null, ''),
    ]);
    expect(digest).toContain('TOP_CODE');
    expect(digest).not.toContain('love the bass');
    expect(digest).not.toContain('too harsh');
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
    ]);
    expect(digest).toContain('— techno · 130bpm');
  });

  it('handles meta with only one of genre/bpm', () => {
    const digest = buildDigest([
      { ...track('g', 5, ''), meta: { genre: 'techno' } },
      { ...track('b', 4, ''), meta: { bpm: 140 } },
    ]);
    expect(digest).toContain('— techno');
    expect(digest).toContain('— 140bpm');
  });

  it('lists lessons from any track regardless of rating', () => {
    const digest = buildDigest([
      track('a', 3, 'mid note', 'CODE_A', 'keep drums under the synths'),
      track('b', null, '', 'CODE_B', 'shorter intros'),
    ]);
    expect(digest).toContain('## Lessons for all future tracks');
    expect(digest).toContain('- keep drums under the synths (from "Title a")');
    expect(digest).toContain('- shorter intros (from "Title b")');
    expect(digest).not.toContain('mid note');
  });

  it('is non-empty when there are lessons but zero ratings', () => {
    const digest = buildDigest([track('a', null, '', 'C', 'use more swing')]);
    expect(digest).not.toMatch(/no ratings yet/i);
    expect(digest).toContain('use more swing');
  });

  it('omits the lessons section when no lessons exist', () => {
    const digest = buildDigest([track('hi', 5, '')]);
    expect(digest).not.toContain('## Lessons for all future tracks');
  });
});
