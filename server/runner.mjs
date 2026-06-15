// Single-slot worker that runs the generation skills headless via `claude -p`.
// Pure helpers (buildArgv/collectionFor/diffNew/batchOf) are exported for tests;
// createRunner (later task) owns the queue and side effects.
import { spawn as nodeSpawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
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

export function batchOf(ids) {
  if (ids.length === 0) return null;
  const batch = (id) => id.replace(/-\d+$/, ''); // strip trailing -NN
  const first = batch(ids[0]);
  return ids.every((id) => batch(id) === first) ? first : null;
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

// createRunner is added in a later task.
export { nodeSpawn, idsIn, parseSummary, ALLOWED_TOOLS };
