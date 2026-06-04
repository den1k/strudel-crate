import { describe, it, expect } from 'vitest';
import { nextPlayingId } from '../src/playing-state.js';

describe('nextPlayingId', () => {
  it('sets the track id when a track starts', () => {
    expect(nextPlayingId(null, 'a', true)).toBe('a');
  });

  it('replaces the current track when another starts', () => {
    expect(nextPlayingId('a', 'b', true)).toBe('b');
  });

  it('clears when the playing track stops', () => {
    expect(nextPlayingId('a', 'a', false)).toBe(null);
  });

  it('ignores a stale stop from a replaced track (new start arrived first)', () => {
    // user switched a -> b; b's start event landed, then a's solo-stop lands late
    expect(nextPlayingId('b', 'a', false)).toBe('b');
  });

  it('stays null when a stop arrives with nothing playing', () => {
    expect(nextPlayingId(null, 'a', false)).toBe(null);
  });
});
