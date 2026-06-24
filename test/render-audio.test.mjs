import { describe, it, expect } from 'vitest';
import { renderId, b64ToBuffer } from '../server/render-audio.mjs';

describe('render-audio helpers', () => {
  it('renderId combines slug and format the way export-render expects', () => {
    expect(renderId({ id: 'demo-01' }, 'wav')).toBe('demo-01:wav');
  });
  it('b64ToBuffer round-trips bytes', () => {
    const b = Buffer.from([0, 1, 2, 250, 255]);
    expect(b64ToBuffer(b.toString('base64')).equals(b)).toBe(true);
  });
});

// Real render: needs system Chrome + a server serving /export-render.html + CDN
// access. Gated so `npm test` never launches Chrome. Run manually:
//   CRATE_RENDER_IT=1 CRATE_RENDER_URL=http://localhost:3008/export-render.html \
//     npx vitest run test/render-audio.test.mjs
const IT = process.env.CRATE_RENDER_IT === '1';
describe.runIf(IT)('render-audio integration', () => {
  it('renders a tiny track to a non-empty RIFF/WAV', async () => {
    const { createRenderer } = await import('../server/render-audio.mjs');
    const renderer = createRenderer({ pageUrl: process.env.CRATE_RENDER_URL });
    try {
      // 2 cycles of a single synth note — fast to render.
      const track = { id: 'it-tiny', code: 'note("c3 e3").s("supersaw")', meta: { bpm: 120 } };
      const buf = await renderer.render(track, 'wav');
      expect(buf.length).toBeGreaterThan(1000);
      expect(buf.subarray(0, 4).toString('ascii')).toBe('RIFF');
    } finally {
      await renderer.close();
    }
  }, 120000);
});
