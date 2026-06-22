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
