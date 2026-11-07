// Round 5: playback of vendored banks, and what a job can put in a public row.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';
import { checkCodePolicy } from '../scripts/lib/code-policy.mjs';
import { loadWorkletsFromBlobs, removeWebRTC } from '../src/frame-lockdown.js';
import { createOps, saveCapFor } from '../server/job-broker.mjs';
import { createJobLauncher } from '../server/job-sandbox.mjs';
import { fakeAdmin } from './fake-admin.mjs';

describe('the bank index', () => {
  let cacheDir;
  const bank = async (slug, manifest, files = []) => {
    const dir = join(cacheDir, 'banks', slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'strudel.json'), JSON.stringify(manifest));
    for (const f of files) {
      await mkdir(join(dir, f, '..'), { recursive: true });
      await writeFile(join(dir, f), 'RIFF');
    }
  };
  const slugs = async () => (await request(createApp({ sampleCacheDir: cacheDir })).get('/sample-cache/index.json').expect(200)).body.slugs;

  beforeEach(async () => { cacheDir = await mkdtemp(join(tmpdir(), 'crate-r5-')); });
  afterEach(async () => { await rm(cacheDir, { recursive: true, force: true }); });

  it('advertises a bank holding every file it lists', async () => {
    await bank('whole', { _base: './', bd: ['bd/1.wav'], hh: 'hh.wav', pad: { c3: ['pad/c3.wav'] } }, ['bd/1.wav', 'hh.wav', 'pad/c3.wav']);
    expect(await slugs()).toEqual(['whole']);
  });

  // A manifest vendored without its audio: the client would lose a sound upstream still has.
  it('leaves out a bank missing a listed file, so the client uses upstream', async () => {
    await bank('empty', { _base: './', bd: ['bd/1.wav'] });
    await bank('partial', { _base: './', bd: ['bd/1.wav', 'bd/2.wav'] }, ['bd/1.wav']);
    await bank('pitched', { _base: './', pad: { c3: ['pad/c3.wav'], c4: ['pad/c4.wav'] } }, ['pad/c3.wav']);
    expect(await slugs()).toEqual([]);
  });

  it('leaves out a manifest it can\'t read, or one naming a path outside the bank', async () => {
    await bank('escapes', { _base: './', bd: ['../whole/1.wav'] });
    await mkdir(join(cacheDir, 'banks', 'garbled'), { recursive: true });
    await writeFile(join(cacheDir, 'banks', 'garbled', 'strudel.json'), '{');
    expect(await slugs()).toEqual([]);
  });
});

