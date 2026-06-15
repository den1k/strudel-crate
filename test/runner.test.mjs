// test/runner.test.mjs
import { describe, it, expect } from 'vitest';
import { buildArgv, collectionFor, diffNew } from '../server/runner.mjs';

describe('collectionFor', () => {
  it('maps generate types to their dir', () => {
    expect(collectionFor('generate-stems')).toBe('stems');
    expect(collectionFor('generate-tracks')).toBe('tracks');
  });
  it('uses the prompt as the collection for revise', () => {
    expect(collectionFor('revise-from-notes', 'stems')).toBe('stems');
    expect(collectionFor('revise-from-notes', 'tracks')).toBe('tracks');
  });
});

describe('buildArgv', () => {
  it('builds a generate-stems invocation', () => {
    const argv = buildArgv({ type: 'generate-stems', prompt: 'alien pads', count: 4 });
    expect(argv[0]).toBe('-p');
    expect(argv[1]).toBe('/generate-stems "alien pads" 4');
    expect(argv).toContain('--output-format');
    expect(argv).toContain('json');
    expect(argv).toContain('--allowedTools');
  });
  it('builds a generate-tracks invocation', () => {
    const argv = buildArgv({ type: 'generate-tracks', prompt: 'dark techno', count: 12 });
    expect(argv[1]).toBe('/generate-tracks "dark techno" 12');
  });
  it('builds a revise invocation with the collection arg', () => {
    const argv = buildArgv({ type: 'revise-from-notes', prompt: 'stems' });
    expect(argv[1]).toBe('/revise-from-notes stems');
  });
});

describe('diffNew', () => {
  it('returns ids present in after but not before, sorted', () => {
    const before = new Set(['a', 'b']);
    const after = new Set(['b', 'c', 'a', 'd']);
    expect(diffNew(before, after)).toEqual(['c', 'd']);
  });
});


import { describe as describe2, it as it2, expect as expect2, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as join2 } from 'node:path';
import { createRunner } from '../server/runner.mjs';
import { createJobStore } from '../server/jobs.mjs';

// A controllable fake child process + spawn.
function fakeSpawnFactory() {
  const children = [];
  const spawn = (cmd, argv, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.argv = argv;
    child.opts = opts;
    children.push(child);
    return child;
  };
  return { spawn, children };
}

const baseJob = (id, extra = {}) => ({
  id, type: 'generate-stems', prompt: 'pads', count: 2, collection: 'stems',
  status: 'queued', createdAt: '2026-06-15T00:00:00Z', startedAt: null,
  finishedAt: null, summary: null, error: null, batch: null, newItems: [], ...extra,
});

let repoRoot, jobStore, ticks;
beforeEach(async () => {
  repoRoot = await mkdtemp(join2(tmpdir(), 'strudel-runner-'));
  await mkdir(join2(repoRoot, 'stems'), { recursive: true });
  jobStore = createJobStore({ jobsDir: join2(repoRoot, 'data', 'jobs') });
  let n = 0;
  ticks = () => `2026-06-15T00:00:0${n++}Z`;
});

