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
import { systemdEnv, systemdRunArgv, workerSandboxFlags, WORKER_LIMITS } from './job-sandbox.mjs';
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

export const saveCapFor = (job) => (job.count ?? 1) + MAX_REVISIONS;

// Evaluate agent-written code in its own sandbox and unit, away from this process.
export function createWorkerRunner({ repoRoot, spawn = nodeSpawn }) {
  return async function runWorker(payload) {
    const name = randomUUID();
    const tmpDir = join(repoRoot, 'data', 'job-sandbox', `worker-${name}`);
    await mkdir(tmpDir, { recursive: true });
    const command = [
      '/usr/bin/python3', '-I', join(repoRoot, 'scripts', 'sandbox', 'sandbox-exec.py'),
      ...workerSandboxFlags({ repoRoot, tmpDir }),
      '--', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', `HOME=${tmpDir}`, `TMPDIR=${tmpDir}`, 'NODE_ENV=production',
      process.execPath, join(repoRoot, 'scripts', 'sandbox', 'validate-worker.mjs'),
    ];
    try {
      return await new Promise((resolve) => {
        const child = spawn('systemd-run', systemdRunArgv({
          unit: `crate-worker-${name}`, limits: WORKER_LIMITS, cwd: repoRoot, command,
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
  };
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
    if (entry.saves >= saveCapFor(job)) return fail('save limit for this job reached');
    const { item } = body;
    const problem = checkItem(item) ?? checkCode(item?.code);
    if (problem) return fail(problem);
    if (!profileId) return fail('job has no author profile');
    const checked = await runWorker({ kind: 'item', item, character });
    if (!checked.ok) return { ok: false, error: checked.error, warnings: checked.warnings };
    const saved = await insertItem(adminDb, namespace, item, profileId, { jobId: job.id });
    if (!saved.ok) return { ...saved, warnings: checked.warnings };
    entry.saves += 1;
    return { ok: true, id: item.id, warnings: checked.warnings ?? [] };
  }

  return {
    'save-track': (entry, body) => save(entry, 'tracks', body, true),
    'save-stem': (entry, body) => save(entry, 'stems', body, false),

    'save-palette': async (_entry, { palette }) => {
      const problem = checkItem(palette, 'batch');
      if (problem) return fail(problem);
      return runWorker({ kind: 'palette', palette });
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
