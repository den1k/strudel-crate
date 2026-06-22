// Validate a Strudel code string headlessly: it must transpile, evaluate to
// a Pattern, and produce events when queried.
// NOTE: evaluate() executes the input string as JS in this process. Inputs are
// trusted agent-generated Strudel code (reviewed via the webapp), not untrusted user input.
import { fileURLToPath } from 'node:url';
import { evaluate } from '@strudel/transpiler';
import * as webaudio from '@strudel/webaudio';
import { Pattern } from '@strudel/core';
import { initStrudelEnv, loadedSoundNames, resetLoadedSounds } from './strudel-env.mjs';
import { checkSounds, loadKnownSounds } from './check-sounds.mjs';

const QUERY_CYCLES = 8; // events must appear early — intros may not open with silence
// The sound allowlist must cover the WHOLE arrangement, not just the intro:
// 512 cycles > 6 minutes at 180 BPM (6 × 180 / 4 = 270 bars), with headroom.
const SOUND_SCAN_CYCLES = 512;

// Matches whole top-level `samples(...)` statements so we can run them ahead of
// pattern evaluation (the transpiler's eager evaluation can't reconcile an async
// samples() load that returns a promise mid-expression). One per line.
const SAMPLES_STMT = /^\s*(samples\s*\([\s\S]*?\))\s*;?\s*$/gm;

// Run every `samples(...)` call the code declares against the REAL webaudio
// loader, so the bank's sounds become resolvable. Returns the code with those
// statements stripped (the remaining expression is the pattern to evaluate).
// `samples` is the only identifier in scope — no other code is executed here.
async function loadDeclaredSamples(code) {
  const calls = [];
  const stripped = code.replace(SAMPLES_STMT, (_, call) => { calls.push(call); return ''; });
  for (const call of calls) {
    // eslint-disable-next-line no-new-func
    const run = new Function('samples', `return ${call};`);
    await run(webaudio.samples);
  }
  return { stripped: stripped.trim(), loaded: calls.length > 0 };
}

export async function validateCode(code) {
  await initStrudelEnv();
  // Each track is validated against the base set ∪ ONLY its own samples() loads.
  resetLoadedSounds();
  let toEvaluate = code;
  try {
    const { stripped } = await loadDeclaredSamples(code);
    toEvaluate = stripped;
  } catch (err) {
    return { ok: false, error: `samples() load failed: ${err.message}` };
  }
  let pattern;
  try {
    ({ pattern } = await evaluate(toEvaluate));
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
  // Effective sound set = base palette (always-available prebake) ∪ whatever
  // THIS track loaded via its own samples() calls. The base set is a floor, not
  // a ceiling: a track is free to bring its own banks.
  const effective = new Set(await loadKnownSounds());
  for (const name of loadedSoundNames()) effective.add(name);
  const unknown = checkSounds(allHaps, effective);
  if (unknown.length > 0) {
    return { ok: false, error: `unknown sounds (not in the base palette or any bank you loaded): ${unknown.join(', ')} — load a bank with samples('github:user/repo') or see scripts/sounds.json for the base palette` };
  }
  return { ok: true, events: haps.length };
}

// ---- Character gate (track files only) -------------------------------------
// A static, deliberately-crude check that a track reaches beyond the generic
// floor (on-grid triads under a filter sweep). It rewards USING operators from
// distinct families, not using them well — quality-of-use is out of scope.
// Regexes run against the raw code string. See the design doc for rationale.

// A note/chord progression of >=4 entries — harmonic interest. Counts top-level
// entries in each <...> group that look like pitches (note name + octave), so
// automation like <0.9 0.6 0.8 0.6> (gain), <0 1 2 3> (degrees) or <bd sd hh oh>
// (sample variants) does NOT score. The bounded, non-backtracking <[^<>]*> scan
// avoids catastrophic backtracking on a stray unclosed `<`.
function hasNoteProgression(code) {
  const groups = code.match(/<[^<>]*>/g);
  if (!groups) return false;
  const noteToken = /[a-gA-G][#sb]?\d/;
  return groups.some((g) => {
    const inner = g.slice(1, -1).trim();
    if (!inner) return false;
    return inner.split(/\s+/).filter((e) => noteToken.test(e)).length >= 4;
  });
}

const CHARACTER_CATEGORIES = {
  // Harmonic richness beyond bare triads: a 4+ note chord, a transposition/
  // voicing move, a characterful mode, or a >=4-entry progression.
  harmonic: [
    /\[[^\]]*?(?:,[^\],]*?){3,}\]/,                                  // chord with >=4 members
    /\.add\(\s*note/,                                                // .add(note(...))
    /:(?:dorian|phrygian|lydian|mixolydian|locrian|harmonic|melodic)/,
    hasNoteProgression,                                             // >=4-entry note/chord progression
  ],
  // Off-grid rhythm. Euclid is a mini-notation token `word(n,m)` NOT preceded
  // by a dot — so method calls like .range(200, 2000), .every(4, …), .pan(…)
  // and .off(…) are never mistaken for euclid.
  rhythmic: [
    /(?<!\.)\b\w+\(\s*\d+\s*,\s*\d+\s*(?:,\s*\d+\s*)?\)/,            // word(n,m[,r]) euclid
    /\.(?:swingBy|swing|nudge|early|late)\b/,
    /\*\s*(?:3|5|7|9|11|13)\b/,                                      // odd repeat multiple
  ],
  // Timbral dirt/character — NOT plain filter/space (lpf/hpf/room/delay).
  timbral: [
    /\.(?:crush|shape|coarse|vowel|distort)\b/,
    /\.fmh?\b/,                                                      // .fm / .fmh
    /\.speed\((?!\s*1(?:\.0*)?\s*\))[^)]*\)/,                        // .speed(non-1)
  ],
  // Pattern transforms / conditional variation. .off and .ply live here only
  // (not rhythmic) so "3 of 4" means three genuinely different move types.
  transform: [
    /\.(?:every|off|jux|sometimesBy|sometimes|often|rarely|someCycles|ply|mask|degradeBy|degrade|iter|chunk|palindrome)\b/,
  ],
};

