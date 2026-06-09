import { describe, it, expect, beforeAll } from 'vitest';
import { initStrudelEnv } from '../scripts/strudel-env.mjs';
import { renderTrack } from '../src/render.js';

beforeAll(() => initStrudelEnv());

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
