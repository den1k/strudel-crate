// scripts/seed-allowlist.mjs
// One-time migration: copy the legacy CRATE_ALLOWED_EMAILS env list into the
// Instant `allowlist` entity. Idempotent — skips emails that already exist.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { init, id } from '@instantdb/admin';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(join(repoRoot, '.env')); } catch { /* env already set */ }

const { INSTANT_APP_ID, INSTANT_ADMIN_TOKEN } = process.env;
if (!INSTANT_APP_ID || !INSTANT_ADMIN_TOKEN) { console.error('missing Instant env'); process.exit(1); }

const adminEmail = (process.env.CRATE_ADMIN_EMAIL ?? 'kalavox@gmail.com').toLowerCase();
const emails = (process.env.CRATE_ALLOWED_EMAILS ?? '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const db = init({ appId: INSTANT_APP_ID, adminToken: INSTANT_ADMIN_TOKEN });

const { allowlist } = await db.query({ allowlist: {} });
const existing = new Set(allowlist.map((r) => (r.email || '').toLowerCase()));

const toAdd = emails.filter((e) => !existing.has(e));
if (toAdd.length === 0) { console.log('allowlist already seeded; nothing to do'); process.exit(0); }

const now = new Date().toISOString();
await db.transact(toAdd.map((email) => db.tx.allowlist[id()].update({ email, addedAt: now, addedBy: adminEmail })));
console.log(`seeded ${toAdd.length} email(s): ${toAdd.join(', ')}`);
