// Group a flat stem list into version families.
// A version is a stem file with an optional `versionOf` pointing at its root
// stem's id; absent => the stem is its own root (version 1).
// family = versionOf ?? id. Within a family, versions are ordered by createdAt
// ascending and numbered 1..N; `latest` is the newest. Family array order
// follows first occurrence in the input (which the store sorts by filename).
export function groupVersions(stems) {
  const byFamily = new Map(); // family -> { family, versions: [] }
  for (const stem of stems) {
    const family = stem.versionOf ?? stem.id;
    if (!byFamily.has(family)) byFamily.set(family, { family, versions: [] });
    byFamily.get(family).versions.push(stem);
  }
  return [...byFamily.values()].map((fam) => {
    const versions = [...fam.versions]
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
      .map((v, i) => ({ ...v, version: i + 1 }));
    return { family: fam.family, versions, latest: versions[versions.length - 1] };
  });
}
