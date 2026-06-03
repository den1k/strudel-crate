import { describe, it, expect } from 'vitest';
import { checkSounds } from '../scripts/check-sounds.mjs';

const known = new Set(['bd', 'hh', 'piano', 'sawtooth', 'RolandTR909_bd']);
const hap = (value) => ({ value });

describe('checkSounds', () => {
  it('passes haps whose s is known', () => {
    expect(checkSounds([hap({ s: 'bd' }), hap({ s: 'piano', note: 60 })], known)).toEqual([]);
  });

  it('flags unknown sounds, deduplicated', () => {
    const haps = [hap({ s: 'zzz' }), hap({ s: 'zzz' }), hap({ s: 'bd' })];
    expect(checkSounds(haps, known)).toEqual(['zzz']);
  });

  it('checks bank-prefixed names the way superdough resolves them', () => {
    expect(checkSounds([hap({ s: 'bd', bank: 'RolandTR909' })], known)).toEqual([]);
    expect(checkSounds([hap({ s: 'bd', bank: 'NopeMachine' })], known)).toEqual(['NopeMachine_bd']);
  });

  it('ignores haps without an s control (pure synth notes use default sound)', () => {
    expect(checkSounds([hap({ note: 60 }), hap(undefined)], known)).toEqual([]);
  });
});
