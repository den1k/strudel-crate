import { describe, it, expect } from 'vitest';
import { nextRemixId } from '../scripts/remix-source.mjs';

describe('nextRemixId', () => {
  it('picks 01 when none exist', () => {
    expect(nextRemixId('demo-01', ['demo-01'])).toBe('demo-01-remix-01');
  });
  it('skips taken numbers', () => {
    expect(nextRemixId('demo-01', ['demo-01', 'demo-01-remix-01', 'demo-01-remix-02'])).toBe('demo-01-remix-03');
  });
});
