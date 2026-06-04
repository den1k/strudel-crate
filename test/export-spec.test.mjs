import { describe, it, expect } from 'vitest';
import { parseArrangeCycles, exportSpec } from '../src/export-spec.js';

const arrangeCode = `setcpm(124/4)
arrange(
  [12, stack(
    s("bd*4").bank("RolandTR909"),
    note("<[a2,c3,e3] [f2,a2,c3]>/2").s("sawtooth"),
  )],
  [16, stack(
    s("bd*4, [~ cp]*2"),
  )],
  [8, s("hh*8")],
)`;

describe('parseArrangeCycles', () => {
  it('sums section weights at line starts', () => {
    expect(parseArrangeCycles(arrangeCode)).toBe(36);
  });

  it('is not fooled by bracketed mini-notation chords', () => {
    // "[a2,c3,e3]" sits mid-line; only line-start "[N," counts
    expect(parseArrangeCycles(arrangeCode)).toBe(36);
  });

  it('returns null when there is no arrange call', () => {
    expect(parseArrangeCycles('setcpm(30)\nstack(s("bd*4"))')).toBe(null);
  });

  it('returns null for arrange with no parseable sections', () => {
    expect(parseArrangeCycles('arrange([a, s("bd")])')).toBe(null);
  });
});

describe('exportSpec', () => {
  const track = { meta: { bpm: 124 }, code: arrangeCode };

  it('derives cps from meta.bpm via the setcpm(bpm/4) convention', () => {
    expect(exportSpec(track).cps).toBeCloseTo(124 / 240);
  });

  it('uses parsed arrange cycles and computes seconds', () => {
    const spec = exportSpec(track);
    expect(spec.cycles).toBe(36);
    expect(spec.seconds).toBeCloseTo(36 / (124 / 240));
  });

  it('falls back to 32 cycles without arrange', () => {
    expect(exportSpec({ meta: { bpm: 120 }, code: 'stack(s("bd"))' }).cycles).toBe(32);
  });

  it('caps runaway cycle counts at 512', () => {
    const huge = 'arrange(\n  [9999, s("bd")],\n)';
    expect(exportSpec({ meta: { bpm: 120 }, code: huge }).cycles).toBe(512);
  });
});
