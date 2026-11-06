// scripts/save-palette.mjs <staging/<batch>.json>
// Validate a batch's bespoke kit palette (every voice validated like a stem) and
// write it to palettes/<batch>.json. Also vendors each voice's sample banks
// (cache-on-save), so a saved kit survives an upstream repo vanishing. Deletes
// the staging file on success. Prints "PASS <batch>" / "FAIL <batch> — <reason>".
import { readFile, unlink } from 'node:fs/promises';
import { inJob, saveThroughBroker } from './lib/job-client.mjs';

async function main() {
  const file = process.argv[2];
  if (file && inJob()) process.exit(await saveThroughBroker('save-palette', file, { field: 'palette', key: 'batch' }));
  const { savePalette, effectiveSamples } = await import('./palette.mjs');
  const { cacheBank, writeTrackManifest } = await import('./lib/sample-cache.mjs');
  if (!file) { console.error('usage: node scripts/save-palette.mjs <staging/<batch>.json>'); process.exit(2); }

  let palette;
  try {
    palette = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    console.log(`FAIL ${file} — unreadable JSON: ${err.message}`);
    process.exit(1);
  }

  const result = await savePalette(palette);
  if (!result.ok) { console.log(`FAIL ${palette.batch ?? file} — ${result.error}`); process.exit(1); }

  // Cache-on-save: vendor the kit's effective sample banks (best-effort), and
  // record them under the batch id so the kit is reproducible offline.
  try {
    const sources = effectiveSamples(palette);
    for (const source of sources) {
      const r = await cacheBank(source);
      if (!r.ok) console.error(`WARN ${palette.batch} — cache miss for ${source}: ${r.error}`);
      if (r.ok && r.skipped?.length) console.error(`WARN ${palette.batch} — vendored ${source} minus ${r.skipped.length} missing sample(s)`);
    }
    if (sources.length) await writeTrackManifest(`palette-${palette.batch}`, sources);
  } catch (err) {
    console.error(`WARN ${palette.batch} — sample caching failed: ${err.message}`);
  }

  try { await unlink(file); } catch { /* best effort */ }
  console.log(`PASS ${palette.batch} (${result.voices.length} voices)`);
}

main();
