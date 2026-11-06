// Digest of cross-track lessons, consumed by /generate-tracks agents.
// A song's star rating and per-song notes apply ONLY to that song and are never
// injected here — only lessons apply across the board.
//
// Lessons are first-class records (see instant.schema lessons entity): each has
// `text`, a `target` ('tracks'|'stems'), and an optional `song` provenance
// ({ namespace, slug, title } | null). buildDigest renders the provenance suffix
// only when the lesson came from a song.
import { isMain } from './lib/is-main.mjs';

export function buildDigest(lessons) {
  const present = lessons.filter((l) => l.text?.trim());
  if (present.length === 0) {
    return 'No lessons yet — no cross-track feedback to apply.';
  }
  const lines = ['## Lessons for all future tracks'];
  for (const l of present) {
    const from = l.song?.title ? ` (from "${l.song.title}")` : '';
    lines.push(`- ${l.text.trim()}${from}`);
  }
  return lines.join('\n');
}

if (isMain(import.meta.url)) {
  const { inJob, brokerCall } = await import('./lib/job-client.mjs');
  if (inJob()) {
    const res = await brokerCall('feedback');
    if (!res.ok) { console.error(`feedback: ${res.error}`); process.exit(2); }
    console.log(res.digest);
    process.exit(0);
  }
  const { adminDb, queryLessonsByProfile, queryAllLessons } = await import('./lib/instant.mjs');
  const target = process.argv[2] === 'stems' ? 'stems' : 'tracks';
  // Lessons are per-user: the runner stamps the generating user's profile id into
  // the env, so a job only ever sees its own author's lessons. Manual CLI runs
  // (no profile id) fall back to the full digest for debugging.
  const profileId = process.env.CRATE_AUTHOR_PROFILE_ID;
  // Inside a runner job (CRATE_JOB_ID is set) the author profile id must be
  // present. Falling back to the all-users digest there would leak one user's
  // lessons into another's generation — exactly what per-user scoping prevents —
  // so fail loud instead. A missing profile id is only legitimate for a manual
  // CLI run (no job), which gets the full digest for debugging.
  if (process.env.CRATE_JOB_ID && !profileId) {
    console.error('feedback: CRATE_AUTHOR_PROFILE_ID missing inside job — refusing to leak all-user lessons');
    process.exit(2);
  }
  const lessons = profileId
    ? await queryLessonsByProfile(adminDb, profileId, target)
    : await queryAllLessons(adminDb, target);
  console.log(buildDigest(lessons));
}
