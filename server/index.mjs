import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { init as initAdmin } from '@instantdb/admin';
import { createApp } from './app.mjs';
import { createStore } from './store.mjs';
import { createJobStore } from './jobs.mjs';
import { createRunner, idsIn, liveProduced } from './runner.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(repoRoot, 'dist');

// Auth gate for mutating routes (generation + rating). Verifies an InstantDB
// token and checks the email allowlist. When Instant env vars are absent
// (local dev) the gate is omitted and those routes stay open.
const allowedEmails = (process.env.CRATE_ALLOWED_EMAILS ?? '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

function buildRequireAuth() {
  const { INSTANT_APP_ID, INSTANT_ADMIN_TOKEN } = process.env;
  if (!INSTANT_APP_ID || !INSTANT_ADMIN_TOKEN) {
    console.warn('[crate] Instant auth not configured — mutating routes are OPEN');
    return undefined;
  }
  const adminDb = initAdmin({ appId: INSTANT_APP_ID, adminToken: INSTANT_ADMIN_TOKEN });
  return async (req, res, next) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'sign in required' });
    try {
      const user = await adminDb.auth.verifyToken(token);
      const email = user?.email?.toLowerCase();
      if (!email || !allowedEmails.includes(email)) {
        return res.status(403).json({ error: 'account not allowed' });
      }
      req.user = user;
      next();
    } catch {
      return res.status(401).json({ error: 'invalid or expired session' });
    }
  };
}

const requireAuth = buildRequireAuth();

const jobStore = createJobStore({ jobsDir: join(repoRoot, 'data', 'jobs') });
const dirs = { stems: 'stems', tracks: 'tracks' };
const runner = createRunner({ repoRoot, dirs, jobStore });

// Live produced-count for a running job: items in its collection dir now,
// minus the baseline captured when it started.
const progressFor = async (job) => {
  if (job.status !== 'running') return undefined;
  const count = (await idsIn(join(repoRoot, dirs[job.collection]))).size;
  return liveProduced(job, count);
};

const app = createApp(
  {
    tracks: createStore({ tracksDir: 'tracks', ratingsDir: 'data/ratings' }),
    stems: createStore({ tracksDir: 'stems', ratingsDir: 'data/stem-ratings' }),
  },
  { jobStore, runner, progressFor, requireAuth, distDir: existsSync(distDir) ? distDir : undefined },
);

await runner.recover(); // requeue/clean up jobs left over from a restart

const port = process.env.PORT ?? 3001;
app.listen(port, () => console.log(`strudel-ai api listening on http://localhost:${port}`));
