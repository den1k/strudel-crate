// Pure planner for the legacy rating → ratings migration. See the migration
// script for the side-effecting runner.
export function planRatingMigration(items) {
  const creates = [];
  const patches = [];
  for (const it of items) {
    if (it.rating == null) continue;
    patches.push({ slug: it.slug, ratingSum: it.rating, ratingCount: 1 });
    if (it.authorProfileId) {
      creates.push({ slug: it.slug, value: it.rating, profileId: it.authorProfileId, updatedAt: it.createdAt });
    }
  }
  return { creates, patches };
}
