// server/card-cache.mjs
// Flat disk cache for rendered OG card PNGs at <dir>/<name>.png, governed by a
// single LRU byte cap keyed on access time (atime) — mirrors audio-cache.mjs.
// Card files are named "<entityId>-<contentHash>.png" so a content change yields
// a new file and the stale one ages out under the cap.
import { mkdir, readdir, stat, writeFile, unlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';

export function createCardCache({ dir, maxBytes = 268435456 }) { // 256 MB
  const fileFor = (name) => join(dir, `${name}.png`);

  async function cachedPath(name) {
    const p = fileFor(name);
    try { await stat(p); } catch { return null; }
    const now = new Date();
    try { await utimes(p, now, now); } catch { /* mounts may be noatime; best effort */ }
    return p;
  }

  async function store(name, buffer) {
    await mkdir(dir, { recursive: true });
    const p = fileFor(name);
    await writeFile(p, buffer);
    await prune();
    return p;
  }

  async function prune() {
    let names = [];
    try { names = await readdir(dir); } catch { return 0; }
    const files = [];
    for (const f of names) {
      const p = join(dir, f);
      try { const s = await stat(p); if (s.isFile()) files.push({ p, size: s.size, atime: s.atimeMs }); }
      catch { /* vanished mid-scan */ }
    }
    let total = files.reduce((n, f) => n + f.size, 0);
    if (total <= maxBytes) return 0;
    files.sort((a, b) => a.atime - b.atime); // oldest access first
    let freed = 0;
    for (const f of files) {
      if (total <= maxBytes) break;
      try { await unlink(f.p); total -= f.size; freed += f.size; } catch { /* already gone */ }
    }
    return freed;
  }

  return { cachedPath, store, prune };
}
