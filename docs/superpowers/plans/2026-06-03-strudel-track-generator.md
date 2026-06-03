# Strudel Track Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A system where the user invokes `/generate-tracks "<style prompt>" [count]` in Claude Code to fan out parallel agents that each write a validated Strudel track, plus a local webapp to listen, rate (1–5), and leave notes on each track — with ratings feeding back into future generations.

**Architecture:** Tracks are plain JSON files in `tracks/` (one per track: id, title, prompt, batch, code). Ratings are plain JSON files in `data/ratings/` (one per track) written by a tiny Express API and read by both the webapp and the generation feedback loop. A headless Node validator (`scripts/validate.mjs`) uses Strudel's own eval pipeline (`@strudel/transpiler` + `evalScope`) to prove every generated track transpiles, evaluates to a Pattern, produces events, and only references sounds the webapp actually loads (allowlist in `scripts/sounds.json`, generated from the same sample manifests the webapp prebakes). The webapp is Vite + vanilla JS using `@strudel/web` for playback (single global scheduler: one track plays at a time).

**Tech Stack:** Node ≥ 18 (ESM only), `@strudel/core|mini|tonal|transpiler` @ 1.2.6, `@strudel/web|webaudio` @ 1.3.0, Express 4, Vite 6 (+ `vite-plugin-wasm`, `vite-plugin-top-level-await`), Vitest + Supertest for tests.

**Verified API facts (from Strudel source at codeberg.org/uzu/strudel, test/runtime.mjs):**
- `evalScope(...modules)` from `@strudel/core` is **async**; it puts pattern functions (`note`, `s`, `stack`, `lpf`, …) on `globalThis`.
- `evaluate(code)` from `@strudel/transpiler` is **async**, returns `{ mode, pattern, meta }`. Double-quoted strings are auto-treated as mini-notation by the transpiler.
- Query events: `pattern.sortHapsByPart().queryArc(0, cycles)` → array of Haps `{ whole, part, value, context }`; `hap.value` is the controls object (e.g. `{ note, s, bank, cutoff }`).
- Browser-only things to stub in Node: `samples`, visual/audio Pattern methods (`pianoroll`, `scope`, …).
- `@strudel/web`: `initStrudel({ prebake })` returns a promise (await before playing); `evaluate(code)` plays (replacing current pattern), `hush()` stops. Audio unlocks on first user click. **Default prebake only loads synths** — drum machines / piano / dirt-samples must be loaded via the `prebake` option.

---

## File Structure

```
strudel-ai/
├── package.json                  # ESM, scripts: dev/test/validate/feedback/build-sounds
├── vite.config.js                # wasm + TLA plugins, /api proxy → :3001
├── vitest.config.js              # node env, generous timeout (strudel imports are heavy)
├── .gitignore
├── README.md
├── STRUDEL_GUIDE.md              # the bible for generation agents: rules, sounds, examples
├── index.html                    # webapp shell
├── src/
│   ├── main.js                   # webapp logic: init strudel, list/play/rate tracks
│   └── style.css                 # acid-rave dark theme
├── shared/
│   └── sample-banks.json         # single source of truth: which sample banks exist (webapp prebake + sounds.json builder both read this)
├── scripts/
│   ├── strudel-env.mjs           # headless evalScope setup + browser stubs
│   ├── validate.mjs              # validateCode() lib + CLI (PASS/FAIL, exit code)
│   ├── check-sounds.mjs          # hap sound names vs allowlist
│   ├── build-sounds.mjs          # fetch sample manifests → scripts/sounds.json
│   ├── sounds.json               # GENERATED allowlist (committed)
│   └── feedback.mjs              # buildDigest() lib + CLI: ratings → text digest for agents
├── server/
│   ├── store.mjs                 # createStore(): list tracks merged with ratings, save rating
│   ├── app.mjs                   # createApp(store): Express routes
│   └── index.mjs                 # entry: listen :3001
├── tracks/                       # generated tracks (committed), one JSON per track
├── data/ratings/                 # one JSON per rated track (committed)
├── test/
│   ├── validate.test.mjs
│   ├── check-sounds.test.mjs
│   ├── store.test.mjs
│   ├── api.test.mjs
│   └── feedback.test.mjs
└── .claude/skills/generate-tracks/SKILL.md   # the /generate-tracks command
```

**Track JSON schema** (`tracks/<id>.json`):
```json
{
  "id": "2026-06-03-dark-techno-03",
  "title": "Rust Cathedral",
  "prompt": "dark hypnotic techno, 130bpm",
  "batch": "2026-06-03-dark-techno",
  "code": "setcpm(130/4)\nstack(...)",
  "createdAt": "2026-06-03T18:00:00Z"
}
```

**Rating JSON schema** (`data/ratings/<id>.json`):
```json
{ "id": "2026-06-03-dark-techno-03", "rating": 4, "notes": "love the bassline, hats too loud", "updatedAt": "..." }
```

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `.gitignore`, `vite.config.js`, `vitest.config.js`, `shared/sample-banks.json`, `tracks/.gitkeep`, `data/ratings/.gitkeep`

- [ ] **Step 1: Init git repo**

```bash
cd /Users/den/dev/code/strudel-ai && git init -b main
```

- [ ] **Step 2: Write `.gitignore`**

```
node_modules/
dist/
.DS_Store
```

- [ ] **Step 3: Write `package.json`**

```json
{
  "name": "strudel-ai",
  "private": true,
  "type": "module",
  "engines": { "node": ">=18" },
  "scripts": {
    "dev": "concurrently -n api,web -c blue,green \"node server/index.mjs\" \"vite\"",
    "build": "vite build",
    "test": "vitest run",
    "validate": "node scripts/validate.mjs",
    "feedback": "node scripts/feedback.mjs",
    "build-sounds": "node scripts/build-sounds.mjs"
  },
  "dependencies": {
    "@strudel/core": "1.2.6",
    "@strudel/mini": "1.2.6",
    "@strudel/tonal": "1.2.6",
    "@strudel/transpiler": "1.2.6",
    "@strudel/web": "1.3.0",
    "@strudel/webaudio": "1.3.0",
    "express": "^4.19.2"
  },
  "devDependencies": {
    "concurrently": "^9.1.0",
    "supertest": "^7.0.0",
    "vite": "^6.0.0",
    "vite-plugin-top-level-await": "^1.4.4",
    "vite-plugin-wasm": "^3.3.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 4: Write `vite.config.js`**

```js
import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

export default defineConfig({
  plugins: [wasm(), topLevelAwait()],
  build: { target: 'esnext' },
  optimizeDeps: { esbuildOptions: { target: 'esnext' } },
  server: { proxy: { '/api': 'http://localhost:3001' } },
});
```

- [ ] **Step 5: Write `vitest.config.js`** (separate from vite.config so the wasm plugins don't run under vitest; strudel module imports are slow on first load, hence the timeout)

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', testTimeout: 20000 },
});
```

- [ ] **Step 6: Write `shared/sample-banks.json`** — the single source of truth for which sample banks the webapp loads AND which sounds the validator allows. These are the same banks strudel.cc's own REPL prebakes (from `website/src/repl/prebake.mjs`).

```json
[
  { "json": "https://strudel.b-cdn.net/piano.json", "base": "https://strudel.b-cdn.net/piano/", "prebake": true },
  { "json": "https://strudel.b-cdn.net/vcsl.json", "base": "https://strudel.b-cdn.net/VCSL/", "prebake": true },
  { "json": "https://strudel.b-cdn.net/tidal-drum-machines.json", "base": "https://strudel.b-cdn.net/tidal-drum-machines/machines/", "prebake": true, "tag": "drum-machines" },
  { "json": "https://strudel.b-cdn.net/mridangam.json", "base": "https://strudel.b-cdn.net/mrid/", "prebake": true, "tag": "drum-machines" },
  { "shorthand": "github:tidalcycles/dirt-samples" }
]
```

- [ ] **Step 7: Create data directories**

```bash
mkdir -p tracks data/ratings && touch tracks/.gitkeep data/ratings/.gitkeep
```

- [ ] **Step 8: Install dependencies + kabelsalat ESM fix**

Run: `npm install`
Expected: completes without errors (peer-dep warnings are fine).

