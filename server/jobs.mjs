// File-backed job store: one JSON file per job at <jobsDir>/<id>.json.
// Mirrors server/store.mjs conventions (file-per-record, defensive reads).
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const JOB_TYPES = new Set([
  'generate-stems', 'generate-tracks', 'revise-from-notes',
]);

export function createJobStore({ jobsDir }) {
  async function write(job) {
    await mkdir(jobsDir, { recursive: true });
    await writeFile(join(jobsDir, `${job.id}.json`), JSON.stringify(job, null, 2));
    return job;
  }

  async function get(id) {
    try {
      return JSON.parse(await readFile(join(jobsDir, `${id}.json`), 'utf8'));
    } catch {
      return null;
    }
  }

  async function list() {
    let files;
    try {
      files = await readdir(jobsDir);
    } catch {
      return [];
    }
    const jobs = [];
    for (const f of files.filter((f) => f.endsWith('.json'))) {
      try {
        jobs.push(JSON.parse(await readFile(join(jobsDir, f), 'utf8')));
      } catch {
        // skip malformed job files rather than breaking the whole listing
      }
    }
    return jobs
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, 50);
  }

  async function update(id, patch) {
    const job = await get(id);
    if (!job) return null;
    return write({ ...job, ...patch });
  }

  return { write, get, list, update, TYPES: JOB_TYPES };
}
