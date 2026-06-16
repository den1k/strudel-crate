// Single-slot worker that runs the generation skills headless via `claude -p`.
// Pure helpers (buildArgv/collectionFor/diffNew) are exported for tests;
// createRunner (later task) owns the queue and side effects.
import { spawn as nodeSpawn } from 'node:child_process';
import { itemSlugs, itemsBySlug, ensureProfile } from './instant.mjs';

const COLLECTION_BY_TYPE = {
  'generate-stems': 'stems',
  'generate-tracks': 'tracks',
};

export function collectionFor(type, prompt) {
  if (type === 'revise-from-notes') return prompt === 'stems' ? 'stems' : 'tracks';
  return COLLECTION_BY_TYPE[type];
}

// Scoped tool allowlist: exactly what the skills + their sub-agents run.
// If sub-agents stall on a permission prompt headless can't answer, widen the
// Bash entry to a bare 'Bash' (still private + fixed prompt) and note it here.
const ALLOWED_TOOLS = [
  'Write', 'Read', 'Edit', 'Task',
  'Bash(node scripts/validate.mjs:*)',
  'Bash(node scripts/feedback.mjs:*)',
  'Bash(node scripts/pending-revisions.mjs:*)',
  'Bash(date:*)', 'Bash(pwd)', 'Bash(ls:*)', 'Bash(grep:*)',
  'Bash(rm stems/:*)', 'Bash(rm tracks/:*)',
].join(',');

export function buildArgv(job) {
  const prompt = job.type === 'revise-from-notes'
    ? `/revise-from-notes ${job.prompt}`
    : `/${job.type} "${job.prompt}" ${job.count}`;
  return ['-p', prompt, '--output-format', 'json', '--allowedTools', ALLOWED_TOOLS];
}

export function diffNew(before, after) {
  return [...after].filter((id) => !before.has(id)).sort();
}

// Live count of items produced since the job started. Undefined unless the job
// is running AND has a numeric baseline (so a stray pre-baseline job never shows
// a bogus full-directory count).
export function liveProduced(job, currentCount) {
  if (job.status !== 'running' || typeof job.baselineCount !== 'number') return undefined;
  return Math.max(0, currentCount - job.baselineCount);
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
}) {
  const queue = [];
  let running = false;

  function runClaude(job, authorProfileId) {
    return new Promise((resolve) => {
      let out = '';
      let resolved = false;
      const settle = (result) => { if (!resolved) { resolved = true; resolve(result); } };
      const env = { ...process.env };
      if (authorProfileId) env.CRATE_AUTHOR_PROFILE_ID = authorProfileId;
      const child = spawn('claude', buildArgv(job), { cwd: repoRoot, env });
      child.stdout?.on('data', (d) => { out += d; });
      child.on('error', () => settle({ code: -1, out }));
      child.on('close', (code) => settle({ code: code ?? -1, out }));
    });
  }

  async function runOne(id) {
    const job = await jobStore.get(id);
    if (!job) return;
    const ns = job.collection; // 'tracks' | 'stems'
    const authorProfileId = job.userId
      ? await ensureProfile(adminDb, { id: job.userId, email: job.userEmail })
      : null;
    const before = await itemSlugs(adminDb, ns);
    await jobStore.update(id, { status: 'running', startedAt: now(), baselineCount: before.size });
    const { code, out } = await runClaude(job, authorProfileId);
    const after = await itemSlugs(adminDb, ns);
    const newItems = diffNew(before, after);
    const newRows = await itemsBySlug(adminDb, ns, newItems);
    const patch = { finishedAt: now(), newItems, batch: majorityBatch(newRows) };
    if (code === 0) { patch.status = 'done'; patch.summary = parseSummary(out); }
    else { patch.status = 'failed'; patch.error = `claude exited ${code}`; }
    await jobStore.update(id, patch);
  }

  async function pump() {
    if (running) return;
    const id = queue.shift();
    if (!id) return;
    running = true;
    try {
      await runOne(id);
    } finally {
      running = false;
      if (queue.length) pump();
    }
  }

  async function enqueue(job) {
    queue.push(job.id);
    pump().catch((err) => console.error('runner pump failed', err));
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
    pump().catch((err) => console.error('runner pump failed', err));
  }

  return { enqueue, recover };
}
