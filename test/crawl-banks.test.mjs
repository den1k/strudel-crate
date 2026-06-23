import { describe, it, expect } from 'vitest';
import { crawl } from '../scripts/crawl-banks.mjs';

// This is the ONE network-gated end-to-end smoke test for the crawler. It hits
// the live `gh` code-search API and GitHub raw, so it is SKIPPED BY DEFAULT to
// keep `npm test` fully offline. Run it explicitly with:
//
//   CRAWL_LIVE_TEST=1 npx vitest run test/crawl-banks.test.mjs
//
const live = process.env.CRAWL_LIVE_TEST === '1';

describe.skipIf(!live)('crawl-banks (live network smoke test)', () => {
  it('searches one page, fetches + parses, and yields real index entries', async () => {
    const { entries, skips, totalCandidates } = await crawl({ maxPages: 1 });
    expect(totalCandidates).toBeGreaterThan(0);
    expect(entries.length).toBeGreaterThan(0);

    const e = entries[0];
    expect(e).toHaveProperty('ref');
    expect(e).toHaveProperty('repo');
    expect(e.repo).toMatch(/^[^/]+\/[^/]+$/);
    expect(e).toHaveProperty('category');
    expect(e.soundCount).toBeGreaterThan(0);
    expect(Array.isArray(e.sounds)).toBe(true);
    expect(e.description).toMatch(/·/);
    expect(typeof e.stars).toBe('number');
    expect(Array.isArray(skips)).toBe(true);
  }, 120000);
});
