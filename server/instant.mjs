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

// Set/clear the caller's rating for an item and maintain the denormalized
// aggregate (ratingSum/ratingCount) on the item. `value` is 1-5 to set, or null
// to clear. Computes the new aggregate from the currently-stored ratings plus
// this caller's delta (the row is upserted/deleted in the same transact).
// NOTE: the aggregate is delta-maintained (item.ratingCount/ratingSum ± delta),
// NOT re-summed from all ratings rows. It will NOT self-heal if ratings rows are
// removed out-of-band — e.g. deleting a profile cascades away its ratings links
// but does not decrement ratingSum/ratingCount on the item.
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

// The linked author's profile id (has-one comes back as a single-element list),
// or null when the item is unowned or missing.
export async function itemOwnerProfileId(adminDb, namespace, slug) {
  const res = await adminDb.query({ [namespace]: { author: {}, $: { where: { slug } } } });
  const item = res[namespace][0];
  return item?.author?.[0]?.id ?? null;
}

// The owner of an item's version family: the author of its root row (`versionOf`
// names the root; a root is its own family). Falls back to the row's own author
// only if the root row is gone.
export async function familyOwnerProfileId(adminDb, namespace, slug) {
  const res = await adminDb.query({ [namespace]: { author: {}, $: { where: { slug } } } });
  const item = res[namespace][0];
  if (!item) return null;
  const own = item.author?.[0]?.id ?? null;
  if (!item.versionOf) return own;
  const root = await adminDb.query({ [namespace]: { author: {}, $: { where: { slug: item.versionOf } } } });
  return root[namespace][0] ? (root[namespace][0].author?.[0]?.id ?? null) : own;
}

// Patch notes on the item and, when `patch.lesson` is present, upsert/delete the
// song's linked lesson record (the song-card "quick-add"). `notes` still lives
// as a string on the item; `lesson` is now a first-class `lessons` record linked
// to the song + its author. Returns the merged { notes, lesson } (lesson is the
// record's text, or '' when none) or null when the slug doesn't exist. Caller is
// responsible for the owner check.
//
// `callerProfileId` (the signed-in writer's profile) is the fallback owner for a
// newly-created lesson when the song has no author — e.g. an admin editing an
// unowned legacy song. Without it the lesson would be created profile-less:
// invisible to the manager, un-deletable, and never cascade-cleaned. For an
// owned song the author IS the caller, so this changes nothing there.
export async function setNotes(adminDb, namespace, slug, patch, callerProfileId = null) {
  const res = await adminDb.query({
    [namespace]: { author: {}, lessonRecord: {}, $: { where: { slug } } },
  });
  const item = res[namespace][0];
  if (!item) return null;

  const txs = [];
  if (patch.notes !== undefined) {
    txs.push(adminDb.tx[namespace][item.id].update({ notes: patch.notes ?? '' }));
  }

  // has-one reverse links come back as a (possibly empty) list — normalize to a
  // single record or null (an empty [] is truthy and would break the branches).
  const existing = (Array.isArray(item.lessonRecord) ? item.lessonRecord[0] : item.lessonRecord) || null;
  let lessonText = existing?.text ?? '';
  if (patch.lesson !== undefined) {
    const text = (patch.lesson ?? '').trim();
    const now = new Date().toISOString();
    if (!text) {
      if (existing) txs.push(adminDb.tx.lessons[existing.id].delete());
      lessonText = '';
    } else if (existing) {
      txs.push(adminDb.tx.lessons[existing.id].update({ text, updatedAt: now }));
      lessonText = text;
    } else {
      const ownerId = item.author?.[0]?.id ?? callerProfileId;
      const lessonId = id();
      const links = { [namespace === 'tracks' ? 'track' : 'stem']: item.id };
      if (ownerId) links.profile = ownerId;
      txs.push(adminDb.tx.lessons[lessonId].update({
        text, target: namespace, createdAt: now, updatedAt: now,
      }).link(links));
      lessonText = text;
    }
  }

  if (txs.length) await adminDb.transact(txs);
  return {
    notes: patch.notes !== undefined ? (patch.notes ?? '') : (item.notes ?? ''),
    lesson: lessonText,
  };
}

