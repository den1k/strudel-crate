// Regression tests for the 2026-11-06 security audit (run-1). Dummy principals only.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { mkdtemp, mkdir, rm, writeFile, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeAdmin } from './fake-admin.mjs';
import { createApp } from '../server/app.mjs';
import { createJobStore } from '../server/jobs.mjs';
import { createCardCache } from '../server/card-cache.mjs';
import { createCardRenderer } from '../server/render-card.mjs';
import { insertItem } from '../server/instant.mjs';
import { cacheBank } from '../scripts/lib/sample-cache.mjs';
import { checkCodePolicy } from '../scripts/lib/code-policy.mjs';
import { validateCode } from '../scripts/validate.mjs';
import { scopeToFamilyOwner, MAX_WORKLIST, buildWorklist } from '../src/versions.js';
import { isTrustedExportMessage } from '../src/export-guard.js';

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

describe('cacheBank refuses unsafe manifests', () => {
  let root, cacheDir;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'crate-sec-'));
    cacheDir = join(root, 'a', 'b', 'cache');
    await mkdir(cacheDir, { recursive: true });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const run = (manifest, source = 'github:evil/bank') => {
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(url);
      if (url === 'https://raw.githubusercontent.com/evil/bank/main/strudel.json' || url === source) {
        return { ok: true, status: 200, json: async () => manifest };
      }
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('PWN').buffer };
    };
    return cacheBank(source, { cacheDir, fetchImpl }).then((res) => ({ res, urls }));
  };

  it.each([
    ['parent traversal', '../../../../../pwned.wav'],
    ['nested traversal', 'kit/../../../pwned.wav'],
    ['absolute path', '/tmp/crate-sec-pwned.wav'],
    ['absolute url', 'http://127.0.0.1:9/secret.wav'],
    ['protocol-relative', '//127.0.0.1/secret.wav'],
    ['backslash traversal', '..\\..\\pwned.wav'],
    ['encoded traversal', '%2e%2e/%2e%2e/pwned.wav'],
    ['active content', 'kit/page.html'],
    ['audio extension hidden before a query', 'kit/a.wav?.html'],
    ['script', 'kit/a.js'],
    ['null byte', 'kit/a\0.wav'],
  ])('aborts the whole bank on %s, fetching and writing nothing', async (_n, leaf) => {
    const { res, urls } = await run({ _base: 'https://raw.githubusercontent.com/fake/a/b/c/d/', ok: ['ok/a.wav'], bad: ['ok/b.wav', leaf] });
    expect(res.ok).toBe(false);
    expect(urls).toHaveLength(1); // the manifest only, no sample
    expect(await exists(join(root, 'pwned.wav'))).toBe(false);
    expect(await exists(join(cacheDir, 'banks', 'github-evil-bank'))).toBe(false);
  });

  it.each([
    ['plain http', 'http://fake.test/'],
    ['loopback', 'https://127.0.0.1/'],
    ['localhost', 'https://localhost:3008/'],
    ['private range', 'https://10.0.0.8/'],
    ['tailnet range', 'https://100.100.100.100/'],
    ['link-local metadata', 'https://169.254.169.254/latest/'],
    ['ipv6 loopback', 'https://[::1]/'],
    ['missing', undefined],
  ])('refuses a %s _base', async (_n, base) => {
    const { res, urls } = await run({ _base: base, ok: ['ok/a.wav'] });
    expect(res.ok).toBe(false);
    expect(urls).toHaveLength(1);
  });

  it.each([
    ['http://127.0.0.1:3008/strudel.json'],
    ['http://fake.test/strudel.json'],
    ['file:///etc/passwd'],
  ])('refuses source %s before fetching', async (source) => {
    const { res, urls } = await run({ _base: 'https://raw.githubusercontent.com/fake/', ok: ['ok/a.wav'] }, source);
    expect(res.ok).toBe(false);
    expect(urls).toHaveLength(0);
  });

  it('refuses to follow redirects, so a public host cannot bounce a fetch inward', async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push(init?.redirect);
      return url.endsWith('strudel.json')
        ? { ok: true, status: 200, json: async () => ({ _base: 'https://raw.githubusercontent.com/fake/', ok: ['ok/a.wav'] }) }
        : { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(1) };
    };
    const res = await cacheBank('github:evil/bank', { cacheDir, fetchImpl });
    expect(res.ok).toBe(true);
    expect(seen).toEqual(['error', 'error']);
  });

  it('still vendors a normal bank', async () => {
    const { res } = await run({ _base: 'https://raw.githubusercontent.com/fake/x/', kick: ['kit one/Kick_01.WAV', 'kit one/k2.flac'], sn: 'sn.ogg' });
    expect(res).toMatchObject({ ok: true, files: 3 });
    expect(await readdir(join(cacheDir, 'banks', 'github-evil-bank'))).toContain('strudel.json');
  });
});

