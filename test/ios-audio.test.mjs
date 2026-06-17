import { describe, it, expect } from 'vitest';
import { enableSilentSwitchPlayback } from '../src/ios-audio.js';

// A throwaway document stub: records listeners and lets a test fire a gesture.
function fakeDoc() {
  const handlers = {};
  return {
    handlers,
    addEventListener: (ev, fn) => ((handlers[ev] ??= []).push(fn)),
    removeEventListener: (ev, fn) => (handlers[ev] = (handlers[ev] ?? []).filter((h) => h !== fn)),
    fire: (ev) => (handlers[ev] ?? []).slice().forEach((fn) => fn()),
  };
}

const fakeAudio = (onPlay = () => {}) => ({
  play: () => {
    onPlay();
    return Promise.resolve();
  },
  setAttribute: () => {},
});

describe('enableSilentSwitchPlayback', () => {
  it('sets navigator.audioSession.type to "playback" when supported (iOS 16.4+)', () => {
    const nav = { audioSession: { type: 'auto' } };
    enableSilentSwitchPlayback({ doc: fakeDoc(), nav, makeAudio: () => fakeAudio() });
    expect(nav.audioSession.type).toBe('playback');
  });

  it('plays a silent media element on the first user gesture (older iOS fallback)', () => {
    let played = 0;
    const doc = fakeDoc();
    enableSilentSwitchPlayback({ doc, nav: {}, makeAudio: () => fakeAudio(() => played++) });
    expect(played).toBe(0); // nothing until the user interacts
    doc.fire('pointerdown');
    expect(played).toBe(1);
  });

  it('unlocks only once across repeated gestures', () => {
    let played = 0;
    const doc = fakeDoc();
    enableSilentSwitchPlayback({ doc, nav: {}, makeAudio: () => fakeAudio(() => played++) });
    doc.fire('pointerdown');
    doc.fire('click');
    doc.fire('touchend');
    expect(played).toBe(1);
  });

  it('does not throw when audioSession is unsupported', () => {
    expect(() =>
      enableSilentSwitchPlayback({ doc: fakeDoc(), nav: {}, makeAudio: () => fakeAudio() }),
    ).not.toThrow();
  });

  it('swallows a rejected play() promise (autoplay blocked) without throwing', async () => {
    const doc = fakeDoc();
    enableSilentSwitchPlayback({
      doc,
      nav: {},
      makeAudio: () => ({ play: () => Promise.reject(new Error('blocked')), setAttribute: () => {} }),
    });
    expect(() => doc.fire('pointerdown')).not.toThrow();
    await Promise.resolve();
  });
});
