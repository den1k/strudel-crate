import { describe, it, expect } from 'vitest';
import { songUrl, slugFromPath } from '../src/song-url.js';

describe('songUrl', () => {
  it('builds a /song/<slug> path', () => {
    expect(songUrl('2026-06-16-uk-garage-dubstep-09')).toBe('/song/2026-06-16-uk-garage-dubstep-09');
  });
  it('encodes characters that need escaping', () => {
    expect(songUrl('a b')).toBe('/song/a%20b');
  });
});

describe('slugFromPath', () => {
  it('extracts the slug from a /song/<slug> path', () => {
    expect(slugFromPath('/song/demo-01')).toBe('demo-01');
  });
  it('tolerates a trailing slash', () => {
    expect(slugFromPath('/song/demo-01/')).toBe('demo-01');
  });
  it('decodes percent-encoding', () => {
    expect(slugFromPath('/song/a%20b')).toBe('a b');
  });
  it('returns empty string when no slug present', () => {
    expect(slugFromPath('/song/')).toBe('');
    expect(slugFromPath('/')).toBe('');
    expect(slugFromPath('/stems')).toBe('');
  });
  it('round-trips with songUrl', () => {
    const slug = '2026-06-16-uk-garage-dubstep-09';
    expect(slugFromPath(songUrl(slug))).toBe(slug);
  });
});
