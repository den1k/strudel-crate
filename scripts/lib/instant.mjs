// scripts/lib/instant.mjs
// Admin client + helpers for CLI scripts. Agents spawned by the runner inherit
// env through the process tree; manual CLI runs need .env loaded here.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { init } from '@instantdb/admin';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
try { process.loadEnvFile(join(repoRoot, '.env')); } catch { /* env already set */ }

const { INSTANT_APP_ID, INSTANT_ADMIN_TOKEN } = process.env;
if (!INSTANT_APP_ID || !INSTANT_ADMIN_TOKEN) {
  console.error('Instant admin not configured (need INSTANT_APP_ID + INSTANT_ADMIN_TOKEN in .env)');
  process.exit(2);
}

export const adminDb = init({ appId: INSTANT_APP_ID, adminToken: INSTANT_ADMIN_TOKEN });
export * from '../../server/instant.mjs';
