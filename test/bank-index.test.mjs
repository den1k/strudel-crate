import { describe, it, expect } from 'vitest';
import {
  parseManifest,
  extractSounds,
  isSampleBank,
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
  it('returns the sound keys whose value is an array', () => {
    expect(extractSounds({ crate_bd: ['a'], crate_sd: ['b'] })).toEqual(['crate_bd', 'crate_sd']);
  });

  it('drops the _base key', () => {
    expect(extractSounds({ _base: 'https://x/', kick: ['a'] })).toEqual(['kick']);
  });

  it('drops every underscore-prefixed meta key, not just _base', () => {
    expect(extractSounds({ _base: 'x', _meta: 1, hh: ['a'] })).toEqual(['hh']);
  });

  it('counts keys that carry sample paths: array, single string, or nested object', () => {
    expect(extractSounds({ kick: ['a.wav'], snare: 'b.wav' })).toEqual(['kick', 'snare']);
    expect(extractSounds({ wt: { d2: ['x.wav'] } })).toEqual(['wt']);
  });

  it('does not count a key whose value holds no path strings (number/bool/empty)', () => {
    // pure config scalars (no nested strings) are never sounds.
    expect(extractSounds({ version: 1, enabled: true, hh: ['b.wav'] })).toEqual(['hh']);
    expect(extractSounds({ count: 3, kick: 'k.wav' })).toEqual(['kick']);
  });

  it('returns [] for an empty or null manifest', () => {
    expect(extractSounds({})).toEqual([]);
    expect(extractSounds({ _base: './' })).toEqual([]);
    expect(extractSounds(null)).toEqual([]);
  });
});

// ---- isSampleBank ----------------------------------------------------------

describe('isSampleBank', () => {
  it('accepts a real bank: array values of audio file paths', () => {
    expect(isSampleBank({
      _base: 'https://x/',
      crate_bd: ['bd/0.wav', 'bd/1.wav'],
      crate_hh: ['hh/0.wav'],
    })).toBe(true);
  });

  it('accepts varied audio extensions case-insensitively, with query/fragment', () => {
    expect(isSampleBank({
      a: ['kick.WAV', 'snare.ogg'],
      b: ['pad.mp3?v=2', 'voc.flac#x', 'tom.aif', 'horn.aiff', 'clip.m4a'],
    })).toBe(true);
  });

  it('rejects the app-config shape (non-_ values are plain strings)', () => {
    expect(isSampleBank({
      id: 'x', name: 'free apps', description: 'd', url: 'https://y',
    })).toBe(false);
  });

  it('accepts the single-path bank shape (scalar string values, e.g. one-shot loops)', () => {
    expect(isSampleBank({
      _base: 'https://x/', shade: 'loop_shade.wav', sncm: 'loop_caustics.wav',
    })).toBe(true);
  });

  it('accepts the nested-object bank shape (e.g. wavetable banks)', () => {
    expect(isSampleBank({
      _base: 'https://x/', wt_stereo: { d2: ['wt_stereo/AKWF_0.wav', 'wt_stereo/AKWF_1.wav'] },
    })).toBe(true);
  });

  it('rejects a dictionary/config whose object values bottom out in non-audio strings', () => {
    expect(isSampleBank({
      term: { meaning: 'a definition' }, other: { meaning: 'another' },
    })).toBe(false);
  });

  it('rejects a bank that lists extensionless sample names (documented tradeoff)', () => {
    expect(isSampleBank({ _base: 'https://x/', breaks: ['break1', 'break2', 'break3'] })).toBe(false);
  });

  it('rejects the npm/package-manifest shape (name+version+description+resources)', () => {
    // DelicTide/samples: .wav paths under `resources`, but top-level keys are
    // package metadata — `resources` would register as a bogus sound.
    expect(isSampleBank({
      name: 'Vocal_Samples',
      version: '1.0.0',
      description: 'A collection of audio samples.',
      resources: ['vocals/a.wav', 'vocals/b.wav', 'vocals/c.wav'],
    })).toBe(false);
  });

  it('rejects a manifest whose only audio-carrying key is a generic container', () => {
    // even without the npm triple, a lone `files`/`assets`/`samples` container of
    // .wav paths is a packaged asset list, not a bank.
    expect(isSampleBank({ _base: 'https://x/', files: ['a.wav', 'b.wav'] })).toBe(false);
    expect(isSampleBank({ assets: ['a.wav', 'b.wav'] })).toBe(false);
  });

  it('still accepts a bank that has a real sound named after a real instrument alongside others', () => {
    // a genuine bank whose sound keys happen to NOT all be containers passes.
    expect(isSampleBank({ _base: 'https://x/', kick: ['k.wav'], files: ['f.wav'] })).toBe(true);
  });

  it('still accepts a single-sound bank and a _base-only-plus-one bank', () => {
    expect(isSampleBank({ kick: ['k.wav'] })).toBe(true);
    expect(isSampleBank({ _base: 'https://x/', crash: 'crash.wav' })).toBe(true);
  });

  it('rejects when almost nothing looks like audio even if values are arrays', () => {
    expect(isSampleBank({
      title: ['Some Product'], product_url: ['https://z'], tags: ['a', 'b'],
    })).toBe(false);
  });

  it('requires at least one array value (all-empty arrays do not qualify)', () => {
    expect(isSampleBank({ a: [], b: [] })).toBe(false);
  });

  it('ignores _-prefixed keys when judging shape', () => {
    expect(isSampleBank({ _base: 'https://x/', _meta: 'whatever', kick: ['k.wav'] })).toBe(true);
  });

  it('passes a strong majority (>=60%) of audio entries with a few stragglers', () => {
    // 4 of 5 entries are audio → 80% ≥ 60% → bank.
    expect(isSampleBank({
      kit: ['a.wav', 'b.wav', 'c.ogg', 'd.mp3', 'README.txt'],
    })).toBe(true);
  });

  it('rejects a minority of audio entries (below threshold)', () => {
    // 1 of 4 audio → 25% < 60% → not a bank.
    expect(isSampleBank({
      data: ['a.wav', 'b.json', 'c.csv', 'd.txt'],
    })).toBe(false);
  });

  it('rejects null / non-object input', () => {
    expect(isSampleBank(null)).toBe(false);
    expect(isSampleBank([1, 2])).toBe(false);
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
    expect(categorize(['bd', 'sub', 'bass'])).toBe('bass');
    // regression: 808-drum-kit names vote drums (via bd/sd); '808' is NOT a bass
    // token, so a full kit like Dirt-Samples is no longer mislabeled bass.
    expect(categorize(['808bd', '808sd', 'sub'])).toBe('drums');
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
