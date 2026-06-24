// Disk cache for rendered exports at <dir>/<ns>/<id>.<ext>, governed by a single
// LRU byte cap. "Recently used" = file access time (atime), which we bump on every
// hit (mounts often use noatime, so reads alone won't update it — we do it
// explicitly). prune() runs after each write so the cap is enforced eagerly.
import { mkdir, readdir, stat, writeFile, unlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';

const EXT = { wav: 'wav', mp3: 'mp3', stems: 'zip' };

export function createAudioCache({ dir, maxBytes = 3221225472 }) {
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
    await prune();
    return p;
  }

  // List every cached file with size + atime (one level of ns subdirs).
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
          if (s.isFile()) out.push({ p, size: s.size, atime: s.atimeMs });
        } catch { /* vanished mid-scan */ }
      }
    }
    return out;
  }

  async function prune() {
    const files = await listFiles();
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

  return { EXT, cachedPath, store, prune };
}
