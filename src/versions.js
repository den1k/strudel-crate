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

// Select families whose LATEST version carries a non-empty note and describe
// the next version to generate. Linear chains mean "latest with a note" == "a
// noted item that hasn't had a newer version yet". The new version's title is
// based on the ROOT (v1) title so suffixes don't stack ("Aaa v3", not "Aaa v2 v3").
export function pendingRevisions(items) {
  return groupVersions(items)
    .filter((fam) => fam.latest.notes?.trim())
    .map((fam) => {
      const version = fam.latest.version + 1;
      return {
        root: fam.family,
        nextId: `${fam.family}-v${version}`,
        version,
        note: fam.latest.notes.trim(),
        code: fam.latest.code,
        batch: fam.latest.batch,
        prompt: fam.latest.prompt,
        title: fam.versions[0].title,
      };
    });
}

// Count distinct version-families from raw Instant rows. Rows carry `slug`
// (the human id) and optional `versionOf` (pointing at the root slug), so map
// to the {id, versionOf} shape groupVersions expects before grouping.
export function familyCount(rows) {
  return groupVersions(
    rows.map((r) => ({ id: r.slug ?? r.id, versionOf: r.versionOf })),
  ).length;
}
