import { describe, it, expect } from 'vitest';
import { songUrl, idFromPath } from '../src/song-url.js';

const ID = '3f9c2a14-8b7e-4c2a-9f1d-0a1b2c3d4e5f'; // an entity id (UUID)

describe('songUrl', () => {
  it('builds a /song/<id> path', () => {
    expect(songUrl(ID)).toBe(`/song/${ID}`);
  });
  it('encodes characters that need escaping', () => {
    expect(songUrl('a b')).toBe('/song/a%20b');
  });
});

describe('idFromPath', () => {
  it('extracts the id from a /song/<id> path', () => {
    expect(idFromPath(`/song/${ID}`)).toBe(ID);
  });
  it('tolerates a trailing slash', () => {
    expect(idFromPath(`/song/${ID}/`)).toBe(ID);
  });
  it('decodes percent-encoding', () => {
    expect(idFromPath('/song/a%20b')).toBe('a b');
  });
  it('returns empty string when no id present', () => {
    expect(idFromPath('/song/')).toBe('');
    expect(idFromPath('/')).toBe('');
    expect(idFromPath('/stems')).toBe('');
  });
  it('round-trips with songUrl', () => {
    expect(idFromPath(songUrl(ID))).toBe(ID);
  });
});
