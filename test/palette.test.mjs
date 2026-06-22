import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validatePaletteShape,
  voiceProgram,
  validatePalette,
  effectiveSamples,
  composePreamble,
  savePalette,
  loadPalette,
  KIT_ROLES,
} from '../scripts/palette.mjs';

// A minimal well-formed palette (synth-only voices, no network needed for shape tests).
const synthPalette = () => ({
  batch: '2026-06-22-test-kit',
  brief: 'A warm lo-fi kit: dusty kick, round sub, felt keys, airy pad.',
  createdAt: '2026-06-22T00:00:00Z',
  samples: [],
  voices: [
    { role: 'kick', name: 'Thump', samples: [], frag: 's("bd*4").bank("AkaiMPC60").gain(1.0)', note: 'dusty four-on-floor' },
    { role: 'bass', name: 'Round Sub', samples: [], frag: 'note("<c1 c1 eb1 g0>*2").s("sine").lpf(300).gain(0.6)', note: 'sub bass' },
    { role: 'lead', name: 'Bell', samples: [], frag: 'note("<c4 g4 eb4 bb3>").s("sine").fm(4).fmh(2).decay(0.4).room(0.6).gain(0.5)', note: 'fm bell' },
    { role: 'pad', name: 'Airy', samples: [], frag: 'note("<c3 g3>/4").s("swpad").attack(2).release(3).room(0.7).gain(0.45)', note: 'lush pad' },
  ],
});

describe('validatePaletteShape', () => {
  it('accepts a well-formed palette', () => {
    expect(validatePaletteShape(synthPalette())).toEqual({ ok: true });
  });

  it('requires batch, brief, createdAt, voices', () => {
    for (const f of ['batch', 'brief', 'createdAt', 'voices']) {
      const p = synthPalette();
      delete p[f];
      expect(validatePaletteShape(p).ok, `missing ${f} should fail`).toBe(false);
      expect(validatePaletteShape(p).error).toMatch(new RegExp(f));
    }
  });

  it('requires at least 4 voices', () => {
    const p = synthPalette();
    p.voices = p.voices.slice(0, 3);
    expect(validatePaletteShape(p).ok).toBe(false);
    expect(validatePaletteShape(p).error).toMatch(/at least/);
  });

  it('requires each voice to have a known role, a name, and a frag', () => {
    const p = synthPalette();
    p.voices[0] = { role: 'kick', name: 'X' }; // no frag
    expect(validatePaletteShape(p).error).toMatch(/frag/);
    const p2 = synthPalette();
    p2.voices[0].role = 'not-a-role';
    expect(validatePaletteShape(p2).error).toMatch(/role/);
  });

  it('requires distinct voice roles to span a kit (>=3 distinct roles)', () => {
    const p = synthPalette();
    for (const v of p.voices) v.role = 'lead';
    expect(validatePaletteShape(p).ok).toBe(false);
    expect(validatePaletteShape(p).error).toMatch(/distinct/);
  });

  it('exposes the canonical kit roles', () => {
    expect(KIT_ROLES).toEqual(expect.arrayContaining(['kick', 'perc', 'bass', 'lead', 'pad', 'vocal', 'texture']));
  });
});

describe('voiceProgram + preamble assembly', () => {
  it('wraps a samples-carrying voice into a runnable single-voice program', () => {
    const voice = { role: 'kick', name: 'K', samples: ['github:eddyflux/crate'], frag: 's("crate_bd*4").gain(1.0)' };
    const program = voiceProgram(voice);
    expect(program).toMatch(/^samples\("github:eddyflux\/crate"\)/);
    expect(program).toMatch(/stack\(/);
    expect(program).toContain('crate_bd');
  });

  it('effectiveSamples is the de-duplicated union of all voice + top-level samples', () => {
    const p = synthPalette();
    p.samples = ['github:a/b'];
    p.voices[0].samples = ['github:eddyflux/crate'];
    p.voices[1].samples = ['github:eddyflux/crate', 'github:c/d'];
    expect(effectiveSamples(p)).toEqual(['github:a/b', 'github:eddyflux/crate', 'github:c/d']);
  });

  it('composePreamble emits one samples() line per effective source', () => {
    const p = synthPalette();
    p.voices[0].samples = ['github:eddyflux/crate'];
    expect(composePreamble(p)).toBe('samples("github:eddyflux/crate")');
  });
});

describe('validatePalette (validates every voice like a stem)', () => {
  it('passes a synth-only palette where every voice is a valid sub-expression', async () => {
    const res = await validatePalette(synthPalette());
    expect(res.ok, JSON.stringify(res.voices)).toBe(true);
  });

  it('fails when a voice references an unloaded sound', async () => {
    const p = synthPalette();
    p.voices[2].frag = 's("totallyfakesound_zzz*4")';
    const res = await validatePalette(p);
    expect(res.ok).toBe(false);
    const bad = res.voices.find((v) => !v.ok);
    expect(bad.error).toMatch(/unknown sounds/);
  });

  it('passes a voice that loads its own external bank', async () => {
    const p = synthPalette();
    p.voices[0] = { role: 'kick', name: 'Crate', samples: ['github:eddyflux/crate'], frag: 's("crate_bd*4").gain(1.0)' };
    const res = await validatePalette(p);
    expect(res.ok, JSON.stringify(res.voices)).toBe(true);
  }, 30000);
});

describe('savePalette / loadPalette (validate AND persist contract)', () => {
  let dir;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'crate-palette-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('refuses to save a structurally invalid palette', async () => {
    const p = synthPalette();
    p.voices = [];
    const res = await savePalette(p, { palettesDir: dir });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/at least|voices/);
  });

  it('refuses to save when a voice fails validation', async () => {
    const p = synthPalette();
    p.voices[1].frag = 's("totallyfakesound_zzz*4")';
    const res = await savePalette(p, { palettesDir: dir });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/voice|unknown/);
  });

  it('validates AND writes palettes/<batch>.json, then loads it back', async () => {
    const p = synthPalette();
    const res = await savePalette(p, { palettesDir: dir });
    expect(res.ok, res.error).toBe(true);
    const onDisk = JSON.parse(await readFile(join(dir, `${p.batch}.json`), 'utf8'));
    expect(onDisk.batch).toBe(p.batch);
    expect(onDisk.voices.length).toBe(4);
    const loaded = await loadPalette(p.batch, { palettesDir: dir });
    expect(loaded.batch).toBe(p.batch);
  });
});
