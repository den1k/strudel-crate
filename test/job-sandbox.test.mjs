// A generation job gets what it needs to generate and nothing else.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import request from 'supertest';
import { fakeAdmin } from './fake-admin.mjs';
import { createApp } from '../server/app.mjs';
import { createJobBroker, createOps, createWorkerRunner, saveCapFor } from '../server/job-broker.mjs';
import { agentEnv, agentSandboxFlags, createJobLauncher, freshOauthToken, systemdRunArgv, workerSandboxFlags } from '../server/job-sandbox.mjs';
import { budgetFor, createJobStore, jobQuotaError } from '../server/jobs.mjs';
import { buildArgv, createRunner } from '../server/runner.mjs';
import { cacheBank, fetchManifests } from '../scripts/lib/sample-cache.mjs';

const HELPER = fileURLToPath(new URL('../scripts/sandbox/sandbox-exec.py', import.meta.url));
const SYS = ['--rox', '/usr', '--rox', '/lib', '--rox', '/lib64', '--rox', '/bin', '--ro', '/etc/ld.so.cache'];
const probe = (flags, code) => {
  const r = spawnSync('/usr/bin/python3', ['-I', HELPER, ...SYS, ...flags, '--', '/usr/bin/python3', '-I', '-c', code], { encoding: 'utf8', timeout: 15000 });
  return { out: r.stdout.trim(), code: r.status, err: r.stderr };
};
const attempt = (expr) => `
import socket, os
try:
    ${expr}
    print('ALLOWED')
except OSError:
    print('DENIED')
`;

describe('sandbox-exec', () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'crate-sb-'));
    await mkdir(join(dir, 'open'));
    await mkdir(join(dir, 'closed'));
    await writeFile(join(dir, 'closed', '.env'), 'TOKEN=secret');
    await writeFile(join(dir, 'open', 'file'), 'data');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('reads only what is listed', () => {
    const flags = ['--ro', join(dir, 'open')];
    expect(probe(flags, attempt(`open('${join(dir, 'open/file')}').read()`)).out).toBe('ALLOWED');
    expect(probe(flags, attempt(`open('${join(dir, 'closed/.env')}').read()`)).out).toBe('DENIED');
    expect(probe(flags, attempt(`open('${process.env.HOME}/.claude/.credentials.json').read()`)).out).toBe('DENIED');
  });
  it('writes only where listed', () => {
    const flags = ['--ro', join(dir, 'open'), '--rw', join(dir, 'closed')];
    expect(probe(flags, attempt(`open('${join(dir, 'closed/new')}', 'w').close()`)).out).toBe('ALLOWED');
    expect(probe(flags, attempt(`open('${join(dir, 'open/new')}', 'w').close()`)).out).toBe('DENIED');
  });
  it('blocks UNIX sockets, so the user bus is no way out', () => {
    expect(probe([], attempt('socket.socket(socket.AF_UNIX)')).out).toBe('DENIED');
  });
  it('blocks UDP unless asked, and connects only to listed TCP ports', async () => {
    expect(probe([], attempt('socket.socket(socket.AF_INET, socket.SOCK_DGRAM)')).out).toBe('DENIED');
    expect(probe(['--allow-udp'], attempt('socket.socket(socket.AF_INET, socket.SOCK_DGRAM)')).out).toBe('ALLOWED');
    const server = net.createServer((s) => s.end());
    await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
    const { port } = server.address();
    const connect = attempt(`socket.create_connection(('127.0.0.1', ${port}), 3).close()`);
    const run = (flags) => new Promise((resolve) => {
      const c = spawn('/usr/bin/python3', ['-I', HELPER, ...SYS, ...flags, '--', '/usr/bin/python3', '-I', '-c', connect]);
      let out = '';
      c.stdout.on('data', (d) => { out += d; });
      c.on('close', () => resolve(out.trim()));
    });
    expect(await run(['--tcp', String(port)])).toBe('ALLOWED');
    expect(await run(['--tcp', String(port + 1)])).toBe('DENIED');
    server.close();
  });
  it('blocks reading another process\'s environment', () => {
    expect(probe(['--ro', '/proc'], attempt(`open('/proc/${process.pid}/environ').read()`)).out).toBe('DENIED');
  });
  it('replaces the environment from a file and deletes the file, so no secret sits on argv', async () => {
    const f = join(dir, 'env.json');
    await writeFile(f, JSON.stringify({ ONLY: 'this' }));
    const r = spawnSync('/usr/bin/python3', ['-I', HELPER, ...SYS, '--env-file', f, '--', '/usr/bin/python3', '-I', '-c', 'import os;print(sorted(os.environ))'], {
      encoding: 'utf8', env: { ...process.env, INSTANT_ADMIN_TOKEN: 'leak' },
    });
    expect(r.stdout).toContain('ONLY');
    expect(r.stdout).not.toContain('INSTANT_ADMIN_TOKEN');
    await expect(stat(f)).rejects.toThrow();
  });
  it('fails closed on a bad flag', () => {
    const r = spawnSync('/usr/bin/python3', ['-I', HELPER, '--nope', '--', '/bin/true']);
    expect(r.status).toBe(125);
  });
});

