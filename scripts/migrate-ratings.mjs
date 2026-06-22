// One-off: backfill ratings rows + item aggregates from the legacy `rating`
// field, for both collections. Idempotent-ish: re-running re-creates rows, so
// run once. Usage: node scripts/migrate-ratings.mjs
import { id } from '@instantdb/admin';
import { adminDb } from './lib/instant.mjs';
import { planRatingMigration } from '../src/ratings-migrate.js';

for (const ns of ['tracks', 'stems']) {
  const res = await adminDb.query({ [ns]: { author: {} } });
  const items = res[ns].map((r) => ({
    slug: r.slug, rating: r.rating ?? null,
    authorProfileId: r.author?.[0]?.id ?? null,
    createdAt: r.createdAt,
    _id: r.id,
  }));
  const bySlug = new Map(items.map((it) => [it.slug, it._id]));
  const { creates, patches } = planRatingMigration(items);

  const txs = [];
  for (const c of creates) {
    txs.push(adminDb.tx.ratings[id()]
      .update({ namespace: ns, slug: c.slug, value: c.value, updatedAt: c.updatedAt })
      .link({ profile: c.profileId }));
  }
  for (const p of patches) {
    txs.push(adminDb.tx[ns][bySlug.get(p.slug)].update({ ratingSum: p.ratingSum, ratingCount: p.ratingCount }));
  }
  if (txs.length) await adminDb.transact(txs);
  console.log(`${ns}: ${creates.length} ratings rows, ${patches.length} aggregates`);
}
