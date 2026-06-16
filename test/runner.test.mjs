// test/runner.test.mjs
import { describe, it, expect } from 'vitest';
import { buildArgv, collectionFor, diffNew, liveProduced, majorityBatch } from '../server/runner.mjs';

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

describe('liveProduced', () => {
  it('returns produced = current - baseline for a running job', () => {
    expect(liveProduced({ status: 'running', baselineCount: 5 }, 8)).toBe(3);
  });
  it('clamps to 0 when files were removed', () => {
    expect(liveProduced({ status: 'running', baselineCount: 5 }, 2)).toBe(0);
  });
  it('is undefined for non-running jobs', () => {
    expect(liveProduced({ status: 'done', baselineCount: 5 }, 8)).toBeUndefined();
    expect(liveProduced({ status: 'queued', baselineCount: 5 }, 8)).toBeUndefined();
  });
  it('is undefined when baselineCount is missing', () => {
    expect(liveProduced({ status: 'running' }, 8)).toBeUndefined();
  });
});

describe('majorityBatch', () => {
  it('picks the dominant batch', () => {
    expect(majorityBatch([{ batch: 'A' }, { batch: 'A' }, { batch: 'B' }])).toBe('A');
  });
  it('returns null on a tie', () => {
    expect(majorityBatch([{ batch: 'A' }, { batch: 'B' }])).toBeNull();
  });
  it('returns null when no row has a batch', () => {
    expect(majorityBatch([{}, {}])).toBeNull();
  });
});


