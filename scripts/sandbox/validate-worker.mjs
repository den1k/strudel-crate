// Runs inside a worker sandbox (server/job-broker.mjs): no secrets. check-* kinds evaluate
// agent code, with no network and nothing writable that lasts; the other kinds fetch or
// publish and evaluate nothing.
// Reads one JSON request on stdin, prints one result line.
import { validateCode, validateTrack } from '../validate.mjs';
import { cacheBank, cacheTrackSamples, fetchManifests, sourcesIn, writeTrackManifest } from '../lib/sample-cache.mjs';
import { effectiveSamples, validatePalette, writePalette } from '../palette.mjs';

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

// samples() in the evaluator gets only what was fetched for it beforehand.
if (req.kind.startsWith('check-')) {
  globalThis.fetch = async (url) => {
    const manifest = req.manifests?.[String(url)];
    if (manifest === undefined) throw new Error('samples sources must be literal strings');
    return new Response(JSON.stringify(manifest));
  };
}

try {
  if (req.kind === 'fetch-manifests') finish(await fetchManifests(sourcesIn(req.request)));
  if (req.kind === 'check-code') finish(await validateCode(req.code));
  if (req.kind === 'check-item') finish(await validateTrack(req.item, { character: req.character }));
  if (req.kind === 'check-palette') finish(await validatePalette(req.palette));
  // Publishing: writes where a save lands. Reads sources as text and evaluates no agent code.
  if (req.kind === 'vendor-item') finish({ ok: true, warnings: await vendorItem(req.item) });
  if (req.kind === 'write-palette') {
    const result = await writePalette(req.palette, { overwrite: !!req.overwrite });
    if (!result.ok) finish(result);
    finish({ ...result, warnings: await vendorPalette(req.palette) });
  }
  finish({ ok: false, error: 'unknown request' });
} catch (err) {
  finish({ ok: false, error: String(err?.message ?? err).slice(0, 500) });
}
