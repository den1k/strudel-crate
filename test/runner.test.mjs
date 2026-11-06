// test/runner.test.mjs
import { describe, it, expect } from 'vitest';
import { buildArgv, collectionFor, liveProduced, majorityBatch, modelUsageLine } from '../server/runner.mjs';

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

describe('modelUsageLine', () => {
  const envelope = (modelUsage) => JSON.stringify({ result: 'ok', modelUsage });

  it('lists each model with its output tokens — reveals compose ran on Sonnet', () => {
    const line = modelUsageLine(envelope({
      'claude-opus-4-8[1m]': { outputTokens: 1200, costUSD: 0.4 },
      'claude-sonnet-4-6': { outputTokens: 9000, costUSD: 0.3 },
    }));
    expect(line).toContain('claude-opus-4-8[1m]: 1200 out-tok');
    expect(line).toContain('claude-sonnet-4-6: 9000 out-tok');
  });

  it('returns empty string when modelUsage is absent', () => {
    expect(modelUsageLine(JSON.stringify({ result: 'ok' }))).toBe('');
  });

  it('returns empty string on non-JSON output', () => {
    expect(modelUsageLine('not json at all')).toBe('');
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
  it('strips embedded double quotes so they cannot break the arg boundary', () => {
    const argv = buildArgv({ type: 'generate-tracks', prompt: 'dark "techno" vibes', count: 3 });
    expect(argv[1]).toBe('/generate-tracks "dark techno vibes" 3');
  });
});

describe('liveProduced', () => {
  it('returns the produced count for a running job', () => {
    expect(liveProduced({ status: 'running' }, 3)).toBe(3);
  });
  it('is undefined for non-running jobs', () => {
    expect(liveProduced({ status: 'done' }, 8)).toBeUndefined();
    expect(liveProduced({ status: 'queued' }, 8)).toBeUndefined();
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

describe('remix buildArgv', () => {
  it('builds the /remix command', () => {
    const argv = buildArgv({ type: 'remix', collection: 'tracks', sourceSlug: 'demo-01', prompt: 'darker, halftime' });
    expect(argv[0]).toBe('-p');
    expect(argv[1]).toBe('/remix tracks demo-01 "darker, halftime"');
  });
  it('strips double quotes defensively', () => {
    const argv = buildArgv({ type: 'remix', collection: 'stems', sourceSlug: 's-01', prompt: 'a "b" c' });
    expect(argv[1]).toBe('/remix stems s-01 "a b c"');
  });
  it('pins the planner model to opus by default', () => {
    const prev = process.env.CRATE_PLANNER_MODEL;
    delete process.env.CRATE_PLANNER_MODEL;
    try {
      const argv = buildArgv({ type: 'generate-tracks', prompt: 'dark techno', count: 12 });
      const i = argv.indexOf('--model');
      expect(i).toBeGreaterThan(-1);
      expect(argv[i + 1]).toBe('opus');
    } finally {
      if (prev === undefined) delete process.env.CRATE_PLANNER_MODEL;
      else process.env.CRATE_PLANNER_MODEL = prev;
    }
  });
  it('honors CRATE_PLANNER_MODEL override', () => {
    const prev = process.env.CRATE_PLANNER_MODEL;
    process.env.CRATE_PLANNER_MODEL = 'sonnet';
    try {
      const argv = buildArgv({ type: 'generate-tracks', prompt: 'dark techno', count: 12 });
      const i = argv.indexOf('--model');
      expect(argv[i + 1]).toBe('sonnet');
    } finally {
      if (prev === undefined) delete process.env.CRATE_PLANNER_MODEL;
      else process.env.CRATE_PLANNER_MODEL = prev;
    }
  });
  it('keeps non-compose job types on the default opus planner model', () => {
    const prev = process.env.CRATE_PLANNER_MODEL;
    delete process.env.CRATE_PLANNER_MODEL;
    try {
      for (const job of [
        { type: 'generate-stems', prompt: 'alien pads', count: 4 },
        { type: 'remix', collection: 'tracks', sourceSlug: 'demo-01', prompt: 'darker' },
        { type: 'revise-from-notes', prompt: 'stems' },
      ]) {
        const argv = buildArgv(job);
        const i = argv.indexOf('--model');
        expect(i).toBeGreaterThan(-1);
        expect(argv[i + 1]).toBe('opus');
      }
    } finally {
      if (prev === undefined) delete process.env.CRATE_PLANNER_MODEL;
      else process.env.CRATE_PLANNER_MODEL = prev;
    }
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

// The real launcher binds identity through the broker (see job-sandbox.test.mjs); this one
// surfaces what the runner hands it.
const launcher = async (job, authorProfileId, args) => ({
  command: 'claude',
  args,
  options: { env: { CRATE_JOB_ID: job.id, ...(authorProfileId ? { CRATE_AUTHOR_PROFILE_ID: authorProfileId } : {}) } },
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
    const runner = createRunner({ launcher, jobStore, adminDb: admin, spawn, now: ticks });
    await jobStore.write(baseJob('j1'));
    await runner.enqueue(baseJob('j1'));
    await until(() => children.length === 1);
    expect2((await jobStore.get('j1')).status).toBe('running');
    // The agent's save scripts created two new stem rows, each stamped with this job's id.
    admin._store.stems.push(
      { id: 's1', slug: '2026-06-15-pads-01', batch: '2026-06-15-pads', jobId: 'j1' },
      { id: 's2', slug: '2026-06-15-pads-02', batch: '2026-06-15-pads', jobId: 'j1' },
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
    const runner = createRunner({ launcher, jobStore, adminDb: admin, spawn, now: ticks });
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
    const runner = createRunner({ launcher, jobStore, adminDb: admin, spawn, now: ticks });
    await jobStore.write(baseJob('j1'));
    await runner.enqueue(baseJob('j1'));
    await until(() => children.length === 1);
    expect2(children[0].opts.env.CRATE_AUTHOR_PROFILE_ID).toBeUndefined();
    children[0].emit('close', 0);
    await until(async () => (await jobStore.get('j1'))?.status === 'done');
  });

  it2('sets CRATE_JOB_ID in the child env', async () => {
    const { spawn, children } = fakeSpawnFactory();
    const admin = fakeAdmin({ profiles: [], stems: [], tracks: [] });
    const runner = createRunner({ launcher, jobStore, adminDb: admin, spawn, now: ticks });
    await jobStore.write(baseJob('j1'));
    await runner.enqueue(baseJob('j1'));
    await until(() => children.length === 1);
    expect2(children[0].opts.env.CRATE_JOB_ID).toBe('j1');
    children[0].emit('close', 0);
    await until(async () => (await jobStore.get('j1')).status === 'done');
  });

  it2('marks a job failed on non-zero exit', async () => {
    const { spawn, children } = fakeSpawnFactory();
    const admin = fakeAdmin({ profiles: [], stems: [], tracks: [] });
    const runner = createRunner({ launcher, jobStore, adminDb: admin, spawn, now: ticks });
    await jobStore.write(baseJob('j1'));
    await runner.enqueue(baseJob('j1'));
    await until(() => children.length === 1);
    children[0].emit('close', 1);
    await until(async () => (await jobStore.get('j1')).status === 'failed');
    expect2((await jobStore.get('j1')).status).toBe('failed');
  });

  it2('captures child stderr in the failure error for debuggability', async () => {
    const { spawn, children } = fakeSpawnFactory();
    const admin = fakeAdmin({ profiles: [], stems: [], tracks: [] });
    const runner = createRunner({ launcher, jobStore, adminDb: admin, spawn, now: ticks });
    await jobStore.write(baseJob('j1'));
    await runner.enqueue(baseJob('j1'));
    await until(() => children.length === 1);
    children[0].stderr.emit('data', 'Error: permission prompt timed out\n');
    children[0].emit('close', 1);
    await until(async () => (await jobStore.get('j1')).status === 'failed');
    const failed = await jobStore.get('j1');
    expect2(failed.error).toContain('claude exited 1');
    expect2(failed.error).toContain('permission prompt timed out');
  });

  it2('runs up to maxConcurrent jobs at once and queues the rest', async () => {
    const { spawn, children } = fakeSpawnFactory();
    const admin = fakeAdmin({ profiles: [], stems: [], tracks: [] });
    const runner = createRunner({ launcher, jobStore, adminDb: admin, spawn, now: ticks, maxConcurrent: 2 });
    for (const id of ['j1', 'j2', 'j3']) {
      await jobStore.write(baseJob(id));
      await runner.enqueue(baseJob(id));
    }
    await until(() => children.length === 2);
    expect2(children).toHaveLength(2);                       // two slots filled
    expect2((await jobStore.get('j3')).status).toBe('queued'); // third waits
    children[0].emit('close', 0);                            // free a slot
    await until(() => children.length === 3);                // third starts
    expect2(children).toHaveLength(3);
  });

  it2('respects maxConcurrent: 1 (serial)', async () => {
    const { spawn, children } = fakeSpawnFactory();
    const admin = fakeAdmin({ profiles: [], stems: [], tracks: [] });
    const runner = createRunner({ launcher, jobStore, adminDb: admin, spawn, now: ticks, maxConcurrent: 1 });
    await jobStore.write(baseJob('j1'));
    await jobStore.write(baseJob('j2'));
    await runner.enqueue(baseJob('j1'));
    await runner.enqueue(baseJob('j2'));
    await until(() => children.length === 1);
    expect2((await jobStore.get('j2')).status).toBe('queued');
    children[0].emit('close', 0);
    await until(() => children.length === 2);
  });

  it2('attributes rows per job when two run concurrently in the same namespace', async () => {
    const { spawn, children } = fakeSpawnFactory();
    const admin = fakeAdmin({ profiles: [], stems: [], tracks: [] });
    const runner = createRunner({ launcher, jobStore, adminDb: admin, spawn, now: ticks, maxConcurrent: 2 });
    await jobStore.write(baseJob('jA'));
    await jobStore.write(baseJob('jB'));
    await runner.enqueue(baseJob('jA'));
    await runner.enqueue(baseJob('jB'));
    await until(() => children.length === 2);
    // Both jobs wrote into stems; each row carries its own job's id.
    admin._store.stems.push(
      { id: 'a1', slug: 'a-01', batch: 'A', jobId: 'jA' },
      { id: 'b1', slug: 'b-01', batch: 'B', jobId: 'jB' },
    );
    children[0].emit('close', 0); // jA (enqueued first → children[0])
    children[1].emit('close', 0); // jB
    await until(async () =>
      (await jobStore.get('jA')).status === 'done' && (await jobStore.get('jB')).status === 'done');
    expect2((await jobStore.get('jA')).newItems).toEqual(['a-01']);
    expect2((await jobStore.get('jB')).newItems).toEqual(['b-01']);
  });

  it2('recover() marks running jobs interrupted and resumes queued', async () => {
    const { spawn, children } = fakeSpawnFactory();
    const admin = fakeAdmin({ profiles: [], stems: [], tracks: [] });
    await jobStore.write(baseJob('stale', { status: 'running' }));
    await jobStore.write(baseJob('waiting', { status: 'queued' }));
    const runner = createRunner({ launcher, jobStore, adminDb: admin, spawn, now: ticks });
    await runner.recover();
    await until(() => children.length === 1);
    expect2((await jobStore.get('stale')).status).toBe('interrupted');
    expect2(children).toHaveLength(1);
  });

  it2('derives batch from the row field, not the slug (revise version rows)', async () => {
    const { spawn, children } = fakeSpawnFactory();
    const admin = fakeAdmin({ profiles: [], stems: [], tracks: [] });
    const runner = createRunner({ launcher, jobStore, adminDb: admin, spawn, now: ticks });
    await jobStore.write(baseJob('rev', { type: 'revise-from-notes', prompt: 'stems', count: null }));
    await runner.enqueue(baseJob('rev', { type: 'revise-from-notes', prompt: 'stems', count: null }));
    await until(() => children.length === 1);
    // a revised version row: slug ends in -v2 but its batch field is the family's batch
    admin._store.stems.push({ id: 's1', slug: '2026-06-08-alien-04-v2', batch: '2026-06-08-alien', jobId: 'rev' });
    children[0].emit('close', 0);
    await until(async () => (await jobStore.get('rev')).status === 'done');
    const done = await jobStore.get('rev');
    expect2(done.newItems).toEqual(['2026-06-08-alien-04-v2']);
    expect2(done.batch).toBe('2026-06-08-alien');
  });

  it2('picks the majority batch when Step-0 revise adds version rows from another batch', async () => {
    const { spawn, children } = fakeSpawnFactory();
    const admin = fakeAdmin({ profiles: [], stems: [], tracks: [] });
    const runner = createRunner({ launcher, jobStore, adminDb: admin, spawn, now: ticks });
    await jobStore.write(baseJob('gen'));
    await runner.enqueue(baseJob('gen'));
    await until(() => children.length === 1);
    // Step-0 revise wrote a version row from an OLD batch...
    admin._store.stems.push({ id: 'o1', slug: '2026-06-01-old-03-v2', batch: '2026-06-01-old', jobId: 'gen' });
    // ...then the generation step wrote the new batch (the majority).
    admin._store.stems.push(
      { id: 'n1', slug: '2026-06-15-new-01', batch: '2026-06-15-new', jobId: 'gen' },
      { id: 'n2', slug: '2026-06-15-new-02', batch: '2026-06-15-new', jobId: 'gen' },
    );
    children[0].emit('close', 0);
    await until(async () => (await jobStore.get('gen')).status === 'done');
    expect2((await jobStore.get('gen')).batch).toBe('2026-06-15-new');
  });

  it2('returns null batch when new rows span multiple batches', async () => {
    const { spawn, children } = fakeSpawnFactory();
    const admin = fakeAdmin({ profiles: [], stems: [], tracks: [] });
    const runner = createRunner({ launcher, jobStore, adminDb: admin, spawn, now: ticks });
    await jobStore.write(baseJob('j1'));
    await runner.enqueue(baseJob('j1'));
    await until(() => children.length === 1);
    admin._store.stems.push(
      { id: 'a1', slug: '2026-06-15-pads-01', batch: '2026-06-15-pads', jobId: 'j1' },
      { id: 'b1', slug: '2026-06-15-bass-01', batch: '2026-06-15-bass', jobId: 'j1' },
    );
    children[0].emit('close', 0);
    await until(async () => (await jobStore.get('j1')).status === 'done');
    expect2((await jobStore.get('j1')).batch).toBeNull();
  });

  it2('marks the job failed when Instant throws mid-run', async () => {
    const { spawn, children } = fakeSpawnFactory();
    const admin = fakeAdmin({ profiles: [], stems: [], tracks: [] });
    // Make query throw on the first call (the post-run itemsByJob call), simulating
    // Instant becoming unreachable after the job has started running.
    let queryCalls = 0;
    const origQuery = admin.query.bind(admin);
    admin.query = async (q) => {
      queryCalls += 1;
      if (queryCalls >= 1) throw new Error('instant down');
      return origQuery(q);
    };
    const runner = createRunner({ launcher, jobStore, adminDb: admin, spawn, now: ticks });
    await jobStore.write(baseJob('j1'));
    await runner.enqueue(baseJob('j1'));
    await until(() => children.length === 1);
    children[0].emit('close', 0);
    await until(async () => (await jobStore.get('j1')).status === 'failed');
    const failed = await jobStore.get('j1');
    expect2(failed.status).toBe('failed');
    expect2(failed.error).toBeTruthy();
  });
});
