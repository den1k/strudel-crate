// Check queried haps against the allowlist of sounds the webapp actually loads.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export async function loadKnownSounds() {
  const names = JSON.parse(await readFile(join(here, 'sounds.json'), 'utf8'));
  return new Set(names);
}

// superdough resolves .bank("X") + .s("y") as the sound "X_y".
export function checkSounds(haps, known) {
  const unknown = new Set();
  for (const hap of haps) {
    const v = hap?.value;
    if (!v || typeof v !== 'object' || v.s == null) continue;
    const name = v.bank ? `${v.bank}_${v.s}` : String(v.s);
    if (!known.has(name)) unknown.add(name);
  }
  return [...unknown].sort();
}