describe('job authority', () => {
  const repo = '/srv/crate';
  const flags = agentSandboxFlags({ repoRoot: repo, jobDir: '/srv/crate/data/job-sandbox/j', proxyPort: 4000, claudeDir: '/c', envFile: '/e' });
  const grants = flags.filter((_, i) => flags[i - 1] === '--ro' || flags[i - 1] === '--rox' || flags[i - 1] === '--rw');

  it('never grants the secrets, the repo root, or the operator home', () => {
    for (const g of [...grants, ...workerSandboxFlags({ repoRoot: repo, tmpDir: '/t' })]) {
      expect(g).not.toMatch(/\.env|\.git\b|data\/jobs|\.claude\/\.credentials|\.config|\.ssh/);
      expect(g).not.toBe(repo);
      expect(g).not.toBe(`${repo}/data`);
      expect(g).not.toBe('/proc');
      expect(g).not.toBe('/run');
    }
  });
  it('lets the agent write only its own dir', () => {
    const rw = flags.filter((_, i) => flags[i - 1] === '--rw' || flags[i - 1] === '--rw-links').filter((p) => !p.startsWith('/dev/'));
    expect(rw).toEqual(['/srv/crate/data/job-sandbox/j']);
  });
  it('lets the agent reach only the broker over TCP', () => {
    expect(flags.filter((_, i) => flags[i - 1] === '--tcp')).toEqual(['4000']);
    expect(flags).not.toContain('--allow-udp');
  });
  it('builds the agent environment from nothing', () => {
    process.env.INSTANT_ADMIN_TOKEN = 'leak';
    const env = agentEnv({ jobId: 'j', jobDir: '/d', proxyPort: 1, brokerToken: 'b', oauthToken: 'o' });
    delete process.env.INSTANT_ADMIN_TOKEN;
    expect(JSON.stringify(env)).not.toContain('leak');
    expect(Object.keys(env).join()).not.toMatch(/INSTANT|VITE|CRATE_ALLOWED|REFRESH|CRATE_AUTHOR/);
  });
  it('keeps secrets off the systemd-run command line', () => {
    const argv = systemdRunArgv({ unit: 'u', limits: { MemoryMax: '1G' }, cwd: '/', command: ['x'] });
    expect(argv).toContain('--user');
    expect(argv).not.toContain('--setenv');
    expect(argv.join(' ')).not.toMatch(/\bsudo\b/);
  });
  it('claude gets the repo skills, none of the operator settings, and a spend ceiling', () => {
    const argv = buildArgv({ type: 'generate-tracks', prompt: 'x', count: 12 });
    expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('project');
    expect(argv).toContain('--strict-mcp-config');
    expect(argv[argv.indexOf('--max-budget-usd') + 1]).toBe(String(budgetFor({ type: 'generate-tracks', count: 12 })));
    const allowed = argv[argv.indexOf('--allowedTools') + 1];
    expect(allowed).toContain('Write(staging/**)');
    expect(allowed).not.toMatch(/(^|,)Write(,|$)/);
    expect(allowed).not.toMatch(/(^|,)Bash(,|$)/);
    expect(argv[argv.indexOf('--tools') + 1]).not.toMatch(/WebFetch|WebSearch/);
  });
});

describe('job scripts hold no credentials', () => {
  it('list-slugs forwards to the broker and never needs the admin token', async () => {
    const server = http.createServer((req, res) => {
      expect(req.headers.authorization).toBe('Bearer tok');
      res.end(JSON.stringify({ ok: true, slugs: ['a', 'b'] }));
    });
    await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
    const env = {
      PATH: process.env.PATH, CRATE_BROKER_URL: `http://127.0.0.1:${server.address().port}`, CRATE_BROKER_TOKEN: 'tok', HOME: tmpdir(),
    };
    const script = fileURLToPath(new URL('../scripts/list-slugs.mjs', import.meta.url));
    const out = await new Promise((resolve) => {
      const c = spawn(process.execPath, [script, 'tracks'], { env, cwd: tmpdir() });
      let o = '';
      c.stdout.on('data', (d) => { o += d; });
      c.on('close', () => resolve(o));
    });
    server.close();
    expect(out.trim().split('\n')).toEqual(['a', 'b']);
  });
});

const goodItem = (over = {}) => ({ id: 'song-01', title: 't', code: 's("bd")', ...over });
describe('job broker', () => {
  const job = { id: 'job-1', type: 'generate-tracks', collection: 'tracks', count: 1 };
  let broker; let adminDb; let worker;

  const call = (token, op, body = {}) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: broker.port(), path: `/op/${op}`, method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    }, (res) => {
      let out = '';
      res.on('data', (d) => { out += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(out) }));
    });
    req.on('error', reject);
    req.end(data);
  });

  beforeEach(async () => {
    adminDb = fakeAdmin({ tracks: [], stems: [], lessons: [], profiles: [{ id: 'p1' }] });
    worker = { calls: [], result: { ok: true, events: 4, warnings: [] } };
    const runWorker = async (payload) => { worker.calls.push(payload); return worker.result; };
    broker = createJobBroker({ ops: createOps({ adminDb, runWorker }) });
    await broker.listen();
  });
  afterEach(() => broker.close());

  it('rejects unknown and revoked tokens', async () => {
    expect((await call('nope', 'list-slugs')).status).toBe(401);
    const t = broker.register(job, 'p1');
    broker.revoke(t);
    expect((await call(t, 'list-slugs')).status).toBe(401);
  });
  it('binds author and job from the registration, never the request', async () => {
    const t = broker.register(job, 'p1');
    const res = await call(t, 'save-track', { item: goodItem({ author: 'victim', jobId: 'forged' }), profileId: 'victim', jobId: 'forged' });
    expect(res.body.ok).toBe(true);
    const op = adminDb._txs.find((x) => x.update?.slug === 'song-01');
    expect(op.update.jobId).toBe('job-1');
    expect(op.link).toEqual({ author: 'p1' });
  });
  it('refuses another collection, bad slugs and policy-failing code before any evaluation', async () => {
    const t = broker.register(job, 'p1');
    expect((await call(t, 'save-stem', { item: goodItem() })).body.ok).toBe(false);
    expect((await call(t, 'save-track', { item: goodItem({ id: '../x' }) })).body.ok).toBe(false);
    expect((await call(t, 'save-track', { item: goodItem({ code: 'fetch("https://x")' }) })).body.ok).toBe(false);
    expect((await call(t, 'save-palette', { palette: { batch: '../../x' } })).body.ok).toBe(false);
    expect(worker.calls).toEqual([]);
  });
  it('does not write when the worker rejects', async () => {
    worker.result = { ok: false, error: 'bad' };
    const t = broker.register(job, 'p1');
    expect((await call(t, 'save-track', { item: goodItem() })).body).toMatchObject({ ok: false, error: 'bad' });
    expect(adminDb._txs).toEqual([]);
  });
  it('caps saves per job', async () => {
    const t = broker.register(job, 'p1');
    for (let i = 0; i < saveCapFor(job); i++) {
      expect((await call(t, 'save-track', { item: goodItem({ id: `s-${i}` }) })).body.ok).toBe(true);
    }
    expect((await call(t, 'save-track', { item: goodItem({ id: 's-over' }) })).body.error).toMatch(/limit/);
  });
  it('gives a remix job only its own source, and only if public', async () => {
    adminDb = fakeAdmin({ tracks: [{ id: 'e1', slug: 'mine', isPublic: true, code: 'c' }, { id: 'e2', slug: 'hidden', isPublic: false, code: 'c' }] });
    await broker.close();
    broker = createJobBroker({ ops: createOps({ adminDb, runWorker: async () => ({ ok: true }) }) });
    await broker.listen();
    const remix = { id: 'j', type: 'remix', collection: 'tracks', sourceSlug: 'mine' };
    const t = broker.register(remix, 'p1');
    expect((await call(t, 'remix-source', { slug: 'mine' })).body.source.code).toBe('c');
    expect((await call(t, 'remix-source', { slug: 'hidden' })).body.ok).toBe(false);
    const t2 = broker.register({ ...remix, sourceSlug: 'hidden' }, 'p1');
    expect((await call(t2, 'remix-source', { slug: 'hidden' })).body.ok).toBe(false);
  });
  it('tunnels only to the Claude API, and only while a job runs', async () => {
    const connectTo = (target) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: broker.port(), method: 'CONNECT', path: target });
      req.on('connect', (res, sock) => { sock.destroy(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end();
    });
    expect(await connectTo('api.anthropic.com:443')).toBe(403); // no job
    const t = broker.register(job, 'p1');
    for (const bad of ['evil.example:443', 'api.anthropic.com:80', '127.0.0.1:3008', '169.254.169.254:80']) {
      expect(await connectTo(bad)).toBe(403);
    }
    broker.revoke(t);
  });
});

