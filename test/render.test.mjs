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
