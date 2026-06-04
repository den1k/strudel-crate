const DEFAULT_CYCLES = 32; // tracks without arrange (rare) get a fixed-length export
const MAX_CYCLES = 512; // matches the validator's full-arrangement scan window

// Generated track code formats arrange sections at line starts: `  [12, stack(`.
// Mini-notation brackets ("[a2,c3,e3]") never start a line, so a line-anchored
// match on `[<digits>,` only sees section weights.
export function parseArrangeCycles(code) {
  if (!/\barrange\s*\(/.test(code)) return null;
  const weights = [...code.matchAll(/^\s*\[\s*(\d+)\s*,/gm)].map((m) => Number(m[1]));
  const total = weights.reduce((sum, w) => sum + w, 0);
  return total > 0 ? total : null;
}

// cps from metadata: the validator enforces the setcpm(bpm/4) convention,
// so cps = (bpm/4) cpm / 60 = bpm/240.
export function exportSpec(track) {
  const cps = track.meta.bpm / 240;
  const cycles = Math.min(parseArrangeCycles(track.code) ?? DEFAULT_CYCLES, MAX_CYCLES);
  return { cps, cycles, seconds: cycles / cps };
}