**Known issue (verified during planning/execution):** `@strudel/core@1.2.6` does `import { SalatRepl } from '@kabelsalat/web'`, but `@kabelsalat/web@0.4.1` has no `exports` map, so plain Node resolves its `main` (`dist/index.js`, an IIFE bundle with no ESM exports) instead of `dist/index.mjs`. Bundlers use the `module` field, so only plain-Node usage breaks. Fix: a postinstall script that injects an `exports` map.

Write `scripts/fix-kabelsalat.mjs`:
```js
// @kabelsalat/web@0.4.x ships no "exports" map, so plain Node resolves its
// IIFE "main" bundle and `import { SalatRepl } from '@kabelsalat/web'` (inside
// @strudel/core) fails. Point Node at the ESM build. Bundlers are unaffected.
import { readFile, writeFile } from 'node:fs/promises';

const path = 'node_modules/@kabelsalat/web/package.json';
const pkg = JSON.parse(await readFile(path, 'utf8'));
if (!pkg.exports) {
  pkg.exports = { '.': { import: './dist/index.mjs', default: './dist/index.js' } };
  await writeFile(path, JSON.stringify(pkg, null, 2) + '\n');
  console.log('patched @kabelsalat/web exports for Node ESM');
}
```

Add to `package.json` scripts: `"postinstall": "node scripts/fix-kabelsalat.mjs"`, then run `node scripts/fix-kabelsalat.mjs` once now.

- [ ] **Step 9: Sanity-check strudel imports in Node**

Run: `node -e "import('@strudel/transpiler').then(m => console.log(typeof m.evaluate))"`
Expected: `function`

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "chore: scaffold strudel-ai project"
```

---

### Task 2: Headless Strudel environment + core validator

**Files:**
- Create: `scripts/strudel-env.mjs`
- Create: `scripts/validate.mjs` (library part only; CLI added in Task 4)
- Test: `test/validate.test.mjs`

- [ ] **Step 1: Write the failing tests**

`test/validate.test.mjs`:
```js
import { describe, it, expect } from 'vitest';
import { validateCode } from '../scripts/validate.mjs';

