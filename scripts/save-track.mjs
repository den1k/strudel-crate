// scripts/save-track.mjs <staging/file.json>
// Validate a generated track (incl. character gate) and transact it to Instant
// `tracks`, linked to CRATE_AUTHOR_PROFILE_ID. Deletes the staging file on
// success. Prints "PASS <slug>" / "FAIL <slug> — <reason>" (exit 0/1).
import { readFile, unlink } from 'node:fs/promises';
import { validateTrack } from './validate.mjs';
import { adminDb, insertItem } from './lib/instant.mjs';
import { cacheTrackSamples } from './lib/sample-cache.mjs';

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

  // Cache-on-save: vendor any self-declared sample banks so the saved track
  // survives an upstream repo vanishing. Best-effort — a vendoring miss warns
  // but does not block the save (the track still validated against live banks).
  try {
    const cache = await cacheTrackSamples(track.id, track.code);
    for (const b of cache.banks.filter((b) => !b.ok)) console.error(`WARN ${track.id} — cache miss for ${b.source}: ${b.error}`);
    for (const b of cache.banks.filter((b) => b.skipped?.length)) console.error(`WARN ${track.id} — vendored ${b.source} minus ${b.skipped.length} missing sample(s)`);
  } catch (err) {
    console.error(`WARN ${track.id} — sample caching failed: ${err.message}`);
  }

  const authorProfileId = process.env.CRATE_AUTHOR_PROFILE_ID || null;
  if (!authorProfileId) console.error(`WARN ${track.id} — no CRATE_AUTHOR_PROFILE_ID; saving unauthored`);
  const saved = await insertItem(adminDb, NAMESPACE, track, authorProfileId);
  if (!saved.ok) { console.log(`FAIL ${track.id} — ${saved.error}`); process.exit(1); }

  try { await unlink(file); } catch { /* best effort */ }
  console.log(`PASS ${track.id}`);
}

main();