import { describe as describe2, it as it2, expect as expect2, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as join2 } from 'node:path';
import { createRunner } from '../server/runner.mjs';
import { createJobStore } from '../server/jobs.mjs';
import { fakeAdmin } from './fake-admin.mjs';

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
    const admin = fakeAdmin({ profiles: [], stems: [], tracks: [] });
    const runner = createRunner({ repoRoot, jobStore, adminDb: admin, spawn, now: ticks });
    await jobStore.write(baseJob('j1'));
    await runner.enqueue(baseJob('j1'));
    await until(() => children.length === 1);
    expect2((await jobStore.get('j1')).status).toBe('running');
    expect2((await jobStore.get('j1')).baselineCount).toBe(0);
    // The agent's save scripts created two new stem rows in Instant.
    admin._store.stems.push(
      { id: 's1', slug: '2026-06-15-pads-01', batch: '2026-06-15-pads' },
      { id: 's2', slug: '2026-06-15-pads-02', batch: '2026-06-15-pads' },
    );
    children[0].stdout.emit('data', JSON.stringify({ result: 'OK 2 stems' }));
    children[0].emit('close', 0);
    await until(async () => (await jobStore.get('j1')).status === 'done');
    const done = await jobStore.get('j1');
    expect2(done.newItems).toEqual(['2026-06-15-pads-01', '2026-06-15-pads-02']);
    expect2(done.batch).toBe('2026-06-15-pads');
    expect2(done.summary).toBe('OK 2 stems');
  });

  it2('passes the author profile id to claude via env', async () => {
    const { spawn, children } = fakeSpawnFactory();
    const admin = fakeAdmin({
      profiles: [{ id: 'p1', artistName: 'kala', user: { id: 'u1' } }],
      stems: [], tracks: [],
    });
    const runner = createRunner({ repoRoot, jobStore, adminDb: admin, spawn, now: ticks });
    await jobStore.write(baseJob('j1', { userId: 'u1', userEmail: 'kala@x.com' }));
    await runner.enqueue(baseJob('j1', { userId: 'u1', userEmail: 'kala@x.com' }));
    await until(() => children.length === 1);
    expect2(children[0].opts.env.CRATE_AUTHOR_PROFILE_ID).toBe('p1');
    children[0].emit('close', 0);
    await until(async () => (await jobStore.get('j1'))?.status === 'done');
  });

  it2('omits the author env var when the job has no userId', async () => {
    const { spawn, children } = fakeSpawnFactory();
    const admin = fakeAdmin({ profiles: [], stems: [], tracks: [] });
    const runner = createRunner({ repoRoot, jobStore, adminDb: admin, spawn, now: ticks });
    await jobStore.write(baseJob('j1'));
    await runner.enqueue(baseJob('j1'));
    await until(() => children.length === 1);
    expect2(children[0].opts.env.CRATE_AUTHOR_PROFILE_ID).toBeUndefined();
    children[0].emit('close', 0);
    await until(async () => (await jobStore.get('j1'))?.status === 'done');
  });

  it2('marks a job failed on non-zero exit', async () => {
    const { spawn, children } = fakeSpawnFactory();
    const admin = fakeAdmin({ profiles: [], stems: [], tracks: [] });
    const runner = createRunner({ repoRoot, jobStore, adminDb: admin, spawn, now: ticks });
    await jobStore.write(baseJob('j1'));
    await runner.enqueue(baseJob('j1'));
    await until(() => children.length === 1);
    children[0].emit('close', 1);
    await until(async () => (await jobStore.get('j1')).status === 'failed');
    expect2((await jobStore.get('j1')).status).toBe('failed');
  });

  it2('runs jobs one at a time (single slot)', async () => {
    const { spawn, children } = fakeSpawnFactory();
    const admin = fakeAdmin({ profiles: [], stems: [], tracks: [] });
    const runner = createRunner({ repoRoot, jobStore, adminDb: admin, spawn, now: ticks });
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
    const admin = fakeAdmin({ profiles: [], stems: [], tracks: [] });
    await jobStore.write(baseJob('stale', { status: 'running' }));
    await jobStore.write(baseJob('waiting', { status: 'queued' }));
    const runner = createRunner({ repoRoot, jobStore, adminDb: admin, spawn, now: ticks });
    await runner.recover();
    await until(() => children.length === 1);
    expect2((await jobStore.get('stale')).status).toBe('interrupted');
    expect2(children).toHaveLength(1);
  });

  it2('derives batch from the row field, not the slug (revise version rows)', async () => {
    const { spawn, children } = fakeSpawnFactory();
    const admin = fakeAdmin({ profiles: [], stems: [], tracks: [] });
    const runner = createRunner({ repoRoot, jobStore, adminDb: admin, spawn, now: ticks });
    await jobStore.write(baseJob('rev', { type: 'revise-from-notes', prompt: 'stems', count: null }));
    await runner.enqueue(baseJob('rev', { type: 'revise-from-notes', prompt: 'stems', count: null }));
    await until(() => children.length === 1);
    // a revised version row: slug ends in -v2 but its batch field is the family's batch
    admin._store.stems.push({ id: 's1', slug: '2026-06-08-alien-04-v2', batch: '2026-06-08-alien' });
    children[0].emit('close', 0);
    await until(async () => (await jobStore.get('rev')).status === 'done');
    const done = await jobStore.get('rev');
    expect2(done.newItems).toEqual(['2026-06-08-alien-04-v2']);
    expect2(done.batch).toBe('2026-06-08-alien');
  });

  it2('picks the majority batch when Step-0 revise adds version rows from another batch', async () => {
    const { spawn, children } = fakeSpawnFactory();
    const admin = fakeAdmin({ profiles: [], stems: [], tracks: [] });
    const runner = createRunner({ repoRoot, jobStore, adminDb: admin, spawn, now: ticks });
    await jobStore.write(baseJob('gen'));
    await runner.enqueue(baseJob('gen'));
    await until(() => children.length === 1);
    // Step-0 revise wrote a version row from an OLD batch...
    admin._store.stems.push({ id: 'o1', slug: '2026-06-01-old-03-v2', batch: '2026-06-01-old' });
    // ...then the generation step wrote the new batch (the majority).
    admin._store.stems.push(
      { id: 'n1', slug: '2026-06-15-new-01', batch: '2026-06-15-new' },
      { id: 'n2', slug: '2026-06-15-new-02', batch: '2026-06-15-new' },
    );
    children[0].emit('close', 0);
    await until(async () => (await jobStore.get('gen')).status === 'done');
    expect2((await jobStore.get('gen')).batch).toBe('2026-06-15-new');
  });

  it2('returns null batch when new rows span multiple batches', async () => {
    const { spawn, children } = fakeSpawnFactory();
    const admin = fakeAdmin({ profiles: [], stems: [], tracks: [] });
    const runner = createRunner({ repoRoot, jobStore, adminDb: admin, spawn, now: ticks });
    await jobStore.write(baseJob('j1'));
    await runner.enqueue(baseJob('j1'));
    await until(() => children.length === 1);
    admin._store.stems.push(
      { id: 'a1', slug: '2026-06-15-pads-01', batch: '2026-06-15-pads' },
      { id: 'b1', slug: '2026-06-15-bass-01', batch: '2026-06-15-bass' },
    );
    children[0].emit('close', 0);
    await until(async () => (await jobStore.get('j1')).status === 'done');
    expect2((await jobStore.get('j1')).batch).toBeNull();
  });
});