describe('validateCode', () => {
  it('accepts valid strudel code and counts events', async () => {
    const result = await validateCode('note("c3 e3 g3").s("sawtooth").lpf(800)');
    expect(result.ok).toBe(true);
    expect(result.events).toBeGreaterThan(0);
  });

  it('accepts multi-statement code with setcpm and stack', async () => {
    const code = 'setcpm(120/4)\nstack(s("bd*4"), note("c2 g1").s("sawtooth"))';
    const result = await validateCode(code);
    expect(result.ok).toBe(true);
  });

  it('rejects code with syntax errors', async () => {
    const result = await validateCode('note("c3 e3"');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/evaluation failed/);
  });

  it('rejects code that references undefined functions', async () => {
    const result = await validateCode('definitelyNotAFunction("c3")');
    expect(result.ok).toBe(false);
  });

  it('rejects patterns that produce no events', async () => {
    const result = await validateCode('silence');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no events/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/validate.test.mjs`
Expected: FAIL — cannot find module `../scripts/validate.mjs`.

- [ ] **Step 3: Write `scripts/strudel-env.mjs`** (mirrors strudel's own `test/runtime.mjs`)

```js
// Headless Strudel evaluation environment for Node.
// Mirrors strudel's own test/runtime.mjs: stubs browser-only functions,
// then evalScope()s the pattern vocabulary onto globalThis.
import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import * as tonal from '@strudel/tonal';
import * as webaudio from '@strudel/webaudio';

// Pattern methods that only have audio/visual side effects in the browser.
const BROWSER_ONLY_METHODS = [
  'osc', 'csound', 'tone', 'webdirt', 'pianoroll', 'speak', 'wave', 'filter',
  'adsr', 'webaudio', 'soundfont', 'tune', 'midi', '_scope', '_spiral',
  '_pitchwheel', '_pianoroll', '_spectrum', 'markcss', 'p',
];

const id = (x) => x;
let ready;

export function initStrudelEnv() {
  if (ready) return ready;
  for (const name of BROWSER_ONLY_METHODS) {
    core.Pattern.prototype[name] = function () { return this; };
  }
  // evalScope is ASYNC: it puts note/s/stack/lpf/... on globalThis so that
  // transpiled code can resolve bare identifiers.
  ready = core.evalScope(core, mini, tonal, webaudio, {
    samples: id, // browser-only: loads audio over fetch
    setcps: id,
    setcpm: id,
    getAudioContext: () => ({ currentTime: 0 }),
    getDrawContext: () => ({
      clearRect() {}, fillRect() {}, fillText() {},
      canvas: { width: 100, height: 100 },
    }),
  });
  return ready;
}
```

- [ ] **Step 4: Write `scripts/validate.mjs`** (library part)

```js
// Validate a Strudel code string headlessly: it must transpile, evaluate to
// a Pattern, and produce events when queried.
import { evaluate } from '@strudel/transpiler';
import { Pattern } from '@strudel/core';
import { initStrudelEnv } from './strudel-env.mjs';

const QUERY_CYCLES = 8;

export async function validateCode(code) {
  await initStrudelEnv();
  let pattern;
  try {
    ({ pattern } = await evaluate(code));
  } catch (err) {
    return { ok: false, error: `evaluation failed: ${err.message}` };
  }
  if (!(pattern instanceof Pattern)) {
    return { ok: false, error: 'code did not evaluate to a Pattern (end with a single stack(...) expression)' };
  }
  let haps;
  try {
    haps = pattern.sortHapsByPart().queryArc(0, QUERY_CYCLES);
  } catch (err) {
    return { ok: false, error: `pattern query failed: ${err.message}` };
  }
  if (haps.length === 0) {
    return { ok: false, error: `pattern produced no events in ${QUERY_CYCLES} cycles` };
  }
  return { ok: true, events: haps.length };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/validate.test.mjs`
Expected: 5 passed.

Troubleshooting if imports fail: `@strudel/mini` main export should include `mini`/`m`; if `evalScope` errors on the module form, fall back to `import { mini, m } from '@strudel/mini/mini.mjs'` and pass `{ mini, m }` explicitly (this is what strudel's own test runtime does).

- [ ] **Step 6: Commit**

```bash
git add scripts/strudel-env.mjs scripts/validate.mjs test/validate.test.mjs
git commit -m "feat: headless strudel validator (transpile + evaluate + query events)"
```

---

### Task 3: Sound-name allowlist

The webapp only loads specific sample banks; the validator must reject tracks that reference sounds outside them ("plays headless" ≠ "audible in browser" otherwise).

**Files:**
- Create: `scripts/build-sounds.mjs`, `scripts/check-sounds.mjs`
- Create (generated): `scripts/sounds.json`
- Modify: `scripts/validate.mjs`
- Test: `test/check-sounds.test.mjs`, extend `test/validate.test.mjs`

- [ ] **Step 1: Write the failing tests**

`test/check-sounds.test.mjs`:
```js
import { describe, it, expect } from 'vitest';
import { checkSounds } from '../scripts/check-sounds.mjs';

const known = new Set(['bd', 'hh', 'piano', 'sawtooth', 'RolandTR909_bd']);
const hap = (value) => ({ value });

describe('checkSounds', () => {
  it('passes haps whose s is known', () => {
    expect(checkSounds([hap({ s: 'bd' }), hap({ s: 'piano', note: 60 })], known)).toEqual([]);
  });

  it('flags unknown sounds, deduplicated', () => {
    const haps = [hap({ s: 'zzz' }), hap({ s: 'zzz' }), hap({ s: 'bd' })];
    expect(checkSounds(haps, known)).toEqual(['zzz']);
  });

  it('checks bank-prefixed names the way superdough resolves them', () => {
    expect(checkSounds([hap({ s: 'bd', bank: 'RolandTR909' })], known)).toEqual([]);
    expect(checkSounds([hap({ s: 'bd', bank: 'NopeMachine' })], known)).toEqual(['NopeMachine_bd']);
  });

  it('ignores haps without an s control (pure synth notes use default sound)', () => {
    expect(checkSounds([hap({ note: 60 }), hap(undefined)], known)).toEqual([]);
  });
});
```

Add to `test/validate.test.mjs`:
```js
  it('rejects sounds the webapp does not load', async () => {
    const result = await validateCode('s("definitelynotasound*4")');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unknown sounds/);
  });

  it('accepts drum-machine bank sounds', async () => {
    const result = await validateCode('s("bd*4, ~ sd").bank("RolandTR909")');
    expect(result.ok).toBe(true);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run`
Expected: FAIL — `check-sounds.mjs` missing, and the two new validate tests fail.

- [ ] **Step 3: Write `scripts/check-sounds.mjs`**

```js
// Check queried haps against the allowlist of sounds the webapp actually loads.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export async function loadKnownSounds() {
  const names = JSON.parse(await readFile(join(here, 'sounds.json'), 'utf8'));
  return new Set(names);
}

// superdough resolves .bank("X") + .s("y") as the sound "X_y".
export function checkSounds(haps, known) {
  const unknown = new Set();
  for (const hap of haps) {
    const v = hap?.value;
    if (!v || typeof v !== 'object' || v.s == null) continue;
    const name = v.bank ? `${v.bank}_${v.s}` : String(v.s);
    if (!known.has(name)) unknown.add(name);
  }
  return [...unknown].sort();
}
```

- [ ] **Step 4: Write `scripts/build-sounds.mjs`**

```js
// Build scripts/sounds.json: every sound name available in the webapp.
// Fetches the same sample manifests the webapp prebakes (shared/sample-banks.json)
// plus the synth waveforms registered by @strudel/web's defaultPrebake.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SYNTHS = ['sine', 'square', 'triangle', 'sawtooth', 'supersaw', 'white', 'pink', 'brown'];

function manifestUrl(bank) {
  if (bank.shorthand) {
    // 'github:user/repo' shorthand resolves to the repo's strudel.json on the default branch
    const repo = bank.shorthand.replace('github:', '');
    return `https://raw.githubusercontent.com/${repo}/master/strudel.json`;
  }
  return bank.json;
}

const banks = JSON.parse(await readFile(join(here, '../shared/sample-banks.json'), 'utf8'));
const names = new Set(SYNTHS);
for (const bank of banks) {
  const url = manifestUrl(bank);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const manifest = await res.json();
  for (const key of Object.keys(manifest)) {
    if (!key.startsWith('_')) names.add(key);
  }
  console.log(`${url}: ${Object.keys(manifest).length} entries`);
}
await writeFile(join(here, 'sounds.json'), JSON.stringify([...names].sort(), null, 2) + '\n');
console.log(`wrote scripts/sounds.json with ${names.size} sound names`);
```

- [ ] **Step 5: Generate the allowlist (network required)**

Run: `npm run build-sounds`
Expected: logs one line per manifest, final line `wrote scripts/sounds.json with <several hundred> sound names`. Spot-check: `node -e "const s=require('fs').readFileSync('scripts/sounds.json','utf8'); const a=JSON.parse(s); console.log(a.length, a.includes('bd'), a.includes('piano'), a.includes('RolandTR909_bd'))"` → expect `<N> true true true`. If `RolandTR909_bd` is false, inspect tidal-drum-machines.json key format and adjust `checkSounds` bank resolution to match the actual keys (the allowlist and the resolver must agree with how superdough prefixes banks).

- [ ] **Step 6: Wire sound checking into `validateCode`**

Modify `scripts/validate.mjs` — add import and check:
```js
import { checkSounds, loadKnownSounds } from './check-sounds.mjs';
```
and after the `haps.length === 0` check:
```js
  const unknown = checkSounds(haps, await loadKnownSounds());
  if (unknown.length > 0) {
    return { ok: false, error: `unknown sounds (not loaded by the webapp): ${unknown.join(', ')} — see scripts/sounds.json for valid names` };
  }
```

- [ ] **Step 7: Run all tests to verify they pass**

Run: `npx vitest run`
Expected: all pass (validate tests from Task 2 still green — `sawtooth` and bare `bd`/`sd` are in the allowlist).

- [ ] **Step 8: Commit**

```bash
git add scripts/build-sounds.mjs scripts/check-sounds.mjs scripts/sounds.json scripts/validate.mjs test/
git commit -m "feat: sound allowlist generated from webapp sample banks, enforced in validator"
```

---

### Task 4: Validator CLI

**Files:**
- Modify: `scripts/validate.mjs` (append CLI section)

- [ ] **Step 1: Append CLI to `scripts/validate.mjs`**

```js
// ---- CLI: node scripts/validate.mjs <track.json|file.strudel>... | --code "<code>" ----
const REQUIRED_FIELDS = ['id', 'title', 'prompt', 'batch', 'code', 'createdAt'];

async function validateTarget(arg) {
  if (arg.endsWith('.json')) {
    const { readFile } = await import('node:fs/promises');
    let track;
    try {
      track = JSON.parse(await readFile(arg, 'utf8'));
    } catch (err) {
      return { ok: false, error: `unreadable JSON: ${err.message}` };
    }
    const missing = REQUIRED_FIELDS.filter((f) => !track[f]);
    if (missing.length) return { ok: false, error: `missing fields: ${missing.join(', ')}` };
    return validateCode(track.code);
  }
  const { readFile } = await import('node:fs/promises');
  return validateCode(await readFile(arg, 'utf8'));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('usage: node scripts/validate.mjs <track.json>... | --code "<strudel code>"');
    process.exit(2);
  }
  let failures = 0;
  if (args[0] === '--code') {
    const result = await validateCode(args[1] ?? '');
    console.log(result.ok ? `PASS (${result.events} events / 8 cycles)` : `FAIL — ${result.error}`);
    failures += result.ok ? 0 : 1;
  } else {
    for (const file of args) {
      const result = await validateTarget(file);
      console.log(result.ok ? `PASS ${file} (${result.events} events / 8 cycles)` : `FAIL ${file} — ${result.error}`);
      failures += result.ok ? 0 : 1;
    }
  }
  process.exit(failures ? 1 : 0);
}
```

- [ ] **Step 2: Verify CLI happy path**

Run: `node scripts/validate.mjs --code 'note("c3 e3 g3").s("sawtooth")'`
Expected: `PASS (24 events / 8 cycles)` (event count may differ; must be PASS), exit code 0 (`echo $?` → 0).

- [ ] **Step 3: Verify CLI failure path**

Run: `node scripts/validate.mjs --code 's("notarealsound")'; echo "exit=$?"`
Expected: `FAIL — unknown sounds...` then `exit=1`.

- [ ] **Step 4: Verify unit tests still pass**

Run: `npx vitest run`
Expected: all pass (CLI block must not execute under vitest — the `import.meta.url` guard handles that).

- [ ] **Step 5: Commit**

```bash
git add scripts/validate.mjs && git commit -m "feat: validator CLI with track-schema check and exit codes"
```

---

### Task 5: Seed tracks

Two hand-written tracks so the webapp has something to show, doubling as an integration test of the validator.

**Files:**
- Create: `tracks/2026-06-03-seed-01.json`, `tracks/2026-06-03-seed-02.json`

- [ ] **Step 1: Write `tracks/2026-06-03-seed-01.json`**

```json
{
  "id": "2026-06-03-seed-01",
  "title": "Boiler Primer",
  "prompt": "seed: driving acid techno, 130bpm",
  "batch": "2026-06-03-seed",
  "code": "setcpm(130/4)\nstack(\n  s(\"bd*4\").bank(\"RolandTR909\").gain(1.1),\n  s(\"[~ hh]*4\").bank(\"RolandTR909\").gain(0.7).pan(sine.range(0.3, 0.7)),\n  s(\"~ cp ~ cp\").bank(\"RolandTR909\").room(0.3),\n  note(\"<c2 c2 eb2 g1>*8\").s(\"sawtooth\").lpf(sine.slow(4).range(200, 1800)).resonance(12).decay(0.12).sustain(0).gain(0.8)\n)",
  "createdAt": "2026-06-03T00:00:00Z"
}
```

- [ ] **Step 2: Write `tracks/2026-06-03-seed-02.json`**

```json
{
  "id": "2026-06-03-seed-02",
  "title": "Felt Hammer",
  "prompt": "seed: melancholy piano sketch, 72bpm",
  "batch": "2026-06-03-seed",
  "code": "setcpm(72/4)\nstack(\n  note(\"<[c3,eb3,g3] [ab2,c3,eb3] [bb2,d3,f3] [g2,bb2,d3]>\").s(\"piano\").room(0.6).gain(0.9),\n  n(\"0 ~ [4 2] ~ 7 ~ [3 2] ~\").scale(\"C4:minor\").s(\"piano\").slow(2).gain(0.7).delay(0.3),\n  s(\"~ ~ rim ~\").bank(\"RolandTR707\").gain(0.4)\n)",
  "createdAt": "2026-06-03T00:00:00Z"
}
```

- [ ] **Step 3: Validate both seeds**

Run: `node scripts/validate.mjs tracks/2026-06-03-seed-01.json tracks/2026-06-03-seed-02.json`
Expected: two `PASS` lines, exit 0. If a sound name fails (e.g. `RolandTR707_rim` not in allowlist), pick a substitute that IS in `scripts/sounds.json` (e.g. swap to `RolandTR808` rim or `cp`) and re-validate — the allowlist is the source of truth.

- [ ] **Step 4: Commit**

```bash
git add tracks/ && git commit -m "feat: two validated seed tracks"
```

---

### Task 6: Track/rating store

**Files:**
- Create: `server/store.mjs`
- Test: `test/store.test.mjs`

- [ ] **Step 1: Write the failing tests**

`test/store.test.mjs`:
```js
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.mjs';

const track = (id, extra = {}) => ({
  id, title: `t-${id}`, prompt: 'p', batch: 'b', code: 's("bd")',
  createdAt: '2026-06-03T00:00:00Z', ...extra,
});

let dirs, store;
beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'strudel-store-'));
  dirs = { tracksDir: join(base, 'tracks'), ratingsDir: join(base, 'ratings') };
  await mkdir(dirs.tracksDir, { recursive: true });
  store = createStore(dirs);
});

