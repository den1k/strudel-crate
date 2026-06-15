import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { createApp } from './app.mjs';
import { createStore } from './store.mjs';
import { createJobStore } from './jobs.mjs';
import { createRunner } from './runner.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(repoRoot, 'dist');

const jobStore = createJobStore({ jobsDir: join(repoRoot, 'data', 'jobs') });
const runner = createRunner({
  repoRoot,
  dirs: { stems: 'stems', tracks: 'tracks' },
  jobStore,
});

const app = createApp(
  {
    tracks: createStore({ tracksDir: 'tracks', ratingsDir: 'data/ratings' }),
    stems: createStore({ tracksDir: 'stems', ratingsDir: 'data/stem-ratings' }),
  },
  { jobStore, runner, distDir: existsSync(distDir) ? distDir : undefined },
);

await runner.recover(); // requeue/clean up jobs left over from a restart

const port = process.env.PORT ?? 3001;
app.listen(port, () => console.log(`strudel-ai api listening on http://localhost:${port}`));
