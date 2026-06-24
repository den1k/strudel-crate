import { describe, it, expect } from 'vitest';
import { CARD_W, CARD_H } from '../server/render-card.mjs';

describe('render-card constants', () => {
  it('are the standard OG card size', () => {
    expect(CARD_W).toBe(1200);
    expect(CARD_H).toBe(630);
  });
});

// Real render: needs system Chrome + CDN font access. Gated so `npm test` never
// launches Chrome. Run manually:
//   CRATE_RENDER_IT=1 npx vitest run test/render-card.test.mjs
const IT = process.env.CRATE_RENDER_IT === '1';
describe.runIf(IT)('render-card integration', () => {
  it('renders a song card to a non-empty PNG', async () => {
    const { createCardRenderer } = await import('../server/render-card.mjs');
    const { songCardHtml } = await import('../server/og-card.mjs');
    const renderer = createCardRenderer({});
    try {
      const buf = await renderer.render(songCardHtml({
        title: 'It Renders', artistName: 'tester',
        code: 's("bd*4")', meta: { genre: 'techno', bpm: 130, key: 'Amin' },
      }));
      expect(buf.length).toBeGreaterThan(2000);
      // PNG magic number.
      expect(buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
    } finally {
      await renderer.close();
    }
  }, 120000);
});