describe('createStore', () => {
  it('lists tracks with null rating when unrated', async () => {
    await writeFile(join(dirs.tracksDir, 'a.json'), JSON.stringify(track('a')));
    const tracks = await store.listTracks();
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({ id: 'a', rating: null, notes: '' });
  });

  it('merges saved ratings into the listing', async () => {
    await writeFile(join(dirs.tracksDir, 'a.json'), JSON.stringify(track('a')));
    await store.saveRating('a', { rating: 4, notes: 'nice bass' });
    const tracks = await store.listTracks();
    expect(tracks[0]).toMatchObject({ rating: 4, notes: 'nice bass' });
  });

  it('returns empty list when tracks dir missing', async () => {
    const empty = createStore({ tracksDir: join(dirs.tracksDir, 'nope'), ratingsDir: dirs.ratingsDir });
    expect(await empty.listTracks()).toEqual([]);
  });

  it('saveRating returns the persisted record', async () => {
    const saved = await store.saveRating('x', { rating: 2, notes: '' });
    expect(saved).toMatchObject({ id: 'x', rating: 2, notes: '' });
    expect(saved.updatedAt).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/store.test.mjs`
Expected: FAIL — cannot find module `../server/store.mjs`.

- [ ] **Step 3: Write `server/store.mjs`**

```js
// File-backed store: tracks are JSON files written by generation agents,
// ratings are JSON files written here (server is the only ratings writer).
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function createStore({ tracksDir, ratingsDir }) {
  async function getRating(id) {
    try {
      const r = JSON.parse(await readFile(join(ratingsDir, `${id}.json`), 'utf8'));
      return { rating: r.rating ?? null, notes: r.notes ?? '' };
    } catch {
      return { rating: null, notes: '' };
    }
  }

  async function listTracks() {
    let files;
    try {
      files = await readdir(tracksDir);
    } catch {
      return [];
    }
    const tracks = [];
    for (const file of files.filter((f) => f.endsWith('.json')).sort()) {
      try {
        const track = JSON.parse(await readFile(join(tracksDir, file), 'utf8'));
        tracks.push({ ...track, ...(await getRating(track.id)) });
      } catch {
        // skip malformed track files rather than breaking the whole listing
      }
    }
    return tracks;
  }

  async function saveRating(id, { rating, notes }) {
    await mkdir(ratingsDir, { recursive: true });
    const record = {
      id,
      rating: rating ?? null,
      notes: notes ?? '',
      updatedAt: new Date().toISOString(),
    };
    await writeFile(join(ratingsDir, `${id}.json`), JSON.stringify(record, null, 2) + '\n');
    return record;
  }

  return { listTracks, saveRating };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/store.test.mjs`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add server/store.mjs test/store.test.mjs && git commit -m "feat: file-backed track/rating store"
```

---

### Task 7: Express API

**Files:**
- Create: `server/app.mjs`, `server/index.mjs`
- Test: `test/api.test.mjs`

- [ ] **Step 1: Write the failing tests**

`test/api.test.mjs`:
```js
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';

let app, tracksDir;
beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'strudel-api-'));
  tracksDir = join(base, 'tracks');
  await mkdir(tracksDir, { recursive: true });
  app = createApp(createStore({ tracksDir, ratingsDir: join(base, 'ratings') }));
});

describe('API', () => {
  it('GET /api/tracks returns tracks merged with ratings', async () => {
    await writeFile(join(tracksDir, 'a.json'), JSON.stringify({
      id: 'a', title: 'T', prompt: 'p', batch: 'b', code: 's("bd")', createdAt: 'x',
    }));
    const res = await request(app).get('/api/tracks');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: 'a', rating: null });
  });

  it('PUT /api/tracks/:id/rating saves and returns the record', async () => {
    const res = await request(app)
      .put('/api/tracks/a/rating')
      .send({ rating: 5, notes: 'banger' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'a', rating: 5, notes: 'banger' });
  });

  it('rejects out-of-range ratings', async () => {
    const res = await request(app).put('/api/tracks/a/rating').send({ rating: 9 });
    expect(res.status).toBe(400);
  });

  it('rejects ids with path characters', async () => {
    const res = await request(app).put('/api/tracks/..%2Fevil/rating').send({ rating: 3 });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/api.test.mjs`
Expected: FAIL — cannot find module `../server/app.mjs`.

- [ ] **Step 3: Write `server/app.mjs`**

```js
import express from 'express';

const ID_RE = /^[A-Za-z0-9_-]+$/; // rating files are written as <id>.json — no path chars

export function createApp(store) {
  const app = express();
  app.use(express.json());

  app.get('/api/tracks', async (_req, res) => {
    res.json(await store.listTracks());
  });

  app.put('/api/tracks/:id/rating', async (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'invalid track id' });
    const { rating, notes } = req.body ?? {};
    if (rating != null && !(Number.isInteger(rating) && rating >= 1 && rating <= 5)) {
      return res.status(400).json({ error: 'rating must be an integer 1-5' });
    }
    if (notes != null && typeof notes !== 'string') {
      return res.status(400).json({ error: 'notes must be a string' });
    }
    res.json(await store.saveRating(id, { rating, notes }));
  });

  return app;
}
```

- [ ] **Step 4: Write `server/index.mjs`**

```js
import { createApp } from './app.mjs';
import { createStore } from './store.mjs';

const store = createStore({ tracksDir: 'tracks', ratingsDir: 'data/ratings' });
const app = createApp(store);
const port = process.env.PORT ?? 3001;
app.listen(port, () => console.log(`strudel-ai api listening on http://localhost:${port}`));
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/api.test.mjs`
Expected: 4 passed.

- [ ] **Step 6: Smoke the real server against seed tracks**

Run: `node server/index.mjs & sleep 1 && curl -s localhost:3001/api/tracks | head -c 400; kill %1`
Expected: JSON array containing both seed tracks with `"rating": null`.

- [ ] **Step 7: Commit**

```bash
git add server/ test/api.test.mjs && git commit -m "feat: express API for tracks and ratings"
```

---

### Task 8: Webapp (listen / rate / annotate)

**Aesthetic direction:** acid-rave crate-digger — near-black background with faint scanlines, acid-green accent (#c8f53c), hot-pink for the stop/transport, `Bricolage Grotesque` display type over `IBM Plex Mono` body, hard 1px borders, square rating blocks instead of stars, CSS EQ-bars animation on the playing track. One track plays at a time (Strudel has a single global scheduler — `evaluate()` swaps the pattern, `hush()` stops).

**Files:**
- Create: `index.html`, `src/main.js`, `src/style.css`

- [ ] **Step 1: Write `index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>STRUDEL/CRATE</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,300..800&family=IBM+Plex+Mono:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/src/style.css" />
</head>
<body>
  <header class="masthead">
    <h1>STRUDEL<span>/</span>CRATE</h1>
    <div class="filters">
      <select id="batch-filter" aria-label="filter by batch"><option value="all">all batches</option></select>
      <div class="seg" role="group" aria-label="rating filter">
        <button data-filter="all" class="on">all</button>
        <button data-filter="unrated">unrated</button>
        <button data-filter="top">★4+</button>
      </div>
    </div>
  </header>
  <main id="tracks"><p class="empty">loading crate…</p></main>
  <footer id="transport">
    <span id="status" class="status">warming up samples…</span>
    <span id="now-playing"></span>
    <button id="stop" disabled>■ STOP</button>
  </footer>
  <script type="module" src="/src/main.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `src/main.js`**

```js
import { initStrudel, evaluate, hush } from '@strudel/web';
import banks from '../shared/sample-banks.json';

const state = { tracks: [], playingId: null, samplesReady: false, batch: 'all', filter: 'all' };
const $ = (sel, el = document) => el.querySelector(sel);

// --- strudel init: load the same banks the validator allowlists ---------
// initStrudel's evalScope makes `samples` a global before prebake runs.
const ready = initStrudel({
  prebake: () =>
    Promise.all(
      banks.map((b) =>
        b.shorthand
          ? globalThis.samples(b.shorthand)
          : globalThis.samples(b.json, b.base, { prebake: b.prebake, tag: b.tag }),
      ),
    ),
});
ready.then(() => {
  state.samplesReady = true;
  renderTransport();
});

// --- playback (single global scheduler: evaluate swaps, hush stops) ------
async function play(track) {
  state.playingId = track.id;
  renderTracks();
  renderTransport();
  await ready; // audio context unlocks via this click
  if (state.playingId !== track.id) return; // user moved on while samples loaded
  evaluate(track.code);
}

function stop() {
  hush();
  state.playingId = null;
  renderTracks();
  renderTransport();
}

// --- ratings --------------------------------------------------------------
async function putRating(track, patch) {
  const body = {
    rating: 'rating' in patch ? patch.rating : track.rating,
    notes: 'notes' in patch ? patch.notes : track.notes,
  };
  const res = await fetch(`/api/tracks/${track.id}/rating`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`save failed: ${res.status}`);
  const saved = await res.json();
  track.rating = saved.rating;
  track.notes = saved.notes;
}

const debounce = (fn, ms) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

// --- rendering --------------------------------------------------------------
function visibleTracks() {
  return state.tracks.filter((t) => {
    if (state.batch !== 'all' && t.batch !== state.batch) return false;
    if (state.filter === 'unrated') return t.rating == null;
    if (state.filter === 'top') return (t.rating ?? 0) >= 4;
    return true;
  });
}

function trackCard(track) {
  const card = document.createElement('article');
  card.className = 'track' + (track.id === state.playingId ? ' playing' : '');

  const playBtn = document.createElement('button');
  playBtn.className = 'play';
  playBtn.innerHTML =
    track.id === state.playingId
      ? '<span class="eq"><i></i><i></i><i></i></span>'
      : '▶';
  playBtn.title = track.id === state.playingId ? 'stop' : 'play';
  playBtn.addEventListener('click', () =>
    track.id === state.playingId ? stop() : play(track),
  );

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = `<h3></h3><span class="id"></span>`;
  $('h3', meta).textContent = track.title;
  $('.id', meta).textContent = track.id;

  const rate = document.createElement('div');
  rate.className = 'rate';
  for (let n = 1; n <= 5; n++) {
    const b = document.createElement('button');
    b.className = 'block' + (track.rating != null && n <= track.rating ? ' on' : '');
    b.title = `${n}/5`;
    b.addEventListener('click', async () => {
      await putRating(track, { rating: track.rating === n ? null : n }); // click again to clear
      renderTracks();
    });
    rate.appendChild(b);
  }

  const notes = document.createElement('textarea');
  notes.className = 'notes';
  notes.placeholder = 'notes — what works, what to change…';
  notes.value = track.notes ?? '';
  const saveNotes = debounce(async () => {
    await putRating(track, { notes: notes.value });
    notes.classList.add('saved');
    setTimeout(() => notes.classList.remove('saved'), 600);
  }, 600);
  notes.addEventListener('input', saveNotes);

  const code = document.createElement('details');
  code.className = 'code';
  code.innerHTML = `<summary>code</summary><pre></pre>`;
  $('pre', code).textContent = track.code;

  card.append(playBtn, meta, rate, notes, code);
  return card;
}

function renderTracks() {
  const main = $('#tracks');
  main.replaceChildren();
  const tracks = visibleTracks();
  if (tracks.length === 0) {
    main.innerHTML = '<p class="empty">nothing here — generate some tracks: <code>/generate-tracks "dark techno" 12</code></p>';
    return;
  }
  const byBatch = new Map();
  for (const t of tracks) {
    if (!byBatch.has(t.batch)) byBatch.set(t.batch, []);
    byBatch.get(t.batch).push(t);
  }
  for (const [batch, list] of [...byBatch.entries()].sort().reverse()) {
    const section = document.createElement('section');
    section.className = 'batch';
    const h2 = document.createElement('h2');
    h2.textContent = batch;
    const promptSpan = document.createElement('span');
    promptSpan.textContent = list[0].prompt;
    h2.appendChild(promptSpan);
    section.appendChild(h2);
    list.forEach((t) => section.appendChild(trackCard(t)));
    main.appendChild(section);
  }
}

function renderTransport() {
  $('#status').textContent = state.samplesReady ? '● samples loaded' : '◌ warming up samples…';
  $('#status').classList.toggle('ready', state.samplesReady);
  const playing = state.tracks.find((t) => t.id === state.playingId);
  $('#now-playing').textContent = playing ? `NOW PLAYING — ${playing.title}` : '';
  $('#stop').disabled = !playing;
}

function renderBatchFilter() {
  const select = $('#batch-filter');
  const batches = [...new Set(state.tracks.map((t) => t.batch))].sort().reverse();
  for (const b of batches) {
    const opt = document.createElement('option');
    opt.value = opt.textContent = b;
    select.appendChild(opt);
  }
}

// --- boot --------------------------------------------------------------
$('#stop').addEventListener('click', stop);
$('#batch-filter').addEventListener('change', (e) => {
  state.batch = e.target.value;
  renderTracks();
});
document.querySelectorAll('.seg button').forEach((btn) =>
  btn.addEventListener('click', () => {
    document.querySelectorAll('.seg button').forEach((b) => b.classList.remove('on'));
    btn.classList.add('on');
    state.filter = btn.dataset.filter;
    renderTracks();
  }),
);

try {
  const res = await fetch('/api/tracks');
  state.tracks = await res.json();
  renderBatchFilter();
  renderTracks();
  renderTransport();
} catch (err) {
  $('#tracks').innerHTML = `<p class="empty">API unreachable — is <code>npm run dev</code> running? (${err.message})</p>`;
}
```

- [ ] **Step 3: Write `src/style.css`**

```css
:root {
  --bg: #0c0d0a;
  --panel: #13150e;
  --ink: #e9edda;
  --dim: #7c856e;
  --acid: #c8f53c;
  --hot: #ff5ca8;
  --line: #2b2f20;
  --mono: 'IBM Plex Mono', monospace;
  --display: 'Bricolage Grotesque', sans-serif;
}

* { box-sizing: border-box; margin: 0; }

body {
  background:
    repeating-linear-gradient(0deg, transparent 0 2px, rgb(255 255 255 / 0.012) 2px 4px),
    radial-gradient(1200px 500px at 70% -10%, #1a2110 0%, transparent 60%),
    var(--bg);
  color: var(--ink);
  font-family: var(--mono);
  font-size: 14px;
  padding-bottom: 72px; /* room for transport */
}

/* masthead */
.masthead {
  position: sticky; top: 0; z-index: 10;
  display: flex; align-items: baseline; justify-content: space-between; gap: 24px; flex-wrap: wrap;
  padding: 20px 28px 14px;
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter: blur(6px);
  border-bottom: 2px solid var(--acid);
}
.masthead h1 {
  font-family: var(--display);
  font-weight: 800; font-size: 28px; letter-spacing: -0.03em;
}
.masthead h1 span { color: var(--acid); }

.filters { display: flex; gap: 12px; align-items: center; }
.filters select, .seg button {
  background: var(--panel); color: var(--ink);
  border: 1px solid var(--line); font-family: var(--mono); font-size: 12px;
  padding: 6px 10px; cursor: pointer;
}
.seg { display: flex; }
.seg button + button { border-left: 0; }
.seg button.on { background: var(--acid); color: var(--bg); font-weight: 600; }

/* batches */
.batch { padding: 28px 28px 8px; max-width: 1100px; margin: 0 auto; }
.batch h2 {
  font-family: var(--display); font-weight: 600; font-size: 15px;
  color: var(--acid); text-transform: uppercase; letter-spacing: 0.08em;
  margin-bottom: 14px;
}
.batch h2 span { color: var(--dim); font-family: var(--mono); font-weight: 400; text-transform: none; letter-spacing: 0; margin-left: 12px; }

/* track card */
.track {
  display: grid;
  grid-template-columns: 56px 1fr 130px minmax(220px, 1.2fr);
  grid-template-areas: 'play meta rate notes' 'play code code notes';
  gap: 8px 16px; align-items: center;
  border: 1px solid var(--line); background: var(--panel);
  padding: 12px 16px; margin-bottom: 10px;
  transition: border-color 0.15s ease;
}
.track:hover { border-color: var(--dim); }
.track.playing { border-color: var(--acid); box-shadow: 0 0 24px rgb(200 245 60 / 0.12); }

.play {
  grid-area: play;
  width: 48px; height: 48px;
  background: transparent; color: var(--acid);
  border: 1px solid var(--acid); font-size: 16px; cursor: pointer;
}
.play:hover { background: var(--acid); color: var(--bg); }
.track.playing .play { background: var(--acid); }

/* EQ bars while playing */
.eq { display: inline-flex; gap: 3px; align-items: flex-end; height: 18px; }
.eq i {
  width: 4px; background: var(--bg); animation: eq 0.5s ease-in-out infinite alternate;
}
.eq i:nth-child(2) { animation-delay: 0.15s; }
.eq i:nth-child(3) { animation-delay: 0.3s; }
@keyframes eq { from { height: 4px; } to { height: 18px; } }

.meta { grid-area: meta; min-width: 0; }
.meta h3 { font-family: var(--display); font-weight: 600; font-size: 17px; }
.meta .id { color: var(--dim); font-size: 11px; }

.rate { grid-area: rate; display: flex; gap: 4px; }
.rate .block {
  width: 18px; height: 18px; cursor: pointer;
  background: transparent; border: 1px solid var(--dim); padding: 0;
}
.rate .block:hover { border-color: var(--acid); }
.rate .block.on { background: var(--acid); border-color: var(--acid); }

.notes {
  grid-area: notes;
  background: var(--bg); color: var(--ink);
  border: 1px solid var(--line); font-family: var(--mono); font-size: 12px;
  padding: 8px; min-height: 56px; resize: vertical;
  transition: border-color 0.3s ease;
}
.notes:focus { outline: none; border-color: var(--dim); }
.notes.saved { border-color: var(--acid); }

.code { grid-area: code; font-size: 12px; }
.code summary { color: var(--dim); cursor: pointer; user-select: none; }
.code summary:hover { color: var(--acid); }
.code pre {
  margin-top: 6px; padding: 10px; overflow-x: auto;
  background: var(--bg); border-left: 2px solid var(--acid);
  color: #b9c49a; white-space: pre-wrap;
}

/* transport */
#transport {
  position: fixed; inset: auto 0 0 0; z-index: 10;
  display: flex; align-items: center; gap: 20px;
  padding: 12px 28px;
  background: var(--bg); border-top: 1px solid var(--line);
}
.status { color: var(--dim); font-size: 12px; }
.status.ready { color: var(--acid); }
#now-playing {
  flex: 1; color: var(--hot); font-size: 12px; letter-spacing: 0.06em;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
}
#stop {
  background: var(--hot); color: var(--bg); border: 0;
  font-family: var(--display); font-weight: 700; font-size: 14px;
  padding: 8px 22px; cursor: pointer;
}
#stop:disabled { background: var(--line); color: var(--dim); cursor: default; }

.empty { padding: 48px 28px; color: var(--dim); }
.empty code { color: var(--acid); }

@media (max-width: 760px) {
  .track { grid-template-columns: 56px 1fr; grid-template-areas: 'play meta' 'play rate' 'code code' 'notes notes'; }
}
```

- [ ] **Step 4: Verify the app serves and talks to the API**

Run: `npm run dev` in the background, then:
- `curl -s localhost:3001/api/tracks | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const t=JSON.parse(d);console.log(t.length,'tracks',t[0]?.id)})"` → expect `2 tracks 2026-06-03-seed-01`.
- `curl -s localhost:5173 | grep -o 'STRUDEL/CRATE'` → expect `STRUDEL/CRATE`.
- `curl -s localhost:5173/src/main.js | head -c 200` → expect transformed JS (no 500 error).

Expected: all three checks pass. Vite import of `../shared/sample-banks.json` works out of the box (Vite supports JSON imports).

- [ ] **Step 5: Manual browser verification (requires the user — audio cannot be verified headlessly)**

Stop here and ask the user to open `http://localhost:5173`, click ▶ on "Boiler Primer", and confirm: (a) audio plays after samples finish loading (status shows "● samples loaded"; first load fetches ~100MB of samples from CDNs, so it can take a minute), (b) clicking rating blocks persists after reload, (c) notes save (green border flash). Fix anything broken before continuing.

- [ ] **Step 6: Verify a rating landed on disk**

Run: `cat data/ratings/*.json`
Expected: at least one rating file with the values set in the browser.

- [ ] **Step 7: Commit**

```bash
git add index.html src/ && git commit -m "feat: crate webapp — listen, rate, annotate tracks"
```

---

### Task 9: STRUDEL_GUIDE.md (the generation agents' bible)

**Files:**
- Create: `STRUDEL_GUIDE.md`

- [ ] **Step 1: Write `STRUDEL_GUIDE.md`** with exactly this content:

````markdown
# Strudel Track Writing Guide

You are writing one track as a JSON file in `tracks/`. Follow this guide exactly —
the validator (`node scripts/validate.mjs tracks/<id>.json`) enforces most of it.

## Track file format

`tracks/<id>.json` — ALL fields required:

```json
{
  "id": "<batch>-<NN>",
  "title": "Short Evocative Name",
  "prompt": "<the user's style prompt, verbatim>",
  "batch": "<batch id you were given>",
  "code": "<strudel code as a single JSON string, \\n for newlines>",
  "createdAt": "<ISO timestamp, e.g. from `date -u +%Y-%m-%dT%H:%M:%SZ`>"
}
```

## Code rules (hard requirements)

1. **Shape:** optional `setcpm(<bpm>/4)` on the first line, then ONE `stack(...)`
   expression. Nothing else. No `$:` labels, no variable assignments, no `samples()`,
   no `await`, no visual functions (`.pianoroll()`, `.scope()`, `.punchcard()`, …).
2. **Double quotes** for all pattern strings (they become mini-notation). Never single quotes.
3. **Sounds:** only names listed in `scripts/sounds.json`. The validator rejects anything else.
4. **Tempo:** `setcpm(130/4)` = 130 BPM with 4 beats per cycle. Without it, tempo is 0.5 cps (~120bpm/4).
5. Keep per-layer `.gain()` between 0.3 and 1.2.

## Sound palette

- **Synths** (use with `note(...)` or `n(...).scale(...)`): `sine`, `square`, `triangle`,
  `sawtooth`, `supersaw`; noise: `white`, `pink`, `brown`.
- **Drums** (use with `s(...)` + `.bank(...)`): `bd` kick, `sd` snare, `hh` closed hat,
  `oh` open hat, `cp` clap, `rim` rimshot, `lt mt ht` toms, `cr` crash, `rd` ride.
  Banks (pick ONE per track for coherence): `RolandTR808`, `RolandTR909`, `RolandTR707`,
  `RolandTR606`, `LinnDrum`, `AkaiLinn`, `OberheimDMX`, `CasioRZ1`.
  Verify combos exist: the validator checks `<Bank>_<sound>` against `scripts/sounds.json`.
- **Sampled instruments:** `piano` (velvety felt piano). Classic dirt-samples without a
  bank: `casio`, `jvbass`, `arpy`, `space`, `numbers`, `insect`, `wind`, `crow`, `metal`,
  `jazz`, `east` — check `scripts/sounds.json` when in doubt; many have multiple variants
  selectable with `.n(2)`.
- **Do NOT use** `gm_*` soundfonts (not loaded by the webapp).

## Mini-notation cheatsheet

| Syntax | Meaning |
|---|---|
| `"bd sd hh sd"` | sequence within one cycle |
| `~` | rest |
| `[bd bd] sd` | subdivide a step |
| `<c2 eb2 g1>` | alternate per cycle (slowcat) — great for chord progressions |
| `bd*4` | repeat 4× within the step |
| `bd(3,8)` | euclidean rhythm: 3 hits over 8 slots |
| `[c3,e3,g3]` | chord / parallel |
| `hh?` or `hh?0.3` | random drop (degrade) |
| `c3@3 e3` | elongate (weight 3:1) |

## Melody & harmony

Prefer scale degrees over raw notes — they always sound in key:

```
n("0 2 4 <7 9>").scale("C3:minor").s("sawtooth")
```

Good scales: `:minor`, `:major`, `:dorian`, `:mixolydian`, `:minor:pentatonic`,
`:phrygian`. Chords: `note("<[c3,eb3,g3] [ab2,c3,eb3]>")`. Octave shift: `.add(note(12))`
or pick the register in the scale root (`"C2:minor"`).

## Shaping sound (chainable controls)

- Filter: `.lpf(800)` low-pass, `.hpf(200)` high-pass, `.resonance(10)`; sweep with an
  LFO: `.lpf(sine.slow(8).range(200, 2000))`
- Envelope: `.attack(0.01).decay(0.15).sustain(0).release(0.1)` (percussive pluck)
- Space: `.room(0.4)` reverb, `.delay(0.3)` (or `.delay(".5:.125:.7")` wet:time:feedback)
- Dirt: `.crush(6)` bitcrush, `.shape(0.4)` distortion, `.coarse(4)` downsample
- Stereo: `.pan(0.2)` or `.pan(sine.range(0.2, 0.8))`
- Sample tweaks: `.speed(2)` pitch/rate, `.n(3)` sample variant, `.cut(1)` choke group (hats!)
- Vowel filter: `.vowel("<a e o>")`

## Movement & structure (what makes it a TRACK, not a loop)

Layer 3–6 elements in the `stack`. Give the track an arc with per-cycle alternation
and conditional transforms:

- `<...>` progressions: `note("<c2 c2 f1 g1>")` = 4-bar bassline
- `.every(4, x => x.rev())` — vary every 4th cycle
- `.sometimesBy(0.25, x => x.speed(2))` — sprinkle variation
- `.off(0.125, x => x.add(note(12)).gain(0.6))` — echo a transposed copy
- `.mask("<1 1 1 0>")` — drop a layer out every 4th cycle (builds tension)
- `.degradeBy(0.2)` — humanize hats
- `.jux(rev)` — stereo-split a reversed copy
- `.ply("<1 1 2 4>")` — ratchet builds
- LFOs everywhere: `sine`, `saw`, `tri`, `square`, `rand`, `perlin` + `.range(a,b).slow(n)`

Aim for an 8+ cycle arc: something should evolve across cycles (filter sweep,
mask pattern, alternating bassline), not just repeat.

## Complete examples (these validate)

Driving acid techno:

```
setcpm(130/4)
stack(
  s("bd*4").bank("RolandTR909").gain(1.1),
  s("[~ hh]*4").bank("RolandTR909").gain(0.7).pan(sine.range(0.3, 0.7)),
  s("~ cp ~ cp").bank("RolandTR909").room(0.3),
  note("<c2 c2 eb2 g1>*8").s("sawtooth").lpf(sine.slow(4).range(200, 1800)).resonance(12).decay(0.12).sustain(0).gain(0.8)
)
```

Melancholy piano sketch:

```
setcpm(72/4)
stack(
  note("<[c3,eb3,g3] [ab2,c3,eb3] [bb2,d3,f3] [g2,bb2,d3]>").s("piano").room(0.6).gain(0.9),
  n("0 ~ [4 2] ~ 7 ~ [3 2] ~").scale("C4:minor").s("piano").slow(2).gain(0.7).delay(0.3),
  s("~ ~ rim ~").bank("RolandTR707").gain(0.4)
)
```

## Common validator failures

- `unknown sounds: X` → X isn't in `scripts/sounds.json`; grep it for alternatives.
- `evaluation failed: ...` → usually unbalanced `[ ] < > ( )` in mini-notation, or a
  typo'd function name.
- `did not evaluate to a Pattern` → code doesn't end with the `stack(...)` expression.
- `no events` → everything is `~`/`silence`, or a `mask` pattern that is all `0`.
````

- [ ] **Step 2: Verify the guide's examples actually validate**

Run both code blocks through the CLI (they are the seed tracks, so):
`node scripts/validate.mjs tracks/2026-06-03-seed-01.json tracks/2026-06-03-seed-02.json`
Expected: PASS, PASS. (If Task 5 substituted any sounds, mirror the substitution in the guide examples so the guide never shows code that fails.)

- [ ] **Step 3: Commit**

```bash
git add STRUDEL_GUIDE.md && git commit -m "docs: strudel track writing guide for generation agents"
```

---

### Task 10: Feedback digest

**Files:**
- Create: `scripts/feedback.mjs`
- Test: `test/feedback.test.mjs`

- [ ] **Step 1: Write the failing tests**

`test/feedback.test.mjs`:
```js
import { describe, it, expect } from 'vitest';
import { buildDigest } from '../scripts/feedback.mjs';

const track = (id, rating, notes, code = `code-${id}`) => ({
  id, title: `Title ${id}`, prompt: 'p', batch: 'b', code,
  createdAt: 'x', rating, notes,
});

describe('buildDigest', () => {
  it('says so when nothing is rated', () => {
    const digest = buildDigest([track('a', null, '')]);
    expect(digest).toMatch(/no ratings yet/i);
  });

  it('includes code of top-rated tracks and notes of low-rated ones', () => {
    const digest = buildDigest([
      track('hi', 5, 'love the bass', 'TOP_CODE'),
      track('lo', 1, 'too harsh', 'LOW_CODE'),
      track('mid', null, ''),
    ]);
    expect(digest).toContain('TOP_CODE');
    expect(digest).toContain('love the bass');
    expect(digest).toContain('too harsh');
    expect(digest).not.toContain('LOW_CODE');
    expect(digest).toMatch(/1 unrated/);
  });

  it('caps top tracks at 5', () => {
    const tracks = Array.from({ length: 8 }, (_, i) => track(`t${i}`, 5, '', `CODE${i}`));
    const digest = buildDigest(tracks);
    expect((digest.match(/CODE\d/g) ?? []).length).toBe(5);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/feedback.test.mjs`
Expected: FAIL — module missing.

- [ ] **Step 3: Write `scripts/feedback.mjs`**

```js
// Digest of listener ratings/notes, consumed by /generate-tracks agents.
import { createStore } from '../server/store.mjs';

export function buildDigest(tracks) {
  const rated = tracks.filter((t) => t.rating != null);
  if (rated.length === 0) {
    return 'No ratings yet — no listener feedback to apply.';
  }
  const lines = [`# Listener feedback (${rated.length} rated / ${tracks.length} total, ${tracks.length - rated.length} unrated)`];

  const top = rated.filter((t) => t.rating >= 4).sort((a, b) => b.rating - a.rating).slice(0, 5);
  if (top.length) {
    lines.push('', '## Top rated — emulate what works here');
    for (const t of top) {
      lines.push('', `### ${'★'.repeat(t.rating)} "${t.title}" (${t.id})`);
      if (t.notes) lines.push(`notes: ${t.notes}`);
      lines.push('```', t.code, '```');
    }
  }

  const low = rated.filter((t) => t.rating <= 2).slice(0, 10);
  if (low.length) {
    lines.push('', '## Low rated — avoid these mistakes');
    for (const t of low) {
      lines.push(`- ${'★'.repeat(t.rating)} "${t.title}": ${t.notes || '(no notes)'}`);
    }
  }
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const store = createStore({ tracksDir: 'tracks', ratingsDir: 'data/ratings' });
  console.log(buildDigest(await store.listTracks()));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/feedback.test.mjs`
Expected: 3 passed.

- [ ] **Step 5: Verify the CLI against real data**

Run: `npm run feedback`
Expected: either `No ratings yet...` or a digest including the rating saved during Task 8 Step 5/6.

- [ ] **Step 6: Commit**

```bash
git add scripts/feedback.mjs test/feedback.test.mjs && git commit -m "feat: listener feedback digest for the generation loop"
```

---

### Task 11: /generate-tracks skill

**Files:**
- Create: `.claude/skills/generate-tracks/SKILL.md`

- [ ] **Step 1: Write `.claude/skills/generate-tracks/SKILL.md`** with exactly this content:

````markdown
---
name: generate-tracks
description: Generate a batch of validated Strudel tracks in parallel from a style prompt. Use when the user asks to generate tracks, songs, beats, or music. Args: "<style prompt>" [count]
---

# Generate Strudel Tracks

Generate `count` (default 12, max 30) Strudel tracks matching the style prompt, in
parallel, each validated before it counts.

## Workflow

1. **Read `STRUDEL_GUIDE.md`** in full (Read tool). You will paste its path into every
   agent prompt; agents must read it themselves too.

2. **Collect feedback:** run `node scripts/feedback.mjs`. Capture the output — it is
   injected into every agent prompt. If it says "No ratings yet", inject the literal
   text "none yet".

3. **Compute the batch id:** `YYYY-MM-DD-<slug>` where slug = the prompt lowercased,
   non-alphanumerics → `-`, trimmed to ≤ 40 chars (e.g. `2026-06-03-dark-hypnotic-techno`).
   If `ls tracks/ | grep <batch>` shows the batch already exists, append `-b2`, `-b3`, ….
   Track ids are `<batch>-01` … `<batch>-NN`. Get the timestamp with
   `date -u +%Y-%m-%dT%H:%M:%SZ`.

4. **Assign each track a variation directive** so the batch is diverse, by combining
   axes (vary at least two axes between any two tracks):
   - energy: sparse/minimal · mid groove · dense/driving
   - register focus: bass-led · chord-led · melody-led · percussion-led
   - palette: one drum-machine bank + one synth · piano-centric · sampled/dirt textures
   - tempo: pick within whatever range fits the style prompt
   - mood modifier: e.g. darker, dreamier, rawer, funkier (fit to prompt)

5. **Fan out agents:** dispatch ALL agents for a wave in a SINGLE message (parallel
   tool calls), waves of at most 8. Each agent gets this prompt, placeholders filled:

   ```
   You are writing exactly one Strudel track file. Work in <repo root>.

   1. Read STRUDEL_GUIDE.md COMPLETELY and follow every rule in it.
   2. Style brief: "{prompt}". Your variation directive: {directive}.
      Listener feedback to honor (emulate the top-rated, avoid low-rated mistakes):
      {digest}
   3. Write tracks/{id}.json with all required fields:
      id "{id}", batch "{batch}", prompt (the style brief verbatim),
      title (short, evocative, unique), createdAt "{timestamp}",
      code (your Strudel code — follow the guide's shape rules).
   4. Run: node scripts/validate.mjs tracks/{id}.json
      If FAIL: read the error, fix the code (for unknown sounds, grep
      scripts/sounds.json for valid names), re-run. Up to 3 attempts total.
      If still failing after 3 attempts: delete the file (rm tracks/{id}.json).
   5. Reply with EXACTLY one line:
      OK {id} "<title>"   — or —   FAILED {id} <one-line reason>
   ```

6. **Report:** after all waves, output a table (id · title · status), the count of
   valid tracks written, any failures with reasons. Remind the user:
   `npm run dev` → http://localhost:5173 to listen and rate.

## Notes

- Validation is the contract: a track only exists if `validate.mjs` passes it.
- Never edit `scripts/sounds.json` to make a track pass — change the track.
- If the user gives a count > 30, cap at 30 and say so.
````

- [ ] **Step 2: Verify skill discovery**

Run: `ls .claude/skills/generate-tracks/SKILL.md` → file exists. Frontmatter `name` matches directory name. (Skill becomes invocable as `/generate-tracks` in new sessions in this project.)

- [ ] **Step 3: Commit**

```bash
git add .claude/ && git commit -m "feat: /generate-tracks skill — parallel validated track generation"
```

---

### Task 12: README + end-to-end smoke test

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write `README.md`**

```markdown
# strudel-ai

Generate [Strudel](https://strudel.cc) tracks with Claude Code, in parallel; listen,
rate, and annotate them in a local webapp; ratings feed back into the next batch.

## Use

1. In a Claude Code session in this repo: `/generate-tracks "dark hypnotic techno" 12`
2. `npm run dev` → open http://localhost:5173 (first load fetches sample banks — give it a minute)
3. Play tracks, rate 1–5, leave notes on what to change.
4. Generate the next batch — agents read your ratings/notes and steer toward what you liked.

## Commands

- `npm run dev` — API (:3001) + webapp (:5173)
- `npm test` — unit tests
- `node scripts/validate.mjs tracks/<id>.json` — validate a track headlessly
- `npm run feedback` — print the ratings digest agents see
- `npm run build-sounds` — regenerate the sound allowlist (only needed if `shared/sample-banks.json` changes)

## How a track is "valid"

`scripts/validate.mjs` runs the code through Strudel's own transpiler/evaluator in
Node, requires it to produce events over 8 cycles, and checks every referenced sound
against `scripts/sounds.json` — which is generated from the exact sample banks the
webapp loads. If it validates, the webapp can play it.
```

- [ ] **Step 2: End-to-end smoke — generate a real mini-batch**

Following `.claude/skills/generate-tracks/SKILL.md` exactly (the executor performs the skill workflow itself), generate a batch with prompt `"warm lofi house"` and count 3: read the guide, run the feedback digest, compute the batch id, dispatch 3 parallel agents, collect results.

Expected: 3 `OK` lines, 3 new files in `tracks/`, and `node scripts/validate.mjs tracks/<batch>-0*.json` → 3 × PASS.

- [ ] **Step 3: Verify the new batch appears in the webapp API**

Run: `node server/index.mjs & sleep 1 && curl -s localhost:3001/api/tracks | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).map(t=>t.id).join('\n')))"; kill %1`
Expected: 5 ids (2 seeds + 3 lofi house).

- [ ] **Step 4: Run the full test suite one last time**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "docs: README + first generated batch (e2e smoke)"
```

- [ ] **Step 6: Hand back to the user**

Tell the user: open http://localhost:5173 after `npm run dev`, listen to the smoke batch, rate a few tracks, then try `/generate-tracks "<their style>" 12` in a fresh session and confirm the feedback digest reflects their ratings.

---

## Risks & contingencies

- **Strudel API drift:** versions are pinned (core/mini/tonal/transpiler 1.2.6, web/webaudio 1.3.0). If `evalScope(mini-module)` doesn't expose `mini`/`m`, import them from `@strudel/mini/mini.mjs` directly (strudel's own test runtime does this).
- **Bank key format:** if `RolandTR909_bd` isn't a key in the generated `sounds.json` (Task 3 Step 5 spot-check), inspect the actual manifest keys and align `checkSounds`'s bank resolution — allowlist and resolver must agree.
- **Sample CDN availability:** `build-sounds` and the webapp prebake both need network. If `strudel.b-cdn.net` is unreachable, drop that bank from `shared/sample-banks.json` and re-run `npm run build-sounds` (validator and webapp stay in sync by construction).
- **Audio verification:** only the user can confirm sound. Task 8 Step 5 is a deliberate manual checkpoint — do not claim playback works without it.
