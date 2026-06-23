import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  usedBanks,
  usedTechniques,
  usedRoles,
  buildKitDigest,
  loadRecentPalettes,
  loadKitLessons,
  KIT_TECHNIQUES,
} from '../scripts/kit-feedback.mjs';

// A palette artifact as written by save-palette.mjs.
const palette = (batch, voices, samples = []) => ({
  batch,
  brief: `brief for ${batch}`,
  createdAt: `${batch}T00:00:00Z`,
  samples,
  voices,
});

const voice = (role, frag, samples = []) => ({ role, name: `${role}-v`, samples, frag, note: 'n' });

describe('usedBanks', () => {
  it('collects every bank source across palettes (top-level + per-voice + inline)', () => {
    const ps = [
      palette('b1', [voice('kick', 's("crate_bd*4")', ['github:eddyflux/crate'])], ['github:a/b']),
      palette('b2', [voice('pad', 'samples("github:c/d"); note("c3").s("swpad")')]),
    ];
    expect(usedBanks(ps)).toEqual(
      expect.arrayContaining(['github:a/b', 'github:eddyflux/crate', 'github:c/d']),
    );
  });

  it('de-duplicates banks used in more than one palette', () => {
    const ps = [
      palette('b1', [voice('kick', 's("x")', ['github:eddyflux/crate'])]),
      palette('b2', [voice('bass', 's("y")', ['github:eddyflux/crate'])]),
    ];
    expect(usedBanks(ps).filter((b) => b === 'github:eddyflux/crate')).toHaveLength(1);
  });

  it('returns empty when no palettes', () => {
    expect(usedBanks([])).toEqual([]);
  });
});

describe('usedTechniques', () => {
  it('detects synthesis/dirt techniques from voice frags', () => {
    const ps = [
      palette('b1', [
        voice('lead', 'note("c4").s("sine").fm(4).fmh(2)'),
        voice('vocal', 'note("c3").vowel("a").s("sawtooth")'),
        voice('texture', 's("noise").crush(4).coarse(2)'),
      ]),
    ];
    const t = usedTechniques(ps);
    expect(t).toEqual(expect.arrayContaining(['fm', 'vowel', 'crush', 'coarse']));
  });

  it('returns techniques sorted/deduped and nothing for plain frags', () => {
    const ps = [palette('b1', [voice('kick', 's("bd*4").gain(1)')])];
    expect(usedTechniques(ps)).toEqual([]);
  });

  it('exposes the technique vocabulary it scans for', () => {
    expect(KIT_TECHNIQUES).toEqual(expect.arrayContaining(['fm', 'vowel', 'crush', 'wavetable']));
  });
});

describe('usedRoles', () => {
  it('reports role coverage with counts', () => {
    const ps = [
      palette('b1', [voice('kick', 'x'), voice('pad', 'y'), voice('pad', 'z')]),
    ];
    const r = usedRoles(ps);
    expect(r.pad).toBe(2);
    expect(r.kick).toBe(1);
  });
});

describe('buildKitDigest', () => {
  it('says so when there is nothing to report', () => {
    const d = buildKitDigest([], []);
    expect(d).toMatch(/no recent kits/i);
  });

  it('lists already-mined banks and tells Stage 1 to avoid re-mining them', () => {
    const ps = [
      palette('b1', [voice('kick', 's("crate_bd")', ['github:eddyflux/crate'])]),
    ];
    const d = buildKitDigest(ps, []);
    expect(d).toContain('github:eddyflux/crate');
    expect(d).toMatch(/avoid|fresh|away|unexplored|anti-conv/i);
  });

  it('surfaces over-used techniques as territory to vary away from', () => {
    const ps = [
      palette('b1', [voice('lead', 'note("c").s("sine").fm(4)')]),
      palette('b2', [voice('lead', 'note("c").s("sine").fm(2)')]),
    ];
    const d = buildKitDigest(ps, []);
    expect(d).toMatch(/fm/);
  });

  it('includes kit lessons verbatim and never leaks ratings/notes', () => {
    const lessons = [
      { batch: 'b1', lesson: 'the choir pad was the best part — lean into ensemble vocals', rating: 5, notes: 'loved it' },
      { batch: 'b2', lesson: '', rating: 1, notes: 'hated the bass' },
    ];
    const d = buildKitDigest([palette('b1', [voice('pad', 'x')])], lessons);
    expect(d).toContain('lean into ensemble vocals');
    expect(d).not.toContain('loved it');
    expect(d).not.toContain('hated the bass');
  });

  it('reports under-explored roles as fresh territory', () => {
    // Only kick+bass+pad ever used; vocal/texture never → should be suggested.
    const ps = [
      palette('b1', [voice('kick', 'x'), voice('bass', 'y'), voice('pad', 'z'), voice('lead', 'w')]),
    ];
    const d = buildKitDigest(ps, []);
    expect(d).toMatch(/vocal|texture/);
  });
});

describe('loadRecentPalettes / loadKitLessons (disk artifacts)', () => {
  let dir, palettesDir, lessonsDir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'crate-kitfb-'));
    palettesDir = join(dir, 'palettes');
    lessonsDir = join(dir, 'kit-lessons');
    await mkdir(palettesDir, { recursive: true });
    await mkdir(lessonsDir, { recursive: true });
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('loads palettes newest-first, capped to `limit`', async () => {
    for (const b of ['2026-06-01-a', '2026-06-02-b', '2026-06-03-c']) {
      await writeFile(join(palettesDir, `${b}.json`), JSON.stringify(palette(b, [voice('kick', 'x')])));
    }
    const recent = await loadRecentPalettes({ palettesDir, limit: 2 });
    expect(recent.map((p) => p.batch)).toEqual(['2026-06-03-c', '2026-06-02-b']);
  });

  it('returns [] when the palettes dir does not exist', async () => {
    const recent = await loadRecentPalettes({ palettesDir: join(dir, 'nope') });
    expect(recent).toEqual([]);
  });

  it('loads kit lessons sidecar files', async () => {
    await writeFile(join(lessonsDir, 'b1.json'), JSON.stringify({ batch: 'b1', lesson: 'use more vocals', rating: 4, notes: 'x' }));
    const lessons = await loadKitLessons({ lessonsDir });
    expect(lessons).toHaveLength(1);
    expect(lessons[0].lesson).toBe('use more vocals');
  });

  it('returns [] when the kit-lessons dir does not exist', async () => {
    expect(await loadKitLessons({ lessonsDir: join(dir, 'nope') })).toEqual([]);
  });
});
