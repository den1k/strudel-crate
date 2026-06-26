import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { initStrudelEnv } from '../scripts/strudel-env.mjs';
import { renderTrack } from '../src/render.js';

beforeAll(() => initStrudelEnv());

describe('render.js superdough instance', () => {
  // Regression guard for the silent-export bug: render.js must import every
  // superdough symbol through @strudel/webaudio. Importing from the bare
  // `superdough` package (or a `superdough/...` subpath) pulls in a SECOND
  // superdough copy with its own audio-context global that setAudioContext()
  // never updates, so effect nodes (reverb/delay) live on a different context
  // and silently fail to connect ("different audio context"). Browser-only, so
  // this static check is the cheapest way to keep the single-instance invariant.
  it('never imports superdough directly (single-instance invariant)', async () => {
    const src = await readFile(fileURLToPath(new URL('../src/render.js', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/from\s+['"]superdough/);
  });
});

describe('renderHapsToBuffer init order', () => {
  // Regression guard for the "wav export works once, then every later export
  // fails" bug. After a render, its OfflineAudioContext closes, but superdough's
  // module-level controller still references it. On the NEXT render,
  // resetGlobalEffects() rebuilds effect nodes on that CLOSED context and throws
  // InvalidStateError (browser-only — Node web-audio polyfills don't enforce the
  // closed-context rule, which is why this slips past runtime tests). The
  // controller MUST be nulled BEFORE resetGlobalEffects() runs. Static
  // source-order check, in the same spirit as the single-instance guard above.
  it('nulls the superdough controller before resetGlobalEffects()', async () => {
    const src = await readFile(fileURLToPath(new URL('../src/render.js', import.meta.url)), 'utf8');
    // Match the actual statement lines (start-of-line + indentation), not any
    // mention inside a comment, so prose can't fool the order check.
    const nullIdx = src.search(/^\s*setSuperdoughAudioController\(null\)/m);
    const resetIdx = src.search(/^\s*resetGlobalEffects\(\)/m);
    expect(nullIdx, 'setSuperdoughAudioController(null) call present').toBeGreaterThan(-1);
    expect(resetIdx, 'resetGlobalEffects() call present').toBeGreaterThan(-1);
    expect(nullIdx, 'controller nulled before resetGlobalEffects()').toBeLessThan(resetIdx);
  });
});

describe('renderTrack', () => {
  it('rejects code that does not evaluate to a pattern', async () => {
    // `42` evaluates fine but is not a Pattern → guard must throw before any audio API
    await expect(renderTrack({ code: '42', meta: { bpm: 120 } }, 'wav')).rejects.toThrow(
      /did not evaluate to a pattern/,
    );
  });

  it('throws on evaluation failure without touching the audio context', async () => {
    await expect(renderTrack({ code: 'note("c3"', meta: { bpm: 120 } }, 'wav')).rejects.toThrow();
  });
});
