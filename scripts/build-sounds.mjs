// Build scripts/sounds.json: every sound name available in the webapp.
// Fetches the same sample manifests the webapp prebakes (shared/sample-banks.json)
// plus the synth waveforms registered by @strudel/web's defaultPrebake.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SYNTHS = ['sine', 'square', 'triangle', 'sawtooth', 'supersaw', 'white', 'pink', 'brown'];

function manifestUrl(bank) {
  if (bank.shorthand) {
    // 'github:user/repo' shorthand: @strudel/webaudio's githubPath() defaults to
    // the 'main' branch when none is given — mirror that exactly so the allowlist
    // matches what the webapp will actually fetch.
    const repo = bank.shorthand.replace('github:', '');
    return `https://raw.githubusercontent.com/${repo}/main/strudel.json`;
  }
  return bank.json;
}

const banks = JSON.parse(await readFile(join(here, '../shared/sample-banks.json'), 'utf8'));
const names = new Set(SYNTHS);
for (const bank of banks) {
  const url = manifestUrl(bank);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const manifest = await res.json();
  for (const key of Object.keys(manifest)) {
    if (!key.startsWith('_')) names.add(key);
  }
  console.log(`${url}: ${Object.keys(manifest).length} entries`);
}
await writeFile(join(here, 'sounds.json'), JSON.stringify([...names].sort(), null, 2) + '\n');
console.log(`wrote scripts/sounds.json with ${names.size} sound names`);
