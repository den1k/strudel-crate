import { describe, it, expect } from 'vitest';
import { normalizeEmail } from '../src/email.js';

describe('normalizeEmail', () => {
  it('lowercases and trims a valid email', () => {
    expect(normalizeEmail('  JakeWRFoster@Gmail.com ')).toBe('jakewrfoster@gmail.com');
  });
  it('returns null for malformed input', () => {
    expect(normalizeEmail('not-an-email')).toBeNull();
    expect(normalizeEmail('a@b')).toBeNull();
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });
});