export function characterCheck(code) {
  const present = [];
  const missing = [];
  for (const [category, patterns] of Object.entries(CHARACTER_CATEGORIES)) {
    const present_ = patterns.some((m) => (typeof m === 'function' ? m(code) : m.test(code)));
    (present_ ? present : missing).push(category);
  }
  return { ok: present.length >= 3, present, missing };
}

// ---- CLI: node scripts/validate.mjs <track.json|file.strudel>... | --code "<code>" ----
const REQUIRED_FIELDS = ['id', 'title', 'prompt', 'batch', 'description', 'code', 'createdAt'];

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

// Assumes at most one setcpm call (the guide forbids more); first match wins.
// BPM declared by the code: setcpm(N/4) → N, setcpm(N) → N×4, none → 120 (strudel default).
function declaredBpm(code) {
  const frac = code.match(/setcpm\(\s*(\d+(?:\.\d+)?)\s*\/\s*4\s*\)/);
  if (frac) return Number(frac[1]);
  const plain = code.match(/setcpm\(\s*(\d+(?:\.\d+)?)\s*\)/);
  if (plain) return Number(plain[1]) * 4;
  return 120;
}

// Full track validation: required fields + meta schema + bpm↔setcpm, then the code itself.
export async function validateTrack(track, opts = {}) {
  const missing = REQUIRED_FIELDS.filter((f) => track[f] == null || (typeof track[f] === 'string' && track[f].trim() === ''));
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
  const codeResult = await validateCode(track.code);
  if (!codeResult.ok || !opts.character) return codeResult;
  const c = characterCheck(track.code);
  if (!c.ok) {
    return {
      ok: false,
      error: `lacks character: present [${c.present.join(', ') || 'none'}]; need >=3 of {harmonic, rhythmic, timbral, transform} — add e.g. an off-grid groove (euclid/swing) or dirt (crush/shape/vowel)`,
    };
  }
  return codeResult;
}

// True when the path points at a track file (gated for character), not a stem.
export function isTrackPath(arg) {
  return /(?:^|\/)tracks\/[^/]+\.json$/.test(arg);
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
    return validateTrack(track, { character: isTrackPath(arg) });
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
