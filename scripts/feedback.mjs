// Digest of cross-track lessons, consumed by /generate-tracks agents.
// A song's star rating and per-song notes apply ONLY to that song and are never
// injected here — only lessons apply across the board.
import { fileURLToPath } from 'node:url';

export function buildDigest(tracks) {
  const lessons = tracks.filter((t) => t.lesson?.trim());
  if (lessons.length === 0) {
    return 'No lessons yet — no cross-track feedback to apply.';
  }
  const lines = ['## Lessons for all future tracks'];
  for (const t of lessons) {
    lines.push(`- ${t.lesson.trim()} (from "${t.title}")`);
  }
  return lines.join('\n');
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const { adminDb, queryItems, queryItemsByAuthor } = await import('./lib/instant.mjs');
  const ns = process.argv[2] === 'stems' ? 'stems' : 'tracks';
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
  const items = profileId
    ? await queryItemsByAuthor(adminDb, ns, profileId)
    : await queryItems(adminDb, ns);
  console.log(buildDigest(items));
}
