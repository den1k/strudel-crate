import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { createApp } from './app.mjs';
import { createStore } from './store.mjs';
import { createJobStore } from './jobs.mjs';
import { createRunner, idsIn, liveProduced } from './runner.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(repoRoot, 'dist');

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
  { jobStore, runner, progressFor, distDir: existsSync(distDir) ? distDir : undefined },
);

await runner.recover(); // requeue/clean up jobs left over from a restart

const port = process.env.PORT ?? 3001;
app.listen(port, () => console.log(`strudel-ai api listening on http://localhost:${port}`));
