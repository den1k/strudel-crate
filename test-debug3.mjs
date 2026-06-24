import { mkdtemp, writeFile, stat, utimes, readFile, readdir, unlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXT = { wav: 'wav', mp3: 'mp3', stems: 'zip' };

function createAudioCache({ dir, maxBytes = 3221225472 }) {
  const fileFor = (ns, id, fmt) => join(dir, ns, `${id}.${EXT[fmt]}`);

  async function cachedPath(ns, id, fmt) {
    const p = fileFor(ns, id, fmt);
    try {
      await stat(p);
    } catch {
      return null;
    }
    const now = new Date();
    try { await utimes(p, now, now); } catch { /* best effort */ }
    return p;
  }

  async function store(ns, id, fmt, buffer) {
    const p = fileFor(ns, id, fmt);
    await mkdir(join(dir, ns), { recursive: true });
    await writeFile(p, buffer);
    console.log(`\n  store('${id}') wrote file, about to prune...`);
    await prune();
    return p;
  }

  async function listFiles() {
    const out = [];
    let nss;
    try { nss = await readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const d of nss) {
      if (!d.isDirectory()) continue;
      const sub = join(dir, d.name);
      let files;
      try { files = await readdir(sub); } catch { continue; }
      for (const f of files) {
        const p = join(sub, f);
        try {
          const s = await stat(p);
          if (s.isFile()) {
            out.push({ p, size: s.size, atime: s.atimeMs });
            console.log(`    listFiles: ${f} atime=${new Date(s.atimeMs).toISOString()}`);
          }
        } catch { /* vanished mid-scan */ }
      }
    }
    return out;
  }

  async function prune() {
    console.log('    prune() starting...');
    const files = await listFiles();
    let total = files.reduce((n, f) => n + f.size, 0);
    console.log(`    total=${total}, maxBytes=${maxBytes}`);
    if (total <= maxBytes) {
      console.log('    total <= maxBytes, returning 0');
      return 0;
    }
    files.sort((a, b) => a.atime - b.atime); // oldest access first
    let freed = 0;
    console.log(`    sorted files by atime:`);
    for (const f of files) {
      console.log(`      ${f.p.split('/').pop()} atime=${new Date(f.atime).toISOString()}`);
    }
    for (const f of files) {
      if (total <= maxBytes) break;
      console.log(`    deleting ${f.p.split('/').pop()}`);
      try { await unlink(f.p); total -= f.size; freed += f.size; } catch { /* already gone */ }
    }
    console.log(`    prune() freed=${freed}`);
    return freed;
  }

  return { EXT, cachedPath, store, prune };
}

const dir = await mkdtemp(join(tmpdir(), 'audio-cache-'));
console.log('Working dir:', dir);

const cache = createAudioCache({ dir, maxBytes: 250 });
const big = Buffer.alloc(100, 1);

console.log('\nStore old:');
await cache.store('tracks', 'old', 'wav', big);

console.log('\nSet old atime to 2020:');
const t0 = new Date('2020-01-01T00:00:00Z');
await utimes(join(dir, 'tracks', 'old.wav'), t0, t0);
const s = await stat(join(dir, 'tracks', 'old.wav'));
console.log(`old.wav atime is now: ${new Date(s.atimeMs).toISOString()}`);

console.log('\nStore mid:');
await cache.store('tracks', 'mid', 'wav', big);

console.log('\nStore new:');
await cache.store('tracks', 'new', 'wav', big);

console.log('\nCall prune explicitly:');
const freed = await cache.prune();
console.log(`Explicit prune returned freed=${freed}`);
