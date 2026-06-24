import { mkdtemp, writeFile, stat, utimes, readFile, readdir, unlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAudioCache } from './server/audio-cache.mjs';

const dir = await mkdtemp(join(tmpdir(), 'audio-cache-'));
console.log('Working dir:', dir);

const cache = createAudioCache({ dir, maxBytes: 250 });
const big = Buffer.alloc(100, 1);

console.log('\n1. Storing old...');
await cache.store('tracks', 'old', 'wav', big);
console.log('Files after store(old):', await readdir(join(dir, 'tracks')));

console.log('\n2. Storing mid...');
await cache.store('tracks', 'mid', 'wav', big);
console.log('Files after store(mid):', await readdir(join(dir, 'tracks')));

console.log('\n3. Storing new...');
await cache.store('tracks', 'new', 'wav', big);
console.log('Files after store(new):', await readdir(join(dir, 'tracks')));

console.log('\n4. Checking files and atimes...');
const files = await readdir(join(dir, 'tracks'));
for (const f of files) {
  const s = await stat(join(dir, 'tracks', f));
  console.log(f, 'size:', s.size, 'atime:', new Date(s.atimeMs).toISOString());
}

console.log('\n5. Setting old.wav atime to 2020...');
try {
  const t0 = new Date('2020-01-01T00:00:00Z');
  await utimes(join(dir, 'tracks', 'old.wav'), t0, t0);
  console.log('Success');
} catch(e) {
  console.log('Failed:', e.message);
}

console.log('\n6. Files after utimes attempt...');
const files2 = await readdir(join(dir, 'tracks'));
console.log('Files:', files2);
for (const f of files2) {
  const s = await stat(join(dir, 'tracks', f));
  console.log(f, 'size:', s.size, 'atime:', new Date(s.atimeMs).toISOString());
}

console.log('\n7. Calling prune()...');
const freed = await cache.prune();
console.log('Freed:', freed, 'bytes');

console.log('\n8. Files after explicit prune...');
const files3 = await readdir(join(dir, 'tracks'));
console.log('Files:', files3);
