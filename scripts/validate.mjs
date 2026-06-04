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
const REQUIRED_FIELDS = ['id', 'title', 'prompt', 'batch', 'description', 'code', 'createdAt'];

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

// BPM declared by the code: setcpm(N/4) → N, setcpm(N) → N×4, none → 120 (strudel default).
function declaredBpm(code) {
  const frac = code.match(/setcpm\(\s*(\d+(?:\.\d+)?)\s*\/\s*4\s*\)/);
  if (frac) return Number(frac[1]);
  const plain = code.match(/setcpm\(\s*(\d+(?:\.\d+)?)\s*\)/);
  if (plain) return Number(plain[1]) * 4;
  return 120;
}

// Full track validation: required fields + meta schema + bpm↔setcpm, then the code itself.
export async function validateTrack(track) {
  const missing = REQUIRED_FIELDS.filter((f) => track[f] == null || track[f] === '');
  if (missing.length) return { ok: false, error: `missing fields: ${missing.join(', ')}` };
  const m = track.meta;
  if (m == null || typeof m !== 'object' || Array.isArray(m)) {
    return { ok: false, error: 'missing fields: meta (object with bpm, genre, mood, key, instruments, energy)' };
  }
  if (!(Number.isInteger(m.bpm) && m.bpm >= 40 && m.bpm <= 220)) {
    return { ok: false, error: 'meta.bpm must be an integer 40-220' };
  }
  for (const f of ['genre', 'mood', 'key']) {
    if (!isNonEmptyString(m[f])) return { ok: false, error: `meta.${f} must be a non-empty string` };
  }
  if (!Array.isArray(m.instruments) || m.instruments.length === 0 || !m.instruments.every(isNonEmptyString)) {
    return { ok: false, error: 'meta.instruments must be a non-empty array of strings' };
  }
  if (!(Number.isInteger(m.energy) && m.energy >= 1 && m.energy <= 5)) {
    return { ok: false, error: 'meta.energy must be an integer 1-5' };
  }
  const bpm = declaredBpm(track.code);
  if (m.bpm !== bpm) {
    return { ok: false, error: `meta.bpm (${m.bpm}) does not match the code's tempo (${bpm} BPM from setcpm)` };
  }
  return validateCode(track.code);
}

async function validateTarget(arg) {
  const { readFile } = await import('node:fs/promises');
  if (arg.endsWith('.json')) {
    let track;
    try {
      track = JSON.parse(await readFile(arg, 'utf8'));
    } catch (err) {
      return { ok: false, error: `unreadable JSON: ${err.message}` };
    }
    return validateTrack(track);
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
