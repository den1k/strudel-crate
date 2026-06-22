import { describe, it, expect } from 'vitest';
import { createPlayLimiter } from '../server/rate-limit.mjs';

describe('createPlayLimiter', () => {
  it('allows the first play of a song from an ip, then blocks within the cooldown', () => {
    let t = 1000;
    const allow = createPlayLimiter({ cooldownMs: 5000, perIpPerMin: 100, now: () => t });
    expect(allow('1.1.1.1', 'tracks', 's-01')).toBe(true);
    t = 2000; // 1s later — still within cooldown
    expect(allow('1.1.1.1', 'tracks', 's-01')).toBe(false);
  });

  it('allows the same song again once the cooldown elapses', () => {
    let t = 1000;
    const allow = createPlayLimiter({ cooldownMs: 5000, perIpPerMin: 100, now: () => t });
    expect(allow('1.1.1.1', 'tracks', 's-01')).toBe(true);
    t = 6001; // > cooldown
    expect(allow('1.1.1.1', 'tracks', 's-01')).toBe(true);
  });

  it('scopes the cooldown by namespace + slug (a different song is independent)', () => {
    let t = 1000;
    const allow = createPlayLimiter({ cooldownMs: 5000, perIpPerMin: 100, now: () => t });
    expect(allow('1.1.1.1', 'tracks', 's-01')).toBe(true);
    expect(allow('1.1.1.1', 'tracks', 's-02')).toBe(true); // different slug
    expect(allow('1.1.1.1', 'stems', 's-01')).toBe(true);  // different namespace, same slug
  });

  it('caps total plays per ip per minute (across different songs)', () => {
    let t = 1000;
    const allow = createPlayLimiter({ cooldownMs: 0, perIpPerMin: 3, now: () => t });
    expect(allow('9.9.9.9', 'tracks', 'a')).toBe(true);
    expect(allow('9.9.9.9', 'tracks', 'b')).toBe(true);
    expect(allow('9.9.9.9', 'tracks', 'c')).toBe(true);
    expect(allow('9.9.9.9', 'tracks', 'd')).toBe(false); // 4th within the minute
    t = 61001; // window rolls over
    expect(allow('9.9.9.9', 'tracks', 'e')).toBe(true);
  });

  it('tracks ips independently', () => {
    let t = 1000;
    const allow = createPlayLimiter({ cooldownMs: 5000, perIpPerMin: 100, now: () => t });
    expect(allow('1.1.1.1', 'tracks', 's-01')).toBe(true);
    expect(allow('2.2.2.2', 'tracks', 's-01')).toBe(true); // different ip, same song
  });

  it('treats a missing ip as a single anonymous bucket without throwing', () => {
    let t = 1000;
    const allow = createPlayLimiter({ cooldownMs: 5000, perIpPerMin: 100, now: () => t });
    expect(allow(undefined, 'tracks', 's-01')).toBe(true);
    t = 2000;
    expect(allow(undefined, 'tracks', 's-01')).toBe(false);
  });
});
