// File-backed job store: one JSON file per job at <jobsDir>/<id>.json.
// File-per-record conventions with defensive reads.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const JOB_TYPES = new Set([
  'generate-stems', 'generate-tracks', 'revise-from-notes', 'remix',
]);

// Hard ceiling on one job's spend, passed to claude. Sized from the longest real runs (12
// tracks: Opus planner + a Sonnet composer each) with headroom; a job that hits it stops.
const BUDGET_BASE_USD = 5;
const BUDGET_PER_ITEM_USD = 1.5;
export const budgetFor = (job) => BUDGET_BASE_USD + BUDGET_PER_ITEM_USD * (job.count ?? (job.type === 'remix' ? 1 : 6));

const DAY_MS = 24 * 60 * 60 * 1000;
const envNumber = (name, fallback) => Number(process.env[name]) || fallback;

// Per-user bound on what jobs can spend. Past jobs count at their real cost, and anything
// that hasn't reported one at its budget. Returns an error message, or null when allowed.
export function jobQuotaError(jobs, job, nowMs) {
  const mine = jobs.filter((j) => j.userId && j.userId === job.userId);
  const active = mine.filter((j) => j.status === 'queued' || j.status === 'running');
  if (active.length >= envNumber('CRATE_JOB_MAX_ACTIVE', 2)) return 'you already have jobs running';
  const recent = mine.filter((j) => nowMs - Date.parse(j.createdAt) < DAY_MS);
  if (recent.length >= envNumber('CRATE_JOB_DAILY_LIMIT', 10)) return 'daily job limit reached';
  const spent = recent.reduce((sum, j) => sum + (Number.isFinite(j.costUSD) ? j.costUSD : budgetFor(j)), 0);
  if (spent + budgetFor(job) > envNumber('CRATE_JOB_DAILY_USD', 75)) return 'daily generation budget reached';
  return null;
}

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

  async function listAll() {
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
    return jobs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }

  // Check and write as one step, one at a time (one server process), so concurrent submissions
  // can't all pass on the same count. Returns the check's refusal, or null once written.
  let admitting = Promise.resolve();
  function admit(job, check) {
    const turn = admitting.then(async () => {
      const refused = check(await listAll());
      if (!refused) await write(job);
      return refused ?? null;
    });
    admitting = turn.catch(() => {});
    return turn;
  }

  const list = async () => (await listAll()).slice(0, 50); // the UI log never needs more

  async function update(id, patch) {
    const job = await get(id);
    if (!job) return null;
    return write({ ...job, ...patch });
  }

  return { write, get, list, listAll, update, admit, TYPES: JOB_TYPES };
}
