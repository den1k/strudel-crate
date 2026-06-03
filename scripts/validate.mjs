// Validate a Strudel code string headlessly: it must transpile, evaluate to
// a Pattern, and produce events when queried.
// NOTE: evaluate() executes the input string as JS in this process. Inputs are
// trusted agent-generated Strudel code (reviewed via the webapp), not untrusted user input.
import { evaluate } from '@strudel/transpiler';
import { Pattern } from '@strudel/core';
import { initStrudelEnv } from './strudel-env.mjs';

const QUERY_CYCLES = 8;

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
  return { ok: true, events: haps.length };
}
