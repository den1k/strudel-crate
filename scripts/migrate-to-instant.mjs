// scripts/migrate-to-instant.mjs
// One-time import of disk tracks/stems + their disk ratings into Instant,
// authored by kalavox. Idempotent: skips slugs already present.
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminDb, ensureProfile, itemSlugs, insertItem } from './lib/instant.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

async function ratingFor(ratingsDir, slug) {
  const r = await readJson(join(repoRoot, ratingsDir, `${slug}.json`));
  return { rating: r?.rating ?? null, notes: r?.notes ?? '', lesson: r?.lesson ?? '' };
}

async function migrateNamespace(ns, itemsDir, ratingsDir, profileId) {
  const existing = await itemSlugs(adminDb, ns);
  let files;
  try { files = (await readdir(join(repoRoot, itemsDir))).filter((f) => f.endsWith('.json')); }
  catch { files = []; }

  let created = 0, skipped = 0, failed = 0;
  for (const file of files.sort()) {
    const item = await readJson(join(repoRoot, itemsDir, file));
    if (!item?.id) { failed++; continue; }
    if (existing.has(item.id)) { skipped++; continue; }
    const rating = await ratingFor(ratingsDir, item.id);
    const res = await insertItem(adminDb, ns, { ...item, ...rating }, profileId);
    if (res.ok) { created++; existing.add(item.id); } else { skipped++; }
  }
  console.log(`${ns}: created ${created}, skipped ${skipped}, failed ${failed}`);
}

async function main() {
  const email = (process.env.CRATE_ALLOWED_EMAILS ?? '').split(',')[0].trim().toLowerCase();
  if (!email) { console.error('set CRATE_ALLOWED_EMAILS in .env'); process.exit(2); }

  const { $users } = await adminDb.query({ $users: { $: { where: { email } } } });
  const user = $users[0];
  if (!user) { console.error(`no $users row for ${email} — sign in once in the app first`); process.exit(2); }

  const profileId = await ensureProfile(adminDb, { id: user.id, email });
  console.log(`author: ${email} (profile ${profileId})`);

  await migrateNamespace('tracks', 'tracks', 'data/ratings', profileId);
  await migrateNamespace('stems', 'stems', 'data/stem-ratings', profileId);
  console.log('migration complete');
}

main();
