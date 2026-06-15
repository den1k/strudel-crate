import { describe, it, expect } from 'vitest';
import { validateCode } from '../scripts/validate.mjs';
import { loadSeeds, composePairs, wrapStem, wrapTrack, compatible } from '../scripts/seeds.mjs';

describe('stem seeds', () => {
  const pool = loadSeeds('stem');

  it('has at least 5 distinct synthesis families', () => {
    const fams = new Set(pool.sources.map((s) => s.family));
    expect(fams.size).toBeGreaterThanOrEqual(5);
  });

  it('every source validates on its own', async () => {
    for (const s of pool.sources) {
      const res = await validateCode(wrapStem(s.frag));
      expect(res.ok, `source ${s.id}: ${res.error}`).toBe(true);
    }
  });

  it('every compatible source × signature pair validates', async () => {
    for (const { source, signature } of composePairs(pool)) {
      const res = await validateCode(wrapStem(source.frag + signature.frag));
      expect(res.ok, `${source.id} × ${signature.id}: ${res.error}`).toBe(true);
    }
  });

  it('yields at least 30 distinct composable seeds', () => {
    expect(composePairs(pool).length).toBeGreaterThanOrEqual(30);
  });

  it('has unique source and signature ids', () => {
    const sourceIds = pool.sources.map((s) => s.id);
    expect(new Set(sourceIds).size, 'duplicate source id').toBe(sourceIds.length);
    const signatureIds = pool.signatures.map((s) => s.id);
    expect(new Set(signatureIds).size, 'duplicate signature id').toBe(signatureIds.length);
  });

  it('compatible() blocks sample-only signatures on synth sources', () => {
    const synthSource = pool.sources.find((s) => s.appliesTo === 'synth');
    const sampleOnlySig = pool.signatures.find((sig) => sig.appliesTo === 'sample');
    const anySig = pool.signatures.find((sig) => sig.appliesTo === 'any');
    expect(compatible(synthSource, sampleOnlySig)).toBe(false);
    expect(compatible(synthSource, anySig)).toBe(true);
  });
});

describe('track seeds', () => {
  const pool = loadSeeds('track');

  it('every compatible groove × engine pair validates', async () => {
    for (const { source, signature } of composePairs(pool)) {
      const res = await validateCode(wrapTrack(source.frag, signature.frag));
      expect(res.ok, `${source.id} × ${signature.id}: ${res.error}`).toBe(true);
    }
  });

  it('yields at least 20 distinct composable seeds', () => {
    expect(composePairs(pool).length).toBeGreaterThanOrEqual(20);
  });

  it('has unique source and signature ids', () => {
    const sourceIds = pool.sources.map((s) => s.id);
    expect(new Set(sourceIds).size, 'duplicate source id').toBe(sourceIds.length);
    const signatureIds = pool.signatures.map((s) => s.id);
    expect(new Set(signatureIds).size, 'duplicate signature id').toBe(signatureIds.length);
  });
});
