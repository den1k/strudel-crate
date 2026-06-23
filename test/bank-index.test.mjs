import { describe, it, expect } from 'vitest';
import {
  parseManifest,
  extractSounds,
  resolveRef,
  categorize,
  describe as describeBank,
  buildDigest,
  CATEGORY_PRIORITY,
} from '../scripts/lib/bank-index.mjs';

// ---- parseManifest ---------------------------------------------------------

describe('parseManifest', () => {
  it('parses a valid JSON manifest into an object', () => {
    const m = parseManifest('{"_base":"./","crate_bd":["bd.wav"]}');
    expect(m).toEqual({ _base: './', crate_bd: ['bd.wav'] });
  });

  it('returns null for invalid JSON', () => {
    expect(parseManifest('{not json')).toBeNull();
    expect(parseManifest('')).toBeNull();
  });

  it('returns null for JSON that is not an object (array / scalar)', () => {
    expect(parseManifest('[1,2,3]')).toBeNull();
    expect(parseManifest('"hi"')).toBeNull();
    expect(parseManifest('null')).toBeNull();
  });
});

// ---- extractSounds ---------------------------------------------------------

describe('extractSounds', () => {
  it('returns the sound keys', () => {
    expect(extractSounds({ crate_bd: ['a'], crate_sd: ['b'] })).toEqual(['crate_bd', 'crate_sd']);
  });

  it('drops the _base key', () => {
    expect(extractSounds({ _base: 'https://x/', kick: ['a'] })).toEqual(['kick']);
  });

  it('drops every underscore-prefixed meta key, not just _base', () => {
    expect(extractSounds({ _base: 'x', _meta: 1, hh: ['a'] })).toEqual(['hh']);
  });

  it('returns [] for an empty or null manifest', () => {
    expect(extractSounds({})).toEqual([]);
    expect(extractSounds({ _base: './' })).toEqual([]);
    expect(extractSounds(null)).toEqual([]);
  });
});

// ---- resolveRef ------------------------------------------------------------

describe('resolveRef', () => {
  it('root strudel.json on main → github:owner/repo shorthand', () => {
    expect(resolveRef({
      owner: 'eddyflux', repo: 'crate', path: 'strudel.json', branch: 'main',
    })).toBe('github:eddyflux/crate');
  });

  it('root strudel.json on master (default branch) → shorthand still works via raw URL', () => {
    // non-main default branch cannot use the github: shorthand (it pins main),
    // so it must fall back to the full raw URL.
    expect(resolveRef({
      owner: 'a', repo: 'b', path: 'strudel.json', branch: 'master',
    })).toBe('https://raw.githubusercontent.com/a/b/master/strudel.json');
  });

  it('a non-root path → full raw manifest URL', () => {
    expect(resolveRef({
      owner: 'a', repo: 'b', path: 'banks/kit/strudel.json', branch: 'main',
    })).toBe('https://raw.githubusercontent.com/a/b/main/banks/kit/strudel.json');
  });
});

// ---- categorize ------------------------------------------------------------

describe('categorize', () => {
  it('classic drum names → drums', () => {
    expect(categorize(['bd', 'sd', 'hh'])).toBe('drums');
    expect(categorize(['kick', 'snare', 'clap'])).toBe('drums');
  });

  it('bass tokens → bass', () => {
    expect(categorize(['sub', 'bass', '808'])).toBe('bass');
  });

  it('lead tokens → lead', () => {
    expect(categorize(['lead', 'arp', 'pluck'])).toBe('lead');
  });

  it('pad tokens → pad', () => {
    expect(categorize(['pad', 'swpad', 'strings'])).toBe('pad');
  });

  it('vocal tokens → vocal', () => {
    expect(categorize(['vox', 'choir', 'breath', 'ooh'])).toBe('vocal');
  });

  it('world / ethnic tokens → world', () => {
    expect(categorize(['djembe', 'tabla', 'sitar'])).toBe('world');
  });

  it('break tokens → breaks', () => {
    expect(categorize(['amen', 'break', 'jungle'])).toBe('breaks');
  });

  it('fx tokens → fx', () => {
    expect(categorize(['riser', 'sweep', 'impact', 'noise'])).toBe('fx');
  });

  it('melodic instrument tokens → melodic', () => {
    expect(categorize(['piano', 'rhodes', 'guitar'])).toBe('melodic');
  });

  it('no recognizable token → misc fallback', () => {
    expect(categorize(['xyzzy', 'qwerty'])).toBe('misc');
    expect(categorize([])).toBe('misc');
  });

  it('resolves ties by fixed priority order (drums beats bass on a mixed kit)', () => {
    // one drum hit + one bass hit; drums has higher priority than bass.
    expect(categorize(['bd', 'sub'])).toBe('drums');
    // matched-count wins first: two bass tokens vs one drum token → bass.
    expect(categorize(['bd', 'sub', '808'])).toBe('bass');
  });

  it('matches tokens case-insensitively and inside compound names', () => {
    expect(categorize(['Crate_BD', 'CRATE_SD'])).toBe('drums');
    expect(categorize(['mychoir_01', 'mychoir_02'])).toBe('vocal');
  });

  it('CATEGORY_PRIORITY lists every category exactly once with misc last', () => {
    expect(CATEGORY_PRIORITY[CATEGORY_PRIORITY.length - 1]).toBe('misc');
    expect(new Set(CATEGORY_PRIORITY).size).toBe(CATEGORY_PRIORITY.length);
    expect(CATEGORY_PRIORITY).toEqual(
      expect.arrayContaining(['drums', 'bass', 'lead', 'pad', 'vocal', 'world', 'breaks', 'fx', 'melodic', 'misc']),
    );
  });
});

