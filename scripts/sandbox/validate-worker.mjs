// Runs inside the worker sandbox (server/job-broker.mjs): no secrets, evaluates agent code.
// Reads one JSON request on stdin, prints one result line. Vendors sample banks on save.
import { validateCode, validateTrack } from '../validate.mjs';
import { cacheBank, cacheTrackSamples, writeTrackManifest } from '../lib/sample-cache.mjs';
import { effectiveSamples, savePalette } from '../palette.mjs';

const finish = (result) => {
  console.log(`CRATE_WORKER_RESULT ${JSON.stringify(result)}`);
  process.exit(0);
};

let input = '';
for await (const chunk of process.stdin) input += chunk;
const req = JSON.parse(input);

async function vendorItem(item) {
  const warnings = [];
  try {
    const cache = await cacheTrackSamples(item.id, item.code);
    for (const b of cache.banks.filter((x) => !x.ok)) warnings.push(`cache miss for ${b.source}: ${b.error}`);
    for (const b of cache.banks.filter((x) => x.skipped?.length)) warnings.push(`vendored ${b.source} minus ${b.skipped.length} missing sample(s)`);
  } catch (err) {
    warnings.push(`sample caching failed: ${err.message}`);
  }
  return warnings;
}

async function vendorPalette(palette) {
  const warnings = [];
  try {
    const sources = effectiveSamples(palette);
    for (const source of sources) {
      const r = await cacheBank(source);
      if (!r.ok) warnings.push(`cache miss for ${source}: ${r.error}`);
      if (r.ok && r.skipped?.length) warnings.push(`vendored ${source} minus ${r.skipped.length} missing sample(s)`);
    }
    if (sources.length) await writeTrackManifest(`palette-${palette.batch}`, sources);
  } catch (err) {
    warnings.push(`sample caching failed: ${err.message}`);
  }
  return warnings;
}

try {
  if (req.kind === 'check-code') finish(await validateCode(req.code));
  if (req.kind === 'check-item') finish(await validateTrack(req.item, { character: req.character }));
  if (req.kind === 'item') {
    const result = await validateTrack(req.item, { character: req.character });
    if (!result.ok) finish(result);
    finish({ ...result, warnings: await vendorItem(req.item) });
  }
  if (req.kind === 'palette') {
    const result = await savePalette(req.palette);
    if (!result.ok) finish(result);
    finish({ ...result, warnings: await vendorPalette(req.palette) });
  }
  finish({ ok: false, error: 'unknown request' });
} catch (err) {
  finish({ ok: false, error: String(err?.message ?? err).slice(0, 500) });
}
