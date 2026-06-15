// Single-slot worker that runs the generation skills headless via `claude -p`.
// Pure helpers (buildArgv/collectionFor/diffNew) are exported for tests;
// createRunner (later task) owns the queue and side effects.
import { spawn as nodeSpawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

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

// The trustworthy batch comes from each item file's `batch` field (works for
// generate ids like 2026-06-15-pads-01 AND revise version ids like ...-v2,
// which an id-suffix strip can't handle). Null if the new files disagree.
async function readBatch(dir, ids) {
  const batches = new Set();
  for (const id of ids) {
    try {
      const item = JSON.parse(await readFile(join(dir, `${id}.json`), 'utf8'));
      if (item.batch) batches.add(item.batch);
    } catch {
      // ignore unreadable/missing files
    }
  }
  return batches.size === 1 ? [...batches][0] : null;
}

async function idsIn(dir) {
  try {
    return new Set(
      (await readdir(dir)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)),
    );
  } catch {
    return new Set();
  }
}

function parseSummary(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return parsed.result ?? stdout.slice(0, 4000);
  } catch {
    return stdout.slice(0, 4000);
  }
}

export { nodeSpawn, idsIn, parseSummary, ALLOWED_TOOLS };

export function createRunner({
  repoRoot, dirs, jobStore,
  spawn = nodeSpawn,
  now = () => new Date().toISOString(),
}) {
  const queue = [];
  let running = false;

  function runClaude(job) {
    return new Promise((resolve) => {
      let out = '';
      let resolved = false;
      const settle = (result) => { if (!resolved) { resolved = true; resolve(result); } };
      const child = spawn('claude', buildArgv(job), { cwd: repoRoot });
      child.stdout?.on('data', (d) => { out += d; });
      child.on('error', () => settle({ code: -1, out }));
      child.on('close', (code) => settle({ code: code ?? -1, out }));
    });
  }

  async function runOne(id) {
    const job = await jobStore.get(id);
    if (!job) return;
    const dir = join(repoRoot, dirs[job.collection]);
    await jobStore.update(id, { status: 'running', startedAt: now() });
    const before = await idsIn(dir);
    const { code, out } = await runClaude(job);
    const after = await idsIn(dir);
    const newItems = diffNew(before, after);
    const patch = { finishedAt: now(), newItems, batch: await readBatch(dir, newItems) };
    if (code === 0) {
      patch.status = 'done';
      patch.summary = parseSummary(out);
    } else {
      patch.status = 'failed';
      patch.error = `claude exited ${code}`;
    }
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
