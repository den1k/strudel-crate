import { describe, it, expect } from 'vitest';
import { validateCode, validateTrack } from '../scripts/validate.mjs';

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

describe('validateTrack', () => {
  const goodTrack = () => ({
    id: 't', title: 'T', prompt: 'p', batch: 'b',
    description: 'A driving little techno sketch.',
    meta: { bpm: 120, genre: 'techno', mood: 'dark', key: 'C minor', instruments: ['RolandTR909 kit'], energy: 3 },
    code: 'setcpm(120/4)\ns("bd*4").bank("RolandTR909")',
    createdAt: 'x',
  });

  it('accepts a fully-specified track', async () => {
    const result = await validateTrack(goodTrack());
    expect(result.ok).toBe(true);
  });

  it('rejects a missing description', async () => {
    const t = goodTrack();
    delete t.description;
    const result = await validateTrack(t);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/description/);
  });

  it('rejects missing meta', async () => {
    const t = goodTrack();
    delete t.meta;
    expect((await validateTrack(t)).error).toMatch(/meta/);
  });

  it('rejects bpm that contradicts setcpm', async () => {
    const t = goodTrack();
    t.meta.bpm = 95;
    const result = await validateTrack(t);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not match/);
  });

  it('requires bpm 120 when code has no setcpm', async () => {
    const t = goodTrack();
    t.code = 's("bd*4").bank("RolandTR909")';
    t.meta.bpm = 128;
    expect((await validateTrack(t)).error).toMatch(/does not match/);
    t.meta.bpm = 120;
    expect((await validateTrack(t)).ok).toBe(true);
  });

  it('reads setcpm(N) as N cycles per minute (bpm = 4N)', async () => {
    const t = goodTrack();
    t.code = 'setcpm(30)\ns("bd*4").bank("RolandTR909")';
    t.meta.bpm = 120;
    expect((await validateTrack(t)).ok).toBe(true);
  });

  it('rejects bad energy and bad instruments', async () => {
    const t1 = goodTrack();
    t1.meta.energy = 7;
    expect((await validateTrack(t1)).error).toMatch(/energy/);
    const t2 = goodTrack();
    t2.meta.instruments = [];
    expect((await validateTrack(t2)).error).toMatch(/instruments/);
  });

  it('rejects whitespace-only description', async () => {
    const t = goodTrack();
    t.description = '   ';
    expect((await validateTrack(t)).error).toMatch(/description/);
  });

  it('rejects meta missing an individual string field', async () => {
    const t = goodTrack();
    delete t.meta.genre;
    expect((await validateTrack(t)).error).toMatch(/genre/);
  });
});
