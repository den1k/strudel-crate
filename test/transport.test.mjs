import { describe, it, expect } from 'vitest';
import {
  mmss,
  hasTimeline,
  fractionToCycle,
  progressFraction,
  readCycle,
  applySeek,
} from '../src/transport.js';

describe('mmss', () => {
  it('formats whole minutes and seconds', () => {
    expect(mmss(72)).toBe('1:12');
    expect(mmss(5)).toBe('0:05');
    expect(mmss(605)).toBe('10:05');
    expect(mmss(0)).toBe('0:00');
    expect(mmss(71.9)).toBe('1:11');
  });
  it('clamps non-finite and negative to 0:00', () => {
    expect(mmss(-3)).toBe('0:00');
    expect(mmss(NaN)).toBe('0:00');
    expect(mmss(Infinity)).toBe('0:00');
  });
});

describe('hasTimeline', () => {
  it('is true only for a finite positive total', () => {
    expect(hasTimeline({ seconds: 228 })).toBe(true);
    expect(hasTimeline({ seconds: 0 })).toBe(false);
    expect(hasTimeline({ seconds: NaN })).toBe(false);
    expect(hasTimeline(null)).toBe(false);
  });
});

describe('fractionToCycle', () => {
  it('maps a 0..1 position onto cycles, clamping the fraction', () => {
    expect(fractionToCycle(0.5, 32)).toBe(16);
    expect(fractionToCycle(1.5, 32)).toBe(32);
    expect(fractionToCycle(-1, 32)).toBe(0);
  });
});

describe('progressFraction', () => {
  it('is cycle/cycles clamped to [0,1]', () => {
    expect(progressFraction(16, 32)).toBe(0.5);
    expect(progressFraction(40, 32)).toBe(1);
    expect(progressFraction(-4, 32)).toBe(0);
  });
  it('returns 0 for a degenerate total', () => {
    expect(progressFraction(4, 0)).toBe(0);
  });
});

describe('readCycle', () => {
  it('returns the cycle of a running scheduler', () => {
    expect(readCycle({ started: true, now: () => 4.2 })).toBe(4.2);
  });
  it('returns null when stopped or unavailable', () => {
    expect(readCycle({ started: false, now: () => 4.2 })).toBe(null);
    expect(readCycle({ started: true })).toBe(null);
    expect(readCycle(null)).toBe(null);
  });
});

describe('applySeek', () => {
  it('re-anchors a Cyclist-like scheduler in place', () => {
    const s = { lastEnd: 3, num_ticks_since_cps_change: 5 };
    expect(applySeek(s, 10)).toBe(true);
    expect(s.lastEnd).toBe(10);
    expect(s.num_ticks_since_cps_change).toBe(0);
  });
  it('clamps a negative target to 0', () => {
    const s = { lastEnd: 3, num_ticks_since_cps_change: 5 };
    applySeek(s, -2);
    expect(s.lastEnd).toBe(0);
  });
  it('no-ops on a non-Cyclist scheduler', () => {
    expect(applySeek({}, 10)).toBe(false);
    expect(applySeek(null, 10)).toBe(false);
  });
});
