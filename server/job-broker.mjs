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
import { insertItem, itemSlugs, itemsBySlug, queryLessonsByProfile } from './instant.mjs';
import {
  MAX_CONCURRENT_WORKERS, PUBLISHER_LIMITS, systemdEnv, systemdRunArgv, workerSandboxFlags, WORKER_LIMITS,
} from './job-sandbox.mjs';
import { checkCodePolicy, checkCodeVolume } from '../scripts/lib/code-policy.mjs';
import { sourcesIn } from '../scripts/lib/sample-cache.mjs';
import { buildDigest } from '../scripts/feedback.mjs';
import { nextRemixId } from '../scripts/remix-source.mjs';
import { buildWorklist } from '../src/versions.js';

const EGRESS_HOSTS = new Set(['api.anthropic.com:443']);
const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const MAX_BODY = 1024 * 1024;
const MAX_CODE = 32 * 1024; // longest live row: 9.4K
const MAX_OPS = 5000;
// Requests one job may have open. Sub-agents fan out to about 8, one call each; each open call
// holds its body (up to MAX_BODY) on this process's heap while it waits for a worker.
const MAX_INFLIGHT = 24;
const RESULT_MARK = 'CRATE_WORKER_RESULT ';
const PUBLISHING_KINDS = new Set(['vendor-item', 'write-palette']);
const MAX_WORKER_OUTPUT = 40 * 1024 * 1024; // a fetcher's answer holds sample manifests
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

// What was asked for, plus one for each note the worklist told this job to revise (Step 0).
export const saveCapFor = (job, revisions = 0) => (job.count ?? 1) + revisions;

