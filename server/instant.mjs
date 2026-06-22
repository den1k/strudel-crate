// server/instant.mjs
// Instant admin helpers. adminDb is injected (real client in prod, fake in tests).
import { id } from '@instantdb/admin';

// Returns the profile id for a user, creating one (artistName = email local part)
// if none is linked yet. Idempotent.
export async function ensureProfile(adminDb, user) {
  const { profiles } = await adminDb.query({ profiles: { $: { where: { 'user.id': user.id } } } });
  if (profiles[0]) return profiles[0].id;
  const profileId = id();
  const artistName = (user.email || 'artist').split('@')[0];
  await adminDb.transact(
    adminDb.tx.profiles[profileId].update({ artistName, createdAt: new Date().toISOString() }).link({ user: user.id }),
  );
  return profileId;
}

export async function getProfile(adminDb, user) {
  const profileId = await ensureProfile(adminDb, user);
  const { profiles } = await adminDb.query({ profiles: { $: { where: { id: profileId } } } });
  const p = profiles[0] ?? { id: profileId, artistName: (user.email || 'artist').split('@')[0] };
  return { id: p.id, artistName: p.artistName };
}

export async function setArtistName(adminDb, user, artistName) {
  const profileId = await ensureProfile(adminDb, user);
  await adminDb.transact(adminDb.tx.profiles[profileId].update({ artistName }));
  return { id: profileId, artistName };
}

// Patch shared rating fields on the item with the given slug. Returns the merged
// {rating, notes, lesson} or null if no item matches.
export async function saveRating(adminDb, namespace, slug, { rating, notes, lesson }) {
  const res = await adminDb.query({ [namespace]: { $: { where: { slug } } } });
  const item = res[namespace][0];
  if (!item) return null;
  const patch = {};
  if (rating !== undefined) patch.rating = rating; // null clears
  if (notes !== undefined) patch.notes = notes ?? '';
  if (lesson !== undefined) patch.lesson = lesson ?? '';
  await adminDb.transact(adminDb.tx[namespace][item.id].update(patch));
  return {
    rating: 'rating' in patch ? patch.rating : (item.rating ?? null),
    notes: 'notes' in patch ? patch.notes : (item.notes ?? ''),
    lesson: 'lesson' in patch ? patch.lesson : (item.lesson ?? ''),
  };
}

// Set/clear the caller's rating for an item and maintain the denormalized
// aggregate (ratingSum/ratingCount) on the item. `value` is 1-5 to set, or null
// to clear. Computes the new aggregate from the currently-stored ratings plus
// this caller's delta (the row is upserted/deleted in the same transact).
// Returns { you, avg, count } or null when the slug doesn't exist.
export async function setRating(adminDb, namespace, slug, profileId, value) {
  const res = await adminDb.query({ [namespace]: { $: { where: { slug } } } });
  const item = res[namespace][0];
  if (!item) return null;

  const found = await adminDb.query({
    ratings: { $: { where: { namespace, slug, 'profile.id': profileId } } },
  });
  const existing = found.ratings[0];
  const prev = existing ? (existing.value ?? 0) : 0;

  let count = item.ratingCount ?? 0;
  let sum = item.ratingSum ?? 0;
  const txs = [];
  const now = new Date().toISOString();

  if (value == null) {
    if (existing) {
      sum -= prev;
      count -= 1;
      txs.push(adminDb.tx.ratings[existing.id].delete());
    }
  } else if (existing) {
    sum += value - prev;
    txs.push(adminDb.tx.ratings[existing.id].update({ value, updatedAt: now }));
  } else {
    sum += value;
    count += 1;
    txs.push(
      adminDb.tx.ratings[id()]
        .update({ namespace, slug, value, updatedAt: now })
        .link({ profile: profileId }),
    );
  }

  txs.push(adminDb.tx[namespace][item.id].update({ ratingSum: sum, ratingCount: count }));
  await adminDb.transact(txs);

  return {
    you: value == null ? null : value,
    avg: count ? Math.round((sum / count) * 10) / 10 : null,
    count,
  };
}

export async function itemSlugs(adminDb, namespace) {
  const res = await adminDb.query({ [namespace]: {} });
  return new Set(res[namespace].map((i) => i.slug));
}

export async function itemsBySlug(adminDb, namespace, slugs) {
  if (!slugs.length) return [];
  const res = await adminDb.query({ [namespace]: { $: { where: { slug: { $in: slugs } } } } });
  return res[namespace];
}

// All items in a namespace, with their rating/notes/lesson — for feedback and
// pending-revisions digests.
export async function queryItems(adminDb, namespace) {
  const res = await adminDb.query({ [namespace]: {} });
  return res[namespace];
}

// Record a play of <namespace>/<slug>. Always bumps the item's total playCount
// (read-modify-write — under concurrent plays an increment can be lost; accepted
// at this scale). When `user` is given, upserts that user's per-item plays
// record. Returns { playCount, you } or null when the slug doesn't exist.
export async function recordPlay(adminDb, namespace, slug, user) {
  const res = await adminDb.query({ [namespace]: { $: { where: { slug } } } });
  const item = res[namespace][0];
  if (!item) return null;
  const playCount = (item.playCount ?? 0) + 1;
  await adminDb.transact(adminDb.tx[namespace][item.id].update({ playCount }));

  let you;
  if (user) {
    const profileId = await ensureProfile(adminDb, user);
    const found = await adminDb.query({
      plays: { $: { where: { namespace, slug, 'profile.id': profileId } } },
    });
    const existing = found.plays[0];
    const now = new Date().toISOString();
    if (existing) {
      you = (existing.count ?? 0) + 1;
      await adminDb.transact(adminDb.tx.plays[existing.id].update({ count: you, lastPlayedAt: now }));
    } else {
      you = 1;
      const playId = id();
      await adminDb.transact(
        adminDb.tx.plays[playId]
          .update({ namespace, slug, count: 1, lastPlayedAt: now })
          .link({ profile: profileId }),
      );
    }
  }
  return { playCount, you };
}

// Insert a validated track/stem object. `track.id` becomes `slug`. Rejects a
// duplicate slug. Links author when a profile id is given.
export async function insertItem(adminDb, namespace, track, authorProfileId) {
  const existing = await itemsBySlug(adminDb, namespace, [track.id]);
  if (existing.length) return { ok: false, error: `slug already exists: ${track.id}` };
  const entId = id();
  const update = {
    slug: track.id,
    title: track.title,
    prompt: track.prompt,
    batch: track.batch,
    description: track.description,
    code: track.code,
    meta: track.meta,
    createdAt: track.createdAt,
    isPublic: true,
    rating: track.rating ?? null,
    notes: track.notes ?? '',
    lesson: track.lesson ?? '',
  };
  if (track.versionOf) update.versionOf = track.versionOf;
  let tx = adminDb.tx[namespace][entId].update(update);
  if (authorProfileId) tx = tx.link({ author: authorProfileId });
  await adminDb.transact(tx);
  return { ok: true, id: entId };
}