describe('per-user cost bound', () => {
  const now = Date.parse('2026-11-06T12:00:00Z');
  const job = { userId: 'u', type: 'generate-tracks', count: 12 };
  const past = (over = {}) => ({ userId: 'u', status: 'done', createdAt: new Date(now - 3600e3).toISOString(), costUSD: 1, ...over });

  it('allows a normal job', () => expect(jobQuotaError([past()], job, now)).toBeNull());
  it('caps concurrent jobs', () => {
    expect(jobQuotaError([past({ status: 'queued' }), past({ status: 'running' })], job, now)).toMatch(/running/);
  });
  it('caps jobs per day', () => expect(jobQuotaError(Array.from({ length: 10 }, () => past()), job, now)).toMatch(/daily job/));
  it('caps spend per day, and charges unreported jobs at their budget', () => {
    expect(jobQuotaError([past({ costUSD: 60 })], job, now)).toMatch(/budget/);
    expect(jobQuotaError([past({ costUSD: undefined, count: 30 }), past({ costUSD: undefined, count: 12 })], job, now)).toMatch(/budget/);
  });
  it('ignores other users and old jobs', () => {
    expect(jobQuotaError([past({ userId: 'v', costUSD: 500 }), past({ createdAt: new Date(now - 90000e3).toISOString(), costUSD: 500 })], job, now)).toBeNull();
  });
  it('the route answers 429 and does not enqueue', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crate-jobs-'));
    const jobStore = createJobStore({ jobsDir: dir });
    const user = { id: 'u', email: 'a@b.c' };
    for (let i = 0; i < 2; i++) {
      await jobStore.write({ id: `j${i}`, userId: 'u', status: 'running', createdAt: new Date().toISOString() });
    }
    let enqueued = 0;
    const app = createApp({
      jobStore,
      runner: { enqueue: async () => { enqueued += 1; } },
      requireAuth: (req, _res, next) => { req.user = user; next(); },
    });
    await request(app).post('/api/jobs').send({ type: 'generate-stems', prompt: 'x', count: 1 }).expect(429);
    expect(enqueued).toBe(0);
    await rm(dir, { recursive: true });
  });
});

describe('runner', () => {
  const fakeChild = (code = 0, out = '{}') => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    setImmediate(() => { c.stdout.emit('data', out); c.emit('close', code); });
    return c;
  };
  it('runs via the launcher, records cost, always cleans up', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crate-run-'));
    const jobStore = createJobStore({ jobsDir: dir });
    const job = { id: 'a', type: 'generate-stems', prompt: 'x', count: 1, collection: 'stems', userId: 'u', userEmail: 'a@b.c', createdAt: 'x', status: 'queued' };
    await jobStore.write(job);
    let cleaned = false;
    const spawned = [];
    const runner = createRunner({
      jobStore,
      adminDb: fakeAdmin({ stems: [], profiles: [{ id: 'p', user: { id: 'u' } }] }),
      launcher: async (_j, _p, args) => ({ command: 'systemd-run', args, options: {}, cleanup: async () => { cleaned = true; } }),
      spawn: (cmd, args) => { spawned.push([cmd, args]); return fakeChild(0, JSON.stringify({ result: 'ok', total_cost_usd: 1.25 })); },
    });
    await runner.enqueue(job);
    await new Promise((r) => { setTimeout(r, 80); });
    const done = await jobStore.get('a');
    expect(spawned[0][0]).toBe('systemd-run');
    expect(done.status).toBe('done');
    expect(done.costUSD).toBe(1.25);
    expect(cleaned).toBe(true);
    await rm(dir, { recursive: true });
  });
  it('drops a queued job whose requester lost access', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crate-run-'));
    const jobStore = createJobStore({ jobsDir: dir });
    const job = { id: 'b', type: 'generate-stems', prompt: 'x', count: 1, collection: 'stems', userId: 'u', userEmail: 'gone@b.c', createdAt: 'x', status: 'queued' };
    await jobStore.write(job);
    let launched = 0;
    const runner = createRunner({
      jobStore, adminDb: fakeAdmin({ stems: [] }), isAllowed: async () => false,
      launcher: async () => { launched += 1; return {}; },
    });
    await runner.recover();
    await new Promise((r) => { setTimeout(r, 50); });
    expect(launched).toBe(0);
    expect((await jobStore.get('b')).status).toBe('failed');
    await rm(dir, { recursive: true });
  });
});

