// scripts/save-track.mjs <staging/file.json>
// Validate a generated track (incl. character gate) and transact it to Instant
// `tracks`, linked to CRATE_AUTHOR_PROFILE_ID. Deletes the staging file on
// success. Prints "PASS <slug>" / "FAIL <slug> — <reason>" (exit 0/1).
import { readFile, unlink } from 'node:fs/promises';
import { validateTrack } from './validate.mjs';
import { adminDb, insertItem } from './lib/instant.mjs';

const NAMESPACE = 'tracks';
const CHARACTER = true;

async function main() {
  const file = process.argv[2];
  if (!file) { console.error('usage: node scripts/save-track.mjs <staging/file.json>'); process.exit(2); }

  let track;
  try {
    track = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    console.log(`FAIL ${file} — unreadable JSON: ${err.message}`);
    process.exit(1);
  }

  const result = await validateTrack(track, { character: CHARACTER });
  if (!result.ok) { console.log(`FAIL ${track.id ?? file} — ${result.error}`); process.exit(1); }

  const authorProfileId = process.env.CRATE_AUTHOR_PROFILE_ID || null;
  const saved = await insertItem(adminDb, NAMESPACE, track, authorProfileId);
  if (!saved.ok) { console.log(`FAIL ${track.id} — ${saved.error}`); process.exit(1); }

  try { await unlink(file); } catch { /* best effort */ }
  console.log(`PASS ${track.id}`);
}

main();
