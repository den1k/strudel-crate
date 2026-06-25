// test/allowlist.test.mjs — the cached, admin-always-allowed server allowlist.
import { describe, it, expect } from 'vitest';
import { createAllowlist } from '../server/allowlist.mjs';

const ADMIN = 'kalavox@gmail.com';

// adminDb stub: query() returns the current `rows`, counting calls. `fail`
// makes the next query throw, to exercise stale-serving.
function stubDb(rows) {
  const db = {
    queries: 0,
    fail: false,
    rows,
    async query() {
      db.queries++;
      if (db.fail) throw new Error('instant down');
      return { allowlist: db.rows };
    },
  };
  return db;
}

describe('createAllowlist', () => {
  it('always allows the admin email, without querying', async () => {
    const db = stubDb([]);
    const al = createAllowlist({ adminDb: db, adminEmail: ADMIN });
    expect(await al.isAllowed('KalaVox@Gmail.com')).toBe(true);
    expect(db.queries).toBe(0);
  });

  it('allows an email present in the Instant list', async () => {
    const db = stubDb([{ email: 'jakewrfoster@gmail.com' }]);
    const al = createAllowlist({ adminDb: db, adminEmail: ADMIN });
    expect(await al.isAllowed('JakeWRFoster@gmail.com')).toBe(true);
    expect(await al.isAllowed('stranger@example.com')).toBe(false);
  });

  it('caches within the TTL and refreshes after it expires', async () => {
    let t = 1000;
    const db = stubDb([{ email: 'a@x.com' }]);
    const al = createAllowlist({ adminDb: db, adminEmail: ADMIN, ttlMs: 100, now: () => t });
    expect(await al.isAllowed('a@x.com')).toBe(true); // first query
    expect(db.queries).toBe(1);
    db.rows = [{ email: 'b@x.com' }];
    await al.isAllowed('a@x.com');                    // still cached
    expect(db.queries).toBe(1);
    t = 1200;                                          // past TTL
    expect(await al.isAllowed('b@x.com')).toBe(true); // re-queried
    expect(db.queries).toBe(2);
  });

  it('serves the last good set when a refresh query fails', async () => {
    let t = 1000;
    const db = stubDb([{ email: 'a@x.com' }]);
    const al = createAllowlist({ adminDb: db, adminEmail: ADMIN, ttlMs: 100, now: () => t });
    expect(await al.isAllowed('a@x.com')).toBe(true);
    t = 2000; db.fail = true;
    expect(await al.isAllowed('a@x.com')).toBe(true); // stale-but-good
    expect(db.queries).toBe(2);
    expect(await al.isAllowed('nope@x.com')).toBe(false);
  });

  it('rejects everyone but the admin when adminDb is null', async () => {
    const al = createAllowlist({ adminDb: null, adminEmail: ADMIN });
    expect(await al.isAllowed(ADMIN)).toBe(true);
    expect(await al.isAllowed('a@x.com')).toBe(false);
  });
});