describe('claude login', () => {
  const hour = 3600e3;
  const t0 = 1e12;
  it('uses a token that outlasts a job', async () => {
    const token = await freshOauthToken({ read: async () => ({ accessToken: 'a', expiresAt: t0 + 2 * hour }), now: () => t0, refresh: async () => { throw new Error('no'); } });
    expect(token).toBe('a');
  });
  it('refreshes one about to expire', async () => {
    let cur = { accessToken: 'old', expiresAt: t0 + 60e3 };
    const token = await freshOauthToken({ read: async () => cur, now: () => t0, refresh: async () => { cur = { accessToken: 'new', expiresAt: t0 + 8 * hour }; } });
    expect(token).toBe('new');
  });
  it('waits out a token too short to use and too long to refresh', async () => {
    let clock = t0;
    const token = await freshOauthToken({
      read: async () => ({ accessToken: clock < t0 + 40 * 60e3 ? 'old' : 'new', expiresAt: clock < t0 + 40 * 60e3 ? t0 + 30 * 60e3 : t0 + 8 * hour }),
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      refresh: async () => { clock += 60e3; },
    });
    expect(token).toBe('new');
  });
});

// Audit run-2. Each one is a way out that the kernel must refuse even to arbitrary code,
// because the code policy is not the boundary.
describe('sandbox-exec: arbitrary code still reaches nothing else', () => {
  const pyProbe = (flags, code, opts = {}) => {
    const r = spawnSync('/usr/bin/python3', ['-I', HELPER, ...SYS, ...flags, '--', '/usr/bin/python3', '-I', '-c', code], { encoding: 'utf8', timeout: 20000, ...opts });
    return { out: r.stdout.trim(), code: r.status, err: r.stderr };
  };
  let dir;
  let dummy;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'crate-sb2-'));
    dummy = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
  });
  afterEach(async () => {
    dummy.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  });
  const alive = () => dummy.exitCode === null && dummy.signalCode === null;
  const settle = () => new Promise((r) => { setTimeout(r, 150); });
  const tryIt = (body) => `
import os, signal, socket, ctypes
def go():
${body.split('\n').map((l) => `    ${l}`).join('\n')}
try:
    go()
    print('ALLOWED')
except OSError as e:
    print('DENIED', e.errno)
`;

  it.each([
    ['symlink', (d) => `os.symlink('/etc/passwd', '${d}/link')`],
    ['fifo', (d) => `os.mkfifo('${d}/pipe')`],
  ])('--rw refuses a %s, so a served tree holds only regular files', async (_n, op) => {
    expect(pyProbe(['--rw', dir], tryIt(op(dir))).out).toMatch(/^DENIED 13/);
  });
  it('--rw refuses moving a symlink in from private scratch', async () => {
    const scratch = join(dir, 'scratch'); const served = join(dir, 'served');
    await mkdir(scratch); await mkdir(served);
    const r = pyProbe(['--rw-links', scratch, '--rw', served], tryIt(`os.symlink('/etc/passwd', '${scratch}/l')\nos.rename('${scratch}/l', '${served}/l')`));
    expect(r.out).toMatch(/^DENIED (13|18)/);
  });
  it('--rw refuses hard-linking a file it cannot read', async () => {
    const closed = join(dir, 'closed'); const served = join(dir, 'served');
    await mkdir(closed); await mkdir(served);
    await writeFile(join(closed, '.env'), 'TOKEN=dummy');
    expect(pyProbe(['--rw', served], tryIt(`os.link('${closed}/.env', '${served}/x')`)).out).toMatch(/^DENIED (13|18)/);
  });
  it('--rw still writes and renames regular files', () => {
    expect(pyProbe(['--rw', dir], tryIt(`open('${dir}/a', 'w').close()\nos.rename('${dir}/a', '${dir}/b')`)).out).toBe('ALLOWED');
  });

  it.each([
    ['kill', (p) => `os.kill(${p}, signal.SIGTERM)`],
    ['kill 0', (p) => `os.kill(${p}, 0)`],
    ['tkill', (p) => `ctypes.CDLL(None, use_errno=True).syscall(200, ${p}, 15) == 0 or (_ for _ in ()).throw(OSError(ctypes.get_errno(), ''))`],
    ['tgkill', (p) => `ctypes.CDLL(None, use_errno=True).syscall(234, ${p}, ${p}, 15) == 0 or (_ for _ in ()).throw(OSError(ctypes.get_errno(), ''))`],
    ['pidfd_open', (p) => `os.pidfd_open(${p})`],
    ['setpriority', (p) => `os.setpriority(os.PRIO_PROCESS, ${p}, 19)`],
    ['prlimit', (p) => `import resource\nresource.prlimit(${p}, resource.RLIMIT_CPU, (0, 0))`],
    ['sched_setaffinity', (p) => `os.sched_setaffinity(${p}, {0})`],
  ])('%s at a process outside the sandbox is refused', async (_n, op) => {
    const r = pyProbe([], tryIt(op(dummy.pid)));
    expect(r.out).toBe('DENIED 1');
    await settle();
    expect(alive()).toBe(true);
  });
  it('a process group or broadcast signal reaching outside is refused', async () => {
    const group = pyProbe([], tryIt(`os.killpg(os.getpgid(os.getpid()), 0)`));
    expect(group.out).toBe('DENIED 1'); // this test's own group holds the test runner
    expect(pyProbe([], tryIt('os.kill(-1, signal.SIGTERM)')).out).toBe('DENIED 1');
    await settle();
    expect(alive()).toBe(true);
  });
  it('F_SETOWN cannot make the kernel signal someone else', () => {
    expect(pyProbe([], tryIt(`import fcntl\nr, w = os.pipe()\nfcntl.fcntl(r, fcntl.F_SETOWN, ${dummy.pid})`)).out).toBe('DENIED 1');
  });
  it('a dead pid reads as gone, not as forbidden', () => {
    expect(pyProbe([], tryIt('os.kill(4194000, 0)')).out).toMatch(/^DENIED 3/);
  });

  it('its own tree still signals freely: self, children, threads, orphans', () => {
    const code = tryIt(`
import subprocess, threading, time
os.kill(os.getpid(), 0)
c = subprocess.Popen(['/bin/sleep', '30'])
os.kill(c.pid, signal.SIGTERM); assert c.wait() == -15
g = subprocess.Popen(['/bin/sleep', '30'], start_new_session=True)
os.killpg(g.pid, signal.SIGTERM); assert g.wait() == -15
d = subprocess.Popen(['/usr/bin/python3', '-I', '-c', 'import os,subprocess;print(subprocess.Popen(["/bin/sleep","30"]).pid)'], stdout=subprocess.PIPE, text=True)
orphan = int(d.stdout.readline()); d.wait(); time.sleep(.1)
os.kill(orphan, signal.SIGTERM)
os.setpriority(os.PRIO_PROCESS, 0, 1)
done = []
signal.signal(signal.SIGUSR1, lambda *_: done.append(1))
signal.raise_signal(signal.SIGUSR1)
assert done
`);
    expect(pyProbe(['--rw', dir], code).out).toBe('ALLOWED');
  });
  it('ends when the sandbox does, holding no pipe and leaving no process', async () => {
    const r = spawnSync('/usr/bin/python3', ['-I', HELPER, ...SYS, '--', '/bin/true'], { timeout: 5000 });
    expect(r.error).toBeUndefined(); // a supervisor holding stdout would time this out
    expect(r.status).toBe(0);
    const marker = `/crate-sb-marker-${process.pid}`;
    spawnSync('/usr/bin/python3', ['-I', HELPER, ...SYS, '--ro', marker, '--', '/bin/true']);
    await settle();
    expect(spawnSync('/usr/bin/pgrep', ['-f', `[-]-ro ${marker}`]).status).toBe(1); // nothing left running
  });

  it('the supervisor sits outside its tree, and a dead one fails closed', () => {
    // Not a descendant: the tree can't reach it. Unsandboxed stand-in kills it, as an OOM would.
    const code = tryIt(`
import subprocess, sys
print(os.getpid(), flush=True)
sys.stdin.readline()
os.kill(os.getpid(), 0)`);
    return new Promise((resolve, reject) => {
      const before = new Set(spawnSync('/usr/bin/pgrep', ['-u', String(process.getuid()), '-f', 'sandbox-exec.py'], { encoding: 'utf8' }).stdout.split('\n'));
      const job = spawn('/usr/bin/python3', ['-I', HELPER, ...SYS, '--', '/usr/bin/python3', '-I', '-c', code]);
      let out = '';
      job.stdout.on('data', (d) => {
        out += d;
        if (!/^\d+\n/.test(out) || job.killedSupervisor) return;
        job.killedSupervisor = true;
        const sup = spawnSync('/usr/bin/pgrep', ['-u', String(process.getuid()), '-f', 'sandbox-exec.py'], { encoding: 'utf8' }).stdout
          .split('\n').filter((p) => p && !before.has(p) && Number(p) !== job.pid);
        try {
          expect(sup.length).toBe(1);
          process.kill(Number(sup[0]), 'SIGKILL');
        } catch (e) { reject(e); }
        setTimeout(() => job.stdin.write('\n'), 100);
      });
      job.on('close', () => {
        try {
          expect(out.split('\n')[1]).toBe('DENIED 38'); // ENOSYS: the kernel's answer with no listener
          resolve();
        } catch (e) { reject(e); }
      });
    });
  });

  it.each([
    ['MPTCP', (p) => `s = socket.socket(socket.AF_INET, socket.SOCK_STREAM, 262)\ns.settimeout(3)\ns.connect(('127.0.0.1', ${p}))`],
    ['a TCP Fast Open send', (p) => `s = socket.socket()\ns.sendto(b'x', 0x20000000, ('127.0.0.1', ${p}))`],
  ])('%s cannot dodge the TCP port allowlist', async (_n, op) => {
    let accepted = 0;
    const server = net.createServer((s) => { accepted += 1; s.destroy(); });
    await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
    const { port } = server.address();
    const out = await new Promise((resolve) => {
      const c = spawn('/usr/bin/python3', ['-I', HELPER, ...SYS, '--tcp', String(port + 1), '--', '/usr/bin/python3', '-I', '-c', tryIt(op(port))]);
      let o = '';
      c.stdout.on('data', (d) => { o += d; });
      c.on('close', () => resolve(o.trim()));
    });
    await settle();
    server.close();
    expect(out).toMatch(/^DENIED/);
    expect(accepted).toBe(0);
  });
  it('socketpair gives stream sockets only', () => {
    expect(pyProbe([], tryIt('socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM)')).out).toMatch(/^DENIED/);
    expect(pyProbe([], tryIt('socket.socketpair()')).out).toBe('ALLOWED');
  });
});