describe('what a job can put in a public row', () => {
  const job = { id: 'job-1', type: 'generate-tracks', collection: 'tracks', count: 2, prompt: 'dark techno' };
  const entry = (over = {}) => ({ job, profileId: 'p1', saves: 0, calls: 0, ...over });
  const code = 'setcpm(30)\ns("bd")';
  const row = (over = {}) => ({
    id: 'song-1', title: 'T', prompt: 'p', batch: '2026-11-07-dark', description: 'd', code, createdAt: '2026-11-07T01:02:03Z',
    meta: { bpm: 120, genre: 'techno', mood: 'dark', key: 'A minor', instruments: ['kick'], energy: 3 }, ...over,
  });
  const admin = (seed = {}) => fakeAdmin({ tracks: [], stems: [], lessons: [], profiles: [{ id: 'p1' }], ...seed });
  const passing = (calls = []) => async (p) => { calls.push(p); return { ok: true, warnings: [] }; };
  const saved = (db) => db._txs.find((x) => x.update?.slug)?.update;

  it('accepts the longest values live rows hold', async () => {
    const db = admin();
    const ops = createOps({ adminDb: db, runWorker: passing() });
    const big = row({
      id: `${'s'.repeat(54)}-01-remix-01`, title: 't'.repeat(40), prompt: 'p'.repeat(309), batch: `2026-06-23-${'b'.repeat(44)}`, description: 'd'.repeat(605),
      code: `// ${'c'.repeat(1286)}\ns("${'x'.repeat(2800)}")\n${' '.repeat(5200)}`,
      meta: { bpm: 220, genre: 'g'.repeat(44), mood: 'm'.repeat(68), key: 'k'.repeat(50), instruments: Array(13).fill('i'.repeat(43)), energy: 5 },
    });
    expect((await ops['save-track'](entry(), { item: big })).ok).toBe(true);
  });

  it.each([
    ['title', { title: 'x'.repeat(121) }],
    ['prompt', { prompt: 'x'.repeat(601) }],
    ['description', { description: 'x'.repeat(1501) }],
    ['batch length', { batch: 'x'.repeat(73) }],
    ['batch prose', { batch: 'not a slug, a sentence' }],
    ['createdAt prose', { createdAt: 'hello there' }],
    ['a slug that only stringifies to one', { id: ['song-1'] }],
    ['a versionOf that only stringifies to one', { versionOf: ['song-1'] }],
    ['meta that is not an object', { meta: 'free text' }],
    ['meta genre', { meta: { genre: 'x'.repeat(121) } }],
    ['meta genre type', { meta: { genre: { a: 1 } } }],
    ['meta bpm', { meta: { bpm: 'one twenty' } }],
    ['meta energy', { meta: { energy: 1.5 } }],
    ['instrument count', { meta: { instruments: Array(25).fill('k') } }],
    ['instrument length', { meta: { instruments: ['x'.repeat(65)] } }],
    ['code length', { code: `s("bd")\n${' '.repeat(32 * 1024)}` }],
    ['comments', { code: `// ${'x'.repeat(3001)}\ns("bd")` }],
    ['many short comments', { code: `${'// xxxxxxxx\n'.repeat(400)}s("bd")` }],
    ['string volume', { code: `s("${'x'.repeat(8001)}")` }],
    ['strings split up', { code: `stack(${Array(90).fill(`s("${'x'.repeat(100)}")`).join(',')})` }],
    ['template volume', { code: `s(\`${'x'.repeat(8001)}\`)` }],
  ])('refuses before any evaluation: %s', async (_n, over) => {
    const calls = [];
    const db = admin();
    const ops = createOps({ adminDb: db, runWorker: passing(calls) });
    expect((await ops['save-track'](entry(), { item: row(over) })).ok).toBe(false);
    expect(calls).toEqual([]);
    expect(saved(db)).toBeUndefined();
  });

  it('stores only the meta fields the app uses', async () => {
    const db = admin();
    const ops = createOps({ adminDb: db, runWorker: passing() });
    const meta = { bpm: 120, genre: 'g', mood: 'm', key: 'k', instruments: ['i'], energy: 3 };
    expect((await ops['save-track'](entry(), { item: row({ meta: { ...meta, diary: 'dear reader', _x: { y: 1 } } }) })).ok).toBe(true);
    expect(saved(db).meta).toEqual(meta);
  });

  it('remixOf can only name this remix job\'s source', async () => {
    const remix = { ...job, type: 'remix', count: null, sourceSlug: 'src-1' };
    const db = admin({ tracks: [{ id: 'e1', slug: 'src-1', isPublic: true, code: 'c' }] });
    const ops = createOps({ adminDb: db, runWorker: passing() });
    const e = entry({ job: remix });
    expect((await ops['remix-source'](e, { slug: 'src-1' })).ok).toBe(true);
    expect((await ops['save-track'](e, { item: row({ remixOf: 'free-text-here' }) })).error).toMatch(/remixOf/);
    expect((await ops['save-track'](e, { item: row({ remixOf: 'src-1' }) })).ok).toBe(true);
    expect((await ops['save-track'](entry(), { item: row({ id: 'song-2', remixOf: 'src-1' }) })).error).toMatch(/remixOf/);
  });

  it('a slug can\'t carry a lesson past the quote check', async () => {
    const ops = createOps({ adminDb: admin(), runWorker: passing() });
    const e = entry({ privateTexts: ['I secretly love the sound of my neighbour\'s dog'] });
    expect((await ops['save-track'](e, { item: row({ id: 'i-secretly-love-the-sound-of-my-neighbours-dog' }) })).error).toMatch(/private lesson/);
  });
});

describe('how many public rows a job gets', () => {
  const job = { id: 'job-1', type: 'generate-tracks', collection: 'tracks', count: 2, prompt: 'p' };
  const item = (i) => ({ id: `s-${i}`, title: 'T', prompt: 'p', batch: 'b', description: 'd', code: 's("bd")', createdAt: '2026-11-07T01:02:03Z', meta: {} });
  const admin = (tracks = []) => fakeAdmin({ tracks, stems: [], lessons: [], profiles: [{ id: 'p1' }] });

  it('is what was asked for, when nothing is waiting to be revised', async () => {
    const ops = createOps({ adminDb: admin(), runWorker: async () => ({ ok: true }) });
    const e = { job, profileId: 'p1', saves: 0, calls: 0 };
    expect(saveCapFor(job)).toBe(2);
    expect((await ops['pending-revisions'](e, {})).list).toEqual([]);
    expect((await ops['save-track'](e, { item: item(1) })).ok).toBe(true);
    expect((await ops['save-track'](e, { item: item(2) })).ok).toBe(true);
    expect((await ops['save-track'](e, { item: item(3) })).error).toMatch(/limit/);
  });

  it('grows by one per note the worklist says to revise', async () => {
    const noted = { id: 'e1', slug: 'root-1', isPublic: true, code: 'c', notes: 'more cowbell', author: { id: 'p1' } };
    const ops = createOps({ adminDb: admin([noted]), runWorker: async () => ({ ok: true }) });
    const e = { job, profileId: 'p1', saves: 0, calls: 0 };
    expect((await ops['pending-revisions'](e, {})).list).toHaveLength(1);
    for (const i of [1, 2, 3]) expect((await ops['save-track'](e, { item: item(i) })).ok).toBe(true);
    expect((await ops['save-track'](e, { item: item(4) })).error).toMatch(/limit/);
  });
});

