// Print the note-driven revision work list as JSON, consumed by the
// revise-from-notes skill. Usage: node scripts/pending-revisions.mjs <stems|tracks>
// Inside a job the list is scoped to the requester's own song families.
import { buildWorklist } from '../src/versions.js';
import { isMain } from './lib/is-main.mjs';

if (isMain(import.meta.url)) {
  const { inJob, brokerCall } = await import('./lib/job-client.mjs');
  if (inJob()) {
    const res = await brokerCall('pending-revisions');
    if (!res.ok) { console.error(`pending-revisions: ${res.error}`); process.exit(2); }
    console.log(JSON.stringify(res.list, null, 2));
    process.exit(0);
  }
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