describe('audit run-2: broker', () => {
  const job2 = { id: 'j2', type: 'generate-tracks', collection: 'tracks', count: 1, userId: 'u' };
  const entry = (over = {}) => ({ job: job2, profileId: 'p1', saves: 0, calls: 0, ...over });
  const item = (id) => ({ id, code: 's("bd")', title: 't' });
  const today = new Date().toISOString().slice(0, 10);

  it('evaluates in one worker and publishes in another', async () => {
    const adminDb = fakeAdmin({ tracks: [], stems: [], lessons: [], profiles: [{ id: 'p1' }] });
    const kinds = [];
    const ops = createOps({ adminDb, runWorker: async (p) => { kinds.push(p.kind); return { ok: true, warnings: [] }; } });
    await ops['save-track'](entry(), { item: { ...item('song-1'), prompt: 'p', batch: 'b', description: 'd', createdAt: '2026-11-07T01:02:03Z', meta: {} } });
    expect(kinds).toEqual(['check-item', 'vendor-item']);
  });
  it('publishes nothing if evaluation fails', async () => {
    const kinds = [];
    const ops = createOps({ adminDb: fakeAdmin({ tracks: [] }), runWorker: async (p) => { kinds.push(p.kind); return { ok: false, error: 'no' }; } });
    await ops['save-track'](entry(), { item: item('song-1') });
    expect(kinds).toEqual(['check-item']);
  });
  it('overlapping saves cannot pass the cap', async () => {
    const adminDb = fakeAdmin({ tracks: [], stems: [], lessons: [], profiles: [{ id: 'p1' }] });
    let release;
    const gate = new Promise((r) => { release = r; });
    const ops = createOps({ adminDb, runWorker: async () => { await gate; return { ok: true, warnings: [] }; } });
    const e = entry();
    const cap = saveCapFor(job2);
    const all = Array.from({ length: cap + 5 }, (_, i) => ops['save-track'](e, { item: { ...item(`s-${i}`), prompt: 'p', batch: 'b', description: 'd', createdAt: '2026-11-07T01:02:03Z', meta: {} } }));
    release();
    const results = await Promise.all(all);
    expect(results.filter((r) => /limit/.test(r.error ?? '')).length).toBe(5);
    expect(e.saves).toBe(cap);
  });
  it('a failed save gives its slot back', async () => {
    const ops = createOps({ adminDb: fakeAdmin({ tracks: [] }), runWorker: async () => ({ ok: false, error: 'no' }) });
    const e = entry();
    await ops['save-track'](e, { item: item('s-1') });
    expect(e.saves).toBe(0);
  });
  it('palette names can only sort where a new batch belongs', async () => {
    const calls = [];
    const ops = createOps({ adminDb: fakeAdmin({}), runWorker: async (p) => { calls.push(p); return { ok: true, voices: [] }; } });
    for (const batch of ['zzz', '9999-01-01-pin', '2020-01-01-old']) {
      expect((await ops['save-palette'](entry(), { palette: { batch } })).ok).toBe(false);
    }
    expect(calls).toEqual([]);
    expect((await ops['save-palette'](entry(), { palette: { batch: `${today}-mine` } })).ok).toBe(true);
    expect(calls.map((c) => c.kind)).toEqual(['check-palette', 'write-palette']);
  });
  it('a job can rewrite its own palette, not an earlier one, and only a few', async () => {
    const calls = [];
    const ops = createOps({ adminDb: fakeAdmin({}), runWorker: async (p) => { calls.push(p); return { ok: true, voices: [] }; } });
    const e = entry();
    await ops['save-palette'](e, { palette: { batch: `${today}-a` } });
    expect(calls.at(-1).overwrite).toBe(false);
    await ops['save-palette'](e, { palette: { batch: `${today}-a` } });
    expect(calls.at(-1).overwrite).toBe(true);
    await ops['save-palette'](e, { palette: { batch: `${today}-b` } });
    await ops['save-palette'](e, { palette: { batch: `${today}-c` } });
    expect((await ops['save-palette'](e, { palette: { batch: `${today}-d` } })).error).toMatch(/limit/);
  });
});