describe('a job\'s credentials in a row', () => {
  const secret = 'sk-ant-oat01-DUMMYabcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ-KLMNOPQRSTUVWXYZ';
  const job = { id: 'job-1', type: 'generate-tracks', collection: 'tracks', count: 5, prompt: 'p' };
  const row = (over) => ({ id: 's-1', title: 'T', prompt: 'p', batch: 'b', description: 'd', code: 's("bd")', createdAt: '2026-11-07T01:02:03Z', meta: {}, ...over });
  const save = (over) => {
    const calls = [];
    const ops = createOps({ adminDb: fakeAdmin({ tracks: [], stems: [], lessons: [], profiles: [{ id: 'p1' }] }), runWorker: async (p) => { calls.push(p); return { ok: true }; } });
    return ops['save-track']({ job, profileId: 'p1', saves: 0, calls: 0, secrets: [secret] }, { item: row(over) });
  };

  it.each([
    ['as written', { description: secret }],
    ['in a comment, spaced out', { code: `// ${secret.match(/.{1,9}/g).join(' ')}\ns("bd")` }],
    ['a long part of it', { title: secret.slice(20, 60) }],
    ['reversed', { description: [...secret].reverse().join('') }],
    ['base64', { description: Buffer.from(secret).toString('base64') }],
    ['base64url', { description: Buffer.from(secret).toString('base64url') }],
    ['hex', { code: `s("bd") // ${Buffer.from(secret).toString('hex').slice(0, 200)}` }],
    ['upper case', { description: secret.toUpperCase() }],
  ])('refuses it %s', async (_n, over) => {
    const res = await save(over);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/credential/);
    expect(res.error).not.toContain(secret);
  });

  it('leaves an ordinary row alone', async () => {
    expect((await save({ description: 'Dark techno with a sk-ant style name' })).ok).toBe(true);
  });

  it('the launcher hands the broker the token it gives the agent', async () => {
    let got;
    const broker = { register: (_j, _p, secrets) => { got = secrets; return 'broker-token'; }, revoke() {}, port: () => 1 };
    const repoRoot = await mkdtemp(join(tmpdir(), 'crate-r5-launch-'));
    try {
      const launch = createJobLauncher({ repoRoot, broker, getToken: async () => secret });
      const { cleanup } = await launch({ id: 'j' }, 'p1', []).catch((err) => { if (/ENOENT/.test(err.message)) return { skipped: true }; throw err; });
      expect(got).toEqual([secret]);
      await cleanup?.();
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('WebRTC in the playback frames', () => {
  const carrier = () => ({ RTCPeerConnection: class {}, webkitRTCPeerConnection: class {}, keep: 1 });

  it('removes the constructor and its alias', () => {
    const c = carrier();
    removeWebRTC(c);
    expect(c.RTCPeerConnection).toBeUndefined();
    expect(c.webkitRTCPeerConnection).toBeUndefined();
    expect('RTCPeerConnection' in c).toBe(false);
    expect(c.keep).toBe(1);
  });

  it.each(['strudel-engine', 'export-render'])('%s removes it before anything else is imported', async (name) => {
    const src = await readFile(join(import.meta.dirname, '..', 'src', `${name}.js`), 'utf8');
    const first = src.split('\n').find((l) => l.startsWith('import '));
    expect(first).toMatch(/frame-lockdown\.js/);
  });

  it.each(['RTCPeerConnection', 'webkitRTCPeerConnection'])('the save-time policy refuses %s', (name) => {
    expect(checkCodePolicy(`new ${name}({})`).ok).toBe(false);
  });
});

describe('nested frames in the playback frames', () => {
  it('audio worklets bundled as data: URLs load through blob: instead', async () => {
    const seen = [];
    class Worklet { addModule(url, opts) { seen.push([url, opts]); return Promise.resolve('added'); } }
    loadWorkletsFromBlobs(Worklet.prototype);
    const worklet = new Worklet();
    expect(await worklet.addModule('data:text/javascript;base64,Ly8geA==')).toBe('added');
    expect(seen[0][0]).toMatch(/^blob:/);
    await worklet.addModule('/assets/plain.js', { credentials: 'omit' });
    expect(seen[1]).toEqual(['/assets/plain.js', { credentials: 'omit' }]);
  });

  it.each(['strudel-engine.html', 'export-render.html'])('%s can\'t run a data: script or nest a frame', async (page) => {
    const dist = await mkdtemp(join(tmpdir(), 'crate-r5-dist-'));
    try {
      await writeFile(join(dist, page), '<!doctype html>');
      const res = await request(createApp({ distDir: dist })).get(`/${page}`).expect(200);
      const csp = res.headers['content-security-policy'];
      const directive = (name) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `));
      expect(directive('script-src')).not.toContain('data:');
      expect(directive('frame-src')).toBe("frame-src 'none'");
      expect(directive('child-src')).toBe("child-src 'none'");
    } finally {
      await rm(dist, { recursive: true, force: true });
    }
  });
});
