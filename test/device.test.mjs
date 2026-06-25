import { describe, it, expect, afterEach } from 'vitest';
import { isDesktop } from '../src/device.js';

afterEach(() => { delete globalThis.matchMedia; });

describe('isDesktop', () => {
  it('is true when the desktop media query matches', () => {
    globalThis.matchMedia = (q) => ({ matches: q.includes('pointer: fine') });
    expect(isDesktop()).toBe(true);
  });
  it('is false when the query does not match', () => {
    globalThis.matchMedia = () => ({ matches: false });
    expect(isDesktop()).toBe(false);
  });
  it('is false when matchMedia is unavailable', () => {
    expect(isDesktop()).toBe(false);
  });
});