describe('audit run-2: worker units', () => {
  const fakeSpawn = () => {
    const live = { now: 0, peak: 0, argv: [], finish: [] };
    const spawnFn = (_cmd, argv) => {
      live.now += 1;
      live.peak = Math.max(live.peak, live.now);
      live.argv.push(argv);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end() {} };
      live.finish.push(() => {
        live.now -= 1;
        child.stdout.emit('data', 'CRATE_WORKER_RESULT {"ok":true}\n');
        child.emit('close', 0);
      });
      return child;
    };
    return { live, spawnFn };
  };
  const flush = () => new Promise((r) => { setTimeout(r, 30); });

  it('runs at most the cap at once, and queues the rest instead of failing', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'crate-w-'));
    const { live, spawnFn } = fakeSpawn();
    const run = createWorkerRunner({ repoRoot, spawn: spawnFn, maxConcurrent: 2 });
    const all = Array.from({ length: 6 }, () => run({ kind: 'check-code', code: 'x' }));
    for (let i = 0; i < 6; i++) {
      await flush();
      live.finish.shift()?.();
    }
    const results = await Promise.all(all);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(live.peak).toBe(2);
    await rm(repoRoot, { recursive: true, force: true });
  });
  it('an evaluator can write only its scratch and generates no code from strings', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'crate-w-'));
    const { live, spawnFn } = fakeSpawn();
    const run = createWorkerRunner({ repoRoot, spawn: spawnFn });
    const a = run({ kind: 'check-code', code: 'x' });
    await flush();
    const argv = live.argv[0];
    const written = argv.filter((_, i) => argv[i - 1] === '--rw').filter((p) => !p.startsWith('/dev/'));
    expect(written.length).toBe(1);
    expect(written[0]).toMatch(/job-sandbox\/worker-/);
    expect(argv).toContain('--disallow-code-generation-from-strings');
    expect(argv).toContain('--expand-environment=no');
    live.finish.shift()();
    await a;
    const b = run({ kind: 'vendor-item', item: {} });
    await flush();
    const pub = live.argv[1];
    expect(pub.filter((_, i) => pub[i - 1] === '--rw')).toEqual(expect.arrayContaining([join(repoRoot, 'data', 'sample-cache'), join(repoRoot, 'palettes')]));
    live.finish.shift()();
    await b;
    await rm(repoRoot, { recursive: true, force: true });
  });
  it('the real evaluator works with code generation off, and refuses it', () => {
    const repo = fileURLToPath(new URL('..', import.meta.url));
    const worker = (req) => JSON.parse(spawnSync(process.execPath, ['--disallow-code-generation-from-strings', join(repo, 'scripts/sandbox/validate-worker.mjs')], {
      input: JSON.stringify(req), encoding: 'utf8', timeout: 60000,
    }).stdout.split('\n').find((l) => l.startsWith('CRATE_WORKER_RESULT ')).slice(20));
    expect(worker({ kind: 'check-code', code: 's("bd*4")' })).toMatchObject({ ok: true });
    // Even past the policy, the gadgets are gone and strings can't become code.
    const probe = spawnSync(process.execPath, ['--disallow-code-generation-from-strings', '--input-type=module', '-e', `
      import { initStrudelEnv } from '${join(repo, 'scripts/strudel-env.mjs')}';
      await initStrudelEnv();
      let blocked = false;
      try { Function('return 1')(); } catch (e) { blocked = e instanceof EvalError; }
      console.log(JSON.stringify({ blocked, evaluate: typeof globalThis.evaluate, evalScope: typeof globalThis.evalScope, webaudioRepl: typeof globalThis.webaudioRepl, note: typeof globalThis.note }));
    `], { encoding: 'utf8', timeout: 60000 });
    expect(JSON.parse(probe.stdout.trim().split('\n').at(-1))).toEqual({ blocked: true, evaluate: 'undefined', evalScope: 'undefined', webaudioRepl: 'undefined', note: 'function' });
  }, 90000);
});

