// Print the note-driven revision work list as JSON, consumed by the
// revise-from-notes skill. Usage: node scripts/pending-revisions.mjs <stems|tracks>
import { fileURLToPath } from 'node:url';
import { pendingRevisions } from '../src/versions.js';

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const { adminDb, queryItems } = await import('./lib/instant.mjs');
  const ns = process.argv[2] === 'stems' ? 'stems' : 'tracks';
  const rows = (await queryItems(adminDb, ns)).map((r) => ({ ...r, id: r.slug }));
  console.log(JSON.stringify(pendingRevisions(rows), null, 2));
}
