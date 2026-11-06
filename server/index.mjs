import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { init as initAdmin } from '@instantdb/admin';
import { createApp } from './app.mjs';
import { buildRequireAuth, buildResolveUser, buildRequireUser } from './auth.mjs';
import { createJobStore } from './jobs.mjs';
import { createRunner, liveProduced } from './runner.mjs';
import { itemsByJob } from './instant.mjs';
import { createCardRenderer } from './render-card.mjs';
import { createCardCache } from './card-cache.mjs';
import { createAllowlist } from './allowlist.mjs';
import { createJobBroker, createOps, createWorkerRunner } from './job-broker.mjs';
import { createJobLauncher, stopStaleUnits } from './job-sandbox.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(repoRoot, 'dist');

// Local `npm run dev` doesn't get systemd's EnvironmentFile — load .env ourselves.
try { process.loadEnvFile(join(repoRoot, '.env')); } catch { /* prod: env already set */ }

const { INSTANT_APP_ID, INSTANT_ADMIN_TOKEN } = process.env;
const adminDb = INSTANT_APP_ID && INSTANT_ADMIN_TOKEN
  ? initAdmin({ appId: INSTANT_APP_ID, adminToken: INSTANT_ADMIN_TOKEN })
  : null;
if (!adminDb) console.warn('[crate] Instant admin not configured — writes will fail');

const adminEmail = (process.env.CRATE_ADMIN_EMAIL ?? 'kalavox@gmail.com').toLowerCase();
const { isAllowed } = createAllowlist({ adminDb, adminEmail });

const requireAuth = buildRequireAuth({ adminDb, isAllowed });
const resolveUser = buildResolveUser({ adminDb, isAllowed });
const requireUser = buildRequireUser({ adminDb });
const jobStore = createJobStore({ jobsDir: join(repoRoot, 'data', 'jobs') });

const port = process.env.PORT ?? 3001;

const cardCache = createCardCache({
  dir: join(repoRoot, 'data', 'card-cache'),
  maxBytes: Number(process.env.CRATE_CARD_CACHE_MAX_BYTES) || 268435456,
});
const cardRenderer = createCardRenderer({});

// Default 1: on a 4-core/15GB host one job already fans out up to ~8 parallel
// compose sub-agents (each ~500MB), so two full jobs oversubscribe RAM/CPU.
// Raise CRATE_MAX_JOBS only when the box is otherwise idle.
const broker = createJobBroker({
  ops: createOps({ adminDb, runWorker: createWorkerRunner({ repoRoot }) }),
});
await broker.listen();
const runner = createRunner({
  jobStore, adminDb, isAllowed,
  launcher: createJobLauncher({ repoRoot, broker }),
  maxConcurrent: Number(process.env.CRATE_MAX_JOBS) || 1,
});

const progressFor = async (job) => {
  if (!adminDb || job.status !== 'running') return undefined;
  const produced = (await itemsByJob(adminDb, job.collection, job.id)).length;
  return liveProduced(job, produced);
};

const app = createApp({
  adminDb,
  namespaces: ['tracks', 'stems'],
  // Without admin credentials requireAuth is a pass-through: never expose job creation then.
  jobStore: adminDb ? jobStore : undefined,
  runner: adminDb ? runner : undefined,
  progressFor, requireAuth, resolveUser, requireUser, isAllowed,
  distDir: existsSync(distDir) ? distDir : undefined,
  sampleCacheDir: join(repoRoot, 'data', 'sample-cache'),
  anonCacheMs: 2000,
  cardRenderer,
  cardCache,
  publicOrigin: process.env.CRATE_PUBLIC_ORIGIN || 'https://crate.vimsical.com',
});

await stopStaleUnits();
await runner.recover();

app.listen(port, () => console.log(`strudel-ai api listening on http://localhost:${port}`));