// --- Lessons manager: CRUD scoped to a profile -----------------------------
// A lesson is { id, text, target, createdAt, updatedAt, song } where song is
// { namespace, slug, title } or null. All helpers take an explicit profileId and
// the caller (route) is responsible for resolving + matching it.

function lessonSong(l) {
  const track = Array.isArray(l.track) ? l.track[0] : l.track;
  if (track) return { namespace: 'tracks', slug: track.slug, title: track.title };
  const stem = Array.isArray(l.stem) ? l.stem[0] : l.stem;
  if (stem) return { namespace: 'stems', slug: stem.slug, title: stem.title };
  return null;
}

function lessonView(l) {
  return {
    id: l.id, text: l.text, target: l.target,
    createdAt: l.createdAt, updatedAt: l.updatedAt, song: lessonSong(l),
  };
}

// All of a profile's lessons, newest first. `target` (optional) filters to
// 'tracks' | 'stems'.
export async function queryLessonsByProfile(adminDb, profileId, target) {
  const where = { 'profile.id': profileId };
  if (target) where.target = target;
  const { lessons } = await adminDb.query({
    lessons: { track: {}, stem: {}, $: { where } },
  });
  return lessons
    .map(lessonView)
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

// All lessons of a target type across every profile — debug-only fallback for
// manual feedback CLI runs (never used inside a job; see feedback.mjs).
export async function queryAllLessons(adminDb, target) {
  const where = target ? { target } : {};
  const { lessons } = await adminDb.query({
    lessons: { track: {}, stem: {}, $: { where } },
  });
  return lessons.map(lessonView);
}

export async function createLesson(adminDb, profileId, { text, target }) {
  const now = new Date().toISOString();
  const lessonId = id();
  await adminDb.transact(
    adminDb.tx.lessons[lessonId]
      .update({ text, target, createdAt: now, updatedAt: now })
      .link({ profile: profileId }),
  );
  return { id: lessonId, text, target, createdAt: now, updatedAt: now, song: null };
}

// Returns the lesson's owning profile id (has-one comes back as a list), or null
// when the lesson is missing.
async function lessonOwnerProfileId(adminDb, lessonId) {
  const { lessons } = await adminDb.query({
    lessons: { profile: {}, $: { where: { id: lessonId } } },
  });
  const l = lessons[0];
  if (!l) return undefined; // distinguish "missing" from "unowned"
  return l.profile?.[0]?.id ?? null;
}

// Update text and/or target. Returns the updated view, null when missing, or
// 'forbidden' when owned by a different profile.
export async function updateLesson(adminDb, profileId, lessonId, patch) {
  const owner = await lessonOwnerProfileId(adminDb, lessonId);
  if (owner === undefined) return null;
  if (owner !== profileId) return 'forbidden';
  const update = { updatedAt: new Date().toISOString() };
  if (patch.text !== undefined) update.text = patch.text;
  if (patch.target !== undefined) update.target = patch.target;
  await adminDb.transact(adminDb.tx.lessons[lessonId].update(update));
  const { lessons } = await adminDb.query({
    lessons: { track: {}, stem: {}, $: { where: { id: lessonId } } },
  });
  return lessons[0] ? lessonView(lessons[0]) : null;
}

// Delete a lesson. Returns true, null when missing, or 'forbidden'.
export async function deleteLesson(adminDb, profileId, lessonId) {
  const owner = await lessonOwnerProfileId(adminDb, lessonId);
  if (owner === undefined) return null;
  if (owner !== profileId) return 'forbidden';
  await adminDb.transact(adminDb.tx.lessons[lessonId].delete());
  return true;
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

// Rows created by a given runner job (stamped with jobId via CRATE_JOB_ID at
// insert time). The basis for per-job newItems + live progress, replacing the
// namespace-wide before/after diff so jobs can share a namespace concurrently.
export async function itemsByJob(adminDb, namespace, jobId) {
  const res = await adminDb.query({ [namespace]: { $: { where: { jobId } } } });
  return res[namespace];
}

// All items in a namespace, with their rating/notes/lesson — for feedback and
// pending-revisions digests.
export async function queryItems(adminDb, namespace) {
  const res = await adminDb.query({ [namespace]: {} });
  return res[namespace];
}

// Only the items authored by `profileId`. Lessons are per-song feedback, so the
// cross-track lessons digest must be scoped to the generating user's OWN songs —
// otherwise one user's lessons would steer everyone's future generations.
// Filters in JS (author included via the link) so it works whether Instant
// returns the has-one author as a single object or a one-element list.
export async function queryItemsByAuthor(adminDb, namespace, profileId) {
  const res = await adminDb.query({ [namespace]: { author: {} } });
  return res[namespace].filter((item) => {
    const author = Array.isArray(item.author) ? item.author[0] : item.author;
    return author?.id === profileId;
  });
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

// Resolve a /song or /card URL param ({entity id} preferred, {slug} legacy) to
// { ns, item } across the given namespaces, in the render shape the OG helpers
// and card templates expect. Mirrors src/song.js's resolveItem (id-first, then
// slug; the first namespace wins a rare slug collision). Returns null on miss.
export async function resolvePublicItem(adminDb, namespaces, param) {
  const map = (row, ns) => {
    const author = Array.isArray(row.author) ? row.author[0] : row.author;
    return {
      ns,
      item: {
        entityId: row.id,
        slug: row.slug,
        title: row.title,
        description: row.description,
        code: row.code,
        meta: row.meta,
        artistName: author?.artistName ?? null,
      },
    };
  };
  for (const ns of namespaces) {
    const res = await adminDb.query({ [ns]: { author: {}, $: { where: { id: param } } } });
    if (res[ns][0]) return map(res[ns][0], ns);
  }
  for (const ns of namespaces) {
    const res = await adminDb.query({ [ns]: { author: {}, $: { where: { slug: param } } } });
    if (res[ns][0]) return map(res[ns][0], ns);
  }
  return null;
}

// Insert a validated track/stem object. `track.id` becomes `slug`. Rejects a
// duplicate slug. Links author when a profile id is given.
export async function insertItem(adminDb, namespace, track, authorProfileId, { jobId = process.env.CRATE_JOB_ID } = {}) {
  const existing = await itemsBySlug(adminDb, namespace, [track.id]);
  if (existing.length) return { ok: false, error: `slug already exists: ${track.id}` };
  // versionOf is agent-written, so this is the control that keeps a family's versions
  // with its owner. Manual CLI runs (no job, no author) stay unrestricted.
  if (track.versionOf && (authorProfileId || jobId)) {
    const rootOwner = await itemOwnerProfileId(adminDb, namespace, track.versionOf);
    if (!authorProfileId || rootOwner !== authorProfileId) {
      return { ok: false, error: `not the owner of family: ${track.versionOf}` };
    }
  }
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
    notes: track.notes ?? '',
    lesson: track.lesson ?? '',
  };
  if (track.versionOf) update.versionOf = track.versionOf;
  if (track.remixOf) update.remixOf = track.remixOf;
  // Stamp the runner job that created this row: passed by the job broker, absent for
  // manual CLI runs.
  if (jobId) update.jobId = jobId;
  let tx = adminDb.tx[namespace][entId].update(update);
  if (authorProfileId) tx = tx.link({ author: authorProfileId });
  await adminDb.transact(tx);
  return { ok: true, id: entId };
}
