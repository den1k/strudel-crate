import { describe, it, expect, beforeAll } from 'vitest';
import { evaluate } from '@strudel/transpiler';
import { initStrudelEnv } from '../scripts/strudel-env.mjs';
import { collectHaps, groupHapsBySound } from '../src/export-spec.js';

// Build a real Pattern headlessly, the same way the validator does.
const patternOf = async (code) => (await evaluate(code)).pattern;

beforeAll(() => initStrudelEnv());

describe('collectHaps', () => {
  // A whole-arrangement queryArc(0, cycles) throws on certain malformed
  // mini-notation (e.g. `<…> / <notes>` → NaN Fraction → "Invalid argument");
  // strudel swallows the throw and returns [] for the ENTIRE range, so the
  // export rendered pure silence. collectHaps queries one cycle at a time so a
  // single bad cycle can't zero the whole track — matching the live scheduler.
  const gated = `arrange(
  [4, stack(s("bd*4"))],
  [4, stack(s("bd*4"), note("<d1 d1 f1 c1> / <d1 a0 f1 c1>").s("sine"))]
)`;

  it('recovers events a whole-arrangement query loses to a throwing cycle', async () => {
    const pattern = await patternOf(gated);
    // the bug: one query over all 8 cycles yields nothing
    expect(pattern.queryArc(0, 8, { _cps: 0.5 })).toHaveLength(0);
    // the fix: per-cycle collection keeps the 4 healthy cycles (4 × bd*4 = 16)
    const haps = collectHaps(pattern, 8, 0.5);
    expect(haps.length).toBe(16);
    expect(haps.every((h) => h.hasOnset())).toBe(true);
  });

  it('returns onset haps in ascending time order', async () => {
    const pattern = await patternOf(gated);
    const begins = collectHaps(pattern, 8, 0.5).map((h) => h.whole.begin.valueOf());
    expect(begins).toEqual([...begins].sort((a, b) => a - b));
  });

  it('matches the naive full query for a healthy pattern', async () => {
    const pattern = await patternOf('stack(s("bd*4"), note("c2 g1").s("sawtooth"))');
    const naive = pattern
      .queryArc(0, 8, { _cps: 0.5 })
      .filter((h) => h.hasOnset()).length;
    expect(collectHaps(pattern, 8, 0.5).length).toBe(naive);
  });
});

describe('groupHapsBySound', () => {
  it('splits a multi-sound stack into one group per sound, sorted by name', async () => {
    const pattern = await patternOf('stack(s("bd*4"), s("hh*8"), note("c2 g1").s("sawtooth"))');
    const haps = collectHaps(pattern, 4, 0.5);
    const groups = groupHapsBySound(haps);
    expect(groups.map((g) => g.name)).toEqual(['bd', 'hh', 'sawtooth']);
    // every hap is accounted for, none duplicated
    expect(groups.reduce((n, g) => n + g.haps.length, 0)).toBe(haps.length);
    // each group only contains its own sound
    for (const g of groups) {
      expect(g.haps.every((h) => (h.value?.s ?? 'synth') === g.name)).toBe(true);
    }
  });

  it('merges layers that share a sound into one group', async () => {
    const pattern = await patternOf('stack(note("c2").s("sawtooth"), note("c4").s("sawtooth"))');
    const groups = groupHapsBySound(collectHaps(pattern, 2, 0.5));
    expect(groups.map((g) => g.name)).toEqual(['sawtooth']);
  });
});