describe('worker egress', () => {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const worker = (req) => JSON.parse(spawnSync(process.execPath, ['--disallow-code-generation-from-strings', join(repo, 'scripts/sandbox/validate-worker.mjs')], {
    input: JSON.stringify(req), encoding: 'utf8', timeout: 60000,
  }).stdout.split('\n').find((l) => l.startsWith('CRATE_WORKER_RESULT ')).slice(20));
  const fakeFetch = (seen) => async (url) => {
    seen.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify({ _base: 'https://raw.githubusercontent.com/a/b/main/', zz: ['zz/a.wav'] }) };
  };

  it.each([
    ['an unlisted host with data in it', 'https://evil.example/strudel.json?lesson=private+text'],
    ['data in the query of a listed host', 'https://raw.githubusercontent.com/a/b/main/strudel.json?lesson=private'],
    ['a look-alike host', 'https://raw.githubusercontent.com.evil.example/x.json'],
    ['credentials in the URL', 'https://private@raw.githubusercontent.com/a/b/main/strudel.json'],
    ['plain http', 'http://raw.githubusercontent.com/a/b/main/strudel.json'],
    ['shabda, which sends words to a third party', 'shabda:private+text'],
    ['an internal host', 'https://127.0.0.1/x.json'],
  ])('refuses %s without touching the network', async (_n, source) => {
    const seen = [];
    const res = await fetchManifests([source], { fetchImpl: fakeFetch(seen) });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not allowed/);
    expect(seen).toEqual([]);
  });
  it('vendoring refuses them too, and a manifest pointing its samples elsewhere', async () => {
    const seen = [];
    expect((await cacheBank('https://evil.example/s.json?x=1', { fetchImpl: fakeFetch(seen), cacheDir: '/nonexistent' })).ok).toBe(false);
    expect(seen).toEqual([]);
    const elsewhere = async (url) => { seen.push(url); return { ok: true, json: async () => ({ _base: 'https://evil.example/', zz: ['a.wav'] }) }; };
    expect((await cacheBank('github:a/b', { fetchImpl: elsewhere, cacheDir: '/nonexistent' })).error).toMatch(/_base/);
    expect(seen.length).toBe(1);
  });
  it('fetches a listed bank at the URL samples() will ask for', async () => {
    for (const [source, url] of [
      ['github:a/b', 'https://raw.githubusercontent.com/a/b/main/strudel.json'],
      ['github:a/b/dev/sub', 'https://raw.githubusercontent.com/a/b/dev/sub/strudel.json'],
      ['https://strudel.b-cdn.net/piano.json', 'https://strudel.b-cdn.net/piano.json'],
    ]) {
      const seen = [];
      const res = await fetchManifests([source], { fetchImpl: fakeFetch(seen) });
      expect(res.ok).toBe(true);
      expect(seen).toEqual([url]);
    }
  });
  it('an evaluator has no network at all, and a publisher or fetcher does', () => {
    const f = (o) => workerSandboxFlags({ repoRoot: '/r', tmpDir: '/t', ...o });
    expect(f({})).not.toContain('--tcp');
    expect(f({})).not.toContain('--allow-udp');
    expect(f({ network: true })).toContain('--tcp');
    expect(f({ publishes: true })).toContain('--tcp');
    expect(f({ network: true }).filter((_, i, a) => a[i - 1] === '--rw')).not.toContain('/r/palettes');
  });
  it('the evaluator resolves samples() from what was fetched, and nothing else', () => {
    const url = 'https://raw.githubusercontent.com/a/b/main/strudel.json';
    const manifests = { [url]: { _base: 'https://raw.githubusercontent.com/a/b/main/', zz: ['zz/a.wav'] } };
    const code = 'samples("github:a/b")\ns("zz*4")';
    expect(worker({ kind: 'check-code', code, manifests })).toMatchObject({ ok: true });
    expect(worker({ kind: 'check-code', code })).toMatchObject({ ok: false });
    expect(worker({ kind: 'check-code', code: 'samples(`https://evil.example/?x=1`)\ns("bd")', manifests })).toMatchObject({ ok: false });
  }, 90000);
  it('runs the fetcher first, and never the evaluator when it refuses', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'crate-w-'));
    const units = [];
    const spawnFn = (_cmd, argv) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end(body) {
        const req = JSON.parse(body);
        units.push({ kind: req.kind, net: argv.includes('--tcp') });
        setImmediate(() => {
          child.stdout.emit('data', `CRATE_WORKER_RESULT ${JSON.stringify({ ok: req.kind !== 'fetch-manifests' || !/evil/.test(req.request.code), manifests: {}, error: 'not allowed' })}\n`);
          child.emit('close', 0);
        });
      } };
      return child;
    };
    const run = createWorkerRunner({ repoRoot, spawn: spawnFn });
    expect(await run({ kind: 'check-code', code: "samples('https://evil.example/?x')" })).toMatchObject({ ok: false });
    expect(units).toEqual([{ kind: 'fetch-manifests', net: true }]);
    units.length = 0;
    expect((await run({ kind: 'check-code', code: "samples('github:a/b')" })).ok).toBe(true);
    expect(units).toEqual([{ kind: 'fetch-manifests', net: true }, { kind: 'check-code', net: false }]);
    await rm(repoRoot, { recursive: true, force: true });
  });
});

