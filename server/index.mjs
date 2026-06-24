import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { init as initAdmin } from '@instantdb/admin';
import { createApp } from './app.mjs';
import { buildRequireAuth, buildResolveUser, buildRequireUser } from './auth.mjs';
import { createJobStore } from './jobs.mjs';
import { createRunner, liveProduced } from './runner.mjs';
import { itemsByJob } from './instant.mjs';
import { createAudioCache } from './audio-cache.mjs';
import { createRenderer } from './render-audio.mjs';
import { createAudioExport } from './audio-export.mjs';

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

const port = process.env.PORT ?? 3001;

const audioCache = adminDb
  ? createAudioCache({
      dir: join(repoRoot, 'data', 'audio-cache'),
      maxBytes: Number(process.env.CRATE_AUDIO_CACHE_MAX_BYTES) || 3221225472,
    })
  : null;
const renderer = adminDb
  ? createRenderer({ pageUrl: `http://localhost:${port}/export-render.html` })
  : null;
const audioExport = audioCache && renderer
  ? createAudioExport({ adminDb, cache: audioCache, renderer, namespaces: ['tracks', 'stems'] })
  : null;

// Default 1: on a 4-core/15GB host one job already fans out up to ~8 parallel
// compose sub-agents (each ~500MB), so two full jobs oversubscribe RAM/CPU.
// Raise CRATE_MAX_JOBS only when the box is otherwise idle.
const runner = createRunner({
  repoRoot, jobStore, adminDb,
  maxConcurrent: Number(process.env.CRATE_MAX_JOBS) || 1,
  audioExport,
});

const progressFor = async (job) => {
  if (!adminDb || job.status !== 'running') return undefined;
  const produced = (await itemsByJob(adminDb, job.collection, job.id)).length;
  return liveProduced(job, produced);
};

const app = createApp({
  adminDb,
  namespaces: ['tracks', 'stems'],
  jobStore, runner, progressFor, requireAuth, resolveUser, requireUser, allowedEmails,
  distDir: existsSync(distDir) ? distDir : undefined,
  sampleCacheDir: join(repoRoot, 'data', 'sample-cache'),
  audioExport,
});

await runner.recover();

app.listen(port, () => console.log(`strudel-ai api listening on http://localhost:${port}`));
