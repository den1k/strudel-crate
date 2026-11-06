// Print the note-driven revision work list as JSON, consumed by the
// revise-from-notes skill. Usage: node scripts/pending-revisions.mjs <stems|tracks>
// Inside a job the list is scoped to the requester's own song families.
import { fileURLToPath } from 'node:url';
import { buildWorklist } from '../src/versions.js';

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const { adminDb } = await import('./lib/instant.mjs');
  const ns = process.argv[2] === 'stems' ? 'stems' : 'tracks';
  const res = await adminDb.query({ [ns]: { author: {} } });
  const rows = res[ns].map((r) => {
    const author = Array.isArray(r.author) ? r.author[0] : r.author;
    return { ...r, id: r.slug, authorProfileId: author?.id ?? null };
  });
  try {
    const list = buildWorklist(rows, {
      profileId: process.env.CRATE_AUTHOR_PROFILE_ID,
      inJob: Boolean(process.env.CRATE_JOB_ID),
    });
    console.log(JSON.stringify(list, null, 2));
  } catch (err) {
    console.error(`pending-revisions: ${err.message}`);
    process.exit(2);
  }
}