describe('each job has its own staging', () => {
  let repoRoot; let broker;
  const launcher = () => createJobLauncher({ repoRoot, broker, getToken: async () => 'tok' });
  const probeAs = (jobDir, code) => {
    const r = spawnSync('/usr/bin/python3', ['-I', HELPER, ...SYS, '--rw-links', jobDir, '--ro', join(repoRoot, 'scripts'), '--', '/usr/bin/python3', '-I', '-c', code], { encoding: 'utf8', timeout: 15000 });
    return r.stdout.trim();
  };
  const attempt2 = (expr) => `
import os
try:
    ${expr}
    print('ALLOWED')
except OSError:
    print('DENIED')
`;
  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'crate-jobs-'));
    await mkdir(join(repoRoot, 'scripts'));
    await writeFile(join(repoRoot, 'scripts', 'a.mjs'), 'x');
    broker = { register: () => 'b', port: () => 1, revoke() {} };
  });
  afterEach(() => rm(repoRoot, { recursive: true, force: true }));

  it('runs in a directory of its own, with the repo reachable the same relative way', async () => {
    const a = await launcher()({ id: 'a' }, 'p', ['x']);
    const dir = join(repoRoot, 'data', 'job-sandbox', 'a', 'work');
    expect(a.args).toContain(`--working-directory=${dir}`);
    expect((await stat(join(dir, 'staging'))).isDirectory()).toBe(true);
    expect((await stat(join(dir, 'scripts', 'a.mjs'))).isFile()).toBe(true);
    expect(a.args).not.toContain(join(repoRoot, 'staging'));
    await expect(stat(join(repoRoot, 'staging'))).rejects.toThrow();
  });
  it('one job cannot read or overwrite what another staged', async () => {
    await launcher()({ id: 'a' }, 'p', ['x']);
    await launcher()({ id: 'b' }, 'p', ['x']);
    const jobs = join(repoRoot, 'data', 'job-sandbox');
    const theirs = join(jobs, 'b', 'work', 'staging', 'draft.json');
    await writeFile(theirs, 'private');
    const me = join(jobs, 'a');
    expect(probeAs(me, attempt2(`open('${join(me, 'work', 'staging', 'mine.json')}', 'w').close()`))).toBe('ALLOWED');
    expect(probeAs(me, attempt2(`open('${theirs}').read()`))).toBe('DENIED');
    expect(probeAs(me, attempt2(`open('${theirs}', 'w').close()`))).toBe('DENIED');
    expect(probeAs(me, attempt2(`os.listdir('${join(jobs, 'b')}')`))).toBe('DENIED');
  });
  it('symlinks in its directory give no more than the repo grants', async () => {
    await launcher()({ id: 'a' }, 'p', ['x']);
    const me = join(repoRoot, 'data', 'job-sandbox', 'a');
    expect(probeAs(me, attempt2(`open('${join(me, 'work', 'scripts', 'a.mjs')}').read()`))).toBe('ALLOWED');
    expect(probeAs(me, attempt2(`open('${join(me, 'work', 'scripts', 'a.mjs')}', 'w').close()`))).toBe('DENIED');
  });
  it('a CLI script still runs as main through such a symlink', async () => {
    const repo = fileURLToPath(new URL('..', import.meta.url));
    const link = join(repoRoot, 'linked');
    await symlink(join(repo, 'scripts'), link);
    const r = spawnSync(process.execPath, [join(link, 'validate.mjs')], { encoding: 'utf8', timeout: 60000 });
    expect(r.status).toBe(2); // its usage error: the main block ran
  }, 90000);
});

describe('audit run-2: job quota', () => {
  it('concurrent submissions see each other', async () => {
    const jobsDir = await mkdtemp(join(tmpdir(), 'crate-q-'));
    const store = createJobStore({ jobsDir });
    const now = Date.now();
    const mk = (i) => ({ id: `j${i}`, userId: 'u', status: 'queued', createdAt: new Date(now).toISOString(), type: 'generate-tracks', count: 1 });
    const verdicts = await Promise.all(Array.from({ length: 8 }, (_, i) => store.admit(mk(i), (jobs) => jobQuotaError(jobs, mk(i), now))));
    expect(verdicts.filter((v) => v === null).length).toBe(2);
    expect((await store.listAll()).length).toBe(2);
    await rm(jobsDir, { recursive: true, force: true });
  });
  it('a store failure does not wedge later submissions', async () => {
    const jobsDir = await mkdtemp(join(tmpdir(), 'crate-q-'));
    const store = createJobStore({ jobsDir });
    await expect(store.admit({ id: 'a' }, () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await store.admit({ id: 'b' }, () => null)).toBeNull();
    await rm(jobsDir, { recursive: true, force: true });
  });
});
