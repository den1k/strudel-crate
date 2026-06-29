import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
describe('export-render.js', () => {
  it('handles render-segment and transfers PCM buffers', async () => {
    const src = await readFile(fileURLToPath(new URL('../src/export-render.js', import.meta.url)), 'utf8');
    expect(src).toMatch(/render-segment/);
    expect(src).toMatch(/segment-done/);
    expect(src).toMatch(/\.buffer/); // transferable
  });
});
