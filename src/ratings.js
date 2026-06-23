// Pure helpers for per-user ratings + the denormalized aggregate.
export function aggregateAvg(item) {
  const count = item?.ratingCount ?? 0;
  if (!count) return null;
  return Math.round(((item.ratingSum ?? 0) / count) * 10) / 10;
}
export function isTopAggregate(item) {
  const avg = aggregateAvg(item);
  return avg != null && avg >= 4;
}
export function myRatingOf(state, slug) {
  return state?.myRatings?.[slug] ?? null;
}
// Is this normalized track/stem owned by the signed-in profile? The `author`
// link is has-one, which InstaQL returns as a single OBJECT — so the source of
// truth is the normalized `authorProfileId` (see mapRow), never `author[0].id`.
// Indexing the array shape here silently made every card non-owned and hid the
// owner-only notes/lessons inputs.
export function isOwnedBy(item, profileId) {
  return profileId != null && item?.authorProfileId != null && item.authorProfileId === profileId;
}
