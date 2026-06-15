import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipStore } from '../src/zip.js';

const bytes = (s) => new TextEncoder().encode(s);

describe('zipStore', () => {
  it('produces an archive that unzip validates and lists every entry', async () => {
    const zip = zipStore([
      { name: 'a.txt', data: bytes('hello stems') },
      { name: 'b.wav', data: new Uint8Array([0, 1, 2, 3, 255, 254]) },
    ]);
    expect(zip).toBeInstanceOf(Uint8Array);

    const dir = await mkdtemp(join(tmpdir(), 'zip-'));
    const path = join(dir, 'out.zip');
    await writeFile(path, zip);
    try {
      // `unzip -t` validates CRCs and structure; throws on a bad archive
      const test = execFileSync('unzip', ['-t', path], { encoding: 'utf8' });
      expect(test).toMatch(/No errors detected/);
      // extract and compare a member byte-for-byte
      execFileSync('unzip', ['-o', path, '-d', dir], { stdio: 'ignore' });
      expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('hello stems');
      expect([...(await readFile(join(dir, 'b.wav')))]).toEqual([0, 1, 2, 3, 255, 254]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
