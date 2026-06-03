// Validate a Strudel code string headlessly: it must transpile, evaluate to
// a Pattern, and produce events when queried.
// NOTE: evaluate() executes the input string as JS in this process. Inputs are
// trusted agent-generated Strudel code (reviewed via the webapp), not untrusted user input.
import { fileURLToPath } from 'node:url';
import { evaluate } from '@strudel/transpiler';
import { Pattern } from '@strudel/core';
import { initStrudelEnv } from './strudel-env.mjs';
import { checkSounds, loadKnownSounds } from './check-sounds.mjs';

const QUERY_CYCLES = 8; // events must appear early — intros may not open with silence
// The sound allowlist must cover the WHOLE arrangement, not just the intro:
// 512 cycles > 6 minutes at 180 BPM (6 × 180 / 4 = 270 bars), with headroom.
const SOUND_SCAN_CYCLES = 512;

export async function validateCode(code) {
  await initStrudelEnv();
  let pattern;
  try {
    ({ pattern } = await evaluate(code));
  } catch (err) {
    return { ok: false, error: `evaluation failed: ${err.message}` };
  }
  if (!(pattern instanceof Pattern)) {
    return { ok: false, error: 'code did not evaluate to a Pattern (end with a single stack(...) expression)' };
  }
  let haps;
  try {
    haps = pattern.sortHapsByPart().queryArc(0, QUERY_CYCLES);
  } catch (err) {
    return { ok: false, error: `pattern query failed: ${err.message}` };
  }
  if (haps.length === 0) {
    return { ok: false, error: `pattern produced no events in ${QUERY_CYCLES} cycles` };
  }
  let allHaps;
  try {
    allHaps = pattern.queryArc(0, SOUND_SCAN_CYCLES);
  } catch (err) {
    return { ok: false, error: `pattern query failed: ${err.message}` };
  }
  const unknown = checkSounds(allHaps, await loadKnownSounds());
  if (unknown.length > 0) {
    return { ok: false, error: `unknown sounds (not loaded by the webapp): ${unknown.join(', ')} — see scripts/sounds.json for valid names` };
  }
  return { ok: true, events: haps.length };
}

// ---- CLI: node scripts/validate.mjs <track.json|file.strudel>... | --code "<code>" ----
const REQUIRED_FIELDS = ['id', 'title', 'prompt', 'batch', 'code', 'createdAt'];

async function validateTarget(arg) {
  const { readFile } = await import('node:fs/promises');
  if (arg.endsWith('.json')) {
    let track;
    try {
      track = JSON.parse(await readFile(arg, 'utf8'));
    } catch (err) {
      return { ok: false, error: `unreadable JSON: ${err.message}` };
    }
    const missing = REQUIRED_FIELDS.filter((f) => track[f] == null || track[f] === '');
    if (missing.length) return { ok: false, error: `missing fields: ${missing.join(', ')}` };
    return validateCode(track.code);
  }
  return validateCode(await readFile(arg, 'utf8'));
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('usage: node scripts/validate.mjs <track.json>... | --code "<strudel code>"');
    process.exit(2);
  }
  let failures = 0;
  if (args[0] === '--code') {
    const result = await validateCode(args[1] ?? '');
    console.log(result.ok ? `PASS (${result.events} events / 8 cycles)` : `FAIL — ${result.error}`);
    failures += result.ok ? 0 : 1;
  } else {
    for (const file of args) {
      const result = await validateTarget(file);
      console.log(result.ok ? `PASS ${file} (${result.events} events / 8 cycles)` : `FAIL ${file} — ${result.error}`);
      failures += result.ok ? 0 : 1;
    }
  }
  process.exit(failures ? 1 : 0);
}
