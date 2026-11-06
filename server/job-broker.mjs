// The only way a job reaches anything privileged. Loopback listener, one bearer per job,
// no admin credentials on the other side of the socket: identity (author, job id,
// collection) comes from the registered job, never from the request.
// Also the job's only way out: a CONNECT proxy to the Claude API and nothing else.
import http from 'node:http';
import net from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { insertItem, itemSlugs, queryLessonsByProfile } from './instant.mjs';
import {
  MAX_CONCURRENT_WORKERS, PUBLISHER_LIMITS, systemdEnv, systemdRunArgv, workerSandboxFlags, WORKER_LIMITS,
} from './job-sandbox.mjs';
import { checkCodePolicy } from '../scripts/lib/code-policy.mjs';
import { buildDigest } from '../scripts/feedback.mjs';
import { nextRemixId } from '../scripts/remix-source.mjs';
import { buildWorklist } from '../src/versions.js';

const EGRESS_HOSTS = new Set(['api.anthropic.com:443']);
const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const MAX_BODY = 1024 * 1024;
const MAX_CODE = 256 * 1024;
const MAX_OPS = 5000;
const MAX_REVISIONS = 24; // buildWorklist's per-job cap: a job also saves its Step 0 revisions
const RESULT_MARK = 'CRATE_WORKER_RESULT ';
const PUBLISHING_KINDS = new Set(['vendor-item', 'write-palette']);
const MAX_PALETTES_PER_JOB = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

// Palettes feed a memo every later job reads, newest filename last. A date-prefixed name near
// today can't pin itself to the end of that list.
export function batchNameProblem(batch, now = Date.now()) {
  const date = /^(\d{4}-\d{2}-\d{2})-/.exec(batch)?.[1];
  if (!date) return 'batch must start with YYYY-MM-DD-';
  const at = Date.parse(`${date}T00:00:00Z`);
  return Math.abs(at - now) <= 2 * DAY_MS ? null : 'batch date must be today';
}

