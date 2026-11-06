// Single-slot worker that runs the generation skills headless via `claude -p`.
// Pure helpers (buildArgv/collectionFor/liveProduced/majorityBatch) are exported for tests;
// createRunner (later task) owns the queue and side effects.
import { spawn as nodeSpawn } from 'node:child_process';
import { itemsByJob, ensureProfile } from './instant.mjs';
import { budgetFor } from './jobs.mjs';

const COLLECTION_BY_TYPE = {
  'generate-stems': 'stems',
  'generate-tracks': 'tracks',
};

export function collectionFor(type, prompt, collection) {
  if (type === 'remix') return collection;
  if (type === 'revise-from-notes') return prompt === 'stems' ? 'stems' : 'tracks';
  return COLLECTION_BY_TYPE[type];
}

// Scoped tool allowlist: exactly what the skills + their sub-agents run. The real limit is
// the sandbox (server/job-sandbox.mjs); this keeps the model from trying anything else.
const TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'Task', 'Skill', 'TodoWrite'].join(',');
const ALLOWED_TOOLS = [
  'Read', 'Glob', 'Grep', 'Task', 'Skill', 'TodoWrite',
  'Write(staging/**)', 'Edit(staging/**)',
  'Bash(node scripts/save-track.mjs:*)',
  'Bash(node scripts/save-stem.mjs:*)',
  'Bash(node scripts/save-palette.mjs:*)',
  'Bash(node scripts/list-slugs.mjs:*)',
  'Bash(node scripts/feedback.mjs:*)',
  'Bash(node scripts/kit-feedback.mjs:*)',
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
  // Pin the orchestrator (planner) model. Sub-agents inherit this unless they
  // override it per-dispatch — generate-tracks Stage 2 dispatches compose
  // agents on Sonnet; everything else (kit design, stems, remix, revise) stays
  // on this model. Override via CRATE_PLANNER_MODEL; default Opus.
  const plannerModel = process.env.CRATE_PLANNER_MODEL || 'opus';
  return [
    '-p', prompt, '--model', plannerModel, '--output-format', 'json',
    '--tools', TOOLS, '--allowedTools', ALLOWED_TOOLS,
    '--max-budget-usd', String(budgetFor(job)),
    // The job gets the repo's skills and nothing of the operator's config.
    '--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence',
  ];
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

// Per-model usage from the claude -p JSON envelope (top-level `modelUsage`,
// keyed by model name; inner values are camelCase: outputTokens, costUSD, …).
// The runner otherwise keeps only `result`, so without this a batch report can't
// reveal which models actually ran — the load-bearing check that generate-tracks
// compose agents landed on Sonnet (a `claude-sonnet-*` key with real output
// tokens) rather than silently falling back to the Opus planner. Returns "" when
// the field is absent or the output is unparseable.
export function modelUsageLine(stdout) {
  try {
    const mu = JSON.parse(stdout).modelUsage;
    if (!mu || typeof mu !== 'object') return '';
    return Object.entries(mu)
      .map(([model, u]) => `${model}: ${u?.outputTokens ?? '?'} out-tok`)
      .join('; ');
  } catch {
    return '';
  }
}

export function costOf(stdout) {
  try {
    const cost = JSON.parse(stdout).total_cost_usd;
    return Number.isFinite(cost) ? cost : null;
  } catch {
    return null;
  }
}

export { nodeSpawn, parseSummary, ALLOWED_TOOLS };

export function createRunner({
  jobStore, adminDb, launcher, isAllowed,
  spawn = nodeSpawn,
  now = () => new Date().toISOString(),
  maxConcurrent = 1,
}) {
  const queue = [];
  let active = 0;

  async function runClaude(job, authorProfileId) {
    const { command, args, options, cleanup } = await launcher(job, authorProfileId, buildArgv(job));
    try {
      return await new Promise((resolve) => {
        let out = '';
        let err = '';
        let resolved = false;
        const settle = (result) => { if (!resolved) { resolved = true; resolve(result); } };
        const child = spawn(command, args, options);
        child.stdout?.on('data', (d) => { out += d; });
        child.stderr?.on('data', (d) => { err += d; });
        child.on('error', (e) => settle({ code: -1, out, err: err || String(e?.message ?? e) }));
        child.on('close', (code) => settle({ code: code ?? -1, out, err }));
      });
    } finally {
      await cleanup?.();
    }
  }

  async function runOne(id) {
    const job = await jobStore.get(id);
    if (!job) return;
    const ns = job.collection; // 'tracks' | 'stems'
    try {
      // A queued job can outlive its requester's access, including across a restart.
      if (isAllowed && !(job.userEmail && await isAllowed(job.userEmail))) {
        await jobStore.update(id, { status: 'failed', finishedAt: now(), error: 'requester no longer allowed' });
        return;
      }
      const authorProfileId = job.userId
        ? await ensureProfile(adminDb, { id: job.userId, email: job.userEmail })
        : null;
      await jobStore.update(id, { status: 'running', startedAt: now() });
      const { code, out, err } = await runClaude(job, authorProfileId);
      const newRows = await itemsByJob(adminDb, ns, id);
      const newItems = newRows.map((r) => r.slug).sort();
      const patch = { finishedAt: now(), newItems, batch: majorityBatch(newRows), costUSD: costOf(out) };
      if (code === 0) {
        patch.status = 'done';
        patch.summary = parseSummary(out);
        // Surface which models the batch actually used, so a track run reveals
        // whether compose agents ran on Sonnet (vs silently falling back to the
        // Opus planner). "" when the envelope lacks modelUsage.
        const models = modelUsageLine(out);
        if (models) patch.summary += `\n\nModels used: ${models}`;
      } else {
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
