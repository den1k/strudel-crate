import { describe, it, expect } from 'vitest';
import { buildDigest } from '../scripts/feedback.mjs';

// buildDigest now consumes first-class lesson records:
//   { text, target, song: { namespace, slug, title } | null }
const lesson = (text, song = null) => ({ text, target: 'tracks', song });

describe('buildDigest', () => {
  it('says so when there are no lessons', () => {
    expect(buildDigest([])).toMatch(/no lessons yet/i);
  });

  it('ignores empty / whitespace-only lessons', () => {
    expect(buildDigest([lesson(''), lesson('   ')])).toMatch(/no lessons yet/i);
    expect(buildDigest([lesson('   ')])).not.toContain('## Lessons');
  });

  it('lists lessons with a header', () => {
    const digest = buildDigest([lesson('keep drums under the synths'), lesson('shorter intros')]);
    expect(digest).toContain('## Lessons for all future tracks');
    expect(digest).toContain('- keep drums under the synths');
    expect(digest).toContain('- shorter intros');
  });

  it('adds a provenance suffix only when the lesson came from a song', () => {
    const digest = buildDigest([
      lesson('use more swing', { namespace: 'tracks', slug: 's1', title: 'Boiler Primer' }),
      lesson('warmer pads'), // standalone — no suffix
    ]);
    expect(digest).toContain('- use more swing (from "Boiler Primer")');
    expect(digest).toContain('- warmer pads');
    expect(digest).not.toContain('warmer pads (from');
  });

  it('trims lesson text', () => {
    expect(buildDigest([lesson('  trimmed  ')])).toContain('- trimmed');
  });
});