describe('/sample-cache serves inert content', () => {
  it('sandboxes responses so a vendored file cannot run on the crate origin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crate-sec-'));
    await writeFile(join(dir, 'x.html'), '<script>1</script>');
    const res = await request(createApp({ sampleCacheDir: dir })).get('/sample-cache/x.html');
    expect(res.headers['content-security-policy']).toMatch(/sandbox/);
    expect(res.headers['content-security-policy']).toMatch(/default-src 'none'/);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('public job reads', () => {
  let jobApp;
  const stored = {
    id: 'j1', type: 'generate-stems', prompt: 'pads', count: 1, collection: 'stems', status: 'failed',
    userId: 'dummy-user', userEmail: 'dummy@invalid.test', createdAt: '2026-01-01T00:00:00Z',
    startedAt: null, finishedAt: null, summary: 'agent output', error: 'claude exited 1: stderr tail',
    batch: null, newItems: [],
  };
  beforeEach(async () => {
    const jobsDir = join(await mkdtemp(join(tmpdir(), 'crate-sec-')), 'jobs');
    const jobStore = createJobStore({ jobsDir });
    await jobStore.write(stored);
    jobApp = createApp({ jobStore, runner: { enqueue: async (j) => j }, progressFor: async () => 2 });
  });

  it.each(['/api/jobs', '/api/jobs/j1'])('%s hides identity and raw diagnostics', async (path) => {
    const res = await request(jobApp).get(path);
    const job = Array.isArray(res.body) ? res.body[0] : res.body;
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/dummy|stderr|agent output/);
    expect(job).not.toHaveProperty('userId');
    expect(job).not.toHaveProperty('userEmail');
    expect(job).not.toHaveProperty('summary');
    expect(job.error).toBe('generation failed');
    // everything the log UI + retry flow reads stays
    expect(job).toMatchObject({ id: 'j1', type: 'generate-stems', prompt: 'pads', count: 1, collection: 'stems', status: 'failed', newItems: [] });
  });
});

describe('revise-from-notes is owner-scoped', () => {
  const row = (id, author, extra = {}) => ({ id, authorProfileId: author, createdAt: '2026-01-01', notes: '', ...extra });
  const rows = [
    row('a', 'A', { notes: 'A note', code: 'a' }),
    row('b', 'B', { notes: 'B note', code: 'b' }),
    row('b-v2', 'B', { versionOf: 'b', createdAt: '2026-01-02', notes: 'B v2 note' }),
    // legacy mixed family: root A, latest version by B
    row('m', 'A'),
    row('m-v2', 'B', { versionOf: 'm', createdAt: '2026-01-02', notes: 'on mixed' }),
  ];

  it('keeps whole families whose root the profile owns', () => {
    expect(scopeToFamilyOwner(rows, 'A').map((r) => r.id).sort()).toEqual(['a', 'm', 'm-v2']);
    expect(scopeToFamilyOwner(rows, 'B').map((r) => r.id).sort()).toEqual(['b', 'b-v2']);
  });
  it('a job only sees its own author\'s notes, with correct next version numbers', () => {
    const list = buildWorklist(rows, { profileId: 'B', inJob: true });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ root: 'b', nextId: 'b-v3', note: 'B v2 note' });
    expect(buildWorklist(rows, { profileId: 'A', inJob: true }).map((w) => w.nextId).sort()).toEqual(['a-v2', 'm-v3']);
  });
  it('fails closed inside a job without a profile; manual runs see everything', () => {
    expect(() => buildWorklist(rows, { profileId: undefined, inJob: true })).toThrow(/CRATE_AUTHOR_PROFILE_ID/);
    expect(buildWorklist(rows, { profileId: undefined, inJob: false })).toHaveLength(3);
  });
  it('caps a job\'s worklist', () => {
    const many = Array.from({ length: MAX_WORKLIST + 5 }, (_, i) => row(`n${i}`, 'A', { notes: 'x' }));
    expect(buildWorklist(many, { profileId: 'A', inJob: true })).toHaveLength(MAX_WORKLIST);
  });
});

