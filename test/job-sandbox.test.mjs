// A generation job gets what it needs to generate and nothing else.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import request from 'supertest';
import { fakeAdmin } from './fake-admin.mjs';
import { createApp } from '../server/app.mjs';
import { createJobBroker, createOps, saveCapFor } from '../server/job-broker.mjs';
import { agentEnv, agentSandboxFlags, freshOauthToken, systemdRunArgv, workerSandboxFlags } from '../server/job-sandbox.mjs';
import { budgetFor, createJobStore, jobQuotaError } from '../server/jobs.mjs';
import { buildArgv, createRunner } from '../server/runner.mjs';

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
  it('lets the agent write only its own dir and staging', () => {
    const rw = flags.filter((_, i) => flags[i - 1] === '--rw').filter((p) => !p.startsWith('/dev/'));
    expect(rw.sort()).toEqual(['/srv/crate/data/job-sandbox/j', '/srv/crate/staging']);
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
