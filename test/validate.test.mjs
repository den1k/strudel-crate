import { describe, it, expect } from 'vitest';
import { validateCode, validateTrack, characterCheck, isTrackPath } from '../scripts/validate.mjs';

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

describe('characterCheck', () => {
  it('detects a 4+ note chord as harmonic', () => {
    expect(characterCheck('note("[c3,e3,g3,b3]")').present).toContain('harmonic');
  });

  it('detects a characterful mode as harmonic', () => {
    expect(characterCheck('n("0 2 4").scale("C3:dorian")').present).toContain('harmonic');
  });

  it('detects a 4-entry progression as harmonic', () => {
    expect(characterCheck('note("<c2 eb2 f1 g1>")').present).toContain('harmonic');
  });

  it('does NOT count a bare triad in plain minor as harmonic', () => {
    const c = characterCheck('note("[c3,e3,g3]").s("piano")\nn("0 2 4").scale("C3:minor")');
    expect(c.present).not.toContain('harmonic');
  });

  it('detects euclid as rhythmic', () => {
    expect(characterCheck('s("bd(3,8)").bank("RolandTR909")').present).toContain('rhythmic');
  });

  it('detects swing as rhythmic', () => {
    expect(characterCheck('s("hh*8").swingBy(0.1, 8)').present).toContain('rhythmic');
  });

  it('detects an odd repeat multiple as rhythmic', () => {
    expect(characterCheck('s("hh*3")').present).toContain('rhythmic');
  });

  it('does NOT count even multiples or .range as rhythmic', () => {
    const c = characterCheck('s("hh*8").lpf(sine.slow(8).range(200, 2000))');
    expect(c.present).not.toContain('rhythmic');
  });

  it('detects dirt effects as timbral', () => {
    expect(characterCheck('s("bd*4").crush(6)').present).toContain('timbral');
    expect(characterCheck('note("c3").s("sawtooth").vowel("a")').present).toContain('timbral');
    expect(characterCheck('s("arpy").speed(2)').present).toContain('timbral');
  });

  it('does NOT count plain filter/space or .speed(1) as timbral', () => {
    const c = characterCheck('note("c3").lpf(800).hpf(200).room(0.4).delay(0.3).speed(1)');
    expect(c.present).not.toContain('timbral');
    expect(characterCheck('s("arpy").speed( 1 )').present).not.toContain('timbral');
    expect(characterCheck('s("arpy").speed(1.0)').present).not.toContain('timbral');
  });

  it('detects pattern transforms', () => {
    expect(characterCheck('s("bd*4").every(4, x => x.rev())').present).toContain('transform');
    expect(characterCheck('s("bd*4").off(0.125, x => x.gain(0.5))').present).toContain('transform');
  });

  it('passes a rich track (4 of 4) and fails a generic one (1 of 4)', () => {
    const rich = 'note("[c3,eb3,g3,bb3]").s("sawtooth").crush(6)\ns("bd(3,8)").bank("RolandTR909").every(4, x => x.fast(2))';
    const richResult = characterCheck(rich);
    expect(richResult.ok).toBe(true);
    expect(richResult.present.length).toBe(4);

    const generic = 'note("<[c3,eb3,g3] [ab2,c3,eb3]>").s("piano").lpf(sine.slow(8).range(400,1200)).room(0.4)\ns("bd ~ ~ ~ sd ~ ~ ~").bank("CasioRZ1")\ns("hh*8").bank("CasioRZ1").degradeBy(0.2)';
    const genericResult = characterCheck(generic);
    expect(genericResult.ok).toBe(false);
    expect(genericResult.missing).toEqual(expect.arrayContaining(['harmonic', 'rhythmic', 'timbral']));
    expect(genericResult.present).toEqual(['transform']);
  });

  it('treats >=3 categories as the pass threshold', () => {
    // harmonic + rhythmic + transform, no timbral = 3/4 -> ok
    const three = characterCheck('note("[c3,e3,g3,b3]")\ns("bd(3,8)").every(4, x => x.rev())');
    expect(three.present.length).toBe(3);
    expect(three.ok).toBe(true);
    // harmonic + rhythmic only = 2/4 -> not ok
    const two = characterCheck('note("[c3,e3,g3,b3]")\ns("bd(3,8)")');
    expect(two.present.length).toBe(2);
    expect(two.ok).toBe(false);
  });
});

describe('character gate wiring', () => {
  const genericTrack = () => ({
    id: 't', title: 'T', prompt: 'p', batch: 'b',
    description: 'A plain triad sketch under a filter sweep.',
    meta: { bpm: 120, genre: 'techno', mood: 'flat', key: 'C minor', instruments: ['piano'], energy: 3 },
    code: 'setcpm(120/4)\nstack(note("<[c3,eb3,g3] [ab2,c3,eb3]>").s("piano").lpf(sine.slow(8).range(400,1200)).room(0.4), s("bd ~ ~ ~ sd ~ ~ ~").bank("CasioRZ1"), s("hh*8").bank("CasioRZ1").degradeBy(0.2))',
    createdAt: 'x',
  });
  const richTrack = () => {
    const t = genericTrack();
    t.code = 'setcpm(120/4)\nstack(note("[c3,eb3,g3,bb3]").s("sawtooth").crush(6), s("bd(3,8)").bank("RolandTR909"), s("hh*8").bank("RolandTR909").every(4, x => x.fast(2)))';
    return t;
  };

  it('does NOT gate by default (existing behavior preserved)', async () => {
    expect((await validateTrack(genericTrack())).ok).toBe(true);
  });

  it('gates the generic track when character:true', async () => {
    const result = await validateTrack(genericTrack(), { character: true });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/lacks character/);
  });

  it('passes a rich track when character:true', async () => {
    expect((await validateTrack(richTrack(), { character: true })).ok).toBe(true);
  });

  it('still reports a playability error before the character error', async () => {
    const t = genericTrack();
    t.code = 'note("c3 e3"';  // syntax error
    const result = await validateTrack(t, { character: true });
    expect(result.error).toMatch(/evaluation failed/);
  });
});

describe('isTrackPath', () => {
  it('is true for files under tracks/', () => {
    expect(isTrackPath('tracks/2026-06-15-foo-01.json')).toBe(true);
    expect(isTrackPath('/abs/path/tracks/x.json')).toBe(true);
  });
  it('is false for stems and other paths', () => {
    expect(isTrackPath('stems/2026-06-15-foo-01.json')).toBe(false);
    expect(isTrackPath('/abs/path/stems/x.json')).toBe(false);
    expect(isTrackPath('foo.json')).toBe(false);
  });
});
