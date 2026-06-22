import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { init as initAdmin } from '@instantdb/admin';
import { createApp } from './app.mjs';
import { buildRequireAuth, buildResolveUser, buildRequireUser } from './auth.mjs';
import { createJobStore } from './jobs.mjs';
import { createRunner, liveProduced } from './runner.mjs';
import { itemSlugs } from './instant.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(repoRoot, 'dist');

// Local `npm run dev` doesn't get systemd's EnvironmentFile — load .env ourselves.
try { process.loadEnvFile(join(repoRoot, '.env')); } catch { /* prod: env already set */ }

const allowedEmails = (process.env.CRATE_ALLOWED_EMAILS ?? '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const { INSTANT_APP_ID, INSTANT_ADMIN_TOKEN } = process.env;
const adminDb = INSTANT_APP_ID && INSTANT_ADMIN_TOKEN
  ? initAdmin({ appId: INSTANT_APP_ID, adminToken: INSTANT_ADMIN_TOKEN })
  : null;
if (!adminDb) console.warn('[crate] Instant admin not configured — writes will fail');

const requireAuth = buildRequireAuth({ adminDb, allowedEmails });
const resolveUser = buildResolveUser({ adminDb, allowedEmails });
const requireUser = buildRequireUser({ adminDb });
const jobStore = createJobStore({ jobsDir: join(repoRoot, 'data', 'jobs') });
const runner = createRunner({ repoRoot, jobStore, adminDb });

const progressFor = async (job) => {
  if (!adminDb || job.status !== 'running') return undefined;
  const count = (await itemSlugs(adminDb, job.collection)).size;
  return liveProduced(job, count);
};

const app = createApp({
  adminDb,
  namespaces: ['tracks', 'stems'],
  jobStore, runner, progressFor, requireAuth, resolveUser, requireUser, allowedEmails,
  distDir: existsSync(distDir) ? distDir : undefined,
  sampleCacheDir: join(repoRoot, 'data', 'sample-cache'),
});

await runner.recover();

const port = process.env.PORT ?? 3001;
app.listen(port, () => console.log(`strudel-ai api listening on http://localhost:${port}`));
