// test/jobs.test.mjs
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJobStore } from '../server/jobs.mjs';

const job = (id, extra = {}) => ({
  id, type: 'generate-stems', prompt: 'alien pads', count: 4, collection: 'stems',
  status: 'queued', createdAt: '2026-06-15T00:00:00Z', startedAt: null,
  finishedAt: null, summary: null, error: null, batch: null, newItems: [], ...extra,
});

let jobsDir, store;
beforeEach(async () => {
  jobsDir = join(await mkdtemp(join(tmpdir(), 'strudel-jobs-')), 'jobs');
  store = createJobStore({ jobsDir });
});

describe('createJobStore', () => {
  it('write then get round-trips a job', async () => {
    await store.write(job('a'));
    expect(await store.get('a')).toMatchObject({ id: 'a', type: 'generate-stems' });
  });

  it('get returns null for missing job', async () => {
    expect(await store.get('nope')).toBeNull();
  });

  it('list returns empty when dir missing', async () => {
    expect(await store.list()).toEqual([]);
  });

  it('list returns jobs newest-first by createdAt', async () => {
    await store.write(job('old', { createdAt: '2026-06-15T00:00:00Z' }));
    await store.write(job('new', { createdAt: '2026-06-15T01:00:00Z' }));
    const ids = (await store.list()).map((j) => j.id);
    expect(ids).toEqual(['new', 'old']);
  });

  it('update merges a patch into an existing job', async () => {
    await store.write(job('a'));
    await store.update('a', { status: 'done', summary: 'ok' });
    expect(await store.get('a')).toMatchObject({ status: 'done', summary: 'ok' });
  });

  it('update returns null for missing job', async () => {
    expect(await store.update('ghost', { status: 'done' })).toBeNull();
  });

  it('list caps at 50, returns newest first, drops the oldest', async () => {
    // Write 51 jobs with strictly ordered createdAt timestamps (j00 = oldest, j50 = newest)
    for (let i = 0; i <= 50; i++) {
      const id = `j${String(i).padStart(2, '0')}`;
      const createdAt = new Date(Date.UTC(2026, 5, 15, i, 0, 0)).toISOString();
      await store.write(job(id, { createdAt }));
    }
    const result = await store.list();
    expect(result).toHaveLength(50);
    expect(result[0].id).toBe('j50');   // newest first
    expect(result.find((j) => j.id === 'j00')).toBeUndefined(); // oldest dropped
  });

  it('exposes the allowed type set', () => {
    expect([...store.TYPES].sort()).toEqual(
      ['generate-stems', 'generate-tracks', 'remix', 'revise-from-notes'],
    );
  });
});
