// Stored Strudel code must only ever run in the opaque-origin engine/export frames.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.mjs';
import { createEngineClient, SANDBOX_ATTR } from '../src/strudel-engine-client.js';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const FORBIDDEN = ['@strudel/transpiler', '@strudel/webaudio', '@strudel/web', 'superdough'];

async function localGraph(entry, seen = new Set()) {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const text = await readFile(entry, 'utf8');
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
    if (m[1].startsWith('.') && m[1].endsWith('.js')) await localGraph(resolve(dirname(entry), m[1]), seen);
  }
  return seen;
}

describe('page bundles cannot evaluate stored code', () => {
  for (const entry of ['main.js', 'stems.js', 'song.js']) {
    it(`${entry} reaches no evaluator`, async () => {
      for (const file of await localGraph(join(SRC, entry))) {
        const text = await readFile(file, 'utf8');
        for (const pkg of FORBIDDEN) expect(text, `${file} imports ${pkg}`).not.toMatch(new RegExp(`from\\s+['"]${pkg}['"]`));
        expect(text, file).not.toMatch(/\bnew\s+StrudelMirror\b/);
      }
    });
  }
});

describe('server headers', () => {
  let dist; let cache; let app;
  beforeEach(async () => {
    dist = await mkdtemp(join(tmpdir(), 'crate-dist-'));
    cache = await mkdtemp(join(tmpdir(), 'crate-cache-'));
    await mkdir(join(dist, 'assets'));
    for (const f of ['index.html', 'stems.html', 'song.html', 'strudel-engine.html', 'export-render.html']) {
      await writeFile(join(dist, f), '<html><head></head><body></body></html>');
    }
    await writeFile(join(dist, 'assets', 'a.js'), '1');
    await writeFile(join(cache, 'x.json'), '{}');
    app = createApp({ distDir: dist, sampleCacheDir: cache });
  });
  afterEach(async () => { await rm(dist, { recursive: true }); await rm(cache, { recursive: true }); });

  for (const page of ['/strudel-engine.html', '/export-render.html']) {
    it(`${page} is an opaque-origin document even when navigated to directly`, async () => {
      const res = await request(app).get(page).expect(200);
      const csp = res.headers['content-security-policy'];
      expect(csp).toMatch(/sandbox allow-scripts(;|$)/);
      expect(csp).not.toMatch(/allow-same-origin|allow-top-navigation|allow-popups|allow-forms/);
      expect(csp).toMatch(/frame-ancestors 'self'/);
    });
  }

  it('assets and vendored samples are fetchable from the opaque origin, without credentials', async () => {
    for (const url of ['/assets/a.js', '/sample-cache/x.json', '/sample-cache/index.json']) {
      const res = await request(app).get(url).set('Origin', 'null').expect(200);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    }
  });

  for (const page of ['/', '/stems', '/song/x']) {
    it(`${page} refuses eval`, async () => {
      const csp = (await request(app).get(page).expect(200)).headers['content-security-policy'];
      expect(csp).toMatch(/script-src 'self'/);
      expect(csp).not.toMatch(/'unsafe-eval'|'unsafe-inline'/);
    });
  }
});

describe('engine client', () => {
  function fakeWin() {
    const listeners = new Set();
    return {
      addEventListener: (_t, h) => listeners.add(h),
      removeEventListener: (_t, h) => listeners.delete(h),
      fire: (e) => { for (const h of listeners) h(e); },
    };
  }
  function fakeDoc() {
    const frame = {
      attrs: {}, style: {}, contentWindow: { posted: [], postMessage(m) { this.posted.push(m); } },
      setAttribute(k, v) { this.attrs[k] = v; }, remove() {},
    };
    return { frame, createElement: () => frame, body: { appendChild() {} } };
  }

  it('creates the frame opaque, with no same-origin', () => {
    const doc = fakeDoc();
    createEngineClient({ doc, win: fakeWin(), src: '/strudel-engine.html' });
    expect(doc.frame.attrs.sandbox).toBe('allow-scripts');
    expect(SANDBOX_ATTR).toBe('allow-scripts');
  });

  it('ignores messages from any window but its own frame', () => {
    const doc = fakeDoc(); const win = fakeWin();
    const client = createEngineClient({ doc, win, src: '/x' });
    const got = [];
    client.on((m) => got.push(m));
    win.fire({ source: {}, data: { type: 'tick' } });
    win.fire({ source: doc.frame.contentWindow, data: 'not-an-object' });
    win.fire({ source: doc.frame.contentWindow, data: { type: 'tick', gen: 1 } });
    expect(got).toEqual([{ type: 'tick', gen: 1 }]);
  });

  it('never uses a same-origin frame for exports either', async () => {
    const src = await readFile(join(SRC, 'export-client.js'), 'utf8');
    expect(src).toMatch(/SANDBOX_ATTR/);
    expect(src).toMatch(/setAttribute\('sandbox', SANDBOX_ATTR\)/);
  });
});
