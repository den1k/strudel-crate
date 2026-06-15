import { describe, it, expect } from 'vitest';
import { buildDigest } from '../scripts/feedback.mjs';

const track = (id, rating, notes, code = `code-${id}`, lesson = '') => ({
  id, title: `Title ${id}`, prompt: 'p', batch: 'b', code,
  createdAt: 'x', rating, notes, lesson,
});

describe('buildDigest', () => {
  it('says so when there are no lessons', () => {
    const digest = buildDigest([track('a', null, '')]);
    expect(digest).toMatch(/no lessons yet/i);
  });

  it('never leaks per-song rating, notes, or code into the digest', () => {
    const digest = buildDigest([
      track('hi', 5, 'love the bass', 'TOP_CODE'),
      track('lo', 1, 'too harsh', 'LOW_CODE'),
      track('mid', null, ''),
    ]);
    expect(digest).toMatch(/no lessons yet/i);
    expect(digest).not.toContain('TOP_CODE');
    expect(digest).not.toContain('LOW_CODE');
    expect(digest).not.toContain('love the bass');
    expect(digest).not.toContain('too harsh');
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
    expect(digest).not.toMatch(/no lessons yet/i);
    expect(digest).toContain('use more swing');
  });

  it('a high rating alone does not produce a digest', () => {
    const digest = buildDigest([track('hi', 5, '')]);
    expect(digest).toMatch(/no lessons yet/i);
    expect(digest).not.toContain('## Lessons for all future tracks');
  });

  it('ignores whitespace-only lessons', () => {
    const digest = buildDigest([track('w', null, '', 'C', '   ')]);
    expect(digest).toMatch(/no lessons yet/i);
    expect(digest).not.toContain('## Lessons for all future tracks');
  });
});