describe('insertItem protects family ownership', () => {
  const track = { id: 'r-v2', title: 't', prompt: 'p', batch: 'b', description: 'd', code: 'c', meta: {}, createdAt: 'x', versionOf: 'r' };
  const seeded = () => fakeAdmin({ tracks: [{ id: 'e1', slug: 'r', author: [{ id: 'A' }] }] });

  it('refuses a version of someone else\'s family', async () => {
    const db = seeded();
    const res = await insertItem(db, 'tracks', track, 'B');
    expect(res.ok).toBe(false);
    expect(db._txs).toHaveLength(0);
  });
  it('allows the family owner', async () => {
    const db = seeded();
    expect((await insertItem(db, 'tracks', track, 'A')).ok).toBe(true);
  });
  it('refuses an unauthored version inside a job', async () => {
    const db = seeded();
    process.env.CRATE_JOB_ID = 'job-1';
    try {
      expect((await insertItem(db, 'tracks', track, null)).ok).toBe(false);
    } finally { delete process.env.CRATE_JOB_ID; }
  });
});

describe('notes authorize against the family root', () => {
  const mk = (user) => {
    const db = fakeAdmin({
      profiles: [{ id: 'A', user: { id: 'ua' } }, { id: 'B', user: { id: 'ub' } }],
      tracks: [
        { id: 'e1', slug: 'r', notes: '', author: [{ id: 'A' }] },
        { id: 'e2', slug: 'r-v2', versionOf: 'r', notes: '', author: [{ id: 'B' }], lessonRecord: [{ id: 'L', text: 'B private' }] },
      ],
    });
    return createApp({ adminDb: db, namespaces: ['tracks'], requireUser: (req, _r, next) => { req.user = user; next(); } });
  };
  it('the root owner may note a version another author made', async () => {
    const res = await request(mk({ id: 'ua', email: 'a@invalid.test' })).put('/api/tracks/r-v2/notes').send({ notes: 'mine' });
    expect(res.status).toBe(200);
  });
  it('that version\'s author may not, since the family is not theirs', async () => {
    const res = await request(mk({ id: 'ub', email: 'b@invalid.test' })).put('/api/tracks/r-v2/notes').send({ notes: 'take over' });
    expect(res.status).toBe(403);
  });
  it('the root owner still cannot touch the lesson on another author\'s row', async () => {
    const res = await request(mk({ id: 'ua', email: 'a@invalid.test' })).put('/api/tracks/r-v2/notes').send({ lesson: 'overwrite' });
    expect(res.status).toBe(403);
  });
});

describe('play limiter key', () => {
  it('uses the nginx-set X-Real-IP, ignoring a client-chosen X-Forwarded-For', async () => {
    const keys = [];
    const db = fakeAdmin({ tracks: [{ id: 't', slug: 's', playCount: 0 }], stems: [] });
    const a = createApp({ adminDb: db, playLimiter: (ip) => { keys.push(ip); return true; } });
    for (const spoof of ['1.1.1.1', '2.2.2.2']) {
      await request(a).post('/api/tracks/s/play')
        .set('X-Forwarded-For', `${spoof}, 203.0.113.7`).set('X-Real-IP', '203.0.113.7');
    }
    expect(keys).toEqual(['203.0.113.7', '203.0.113.7']);
  });
  it('falls back to the socket, never to X-Forwarded-For', async () => {
    const keys = [];
    const db = fakeAdmin({ tracks: [{ id: 't', slug: 's', playCount: 0 }], stems: [] });
    const a = createApp({ adminDb: db, playLimiter: (ip) => { keys.push(ip); return true; } });
    await request(a).post('/api/tracks/s/play').set('X-Forwarded-For', '1.1.1.1');
    expect(keys[0]).not.toBe('1.1.1.1');
  });
});

describe('card rendering is bounded', () => {
  const item = { id: 'e-1', slug: 'demo', title: 'T', description: 'd', code: 's("bd")', meta: {}, author: [{ id: 'p', artistName: 'x' }] };
  it('renders once for concurrent requests on a cold card', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'crate-sec-'));
    let calls = 0; let release;
    const gate = new Promise((r) => { release = r; });
    const cardRenderer = { render: async () => { calls += 1; await gate; return Buffer.from('JPG'); } };
    const a = createApp({ adminDb: fakeAdmin({ tracks: [item], stems: [] }), namespaces: ['tracks'], cardRenderer, cardCache: createCardCache({ dir }) });
    const server = a.listen(0);
    const reqs = Array.from({ length: 5 }, () => request(server).get('/api/tracks/e-1/card.jpg').then((r) => r));
    await new Promise((r) => setTimeout(r, 100));
    release();
    const out = await Promise.all(reqs);
    server.close();
    expect(calls).toBe(1);
    expect(out.every((r) => r.status === 200)).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it('sheds renders past the queue limit with a 503-class error', async () => {
    const page = { setViewport: async () => {}, setContent: () => new Promise(() => {}), close: async () => {} };
    const launch = async () => ({ on: () => {}, newPage: async () => page, close: async () => {} });
    const r = createCardRenderer({ launch, maxQueue: 2 });
    r.render('a'); r.render('b');
    await expect(r.render('c')).rejects.toMatchObject({ status: 503 });
  });

  it('does not leak internal error text on a 500', async () => {
    const db = fakeAdmin({ tracks: [] });
    db.query = async () => { throw new Error('secret upstream detail'); };
    const res = await request(createApp({ adminDb: db, namespaces: ['tracks'] })).post('/api/tracks/s/play');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/secret/);
  });
});