// ---- describe --------------------------------------------------------------

describe('describe', () => {
  it('templates category · count · first 3 names', () => {
    const d = describeBank({
      category: 'drums',
      soundCount: 18,
      sounds: ['crate_bd', 'crate_sd', 'crate_hh', 'crate_djembe'],
    });
    expect(d).toBe('drums · 18 sounds · crate_bd, crate_sd, crate_hh …');
  });

  it('handles fewer than 3 names without a trailing ellipsis comma', () => {
    const d = describeBank({ category: 'bass', soundCount: 1, sounds: ['sub'] });
    expect(d).toBe('bass · 1 sounds · sub');
  });

  it('shows ellipsis only when there are more than 3 names', () => {
    const d = describeBank({ category: 'pad', soundCount: 3, sounds: ['a', 'b', 'c'] });
    expect(d).toBe('pad · 3 sounds · a, b, c');
  });
});

// ---- buildDigest -----------------------------------------------------------

const entry = (repo, category, soundCount, stars) => ({
  ref: `github:${repo}`,
  repo,
  category,
  soundCount,
  sounds: Array.from({ length: soundCount }, (_, i) => `${repo.split('/')[1]}_${i}`),
  description: `${category} · ${soundCount} sounds`,
  stars,
  lastSeen: '2026-06-23',
});

describe('buildDigest', () => {
  it('groups banks by category with one line per bank', () => {
    const d = buildDigest([
      entry('a/drumkit', 'drums', 10, 5),
      entry('b/bassbank', 'bass', 4, 3),
    ]);
    expect(d).toMatch(/drums/);
    expect(d).toMatch(/bass/);
    expect(d).toContain('github:a/drumkit');
    expect(d).toContain('github:b/bassbank');
    // one line per bank: name · ref · count
    expect(d).toMatch(/a\/drumkit · github:a\/drumkit · 10/);
  });

  it('caps each category to the top N by stars and shows a "…and M more" footer', () => {
    const banks = [];
    for (let i = 0; i < 8; i++) banks.push(entry(`o/d${i}`, 'drums', 5, i));
    const d = buildDigest(banks, { perCategory: 3 });
    // top 3 by stars are d7,d6,d5; d0..d4 are the 5 "more"
    expect(d).toContain('o/d7');
    expect(d).toContain('o/d6');
    expect(d).toContain('o/d5');
    expect(d).not.toContain('github:o/d4');
    expect(d).toMatch(/and 5 more — grep `data\/banks\.json`/);
  });

  it('does not show a footer when a category fits under the cap', () => {
    const d = buildDigest([entry('a/x', 'drums', 5, 1)], { perCategory: 3 });
    expect(d).not.toMatch(/more — grep/);
  });

  it('orders categories by the fixed priority', () => {
    const d = buildDigest([
      entry('a/fxbank', 'fx', 3, 1),
      entry('b/drumkit', 'drums', 3, 1),
    ]);
    expect(d.indexOf('drums')).toBeLessThan(d.indexOf('fx'));
  });

  it('handles an empty index gracefully', () => {
    const d = buildDigest([]);
    expect(typeof d).toBe('string');
  });
});
