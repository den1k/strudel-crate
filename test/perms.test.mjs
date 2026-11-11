// test/perms.test.mjs — pins rules that close holes found against a live Instant app.
import { describe, it, expect } from 'vitest';
import rules from '../instant.perms.ts';

describe('instant.perms', () => {
  it('refuses guest accounts: requireUser lets any account rate, so free guests could stuff ratings', () => {
    expect(rules.$users?.allow).toEqual({ create: 'data.email != null' });
  });

  it('keeps every client write closed (all writes go through the server)', () => {
    for (const ns of ['plays', 'stems', 'tracks', 'ratings', 'lessons', 'profiles']) {
      expect(rules[ns].allow).toMatchObject({ create: 'false', update: 'false', delete: 'false' });
    }
    expect(rules.attrs.allow.create).toBe('false');
  });
});
