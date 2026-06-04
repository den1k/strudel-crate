# STRUDEL/STEMS — Sound-Design Stem Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/stems` route to the strudel-ai webapp where prompt-driven batches of 30 sound-design stems (each ONE star sound, an evolving loop with a 15–60s morph arc) are generated, played, rated, and fed back — exactly like tracks in the crate, with nav between the two.

**Architecture:** Stems reuse the entire existing pipeline by parameterization, not duplication: a second `createStore` instance (`stems/` + `data/stem-ratings/`), the same Express handlers mounted at `/api/stems`, the existing `validate.mjs` unchanged (stem files have the same schema), and the webapp's `main.js` extracted into a shared `initApp({apiBase, emptyHint})` consumed by two MPA pages (`index.html`, `stems.html`). Generation is a new `/generate-stems` skill driven by a new `STEMS_GUIDE.md` focused on sound design instead of arrangement.

**Tech Stack:** Vanilla JS + Vite (MPA mode), Express, @strudel/* 1.2–1.3, vitest + supertest, Claude Code skill for generation.

**Design decisions (confirmed with user):**
- A stem = ONE focused sound ("one star sound") — at most one subtle support layer. Not a mini-groove.
- A stem loops forever but has a built-in morph arc over 8–32 cycles (~15–60s per pass) — filter journeys, `<...>/N` progressions, slow LFOs.
- Same card UI as crate: play, meta chips, 1–5 rating, notes + lesson feedback, code editor.
- Default batch size 30 (max 30).

**Pre-verified (2026-06-04, against this repo's `validate.mjs` + sounds.json):** all sound-design controls used in `STEMS_GUIDE.md` below — `fm/fmh`, `penv/pattack/pdecay`, `lpenv/lpattack/lpdecay/ftype("ladder")`, `vib/vibmod`, `vowel`, `bpf`, `phaser/phaserdepth`, `tremolosync/tremolodepth`, `noise`, `coarse/crush/shape/distort/squiz`, `chop/striate`, `accelerate/detune`, `orbit/postgain`, `delay("w:t:f")` — and both complete example stems PASS validation verbatim. Do not "fix" them.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `server/app.mjs` | Modify | `createApp({tracks, stems})` — same route handlers mounted per collection |
| `server/index.mjs` | Modify | Instantiate the second store (`stems/`, `data/stem-ratings/`) |
| `test/api.test.mjs` | Modify | New `createApp` signature + stems endpoint tests |
| `scripts/feedback.mjs` | Modify | CLI arg `stems` → digest of stem ratings |
| `src/app.js` | Create | The whole page app (extracted from `main.js`), parameterized by `apiBase` + `emptyHint` |
| `src/main.js` | Modify | Thin wrapper: `initApp` for `/api/tracks` |
| `src/stems.js` | Create | Thin wrapper: `initApp` for `/api/stems` |
| `index.html` | Modify | Add crate/stems nav |
| `stems.html` | Create | Second MPA page (STRUDEL/STEMS) |
| `src/style.css` | Modify | Nav styles |
| `vite.config.js` | Modify | MPA build inputs + `/stems` clean-URL rewrite + configurable API proxy |
| `stems/.gitkeep` | Create | Stem JSON files live here (mirrors `tracks/`) |
| `STEMS_GUIDE.md` | Create | Sound-design guide for stem-writing agents |
| `.claude/skills/generate-stems/SKILL.md` | Create | The `/generate-stems` skill |
| `README.md` | Modify | Document the stems flow |

No changes needed: `scripts/validate.mjs` (stem files use the identical schema — `validateTrack` works on them as-is), `src/editor.js`, `src/playing-state.js`, `server/store.mjs` (already a parameterized factory).

---

### Task 1: Server — stems collection API

**Files:**
- Modify: `server/app.mjs`
- Modify: `server/index.mjs`
- Modify: `test/api.test.mjs`
- Create: `stems/.gitkeep`

- [ ] **Step 1: Write the failing tests**

Replace the `beforeEach` block in `test/api.test.mjs` (lines 9–15) with the two-collection setup, and append the stems describe block at the end of the file:

```js
let app, tracksDir, stemsDir;
beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'strudel-api-'));
  tracksDir = join(base, 'tracks');
  stemsDir = join(base, 'stems');
  await mkdir(tracksDir, { recursive: true });
  await mkdir(stemsDir, { recursive: true });
  app = createApp({
    tracks: createStore({ tracksDir, ratingsDir: join(base, 'ratings') }),
    stems: createStore({ tracksDir: stemsDir, ratingsDir: join(base, 'stem-ratings') }),
  });
});
```

Append at the end of the file:

```js
describe('stems API', () => {
  const item = (id) => JSON.stringify({
    id, title: 'S', prompt: 'p', batch: 'b', code: 's("bd")', createdAt: 'x',
  });

  it('GET /api/stems lists stems without bleeding into tracks', async () => {
    await writeFile(join(stemsDir, 's.json'), item('s'));
    const stems = await request(app).get('/api/stems');
    expect(stems.status).toBe(200);
    expect(stems.body).toHaveLength(1);
    expect(stems.body[0]).toMatchObject({ id: 's', rating: null });
    const tracks = await request(app).get('/api/tracks');
    expect(tracks.body).toHaveLength(0);
  });

  it('keeps stem ratings separate from track ratings for the same id', async () => {
    await writeFile(join(tracksDir, 'x.json'), item('x'));
    await writeFile(join(stemsDir, 'x.json'), item('x'));
    await request(app).put('/api/tracks/x/rating').send({ rating: 2 });
    await request(app).put('/api/stems/x/rating').send({ rating: 5, notes: 'gnarly' });
    const tracks = await request(app).get('/api/tracks');
    const stems = await request(app).get('/api/stems');
    expect(tracks.body[0].rating).toBe(2);
    expect(stems.body[0]).toMatchObject({ rating: 5, notes: 'gnarly' });
  });

  it('rejects out-of-range stem ratings', async () => {
    const res = await request(app).put('/api/stems/x/rating').send({ rating: 0 });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/api.test.mjs`
Expected: FAIL — every test errors (the new `createApp({tracks, stems})` object isn't a store; `store.listTracks is not a function` or similar).

- [ ] **Step 3: Implement the collection-parameterized app**

Replace the **entire contents** of `server/app.mjs` with:

```js
import express from 'express';

const ID_RE = /^[A-Za-z0-9_-]+$/; // rating files are written as <id>.json — no path chars

// Express 4 doesn't catch async handler rejections — route them to the error handler.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// One set of list + rating routes per collection (tracks, stems) at /api/<name>.
function collectionRoutes(app, name, store) {
  app.get(`/api/${name}`, wrap(async (_req, res) => {
    res.json(await store.listTracks());
  }));

  app.put(`/api/${name}/:id/rating`, wrap(async (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'invalid id' });
    const { rating, notes, lesson } = req.body ?? {};
    if (rating != null && !(Number.isInteger(rating) && rating >= 1 && rating <= 5)) {
      return res.status(400).json({ error: 'rating must be an integer 1-5' });
    }
    if (notes != null && typeof notes !== 'string') {
      return res.status(400).json({ error: 'notes must be a string' });
    }
    if (lesson != null && typeof lesson !== 'string') {
      return res.status(400).json({ error: 'lesson must be a string' });
    }
    res.json(await store.saveRating(id, { rating, notes, lesson }));
  }));
}

export function createApp(stores) {
  const app = express();
  app.use(express.json());
  for (const [name, store] of Object.entries(stores)) collectionRoutes(app, name, store);

  // JSON error responses (body-parser 400s and async store failures land here).
  app.use((err, _req, res, _next) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });

  return app;
}
```

Replace the **entire contents** of `server/index.mjs` with:

```js
import { createApp } from './app.mjs';
import { createStore } from './store.mjs';

const app = createApp({
  tracks: createStore({ tracksDir: 'tracks', ratingsDir: 'data/ratings' }),
  stems: createStore({ tracksDir: 'stems', ratingsDir: 'data/stem-ratings' }),
});
const port = process.env.PORT ?? 3001;
app.listen(port, () => console.log(`strudel-ai api listening on http://localhost:${port}`));
```

Create the stems directory marker:

```bash
mkdir -p stems && touch stems/.gitkeep
```

- [ ] **Step 4: Run the full test suite**

Run: `npx vitest run`
Expected: ALL PASS (the pre-existing api tests now go through the `tracks` collection; store/feedback/validate/playing-state tests untouched).

- [ ] **Step 5: Commit**

```bash
git add server/app.mjs server/index.mjs test/api.test.mjs stems/.gitkeep
git commit -m "feat: serve a stems collection at /api/stems alongside tracks"
```

---

### Task 2: Feedback digest for stems

**Files:**
- Modify: `scripts/feedback.mjs:36-39` (the CLI block only — `buildDigest` is shared and stays untouched)

- [ ] **Step 1: Update the CLI block**

Replace the CLI block at the bottom of `scripts/feedback.mjs`:

```js
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const store = process.argv[2] === 'stems'
    ? createStore({ tracksDir: 'stems', ratingsDir: 'data/stem-ratings' })
    : createStore({ tracksDir: 'tracks', ratingsDir: 'data/ratings' });
  console.log(buildDigest(await store.listTracks()));
}
```

- [ ] **Step 2: Verify both modes by hand**

Run: `node scripts/feedback.mjs stems`
Expected: `No ratings yet — no listener feedback to apply.` (stems dir is empty)

Run: `node scripts/feedback.mjs`
Expected: the existing track digest (ratings exist in `data/ratings/`), unchanged from before.

Run: `npx vitest run test/feedback.test.mjs`
Expected: PASS (`buildDigest` untouched).

- [ ] **Step 3: Commit**

```bash
git add scripts/feedback.mjs
git commit -m "feat: feedback digest for stems via 'node scripts/feedback.mjs stems'"
```

---

### Task 3: Extract the page app into `src/app.js`

This is a mechanical extraction — `src/main.js` (317 lines) becomes `src/app.js` almost verbatim. The webapp has no unit tests for this layer; verification is the test suite (unaffected), a production build, and the browser smoke in Task 7.

**Files:**
- Create: `src/app.js`
- Modify: `src/main.js` (replace entirely)

- [ ] **Step 1: Create `src/app.js` from the current `src/main.js`**

Copy the **entire current contents** of `src/main.js` into `src/app.js`, then make exactly these changes:

1. Wrap everything below the imports in an exported async function — the imports stay at module top, all code from `const state = …` down to the final `catch` block moves inside:

```js
// ── before (main.js, module top level) ──
const state = { tracks: [], playingId: null, samplesReady: false, batch: 'all', filter: 'all' };

// ── after (app.js) ──
export async function initApp({ apiBase, emptyHint }) {
  const state = { tracks: [], playingId: null, samplesReady: false, batch: 'all', filter: 'all' };
  // … every other line of the old main.js body, unchanged except the edits below …
}
```

(`const $ = …` may stay at module level or move inside — keep it at module level to match the original layout. Everything else, including the `initAudioOnFirstClick()` call, the `ready` promise, `codeSections`, and the boot/event-listener section, moves inside `initApp`. The old file's top-level `await fetch(…)` needs no special treatment — `initApp` is async.)

2. In `putRating` — parameterize the endpoint:

```js
// before
const res = await fetch(`/api/tracks/${track.id}/rating`, {
// after
const res = await fetch(`${apiBase}/${track.id}/rating`, {
```

3. In `renderTracks` — parameterize the empty-state hint:

```js
// before
main.innerHTML = '<p class="empty">nothing here — generate some tracks: <code>/generate-tracks "dark techno" 12</code></p>';
// after
main.innerHTML = `<p class="empty">nothing here — ${emptyHint}</p>`;
```

4. In the boot section — parameterize the list endpoint:

```js
// before
const res = await fetch('/api/tracks');
// after
const res = await fetch(apiBase);
```

No other line changes. Comments, accordion logic, solo-mode playback, rating blocks, autosave areas, batch grouping, transport — all identical.

- [ ] **Step 2: Replace `src/main.js` with a thin wrapper**

Replace the **entire contents** of `src/main.js` with:

```js
import { initApp } from './app.js';

initApp({
  apiBase: '/api/tracks',
  emptyHint: 'generate some tracks: <code>/generate-tracks "dark techno" 12</code>',
});
```

- [ ] **Step 3: Verify nothing broke**

Run: `npx vitest run`
Expected: ALL PASS.

Run: `npm run build`
Expected: build succeeds, no import errors.

- [ ] **Step 4: Commit**

```bash
git add src/app.js src/main.js
git commit -m "refactor: extract page app from main.js into initApp({apiBase, emptyHint})"
```

---

### Task 4: Stems page, nav, and routing

**Files:**
- Create: `stems.html`
- Create: `src/stems.js`
- Modify: `index.html:13-23` (masthead)
- Modify: `src/style.css` (nav styles, after the `.masthead h1 span` rule at line 39)
- Modify: `vite.config.js` (replace entirely)

- [ ] **Step 1: Add the nav to `index.html`**

In `index.html`, directly after the `<h1>` line inside `<header class="masthead">`, insert:

```html
    <nav class="nav" aria-label="sections">
      <a href="/" class="on">crate</a>
      <a href="/stems">stems</a>
    </nav>
```

- [ ] **Step 2: Create `stems.html`**

Full contents (mirror of `index.html` with STEMS branding, the nav's `on` state flipped, and the stems entry script):

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>STRUDEL/STEMS</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,300..800&family=IBM+Plex+Mono:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/src/style.css" />
</head>
<body>
  <header class="masthead">
    <h1>STRUDEL<span>/</span>STEMS</h1>
    <nav class="nav" aria-label="sections">
      <a href="/">crate</a>
      <a href="/stems" class="on">stems</a>
    </nav>
    <div class="filters">
      <select id="batch-filter" aria-label="filter by batch"><option value="all">all batches</option></select>
      <div class="seg" role="group" aria-label="rating filter">
        <button data-filter="all" class="on">all</button>
        <button data-filter="unrated">unrated</button>
        <button data-filter="top">★4+</button>
      </div>
    </div>
  </header>
  <main id="tracks"><p class="empty">loading stems…</p></main>
  <footer id="transport">
    <span id="status" class="status">warming up samples…</span>
    <span id="now-playing"></span>
    <button id="stop" disabled>■ STOP</button>
  </footer>
  <script type="module" src="/src/stems.js"></script>
</body>
</html>
```

- [ ] **Step 3: Create `src/stems.js`**

Full contents:

```js
import { initApp } from './app.js';

initApp({
  apiBase: '/api/stems',
  emptyHint: 'conjure some stems: <code>/generate-stems "alien sound" 30</code>',
});
```

- [ ] **Step 4: Add nav styles to `src/style.css`**

Insert after the `.masthead h1 span { color: var(--acid); }` rule (line 39):

```css
.nav { display: flex; }
.nav a {
  color: var(--dim); text-decoration: none; font-size: 12px;
  border: 1px solid var(--line); padding: 6px 14px;
}
.nav a + a { border-left: 0; }
.nav a:hover { color: var(--acid); }
.nav a.on { background: var(--acid); color: var(--bg); font-weight: 600; border-color: var(--acid); }
```

- [ ] **Step 5: Vite — MPA inputs, `/stems` clean URL, configurable API proxy**

Replace the **entire contents** of `vite.config.js` with:

```js
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

const page = (p) => fileURLToPath(new URL(p, import.meta.url));

// /stems is a second MPA page (stems.html); rewrite the clean URL before the
// SPA fallback would serve index.html for it.
const rewriteStems = (server) => {
  server.middlewares.use((req, _res, next) => {
    if (req.url === '/stems' || req.url?.startsWith('/stems?')) req.url = '/stems.html';
    next();
  });
};

export default defineConfig({
  plugins: [
    wasm(),
    topLevelAwait(),
    { name: 'stems-route', configureServer: rewriteStems, configurePreviewServer: rewriteStems },
  ],
  build: {
    target: 'esnext',
    rollupOptions: { input: { main: page('./index.html'), stems: page('./stems.html') } },
  },
  optimizeDeps: { esbuildOptions: { target: 'esnext' } },
  // API_PROXY lets verification scripts point an isolated vite at an isolated API
  server: { proxy: { '/api': process.env.API_PROXY ?? 'http://localhost:3001' } },
});
```

- [ ] **Step 6: Verify build + tests**

Run: `npm run build`
Expected: succeeds; `dist/` contains both `index.html` and `stems.html`.

Run: `npx vitest run`
Expected: ALL PASS.

(Full in-browser verification happens in Task 7 with an isolated server pair.)

- [ ] **Step 7: Commit**

```bash
git add index.html stems.html src/stems.js src/style.css vite.config.js
git commit -m "feat: /stems page with crate<->stems nav (vite MPA)"
```

---

### Task 5: `STEMS_GUIDE.md`

**Files:**
- Create: `STEMS_GUIDE.md`

Both complete examples below were already validated against this repo's `validate.mjs` on 2026-06-04 — they PASS. If validation fails during this task, something else regressed; do not edit the examples to "fix" it.

- [ ] **Step 1: Create `STEMS_GUIDE.md`**

Full contents:

````markdown
# Strudel Stem Writing Guide

You are writing one STEM as a JSON file in `stems/`. A stem is NOT a track: it is
ONE designed sound — a single star voice with deep sound design — that loops
forever with a built-in morph arc. Think "bass morph", "alien formant", "screaming
riser": something a producer would drop into their own track. Follow this guide
exactly — the validator (`node scripts/validate.mjs stems/<id>.json`) enforces
most of it.

## Stem file format

`stems/<id>.json` — ALL fields required (same schema as tracks):

```json
{
  "id": "<batch>-<NN>",
  "title": "Short Evocative Name",
  "prompt": "<the user's sound prompt, verbatim>",
  "batch": "<batch id you were given>",
  "description": "<1-3 sentences: what the sound is and how it morphs over the loop>",
  "meta": {
    "bpm": <integer matching your setcpm>,
    "genre": "<sound family, e.g. 'fm bass', 'formant lead', 'noise riser'>",
    "mood": "<e.g. menacing, liquid, hollow>",
    "key": "<musical key if pitched, e.g. 'C minor'; 'atonal' if not>",
    "instruments": ["<the star sound, listener-facing, e.g. 'fm sine bass'>"],
    "energy": <1-5: 1 = airy/ambient texture · 5 = aggressive/peak>
  },
  "code": "<strudel code as a single JSON string, \\n for newlines>",
  "createdAt": "<ISO timestamp, e.g. from `date -u +%Y-%m-%dT%H:%M:%SZ`>"
}
```

`meta.bpm` MUST equal the BPM in your `setcpm(<bpm>/4)`; no `setcpm` → bpm 120.

## Stem rules (hard requirements)

1. **Shape:** optional `setcpm(<bpm>/4)` on the first line, then ONE final
   `stack(...)` expression. **No `arrange()`** — stems are loops, not arrangements.
   No `$:` labels, no variable assignments, no `samples()`, no `await`, no visual
   functions (`.pianoroll()`, `.scope()`, …).
2. **ONE star sound.** A single voice carries the stem. At most ONE subtle support
   layer (gain ≤ 0.4) and only if it serves the star (e.g. a sine sub under a
   formant lead). No drum kits, no basslines-plus-pads — that's a track.
3. **Built-in morph arc.** The loop must evolve over 8–32 cycles and then repeat:
   use `<...>/N` step patterns and slow LFOs (`sine.slow(16).range(a, b)`) so one
   full pass takes ~15–65 seconds (one cycle = 240/bpm seconds: at 120 BPM,
   16 cycles = 32 s). A static 1-bar loop will be rated down.
4. **Modulate at least 3 dimensions** — pick from pitch (penv/accelerate/vib),
   timbre (fm/vowel/crush/shape/noise), filter (lpf/bpf + lpenv + resonance),
   space (room/delay/pan), motion (tremolo/speed/degrade). A raw waveform with one
   filter sweep is not sound design.
5. **Double quotes** for all pattern strings. **Sounds** only from
   `scripts/sounds.json`. **First 8 cycles must produce sound.** Per-stack-layer
   `.gain()` between 0.3 and 1.2 (support layer 0.3–0.4); echo copies inside
   `.off()`/`.jux()` chains may sit lower.
6. **Original sound.** Never leave a default tone untouched; transform the source
   until it's yours. Detune-thicken with `.off(0.01, x => x.add(note(0.1)))`,
   stereo-split with `.jux(rev)`, dirty up with `.shape()`/`.crush()` — make
   something a preset browser doesn't have.

## Sound-design arsenal (all verified to work here)

| Technique | Controls |
|---|---|
| FM synthesis | `.fm(index)` `.fmh(harmonicity)` — both patternable/LFO-able; `fm` 2–15 is wild territory |
| Pitch envelope | `.penv(semitones).pattack(t).pdecay(t)` — 808 knocks, laser drops, risers (negative penv falls) |
| Filter envelope | `.lpenv(depth).lpattack(t).lpdecay(t)` + `.ftype("ladder")` for acid squelch |
| Filters | `.lpf(hz)` `.hpf(hz)` `.bpf(hz)` + `.resonance(0–20)`; sweep with LFOs |
| Vibrato | `.vib(hz).vibmod(semitones)` — slow+deep = seasick, fast+shallow = nervous |
| Formants | `.vowel("<a e i o u>")` — instant alien vocal character |
| Phaser | `.phaser(hz).phaserdepth(0–1)` |
| Tremolo | `.tremolosync(cyclesPerCycle).tremolodepth(0–1)` — rhythmic gating |
| Noise | `.noise(0–1)` blends noise into a synth voice; `s("white")`/`"pink"`/`"brown"` as sources |
| Degradation | `.coarse(n)` downsample · `.crush(bits)` · `.shape(0–1)` soft drive · `.distort(n)` hard · `.squiz(n)` pitch-mangle |
| Space | `.room(0–1)` · `.delay("wet:time:feedback")` e.g. `"0.5:0.375:0.7"` · `.orbit(n)` separate fx bus |
| Motion | `.pan(LFO)` · `.speed(n)` (negative = reverse) · `.accelerate(n)` pitch glide · `.detune(n)` |
| Sample mangling | `.chop(n)` granulate · `.striate(n)` interleave · `.cut(1)` choke · `.n(i)` variant — on dirt samples (`space`, `metal`, `wind`, `insect`, `east`, `numbers`, `crow`, `jazz`, `arpy`, `casio`) |
| Structure | `.off(t, f)` echo-copies · `.jux(rev)` stereo split · `.sometimesBy(p, f)` · `.every(n, f)` · `.ply(n)` · `.mask("...")` · `.degradeBy(p)` |
| LFOs | `sine` `saw` `tri` `square` `rand` `perlin` + `.range(a, b).slow(n)` — the morph arc's engine |

## Recipes by sound family

- **FM morph bass:** `sine` + `.fm(sine.slow(16).range(2, 14))` + stepped `.fmh("<1 1.5 2 0.5>/4")` + `.penv` click + ladder filter env.
- **Formant alien:** `sawtooth` + `.vowel("<a e i o u>/3")` + `.vib`/`.vibmod` + slow `.bpf` sweep + `.sometimesBy(0.15, x => x.speed(-1))`.
- **Noise riser/texture:** `s("white*2")` + `.lpf(saw.slow(8).range(200, 6000))` + high `.resonance` + `.pan(rand)`.
- **Sample mangle:** dirt sample + `.chop(16)` + `.speed("<1 -1 0.5>")` + `.striate(4)` — granular clouds from one hit.
- **Designed percussion:** short-decay synth + `.penv(24).pdecay(0.05)` + `.lpenv` + `.shape` — ONE sculpted hit pattern, not a kit.

## Complete examples (these validate)

FM morph bass — "bass morph" energy; the fm index, harmonicity, pitch env and
ladder filter all travel on different clocks so the loop never sits still:

```
setcpm(120/4)
stack(
  note("<c1 c1 eb1 g0>*4").s("sine")
    .fm(sine.slow(16).range(2, 14)).fmh("<1 1.5 2 0.5>/4")
    .penv("<0 0 12 -5>/8").pattack(0.001).pdecay(0.08)
    .lpf(sine.slow(32).range(250, 2800)).resonance(12).ftype("ladder")
    .lpenv(3).lpattack(0.005).lpdecay(0.15)
    .attack(0.004).decay(0.2).sustain(0.5).release(0.06)
    .shape(0.35).postgain(0.9)
    .off(1/8, x => x.add(note(12)).gain(0.25).pan(0.8))
    .room(0.15).gain(0.85)
)
```

Alien formant lead — "alien sound" energy; vowels cycle against a prime-numbered
vibrato LFO and a band-pass sweep, with occasional reversed notes:

```
setcpm(120/4)
stack(
  note("<c4 [c4 d4] f4 <eb4 g4>>/2").s("sawtooth")
    .vowel("<a e i o u>/3").vib("<4 6 9>/8").vibmod(sine.slow(13).range(0.2, 1.5))
    .coarse("<1 1 2 4>/4").crush("<16 8 6>/16")
    .bpf(sine.slow(24).range(400, 3200)).resonance(18)
    .pan(sine.slow(7).range(0.15, 0.85))
    .sometimesBy(0.15, x => x.speed(-1))
    .delay("0.5:0.375:0.7").room(0.85).gain(0.65)
)
```

Pro move in both: LFO periods are mutually prime-ish (7, 13, 16, 24, 32 cycles),
so parameter combinations don't realign for a long time — the loop feels alive.

## Common validator failures

- `unknown sounds: X` → X isn't in `scripts/sounds.json`; grep it for alternatives.
- `evaluation failed: ...` → unbalanced `[ ] < > ( )` in mini-notation, or a typo'd
  function name.
- `did not evaluate to a Pattern` → code doesn't end with the `stack(...)` expression.
- `no events` → everything is `~`/`silence`, or a mask that is all `0`.
````

- [ ] **Step 2: Re-validate both guide examples against the validator**

Validate each example by pasting it directly:

```bash
node scripts/validate.mjs --code 'setcpm(120/4)
stack(
  note("<c1 c1 eb1 g0>*4").s("sine")
    .fm(sine.slow(16).range(2, 14)).fmh("<1 1.5 2 0.5>/4")
    .penv("<0 0 12 -5>/8").pattack(0.001).pdecay(0.08)
    .lpf(sine.slow(32).range(250, 2800)).resonance(12).ftype("ladder")
    .lpenv(3).lpattack(0.005).lpdecay(0.15)
    .attack(0.004).decay(0.2).sustain(0.5).release(0.06)
    .shape(0.35).postgain(0.9)
    .off(1/8, x => x.add(note(12)).gain(0.25).pan(0.8))
    .room(0.15).gain(0.85)
)'
```

Expected: `PASS (72 events / 8 cycles)`

```bash
node scripts/validate.mjs --code 'setcpm(120/4)
stack(
  note("<c4 [c4 d4] f4 <eb4 g4>>/2").s("sawtooth")
    .vowel("<a e i o u>/3").vib("<4 6 9>/8").vibmod(sine.slow(13).range(0.2, 1.5))
    .coarse("<1 1 2 4>/4").crush("<16 8 6>/16")
    .bpf(sine.slow(24).range(400, 3200)).resonance(18)
    .pan(sine.slow(7).range(0.15, 0.85))
    .sometimesBy(0.15, x => x.speed(-1))
    .delay("0.5:0.375:0.7").room(0.85).gain(0.65)
)'
```

Expected: `PASS (8 events / 8 cycles)`

- [ ] **Step 3: Commit**

```bash
git add STEMS_GUIDE.md
git commit -m "docs: STEMS_GUIDE.md — sound-design rules, verified arsenal, validated examples"
```

---

### Task 6: `/generate-stems` skill

**Files:**
- Create: `.claude/skills/generate-stems/SKILL.md`

- [ ] **Step 1: Create the skill file**

Full contents:

````markdown
---
name: generate-stems
description: Generate a batch of validated Strudel sound-design stems in parallel from a sound prompt. Use when the user asks to generate stems, sounds, textures, or sound design. Args: "<sound prompt>" [count]
---

# Generate Strudel Stems

Generate `count` (default 30, max 30) Strudel STEMS matching the sound prompt, in
parallel, each validated before it counts. A stem is ONE designed sound — a single
star voice with deep sound design — looping with a built-in 15–60 s morph arc.
Quality bar: original, transformed sound; nothing that sounds like a stock preset.

## Workflow

1. **Read `STEMS_GUIDE.md`** in full (Read tool). Agents must read it themselves
   too — your prompt tells them to.

2. **Collect feedback:** run `node scripts/feedback.mjs stems`. Capture the
   output — it is injected into every agent prompt. If it says "No ratings yet",
   inject the literal text "none yet".

3. **Compute the batch id:** `YYYY-MM-DD-<slug>` where slug = the prompt lowercased,
   non-alphanumerics → `-`, trimmed to ≤ 40 chars (e.g. `2026-06-04-alien-sound`).
   If `ls stems/ | grep <batch>` shows the batch already exists, append `-b2`, `-b3`, ….
   Stem ids are `<batch>-01` … `<batch>-NN`. Get the timestamp with
   `date -u +%Y-%m-%dT%H:%M:%SZ`.

4. **Assign each stem a variation directive** so the batch covers wildly different
   sonic territory. Combine axes — any two stems must differ on at least two axes,
   and in a 30-batch every sound family appears at least 3 times:
   - sound family: sub/808 bass · reese-or-fm bass · lead · pad/texture ·
     designed percussion hit · riser/noise · formant/vocal-ish · sample-mangle
   - synthesis core: FM (sine + fm/fmh) · subtractive (sawtooth/supersaw + filter
     env) · formant (vowel) · noise sculpting (white/pink/brown) · sample
     mangling (chop/striate/speed on dirt samples) · layered detune (off/jux)
   - motion engine: slow filter journey · pitch-envelope morph (penv/accelerate) ·
     rhythmic gating (tremolo/ply/euclid) · stereo drift (pan LFOs/jux) ·
     degradation arc (crush/coarse ramps) · reverse/speed play
   - register: sub · low · mid · high · full-spectrum
   - character (fit to prompt): e.g. wet/cavernous · dry/clicky · metallic ·
     hollow · screaming · liquid · broken

5. **Fan out agents:** dispatch ALL agents for a wave in a SINGLE message (parallel
   tool calls), waves of at most 8. Each agent gets this prompt, placeholders filled:

   ```
   You are writing exactly one Strudel STEM file. Work in <repo root>.

   1. Read STEMS_GUIDE.md COMPLETELY and follow every rule in it — ONE star
      sound, a built-in 8–32 cycle morph arc (~15–60 s), at least 3 modulated
      dimensions, original transformed sound.
   2. Sound brief: "{prompt}". Your variation directive: {directive}.
      Listener feedback to honor (emulate the top-rated; apply every lesson
      under "Lessons for all future tracks"):
      {digest}
   3. Write stems/{id}.json with all required fields:
      id "{id}", batch "{batch}", prompt (the sound brief verbatim),
      title (short, evocative, unique), createdAt "{timestamp}",
      description (1-3 sentences: the sound and how it morphs),
      meta { bpm (must match your setcpm), genre (sound family), mood,
             key ("atonal" if unpitched), instruments (the star sound),
             energy (1-5) },
      code (your Strudel code — single stack(), no arrange()).
   4. Run: node scripts/validate.mjs stems/{id}.json
      If FAIL: read the error, fix the code (for unknown sounds, grep
      scripts/sounds.json for valid names), re-run. Up to 3 attempts total.
      If still failing after 3 attempts: delete the file (rm stems/{id}.json).
   5. Reply with EXACTLY one line:
      OK {id} "<title>"   — or —   FAILED {id} <one-line reason>
   ```

6. **Report:** after all waves, output a table (id · title · status), the count of
   valid stems written, any failures with reasons. Remind the user:
   `npm run dev` → http://localhost:5173/stems to listen and rate.

## Notes

- Validation is the contract: a stem only exists if `validate.mjs` passes it.
- Never edit `scripts/sounds.json` to make a stem pass — change the stem.
- If the user gives a count > 30, cap at 30 and say so.
````

- [ ] **Step 2: Sanity-check the skill is discoverable**

Run: `ls .claude/skills/`
Expected: `generate-stems  generate-tracks`

(Claude Code picks up project skills from `.claude/skills/` automatically; a new session will see `/generate-stems`.)

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/generate-stems/SKILL.md
git commit -m "feat: /generate-stems skill — 30 sound-design stems per prompt"
```

---

### Task 7: README + full verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README**

In `README.md` "Use" section, after step 4, add:

```markdown
5. Sound sorcery: `/generate-stems "alien sound"` writes 30 single-sound,
   sound-design stems to `stems/` — listen and rate them at
   http://localhost:5173/stems (nav links crate ↔ stems).
```

In the "Commands" section, after the `npm run feedback` line, add:

```markdown
- `node scripts/feedback.mjs stems` — the same digest for stem ratings
```

- [ ] **Step 2: Run the full test suite and build**

Run: `npx vitest run`
Expected: ALL PASS.

Run: `npm run build`
Expected: succeeds with both pages in `dist/`.

- [ ] **Step 3: Browser smoke test on an isolated server pair**

The user's dev servers usually occupy :3001/:5173 — and the user's running API
predates `/api/stems`, so the smoke test needs its OWN API. Use the `API_PROXY`
escape hatch added in Task 4:

```bash
PORT=3101 node server/index.mjs &        # isolated API with /api/stems
API_PROXY=http://localhost:3101 npx vite --port 5273 --strictPort &
sleep 3
```

Write `/tmp/stems-smoke.py`:

```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page()
    console = []
    pg.on('console', lambda m: console.append(f'{m.type}: {m.text}'))

    # 1. /stems clean URL serves the stems page
    pg.goto('http://localhost:5273/stems')
    pg.wait_for_selector('.masthead h1')
    assert 'STEMS' in pg.inner_text('.masthead h1'), 'stems masthead missing'

    # 2. empty state points at /generate-stems (stems/ holds only .gitkeep)
    pg.wait_for_selector('#tracks .empty')
    assert 'generate-stems' in pg.inner_text('#tracks'), 'stems empty-state hint missing'

    # 3. nav to crate works and tracks render
    pg.click('.nav a[href="/"]')
    pg.wait_for_selector('.masthead h1')
    assert 'CRATE' in pg.inner_text('.masthead h1'), 'crate masthead missing'
    pg.wait_for_selector('#tracks .track', timeout=20000)

    # 4. nav back to stems works
    pg.click('.nav a[href="/stems"]')
    pg.wait_for_selector('.masthead h1')
    assert 'STEMS' in pg.inner_text('.masthead h1'), 'nav back to stems failed'

    # 5. no API failures in console (audio "not found" errors are the silent killer)
    bad = [c for c in console if 'not found' in c or '404' in c or 'unreachable' in c.lower()]
    assert not bad, f'console errors: {bad}'
    print('SMOKE PASS')
    b.close()
```

Run: `/usr/local/opt/python@3.11/bin/python3.11 /tmp/stems-smoke.py`
Expected: `SMOKE PASS`

Then kill the two background servers (`kill %1 %2` or by port).

- [ ] **Step 4: End-to-end stem check (one real stem through the whole pipe)**

Write one stem by hand to prove the full contract (validate → API → page). Get a
timestamp with `date -u +%Y-%m-%dT%H:%M:%SZ`, then create `stems/smoke-stem-01.json`:

```json
{
  "id": "smoke-stem-01",
  "title": "Smoke Morph",
  "prompt": "smoke test",
  "batch": "smoke-stem",
  "description": "FM sine bass that opens its filter over 32 cycles. Pipeline smoke test.",
  "meta": {
    "bpm": 120,
    "genre": "fm bass",
    "mood": "test",
    "key": "C minor",
    "instruments": ["fm sine bass"],
    "energy": 3
  },
  "code": "setcpm(120/4)\nstack(\n  note(\"<c1 c1 eb1 g0>*4\").s(\"sine\")\n    .fm(sine.slow(16).range(2, 14)).fmh(\"<1 1.5 2 0.5>/4\")\n    .lpf(sine.slow(32).range(250, 2800)).resonance(12).ftype(\"ladder\")\n    .attack(0.004).decay(0.2).sustain(0.5).release(0.06)\n    .shape(0.35).gain(0.85)\n)",
  "createdAt": "<the timestamp you got>"
}
```

Run: `node scripts/validate.mjs stems/smoke-stem-01.json`
Expected: `PASS stems/smoke-stem-01.json (...)`

Restart the isolated server pair from Step 3 (API on :3101, vite on :5273), then
write `/tmp/stems-play.py` — it plays the smoke stem and listens for the one
headless signal that audio actually resolves (console "not found" errors;
silent-playback gotcha):

```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page()
    console = []
    pg.on('console', lambda m: console.append(f'{m.type}: {m.text}'))

    pg.goto('http://localhost:5273/stems')
    pg.wait_for_selector('#tracks .track', timeout=20000)   # smoke stem card rendered
    pg.wait_for_selector('#status.ready', timeout=60000)    # samples prebaked
    pg.click('#tracks .track .play')                        # starts the scheduler
    pg.wait_for_selector('#tracks .track.playing', timeout=15000)
    pg.wait_for_timeout(4000)                               # let several triggers fire

    bad = [c for c in console if 'not found' in c or 'getTrigger' in c]
    assert not bad, f'audio resolution errors: {bad}'
    assert 'NOW PLAYING' in pg.inner_text('#now-playing'), 'transport not playing'
    print('PLAY PASS')
    b.close()
```

Run: `/usr/local/opt/python@3.11/bin/python3.11 /tmp/stems-play.py`
Expected: `PLAY PASS`

Then clean up: `rm stems/smoke-stem-01.json data/stem-ratings/smoke-stem-01.json 2>/dev/null` (the
ratings file only exists if you rated it), and kill the servers.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document /generate-stems and the /stems page"
```

---

## Self-review notes

- **Spec coverage:** route in same repo/UI (Tasks 3–4) ✓ · nav both directions (Task 4, both pages) ✓ · prompt-driven generation of 30 stems (Task 6, default 30) ✓ · "really interesting sound design / perfect quality / original" (Task 5 guide: 3-dimension modulation minimum, originality rule, verified arsenal, morph-arc requirement; Task 6 quality bar + variation axes) ✓ · rating/feedback loop for stems (Tasks 1–2) ✓.
- **Types/signatures:** `createApp({tracks, stems})` used identically in Task 1 impl, Task 1 tests, and `server/index.mjs`. `initApp({apiBase, emptyHint})` used identically in Tasks 3 and 4. Store factory signature unchanged everywhere.
- **Validator reuse:** stem JSON schema = track schema, so `validateTrack` needs zero changes; confirmed `validateTarget` takes any path (`stems/<id>.json` works).
- **All guide code pre-validated** against `scripts/validate.mjs` in this checkout on 2026-06-04.