describe('export page message guard', () => {
  const win = { location: { origin: 'https://crate.test' } };
  win.parent = win;
  it('accepts its parent at the same origin (iframe flow + self-drive)', () => {
    expect(isTrustedExportMessage({ source: win, origin: 'https://crate.test' }, win)).toBe(true);
    const appWin = {};
    const frame = { parent: appWin, location: { origin: 'https://crate.test' } };
    expect(isTrustedExportMessage({ source: appWin, origin: 'https://crate.test' }, frame)).toBe(true);
  });
  it('rejects a cross-origin opener of a popup', () => {
    expect(isTrustedExportMessage({ source: {}, origin: 'https://evil.test' }, win)).toBe(false);
  });
  it('rejects a cross-origin embedding parent', () => {
    const evil = {};
    const frame = { parent: evil, location: { origin: 'https://crate.test' } };
    expect(isTrustedExportMessage({ source: evil, origin: 'https://evil.test' }, frame)).toBe(false);
  });
  it('rejects a same-origin window that is not the parent', () => {
    expect(isTrustedExportMessage({ source: {}, origin: 'https://crate.test' }, win)).toBe(false);
  });
});

describe('stored-code policy', () => {
  it.each([
    'fetch("/x")', 'window.x', 'globalThis.y = 1', 'localStorage.getItem("a")', 'indexedDB.open("a")',
    'document.title = 1', 'process.env', 'eval("1")', 'new Function("1")', 'import("x")', 'this.x',
    '(() => 1).constructor("x")', 'x["constructor"]', 'x["con" + "structor"]', 'const { constructor: c } = x',
    'const k = "a"; x[k]', 'Object.getPrototypeOf(x)', 'Reflect.get(x, "y")', 'setTimeout("x")', 'x.__proto__',
    'samples((globalThis.m = 1, {}))', 's("bd").fmap(v => fetch(v))', 'not valid js (',
  ])('rejects %s', (code) => {
    expect(checkCodePolicy(code).ok).toBe(false);
  });
  it.each([
    's("bd*4").bank("RolandTR909")',
    '// the top of the document, in a comment\ns("window fetch")',
    'samples("github:a/b")\nsetcpm(120/4)\nstack(s("bd"), note("c3").s("sine").lpf(sine.range(200,2000)))',
    '$: s("hh").every(4, x => x.fast(2))',
    'const top2 = [1,2,3]; const a = top2[0]; s("bd").gain(a)',
    's("bd").pan({ left: 0, top: 1 }.top)',
    'let f = (p) => p.jux(rev); f(s("bd"))',
  ])('allows %s', (code) => {
    expect(checkCodePolicy(code)).toEqual({ ok: true });
  });
  it('validateCode rejects before executing anything', async () => {
    delete globalThis.__crate_marker;
    const res = await validateCode('samples((globalThis.__crate_marker = 1, {}))\ns("bd")');
    expect(res.ok).toBe(false);
    expect(globalThis.__crate_marker).toBeUndefined();
  });
});

describe('audit run-2: code policy', () => {
  it.each([
    ['evaluate', "evaluate('1')"],
    ['evalScope', 'evalScope({})'],
    ['strudelScope', 'strudelScope.x'],
    ['repl', 'repl({})'],
    ['webaudioRepl', 'webaudioRepl({})'],
    ['a computed class method key', 'class A { [fetch("https://x")]() {} }\ns("bd")'],
    ['a computed static key', 'class A { static [process.pid]() {} }\ns("bd")'],
    ['a computed class field key', 'class A { [fetch("https://x")] = 1 }\ns("bd")'],
    ['a built class key', 'class A { [a + b]() {} }\ns("bd")'],
    ['a class key naming constructor', 'class A { ["constructor"]() {} }\ns("bd")'],
  ])('rejects %s', (_n, code) => {
    expect(checkCodePolicy(code).ok).toBe(false);
  });
  it.each([
    ['a plain class', 'class A { m() { return 1 } }\ns("bd")'],
    ['a literal class key', 'class A { ["m"]() {} }\ns("bd")'],
    ['the words in text', 's("evaluate repl") // evaluate()'],
    ['a property called evaluate', 'x.evaluate'],
  ])('allows %s', (_n, code) => {
    expect(checkCodePolicy(code).ok).toBe(true);
  });
});
