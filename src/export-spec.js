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

// Collect onset haps one cycle at a time, in ascending onset order.
// Why per-cycle instead of a single queryArc(0, cycles): some valid-enough
// tracks contain mini-notation that throws mid-query (e.g. `<…> / <notes>`,
// where the slow operator divides by a non-numeric pattern → NaN Fraction →
// "Invalid argument"). strudel's queryArc swallows that throw and returns []
// for the WHOLE range, so a one-shot full query rendered total silence. The
// live scheduler queries cycle by cycle, so it only loses the offending cycle;
// the export now does the same — one bad cycle can't zero the whole render.
export function collectHaps(pattern, cycles, cps) {
  const haps = [];
  for (let cycle = 0; cycle < cycles; cycle++) {
    let cycleHaps;
    try {
      cycleHaps = pattern.queryArc(cycle, cycle + 1, { _cps: cps });
    } catch (err) {
      console.warn(`[export] cycle ${cycle} query failed: ${err.message}`);
      continue;
    }
    for (const hap of cycleHaps) {
      if (hap.hasOnset()) haps.push(hap);
    }
  }
  return haps.sort((a, b) => a.whole.begin.valueOf() - b.whole.begin.valueOf());
}

// The stem key for a hap: its sound name (`s`), falling back to 'synth' for
// note-only haps with no explicit sound. A track normally uses one drum bank,
// so the bare sound name is a stable per-instrument key across the arrangement.
export function stemName(hap) {
  const v = hap.value;
  return v && typeof v === 'object' && typeof v.s === 'string' ? v.s : 'synth';
}

// Group onset haps by sound into [{ name, haps }], sorted by name for
// deterministic stem ordering/filenames. Used to render one WAV per sound.
export function groupHapsBySound(haps) {
  const groups = new Map();
  for (const hap of haps) {
    const key = stemName(hap);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(hap);
  }
  return [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, hs]) => ({ name, haps: hs }));
}
