// Single-slot worker that runs the generation skills headless via `claude -p`.
// Pure helpers (buildArgv/collectionFor/liveProduced/majorityBatch) are exported for tests;
// createRunner (later task) owns the queue and side effects.
import { spawn as nodeSpawn } from 'node:child_process';
import { itemsByJob, ensureProfile } from './instant.mjs';

const COLLECTION_BY_TYPE = {
  'generate-stems': 'stems',
  'generate-tracks': 'tracks',
};

export function collectionFor(type, prompt, collection) {
  if (type === 'remix') return collection;
  if (type === 'revise-from-notes') return prompt === 'stems' ? 'stems' : 'tracks';
  return COLLECTION_BY_TYPE[type];
}

// Scoped tool allowlist: exactly what the skills + their sub-agents run.
// If sub-agents stall on a permission prompt headless can't answer, widen the
// Bash entry to a bare 'Bash' (still private + fixed prompt) and note it here.
const ALLOWED_TOOLS = [
  'Write', 'Read', 'Edit', 'Task',
  'Bash(node scripts/save-track.mjs:*)',
  'Bash(node scripts/save-stem.mjs:*)',
  'Bash(node scripts/list-slugs.mjs:*)',
  'Bash(node scripts/feedback.mjs:*)',
  'Bash(node scripts/pending-revisions.mjs:*)',
  'Bash(node scripts/validate.mjs:*)',
  'Bash(node scripts/remix-source.mjs:*)',
  'Bash(date:*)', 'Bash(pwd)', 'Bash(ls:*)', 'Bash(grep:*)',
  'Bash(mkdir -p staging)', 'Bash(rm staging/:*)',
].join(',');

export function buildArgv(job) {
  // The generate prompt is wrapped in double quotes to group it as one slash-command
  // argument; a quote inside the user's text would break that boundary. The API
  // rejects quotes up front — strip here too as a defensive fallback so no job can
  // ever produce a malformed command line.
  const safePrompt = String(job.prompt ?? '').replace(/"/g, '');
  const prompt = job.type === 'revise-from-notes'
    ? `/revise-from-notes ${safePrompt}`
    : job.type === 'remix'
      ? `/remix ${job.collection} ${job.sourceSlug} "${safePrompt}"`
      : `/${job.type} "${safePrompt}" ${job.count}`;
  return ['-p', prompt, '--output-format', 'json', '--allowedTools', ALLOWED_TOOLS];
}

// Number of rows this job has produced so far (rows stamped with its jobId).
// Undefined unless the job is running — a finished job reports final newItems.
export function liveProduced(job, producedCount) {
  if (job.status !== 'running') return undefined;
  return producedCount;
}

// The trustworthy batch is the majority `batch` among the newly-created rows
// (a generate run also emits stray revise versions from other batches). Null on
// a genuine tie or when no new row carries a batch.
export function majorityBatch(rows) {
  const counts = new Map();
  for (const r of rows) if (r.batch) counts.set(r.batch, (counts.get(r.batch) ?? 0) + 1);
  if (counts.size === 0) return null;
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) return null;
  return sorted[0][0];
}

function parseSummary(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return parsed.result ?? stdout.slice(0, 4000);
  } catch {
    return stdout.slice(0, 4000);
  }
}

export { nodeSpawn, parseSummary, ALLOWED_TOOLS };

export function createRunner({
  repoRoot, jobStore, adminDb,
  spawn = nodeSpawn,
  now = () => new Date().toISOString(),
  maxConcurrent = 1,
}) {
  const queue = [];
  let active = 0;

  function runClaude(job, authorProfileId) {
    return new Promise((resolve) => {
      let out = '';
      let err = '';
      let resolved = false;
      const settle = (result) => { if (!resolved) { resolved = true; resolve(result); } };
      const env = { ...process.env };
      env.CRATE_JOB_ID = job.id;
      if (authorProfileId) env.CRATE_AUTHOR_PROFILE_ID = authorProfileId;
      const child = spawn('claude', buildArgv(job), { cwd: repoRoot, env });
      child.stdout?.on('data', (d) => { out += d; });
      child.stderr?.on('data', (d) => { err += d; });
      child.on('error', (e) => settle({ code: -1, out, err: err || String(e?.message ?? e) }));
      child.on('close', (code) => settle({ code: code ?? -1, out, err }));
    });
  }

  async function runOne(id) {
    const job = await jobStore.get(id);
    if (!job) return;
    const ns = job.collection; // 'tracks' | 'stems'
    try {
      const authorProfileId = job.userId
        ? await ensureProfile(adminDb, { id: job.userId, email: job.userEmail })
        : null;
      await jobStore.update(id, { status: 'running', startedAt: now() });
      const { code, out, err } = await runClaude(job, authorProfileId);
      const newRows = await itemsByJob(adminDb, ns, id);
      const newItems = newRows.map((r) => r.slug).sort();
      const patch = { finishedAt: now(), newItems, batch: majorityBatch(newRows) };
      if (code === 0) { patch.status = 'done'; patch.summary = parseSummary(out); }
      else {
        patch.status = 'failed';
        const tail = (err ?? '').trim().slice(-500);
        patch.error = tail ? `claude exited ${code}: ${tail}` : `claude exited ${code}`;
      }
      await jobStore.update(id, patch);
    } catch (err) {
      await jobStore.update(id, { status: 'failed', finishedAt: now(), error: String(err?.message ?? err) });
    }
  }

  function pump() {
    while (active < maxConcurrent && queue.length) {
      const id = queue.shift();
      active += 1;
      runOne(id)
        .catch((err) => console.error('runOne failed', err))
        .finally(() => { active -= 1; pump(); });
    }
  }

  async function enqueue(job) {
    queue.push(job.id);
    pump();
    return job;
  }

  async function recover() {
    for (const job of await jobStore.list()) {
      if (job.status === 'running') {
        await jobStore.update(job.id, { status: 'interrupted', finishedAt: now() });
      } else if (job.status === 'queued') {
        queue.push(job.id);
      }
    }
    pump();
  }

  return { enqueue, recover };
}
