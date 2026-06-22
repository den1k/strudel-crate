// scripts/palette.mjs
// The bespoke-per-batch KIT artifact (Phase 2, Shift B).
//
// A palette is a batch's instrument kit: a handful of named, designed voice
// fragments (a kick, a bass, a lead, a pad, …), each a validated Strudel
// sub-expression that may carry its own samples() preamble. Stage 1 (kit design)
// writes palettes/<batch>.json; Stage 2 (compose) injects the voice frags into
// each compose agent's prompt, where they are pasted/adapted as stack layers
// inside ONE arrange()/stack() expression — so a composed track is still a single
// expression validated by the Phase 1 dynamic validator.
//
// Palette schema (palettes/<batch>.json):
//   {
//     "batch":     "<batch id>",
//     "brief":     "<the batch sound brief the kit was designed from>",
//     "createdAt": "<ISO timestamp>",
//     "samples":   ["github:user/repo", ...],   // optional batch-level loads
//     "voices": [
//       { "role": "kick", "name": "Thump",
//         "samples": ["github:user/repo"],       // optional, this voice's loads
//         "frag": "s(\"...\")...",                // a Strudel sub-expression (no setcpm, no arrange)
//         "note": "<design intent>" },
//       ...   // >=4 voices, >=3 distinct roles
//     ]
//   }
// The effective sample set = union of batch + every voice's samples.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCode } from './validate.mjs';
import { extractSampleRefs } from './lib/sample-cache.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PALETTES_DIR = join(ROOT, 'palettes');

// The canonical kit roles. A batch kit picks a sensible subset (need >=4 voices,
// >=3 distinct roles); roles may repeat (e.g. two textures) but the kit must span.
export const KIT_ROLES = ['kick', 'perc', 'bass', 'lead', 'pad', 'vocal', 'texture'];

const MIN_VOICES = 4;
const MIN_DISTINCT_ROLES = 3;

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

// ---- shape validation (cheap, synchronous) ---------------------------------

export function validatePaletteShape(palette) {
  if (palette == null || typeof palette !== 'object' || Array.isArray(palette)) {
    return { ok: false, error: 'palette must be an object' };
  }
  for (const f of ['batch', 'brief', 'createdAt']) {
    if (!isNonEmptyString(palette[f])) return { ok: false, error: `palette.${f} must be a non-empty string` };
  }
  if (palette.samples != null && !(Array.isArray(palette.samples) && palette.samples.every(isNonEmptyString))) {
    return { ok: false, error: 'palette.samples must be an array of source strings' };
  }
  if (!Array.isArray(palette.voices)) return { ok: false, error: 'palette.voices must be an array' };
  if (palette.voices.length < MIN_VOICES) {
    return { ok: false, error: `palette.voices must have at least ${MIN_VOICES} voices` };
  }
  for (const [i, v] of palette.voices.entries()) {
    if (v == null || typeof v !== 'object') return { ok: false, error: `voice ${i} must be an object` };
    if (!KIT_ROLES.includes(v.role)) {
      return { ok: false, error: `voice ${i} role "${v.role}" is not one of: ${KIT_ROLES.join(', ')}` };
    }
    if (!isNonEmptyString(v.name)) return { ok: false, error: `voice ${i} must have a name` };
    if (!isNonEmptyString(v.frag)) return { ok: false, error: `voice ${i} must have a frag (Strudel sub-expression)` };
    if (v.samples != null && !(Array.isArray(v.samples) && v.samples.every(isNonEmptyString))) {
      return { ok: false, error: `voice ${i} samples must be an array of source strings` };
    }
  }
  const distinctRoles = new Set(palette.voices.map((v) => v.role));
  if (distinctRoles.size < MIN_DISTINCT_ROLES) {
    return { ok: false, error: `a kit must span at least ${MIN_DISTINCT_ROLES} distinct roles (got ${distinctRoles.size})` };
  }
  return { ok: true };
}

// ---- sample-set helpers ----------------------------------------------------

// De-duplicated union of batch-level + per-voice samples, in first-seen order.
// Falls back to scanning frags for inline samples() calls, so a voice that only
// declares its load in the frag is still counted.
export function effectiveSamples(palette) {
  const seen = new Set();
  const out = [];
  const add = (s) => { if (isNonEmptyString(s) && !seen.has(s)) { seen.add(s); out.push(s); } };
  for (const s of palette.samples ?? []) add(s);
  for (const v of palette.voices ?? []) {
    for (const s of v.samples ?? []) add(s);
    for (const s of extractSampleRefs(v.frag ?? '')) add(s);
  }
  return out;
}

// One samples() statement per effective source — the preamble Stage 2 hoists
// above the composed arrange()/stack().
export function composePreamble(palette) {
  return effectiveSamples(palette).map((s) => `samples(${JSON.stringify(s)})`).join('\n');
}

// A voice's own samples() preamble (declared sources ∪ inline refs in the frag).
function voicePreamble(voice) {
  const seen = new Set();
  const sources = [];
  for (const s of [...(voice.samples ?? []), ...extractSampleRefs(voice.frag ?? '')]) {
    if (!seen.has(s)) { seen.add(s); sources.push(s); }
  }
  return sources.map((s) => `samples(${JSON.stringify(s)})`).join('\n');
}

// Wrap a single voice into a runnable, validatable program (its samples preamble
// + a one-layer stack), exactly how a stem is validated in Phase 1.
export function voiceProgram(voice) {
  const preamble = voicePreamble(voice);
  const body = `stack(\n  ${voice.frag}\n)`;
  return preamble ? `${preamble}\n${body}` : body;
}

// ---- full validation (validates every voice like a stem) -------------------

export async function validatePalette(palette) {
  const shape = validatePaletteShape(palette);
  if (!shape.ok) return { ok: false, error: shape.error, voices: [] };
  const voices = [];
  for (const v of palette.voices) {
    const res = await validateCode(voiceProgram(v));
    voices.push({ role: v.role, name: v.name, ok: res.ok, error: res.error });
  }
  const ok = voices.every((v) => v.ok);
  const error = ok ? undefined : `voice "${voices.find((v) => !v.ok).name}" failed: ${voices.find((v) => !v.ok).error}`;
  return { ok, error, voices };
}

// ---- save / load (validate AND persist) ------------------------------------

export async function savePalette(palette, { palettesDir = DEFAULT_PALETTES_DIR } = {}) {
  const result = await validatePalette(palette);
  if (!result.ok) return { ok: false, error: result.error, voices: result.voices };
  await mkdir(palettesDir, { recursive: true });
  await writeFile(join(palettesDir, `${palette.batch}.json`), JSON.stringify(palette, null, 2) + '\n');
  return { ok: true, voices: result.voices };
}

export async function loadPalette(batch, { palettesDir = DEFAULT_PALETTES_DIR } = {}) {
  return JSON.parse(await readFile(join(palettesDir, `${batch}.json`), 'utf8'));
}
