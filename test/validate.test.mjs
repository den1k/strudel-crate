import { describe, it, expect } from 'vitest';
import { validateCode } from '../scripts/validate.mjs';

describe('validateCode', () => {
  it('accepts valid strudel code and counts events', async () => {
    const result = await validateCode('note("c3 e3 g3").s("sawtooth").lpf(800)');
    expect(result.ok).toBe(true);
    expect(result.events).toBeGreaterThan(0);
  });

  it('accepts multi-statement code with setcpm and stack', async () => {
    const code = 'setcpm(120/4)\nstack(s("bd*4"), note("c2 g1").s("sawtooth"))';
    const result = await validateCode(code);
    expect(result.ok).toBe(true);
  });

  it('rejects code with syntax errors', async () => {
    const result = await validateCode('note("c3 e3"');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/evaluation failed/);
  });

  it('rejects code that references undefined functions', async () => {
    const result = await validateCode('definitelyNotAFunction("c3")');
    expect(result.ok).toBe(false);
  });

  it('rejects patterns that produce no events', async () => {
    const result = await validateCode('silence');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no events/);
  });

  it('rejects code that does not evaluate to a Pattern', async () => {
    const result = await validateCode('1 + 1');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/did not evaluate to a Pattern/);
  });
});