// Evaluate agent-written code in its own sandbox and unit, away from this process. Its result
// is advisory: an evaluator could print any result line, which is why stored code only ever
// runs in an opaque frame, and why only a publisher, running none of that code, can write.
export function createWorkerRunner({ repoRoot, spawn = nodeSpawn, maxConcurrent = MAX_CONCURRENT_WORKERS }) {
  const limited = limiter(maxConcurrent);
  const runUnit = (payload) => limited(async () => {
    const publishes = PUBLISHING_KINDS.has(payload.kind);
    const network = publishes || payload.kind === 'fetch-manifests';
    const name = randomUUID();
    const tmpDir = join(repoRoot, 'data', 'job-sandbox', `worker-${name}`);
    await mkdir(tmpDir, { recursive: true });
    const command = [
      '/usr/bin/python3', '-I', join(repoRoot, 'scripts', 'sandbox', 'sandbox-exec.py'),
      ...workerSandboxFlags({ repoRoot, tmpDir, publishes, network }),
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
        child.stdout.on('data', (d) => { if (out.length < MAX_WORKER_OUTPUT) out += d; });
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
  return async function runWorker(payload) {
    if (!payload.kind.startsWith('check-') || sourcesIn(payload).length === 0) return runUnit(payload);
    const fetched = await runUnit({ kind: 'fetch-manifests', request: payload });
    if (!fetched.ok) return fetched;
    return runUnit({ ...payload, manifests: fetched.manifests });
  };
}

const fail = (error) => ({ ok: false, error });

function checkItem(item, key = 'id') {
  if (!item || typeof item !== 'object') return 'not an object';
  if (!SLUG_RE.test(String(item[key] ?? ''))) return `invalid ${key}`;
  return null;
}

// A saved row is public, so its free text is a place private text could go. These are about twice
// the longest live values (40, 309, 54, 605). Evaluation can't vouch for them: its result is advisory.
const FIELD_LIMITS = { title: 120, prompt: 600, batch: 72, description: 1500 };
const CREATED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const META_TEXT = 120; // longest live: 68
const META_INSTRUMENTS = 24; // most live: 13
const META_INSTRUMENT = 64; // longest live: 43

const isOptionalInt = (v, min, max) => v === undefined || (Number.isInteger(v) && v >= min && v <= max);

function metaProblem(meta) {
  if (meta === undefined) return null;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return 'meta must be an object';
  if (!isOptionalInt(meta.bpm, 40, 220)) return 'meta.bpm must be an integer 40-220';
  if (!isOptionalInt(meta.energy, 1, 5)) return 'meta.energy must be an integer 1-5';
  for (const f of ['genre', 'mood', 'key']) {
    if (meta[f] !== undefined && (typeof meta[f] !== 'string' || meta[f].length > META_TEXT)) return `meta.${f} must be a string of at most ${META_TEXT} characters`;
  }
  const { instruments } = meta;
  if (instruments !== undefined && !(Array.isArray(instruments) && instruments.length <= META_INSTRUMENTS
    && instruments.every((x) => typeof x === 'string' && x.length <= META_INSTRUMENT))) {
    return `meta.instruments must be at most ${META_INSTRUMENTS} strings of at most ${META_INSTRUMENT} characters`;
  }
  return null;
}

function checkFields(item) {
  for (const [field, max] of Object.entries(FIELD_LIMITS)) {
    const v = item[field];
    if (v !== undefined && (typeof v !== 'string' || v.length > max)) return `${field} must be a string of at most ${max} characters`;
  }
  if (typeof item.id !== 'string') return 'invalid id';
  if (item.batch !== undefined && !SLUG_RE.test(item.batch)) return 'invalid batch';
  if (item.createdAt !== undefined && !(typeof item.createdAt === 'string' && CREATED_AT_RE.test(item.createdAt))) return 'createdAt must be an ISO timestamp, UTC';
  for (const f of ['versionOf', 'remixOf']) {
    if (item[f] !== undefined && item[f] !== null && !(typeof item[f] === 'string' && SLUG_RE.test(item[f]))) return `invalid ${f}`;
  }
  return metaProblem(item.meta);
}

// The meta a row keeps: what the app reads, so a key of the agent's choosing isn't public text.
function storedMeta(meta) {
  if (meta === undefined) return undefined;
  const { bpm, genre, mood, key, instruments, energy } = meta;
  return JSON.parse(JSON.stringify({ bpm, genre, mood, key, instruments, energy }));
}

// What a row stores. Notes and lessons on a row are its listeners', and start empty.
const storedRow = (item) => ({
  id: item.id,
  title: item.title,
  prompt: item.prompt,
  batch: item.batch,
  description: item.description,
  code: item.code,
  meta: storedMeta(item.meta),
  createdAt: item.createdAt,
  versionOf: item.versionOf,
  remixOf: item.remixOf,
  notes: '',
  lesson: '',
});

const rowText = (row) => [
  row.id, row.title, row.batch, row.description, row.prompt, row.versionOf, row.remixOf, JSON.stringify(row.meta ?? {}), row.code,
].join('\n');

const squeeze = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const MIN_QUOTE = 16; // squeezed characters: shorter than this is ordinary musical vocabulary

// Lessons are private and rows are public. This catches a lesson copied into a row, including
// by an unsteered model being helpful; it is no bar to one paraphrasing or encoding on purpose.
// A requester's own prompt may repeat their lesson: that is their choice to publish.
function quotesPrivateText(entry, item) {
  const texts = entry.privateTexts ?? [];
  if (!texts.length) return false;
  const row = squeeze(rowText(item));
  const prompt = squeeze(entry.job.prompt ?? '');
  return texts.flatMap((t) => String(t).split(/[.!?\n]+/)).map(squeeze)
    .some((part) => part.length >= MIN_QUOTE && !prompt.includes(part) && row.includes(part));
}

function checkCode(code) {
  if (typeof code !== 'string' || code.length > MAX_CODE) return 'code missing or too large';
  const policy = checkCodePolicy(code);
  if (!policy.ok) return policy.error;
  const volume = checkCodeVolume(code);
  return volume.ok ? null : volume.error;
}

// A remix job reads another user's row, which is text that user chose. It holds nothing private,
// so that text has nothing of the requester's to steer into a public row.
const NOT_IN_REMIX = 'a remix job does not read lessons or notes';

export function createOps({ adminDb, runWorker }) {
  async function save(entry, namespace, body, character) {
    const { job, profileId } = entry;
    if (namespace !== job.collection) return fail(`this job can only save to ${job.collection}`);
    const problem = checkItem(body.item) ?? checkFields(body.item) ?? checkCode(body.item?.code);
    if (problem) return fail(problem);
    const item = storedRow(body.item);
    // A remix names the source it was handed. Anything else there is just more public text.
    if (item.remixOf && item.remixOf !== entry.remixRoot) return fail('remixOf must be the root of this job\'s remix source');
    if (quotesPrivateText(entry, item)) return fail('this row quotes a private lesson, and rows are public: say it in other words or leave it out');
    if (!profileId) return fail('job has no author profile');
    // Taken before the first await, or overlapping saves all pass the cap. Only a save that
    // lands keeps its slot.
    if (entry.saves >= saveCapFor(job, entry.revisions)) return fail('save limit for this job reached');
    entry.saves += 1;
    let saved = false;
    try {
      // Before vendoring, which would otherwise spend disk and rewrite this slug's manifest for nothing.
      if ((await itemsBySlug(adminDb, namespace, [item.id])).length) return fail(`slug already exists: ${item.id}`);
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

    feedback: async (entry) => {
      const { profileId, job } = entry;
      if (job.type === 'remix') return fail(NOT_IN_REMIX);
      if (!profileId) return fail('job has no author profile');
      const lessons = await queryLessonsByProfile(adminDb, profileId, job.collection);
      entry.privateTexts = lessons.map((l) => l.text).filter(Boolean);
      return { ok: true, digest: buildDigest(lessons) };
    },

    'pending-revisions': async (entry) => {
      const { job, profileId } = entry;
      if (job.type === 'remix') return fail(NOT_IN_REMIX);
      const ns = job.collection;
      const res = await adminDb.query({ [ns]: { author: {} } });
      const rows = res[ns].map((r) => {
        const author = Array.isArray(r.author) ? r.author[0] : r.author;
        return { ...r, id: r.slug, authorProfileId: author?.id ?? null };
      });
      const list = buildWorklist(rows, { profileId, inJob: true });
      entry.revisions = Math.max(entry.revisions ?? 0, list.length); // a saved revision leaves the list
      return { ok: true, list };
    },

    // Only the source the requester named when creating the job, and only if public.
    'remix-source': async (entry, { slug }) => {
      const { job } = entry;
      if (job.type !== 'remix' || slug !== job.sourceSlug) return fail('not this job\'s remix source');
      const ns = job.collection;
      const item = (await adminDb.query({ [ns]: { $: { where: { slug } } } }))[ns][0];
      if (!item || item.isPublic === false) return fail(`source not found: ${ns}/${slug}`);
      const newId = nextRemixId(slug, [...(await itemSlugs(adminDb, ns))]);
      entry.remixRoot = item.versionOf ?? item.slug;
      return {
        ok: true,
        source: {
          root: entry.remixRoot,
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
      if (entry.inflight >= MAX_INFLIGHT) return reply(429, fail('too many calls at once'));
      entry.inflight += 1;
      try {
        return reply(200, await ops[name](entry, await readBody(req)));
      } finally {
        entry.inflight -= 1;
      }
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
      jobs.set(token, { job, profileId, saves: 0, calls: 0, inflight: 0 });
      return token;
    },
    revoke: (token) => { jobs.delete(token); },
  };
}