const until = async (cond, timeout = 1500) => {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeout) throw new Error('until: condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe2('createRunner worker', () => {
  it2('runs a job: running -> done, captures newItems/batch/summary', async () => {
    const { spawn, children } = fakeSpawnFactory();
    const runner = createRunner({ repoRoot, dirs: { stems: 'stems', tracks: 'tracks' }, jobStore, spawn, now: ticks });
    await jobStore.write(baseJob('j1'));
    await runner.enqueue(baseJob('j1'));
    await until(() => children.length === 1);
    expect2((await jobStore.get('j1')).status).toBe('running');
    await writeFile(join2(repoRoot, 'stems', '2026-06-15-pads-01.json'), JSON.stringify({ batch: '2026-06-15-pads' }));
    await writeFile(join2(repoRoot, 'stems', '2026-06-15-pads-02.json'), JSON.stringify({ batch: '2026-06-15-pads' }));
    children[0].stdout.emit('data', JSON.stringify({ result: 'OK 2 stems' }));
    children[0].emit('close', 0);
    await until(async () => (await jobStore.get('j1')).status === 'done');
    const done = await jobStore.get('j1');
    expect2(done.newItems).toEqual(['2026-06-15-pads-01', '2026-06-15-pads-02']);
    expect2(done.batch).toBe('2026-06-15-pads');
    expect2(done.summary).toBe('OK 2 stems');
  });

  it2('marks a job failed on non-zero exit', async () => {
    const { spawn, children } = fakeSpawnFactory();
    const runner = createRunner({ repoRoot, dirs: { stems: 'stems', tracks: 'tracks' }, jobStore, spawn, now: ticks });
    await jobStore.write(baseJob('j1'));
    await runner.enqueue(baseJob('j1'));
    await until(() => children.length === 1);
    children[0].emit('close', 1);
    await until(async () => (await jobStore.get('j1')).status === 'failed');
    expect2((await jobStore.get('j1')).status).toBe('failed');
  });

  it2('runs jobs one at a time (single slot)', async () => {
    const { spawn, children } = fakeSpawnFactory();
    const runner = createRunner({ repoRoot, dirs: { stems: 'stems', tracks: 'tracks' }, jobStore, spawn, now: ticks });
    await jobStore.write(baseJob('j1'));
    await jobStore.write(baseJob('j2'));
    await runner.enqueue(baseJob('j1'));
    await runner.enqueue(baseJob('j2'));
    await until(() => children.length === 1);
    expect2((await jobStore.get('j2')).status).toBe('queued');
    children[0].emit('close', 0);
    await until(() => children.length === 2);
    expect2(children).toHaveLength(2);
  });

  it2('recover() marks running jobs interrupted and resumes queued', async () => {
    const { spawn, children } = fakeSpawnFactory();
    await jobStore.write(baseJob('stale', { status: 'running' }));
    await jobStore.write(baseJob('waiting', { status: 'queued' }));
    const runner = createRunner({ repoRoot, dirs: { stems: 'stems', tracks: 'tracks' }, jobStore, spawn, now: ticks });
    await runner.recover();
    await until(() => children.length === 1);
    expect2((await jobStore.get('stale')).status).toBe('interrupted');
    expect2(children).toHaveLength(1);
  });

  it2('derives batch from the file field, not the id (revise version files)', async () => {
    const { spawn, children } = fakeSpawnFactory();
    const runner = createRunner({ repoRoot, dirs: { stems: 'stems', tracks: 'tracks' }, jobStore, spawn, now: ticks });
    await jobStore.write(baseJob('rev', { type: 'revise-from-notes', prompt: 'stems', count: null }));
    await runner.enqueue(baseJob('rev', { type: 'revise-from-notes', prompt: 'stems', count: null }));
    await until(() => children.length === 1);
    // a revised version file: id ends in -v2 but its batch field is the family's batch
    await writeFile(join2(repoRoot, 'stems', '2026-06-08-alien-04-v2.json'), JSON.stringify({ batch: '2026-06-08-alien' }));
    children[0].emit('close', 0);
    await until(async () => (await jobStore.get('rev')).status === 'done');
    const done = await jobStore.get('rev');
    expect2(done.newItems).toEqual(['2026-06-08-alien-04-v2']);
    expect2(done.batch).toBe('2026-06-08-alien');
  });

  it2('returns null batch when new files span multiple batches', async () => {
    const { spawn, children } = fakeSpawnFactory();
    const runner = createRunner({ repoRoot, dirs: { stems: 'stems', tracks: 'tracks' }, jobStore, spawn, now: ticks });
    await jobStore.write(baseJob('j1'));
    await runner.enqueue(baseJob('j1'));
    await until(() => children.length === 1);
    await writeFile(join2(repoRoot, 'stems', '2026-06-15-pads-01.json'), JSON.stringify({ batch: '2026-06-15-pads' }));
    await writeFile(join2(repoRoot, 'stems', '2026-06-15-bass-01.json'), JSON.stringify({ batch: '2026-06-15-bass' }));
    children[0].emit('close', 0);
    await until(async () => (await jobStore.get('j1')).status === 'done');
    expect2((await jobStore.get('j1')).batch).toBeNull();
  });
});