// FIFO; a caller waits its turn rather than failing, since sub-agents fan out by design.
function limiter(max) {
  let active = 0;
  const waiting = [];
  return async function limited(task) {
    if (active >= max) await new Promise((resolve) => { waiting.push(resolve); });
    else active += 1;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

export const saveCapFor = (job) => (job.count ?? 1) + MAX_REVISIONS;

// Evaluate agent-written code in its own sandbox and unit, away from this process. Its result
// is advisory: an evaluator could print any result line, which is why stored code only ever
// runs in an opaque frame, and why only a publisher, running none of that code, can write.
export function createWorkerRunner({ repoRoot, spawn = nodeSpawn, maxConcurrent = MAX_CONCURRENT_WORKERS }) {
  const limited = limiter(maxConcurrent);
  return (payload) => limited(async () => {
    const publishes = PUBLISHING_KINDS.has(payload.kind);
    const name = randomUUID();
    const tmpDir = join(repoRoot, 'data', 'job-sandbox', `worker-${name}`);
    await mkdir(tmpDir, { recursive: true });
    const command = [
      '/usr/bin/python3', '-I', join(repoRoot, 'scripts', 'sandbox', 'sandbox-exec.py'),
      ...workerSandboxFlags({ repoRoot, tmpDir, publishes }),
      '--', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', `HOME=${tmpDir}`, `TMPDIR=${tmpDir}`, 'NODE_ENV=production',
      // A string can't become code here, whichever gadget it travels through.
      process.execPath, '--disallow-code-generation-from-strings',
      join(repoRoot, 'scripts', 'sandbox', 'validate-worker.mjs'),
    ];
    try {
      return await new Promise((resolve) => {
        const child = spawn('systemd-run', systemdRunArgv({
          unit: `crate-worker-${name}`, limits: publishes ? PUBLISHER_LIMITS : WORKER_LIMITS, cwd: repoRoot, command,
        }), { cwd: repoRoot, env: systemdEnv() });
        let out = '';
        child.stdout.on('data', (d) => { if (out.length < MAX_BODY) out += d; });
        child.stderr.on('data', () => {});
        child.on('error', () => resolve({ ok: false, error: 'validation worker failed to start' }));
        child.on('close', () => {
          const line = out.split('\n').reverse().find((l) => l.startsWith(RESULT_MARK));
          try {
            resolve(JSON.parse(line.slice(RESULT_MARK.length)));
          } catch {
            resolve({ ok: false, error: 'validation worker gave no result' });
          }
        });
        child.stdin.end(JSON.stringify(payload));
      });
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
}

const fail = (error) => ({ ok: false, error });

function checkItem(item, key = 'id') {
  if (!item || typeof item !== 'object') return 'not an object';
  if (!SLUG_RE.test(String(item[key] ?? ''))) return `invalid ${key}`;
  return null;
}

function checkCode(code) {
  if (typeof code !== 'string' || code.length > MAX_CODE) return 'code missing or too large';
  const policy = checkCodePolicy(code);
  return policy.ok ? null : policy.error;
}

export function createOps({ adminDb, runWorker }) {
  async function save(entry, namespace, body, character) {
    const { job, profileId } = entry;
    if (namespace !== job.collection) return fail(`this job can only save to ${job.collection}`);
    const { item } = body;
    const problem = checkItem(item) ?? checkCode(item?.code);
    if (problem) return fail(problem);
    if (!profileId) return fail('job has no author profile');
    // Taken before the first await, or overlapping saves all pass the cap. Only a save that
    // lands keeps its slot.
    if (entry.saves >= saveCapFor(job)) return fail('save limit for this job reached');
    entry.saves += 1;
    let saved = false;
    try {
      const checked = await runWorker({ kind: 'check-item', item, character });
      if (!checked.ok) return { ok: false, error: checked.error, warnings: checked.warnings };
      const vendored = await runWorker({ kind: 'vendor-item', item });
      const warnings = vendored.warnings ?? [];
      const inserted = await insertItem(adminDb, namespace, item, profileId, { jobId: job.id });
      if (!inserted.ok) return { ...inserted, warnings };
      saved = true;
      return { ok: true, id: item.id, warnings };
    } finally {
      if (!saved) entry.saves -= 1;
    }
  }

  return {
    'save-track': (entry, body) => save(entry, 'tracks', body, true),
    'save-stem': (entry, body) => save(entry, 'stems', body, false),

    'save-palette': async (entry, { palette }) => {
      const problem = checkItem(palette, 'batch') ?? batchNameProblem(palette.batch);
      if (problem) return fail(problem);
      // A job may rewrite its own batch; another job's stays that job's.
      entry.batches ??= new Set();
      const mine = entry.batches.has(palette.batch);
      if (!mine && entry.batches.size >= MAX_PALETTES_PER_JOB) return fail('palette limit for this job reached');
      if (!mine) entry.batches.add(palette.batch);
      let saved = false;
      try {
        const checked = await runWorker({ kind: 'check-palette', palette });
        if (!checked.ok) return checked;
        const written = await runWorker({ kind: 'write-palette', palette, overwrite: mine });
        saved = written.ok;
        return written.ok ? { ...written, voices: checked.voices } : written;
      } finally {
        if (!saved && !mine) entry.batches.delete(palette.batch);
      }
    },

    validate: async (_entry, { code, item, character }) => {
      const problem = checkCode(code ?? item?.code);
      if (problem) return fail(problem);
      return runWorker(item ? { kind: 'check-item', item, character: !!character } : { kind: 'check-code', code });
    },

    'list-slugs': async (entry) => ({ ok: true, slugs: [...(await itemSlugs(adminDb, entry.job.collection))].sort() }),

    feedback: async ({ profileId, job }) => {
      if (!profileId) return fail('job has no author profile');
      return { ok: true, digest: buildDigest(await queryLessonsByProfile(adminDb, profileId, job.collection)) };
    },

    'pending-revisions': async ({ job, profileId }) => {
      const ns = job.collection;
      const res = await adminDb.query({ [ns]: { author: {} } });
      const rows = res[ns].map((r) => {
        const author = Array.isArray(r.author) ? r.author[0] : r.author;
        return { ...r, id: r.slug, authorProfileId: author?.id ?? null };
      });
      return { ok: true, list: buildWorklist(rows, { profileId, inJob: true }) };
    },

    // Only the source the requester named when creating the job, and only if public.
    'remix-source': async ({ job }, { slug }) => {
      if (job.type !== 'remix' || slug !== job.sourceSlug) return fail('not this job\'s remix source');
      const ns = job.collection;
      const item = (await adminDb.query({ [ns]: { $: { where: { slug } } } }))[ns][0];
      if (!item || item.isPublic === false) return fail(`source not found: ${ns}/${slug}`);
      const newId = nextRemixId(slug, [...(await itemSlugs(adminDb, ns))]);
      return {
        ok: true,
        source: {
          root: item.versionOf ?? item.slug,
          newId,
          namespace: ns,
          title: item.title,
          batch: item.batch,
          prompt: item.prompt,
          code: item.code,
          meta: item.meta,
        },
      };
    },
  };
}

export function createJobBroker({ ops, connect = (port, host) => net.connect(port, host) }) {
  const jobs = new Map(); // bearer -> { job, profileId, saves, calls }

  async function readBody(req) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) throw Object.assign(new Error('too large'), { status: 413 });
      chunks.push(c);
    }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  }

  const server = http.createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      const entry = jobs.get(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (!entry) return reply(401, fail('unauthorized'));
      const name = req.url.match(/^\/op\/([a-z-]+)$/)?.[1];
      if (req.method !== 'POST' || !name || !Object.hasOwn(ops, name)) return reply(404, fail('no such op'));
      if (++entry.calls > MAX_OPS) return reply(429, fail('op limit for this job reached'));
      return reply(200, await ops[name](entry, await readBody(req)));
    } catch (err) {
      console.error('[crate] job broker:', err);
      return reply(err.status ?? 500, fail('broker error'));
    }
  });

  server.on('connect', (req, sock, head) => {
    sock.on('error', () => {});
    if (!jobs.size || !EGRESS_HOSTS.has(req.url)) {
      sock.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const [host, port] = req.url.split(':');
    const up = connect(Number(port), host);
    up.on('connect', () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.write(head);
      up.pipe(sock);
      sock.pipe(up);
    });
    up.on('error', () => sock.destroy());
    sock.on('close', () => up.destroy());
  });

  return {
    listen: () => new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); }),
    close: () => new Promise((resolve) => { server.close(resolve); }),
    port: () => server.address().port,
    register(job, profileId) {
      const token = randomBytes(32).toString('hex');
      jobs.set(token, { job, profileId, saves: 0, calls: 0 });
      return token;
    },
    revoke: (token) => { jobs.delete(token); },
  };
}
