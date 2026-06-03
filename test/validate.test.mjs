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

  it('rejects sounds the webapp does not load', async () => {
    const result = await validateCode('s("definitelynotasound*4")');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unknown sounds/);
  });

  it('accepts drum-machine bank sounds', async () => {
    const result = await validateCode('s("bd*4, ~ sd").bank("RolandTR909")');
    expect(result.ok).toBe(true);
  });

  it('rejects unknown sounds that first appear after cycle 8 (full-arrangement scan)', async () => {
    const code = 'arrange([8, s("bd*4")], [8, s("definitelynotasound*4")])';
    const result = await validateCode(code);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unknown sounds/);
  });
});
