// Dynamic-validation tests: a track may declare its own samples() loads.
// The effective sound set = base prebake (sounds.json) ∪ what THIS code loaded.
// These tests hit the network (real github sample manifests) like build-sounds.mjs.
import { describe, it, expect } from 'vitest';
import { validateCode } from '../scripts/validate.mjs';

// Generous timeout: external manifest fetches over the network.

// github:eddyflux/crate is NOT a prebaked bank (not in shared/sample-banks.json),
// so its `crate_*` sounds are absent from the base set unless the code loads them.
describe('dynamic validator — self-declared samples()', () => {
  it('passes a track that loads an external bank and uses one of its sounds', async () => {
    const code = 'samples("github:eddyflux/crate")\ns("crate_bd crate_sd").gain(0.9)';
    const result = await validateCode(code);
    expect(result.ok).toBe(true);
  }, 30000);

  it('fails a track that references a sound NOT in the base set and NOT loaded', async () => {
    const result = await validateCode('s("definitelynotarealsound_xyz*4")');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unknown sounds/);
  }, 30000);

  it('fails when the external bank is loaded but the referenced sound is not in it', async () => {
    const code = 'samples("github:eddyflux/crate")\ns("crate_notarealsound*4")';
    const result = await validateCode(code);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unknown sounds/);
  }, 30000);

  it('still resolves base-set sounds without any samples() call', async () => {
    const result = await validateCode('s("bd*4").bank("RolandTR909")');
    expect(result.ok).toBe(true);
  }, 30000);

  it('does not leak loaded sounds across validations (isolation)', async () => {
    // First validate code that loads the external crate bank...
    expect((await validateCode('samples("github:eddyflux/crate")\ns("crate_bd*4")')).ok).toBe(true);
    // ...then a second track that references crate_bd WITHOUT loading it must fail.
    const result = await validateCode('s("crate_bd*4")');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unknown sounds/);
  }, 30000);
});
