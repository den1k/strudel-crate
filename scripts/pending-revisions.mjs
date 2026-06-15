// Print the note-driven revision work list as JSON, consumed by the
// revise-from-notes skill. Usage: node scripts/pending-revisions.mjs <stems|tracks>
import { fileURLToPath } from 'node:url';
import { createStore } from '../server/store.mjs';
import { pendingRevisions } from '../src/versions.js';

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const store = process.argv[2] === 'stems'
    ? createStore({ tracksDir: 'stems', ratingsDir: 'data/stem-ratings' })
    : createStore({ tracksDir: 'tracks', ratingsDir: 'data/ratings' });
  console.log(JSON.stringify(pendingRevisions(await store.listTracks()), null, 2));
}
