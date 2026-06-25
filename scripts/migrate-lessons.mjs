// One-off: migrate the legacy per-song `lesson` string into first-class
// `lessons` records (profile-linked, song-linked, target = namespace). Run
// AFTER schema push #1 (lessons entity added) and BEFORE push #2 (which drops
// the `lesson` field). Idempotent: skips a song that already has a linked
// lessonRecord, so re-running creates no duplicates.
//
// Usage: node scripts/migrate-lessons.mjs
import { id } from '@instantdb/admin';
import { adminDb } from './lib/instant.mjs';

const now = new Date().toISOString();

for (const ns of ['tracks', 'stems']) {
  const res = await adminDb.query({ [ns]: { author: {}, lessonRecord: {} } });
  const items = res[ns];

  const txs = [];
  let skippedExisting = 0;
  let skippedNoAuthor = 0;
  for (const item of items) {
    const text = (item.lesson ?? '').trim();
    if (!text) continue;
    if (item.lessonRecord?.id) { skippedExisting += 1; continue; } // already migrated
    const author = Array.isArray(item.author) ? item.author[0] : item.author;
    if (!author?.id) { skippedNoAuthor += 1; console.error(`WARN ${ns}/${item.slug}: lesson but no author — skipped`); continue; }

    const lessonId = id();
    txs.push(
      adminDb.tx.lessons[lessonId]
        .update({ text, target: ns, createdAt: item.createdAt ?? now, updatedAt: now })
        .link({ profile: author.id, [ns === 'tracks' ? 'track' : 'stem']: item.id }),
    );
  }
  if (txs.length) await adminDb.transact(txs);
  console.log(`${ns}: created ${txs.length} lesson records (skipped ${skippedExisting} existing, ${skippedNoAuthor} no-author)`);
}
