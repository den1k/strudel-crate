# Track Descriptions + Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every track carries a required `description` and `meta` (bpm/genre/mood/key/instruments/energy), enforced by the validator (incl. bpm↔setcpm cross-check), shown in the webapp, surfaced in the feedback digest, backfilled onto the 5 existing tracks.

**Architecture:** Schema logic moves out of the CLI into an exported `validateTrack(track)` (field/meta checks, then `validateCode`). Webapp renders description + metadata chips via `textContent`. Digest appends `genre · bpm`. Spec: `docs/superpowers/specs/2026-06-04-track-metadata-design.md`.

**Tech Stack:** unchanged (Node ESM, vitest, vanilla JS webapp).

**Ordering note:** After Task 1, `node scripts/validate.mjs tracks/*.json` FAILS on existing tracks (they lack the new fields) until Task 2 backfills them. Unit tests are unaffected (they don't read real track files). Don't run the crate-wide validation between Tasks 1 and 2 and expect PASS.

---

### Task 1: `validateTrack` with metadata + bpm cross-check (TDD)

**Files:**
- Modify: `scripts/validate.mjs` (CLI section, lines 49–66)
- Test: `test/validate.test.mjs` (append a new describe block)

- [ ] **Step 1: Write the failing tests** — append to `test/validate.test.mjs` (top-level, after the existing describe). Also change the import line at the top of the file to `import { validateCode, validateTrack } from '../scripts/validate.mjs';`

```js
describe('validateTrack', () => {
  const goodTrack = () => ({
    id: 't', title: 'T', prompt: 'p', batch: 'b',
    description: 'A driving little techno sketch.',
    meta: { bpm: 120, genre: 'techno', mood: 'dark', key: 'C minor', instruments: ['RolandTR909 kit'], energy: 3 },
    code: 'setcpm(120/4)\ns("bd*4").bank("RolandTR909")',
    createdAt: 'x',
  });

  it('accepts a fully-specified track', async () => {
    const result = await validateTrack(goodTrack());
    expect(result.ok).toBe(true);
  });

  it('rejects a missing description', async () => {
    const t = goodTrack();
    delete t.description;
    const result = await validateTrack(t);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/description/);
  });

  it('rejects missing meta', async () => {
    const t = goodTrack();
    delete t.meta;
    expect((await validateTrack(t)).error).toMatch(/meta/);
  });

  it('rejects bpm that contradicts setcpm', async () => {
    const t = goodTrack();
    t.meta.bpm = 95;
    const result = await validateTrack(t);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not match/);
  });

  it('requires bpm 120 when code has no setcpm', async () => {
    const t = goodTrack();
    t.code = 's("bd*4").bank("RolandTR909")';
    t.meta.bpm = 128;
    expect((await validateTrack(t)).error).toMatch(/does not match/);
    t.meta.bpm = 120;
    expect((await validateTrack(t)).ok).toBe(true);
  });

  it('reads setcpm(N) as N cycles per minute (bpm = 4N)', async () => {
    const t = goodTrack();
    t.code = 'setcpm(30)\ns("bd*4").bank("RolandTR909")';
    t.meta.bpm = 120;
    expect((await validateTrack(t)).ok).toBe(true);
  });

  it('rejects bad energy and bad instruments', async () => {
    const t1 = goodTrack();
    t1.meta.energy = 7;
    expect((await validateTrack(t1)).error).toMatch(/energy/);
    const t2 = goodTrack();
    t2.meta.instruments = [];
    expect((await validateTrack(t2)).error).toMatch(/instruments/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/validate.test.mjs`
Expected: FAIL — `validateTrack` is not exported.

- [ ] **Step 3: Implement** — in `scripts/validate.mjs`, replace the CLI section from `const REQUIRED_FIELDS = ...` through the end of `validateTarget` (current lines 50–66) with:

```js
const REQUIRED_FIELDS = ['id', 'title', 'prompt', 'batch', 'description', 'code', 'createdAt'];

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

// BPM declared by the code: setcpm(N/4) → N, setcpm(N) → N×4, none → 120 (strudel default).
function declaredBpm(code) {
  const frac = code.match(/setcpm\(\s*(\d+(?:\.\d+)?)\s*\/\s*4\s*\)/);
  if (frac) return Number(frac[1]);
  const plain = code.match(/setcpm\(\s*(\d+(?:\.\d+)?)\s*\)/);
  if (plain) return Number(plain[1]) * 4;
  return 120;
}

// Full track validation: required fields + meta schema + bpm↔setcpm, then the code itself.
export async function validateTrack(track) {
  const missing = REQUIRED_FIELDS.filter((f) => track[f] == null || track[f] === '');
  if (missing.length) return { ok: false, error: `missing fields: ${missing.join(', ')}` };
  const m = track.meta;
  if (m == null || typeof m !== 'object' || Array.isArray(m)) {
    return { ok: false, error: 'missing fields: meta (object with bpm, genre, mood, key, instruments, energy)' };
  }
  if (!(Number.isInteger(m.bpm) && m.bpm >= 40 && m.bpm <= 220)) {
    return { ok: false, error: 'meta.bpm must be an integer 40-220' };
  }
  for (const f of ['genre', 'mood', 'key']) {
    if (!isNonEmptyString(m[f])) return { ok: false, error: `meta.${f} must be a non-empty string` };
  }
  if (!Array.isArray(m.instruments) || m.instruments.length === 0 || !m.instruments.every(isNonEmptyString)) {
    return { ok: false, error: 'meta.instruments must be a non-empty array of strings' };
  }
  if (!(Number.isInteger(m.energy) && m.energy >= 1 && m.energy <= 5)) {
    return { ok: false, error: 'meta.energy must be an integer 1-5' };
  }
  const bpm = declaredBpm(track.code);
  if (m.bpm !== bpm) {
    return { ok: false, error: `meta.bpm (${m.bpm}) does not match the code's tempo (${bpm} BPM from setcpm)` };
  }
  return validateCode(track.code);
}

async function validateTarget(arg) {
  const { readFile } = await import('node:fs/promises');
  if (arg.endsWith('.json')) {
    let track;
    try {
      track = JSON.parse(await readFile(arg, 'utf8'));
    } catch (err) {
      return { ok: false, error: `unreadable JSON: ${err.message}` };
    }
    return validateTrack(track);
  }
  return validateCode(await readFile(arg, 'utf8'));
}
```

(The `if (process.argv[1] ...)` CLI block below stays unchanged.)

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run`
Expected: 31 passed (24 existing + 7 new).

- [ ] **Step 5: Verify CLI failure on a not-yet-backfilled track (expected at this stage)**

Run: `node scripts/validate.mjs tracks/2026-06-03-seed-01.json; echo exit=$?`
Expected: `FAIL ... missing fields: description`, exit=1. This confirms enforcement; Task 2 fixes the data.

- [ ] **Step 6: Commit**

```bash
git add scripts/validate.mjs test/validate.test.mjs
git commit -m "feat: validateTrack — description + meta schema with bpm/setcpm cross-check"
```

---

### Task 2: Backfill 5 tracks + guide + skill template

**Files:**
- Modify: `tracks/2026-06-03-seed-01.json`, `tracks/2026-06-03-seed-02.json`, `tracks/2026-06-03-warm-lofi-house-01.json`, `tracks/2026-06-03-warm-lofi-house-02.json`, `tracks/2026-06-03-warm-lofi-house-03.json`
- Modify: `STRUDEL_GUIDE.md` (track format block + new Metadata section)
- Modify: `.claude/skills/generate-tracks/SKILL.md` (agent template step 3)

- [ ] **Step 1: Backfill seed-01** — add to `tracks/2026-06-03-seed-01.json` (after the `"batch"` field):

```json
  "description": "Four-on-the-floor acid techno: a relentless 909 kick and offbeat hats under a sawtooth bassline whose filter breathes open and shut every four bars.",
  "meta": {
    "bpm": 130,
    "genre": "acid techno",
    "mood": "dark, driving",
    "key": "C minor",
    "instruments": ["RolandTR909 kit", "sawtooth bass"],
    "energy": 4
  },
```

- [ ] **Step 2: Backfill seed-02** — add to `tracks/2026-06-03-seed-02.json`:

```json
  "description": "A melancholy felt-piano sketch: slow minor chords under a sparse echoing melody, with a lone 707 rimshot keeping time.",
  "meta": {
    "bpm": 72,
    "genre": "ambient piano",
    "mood": "melancholy, intimate",
    "key": "C minor",
    "instruments": ["piano", "RolandTR707 rim"],
    "energy": 1
  },
```

- [ ] **Step 3: Backfill the 3 lofi-house tracks** — for each of `warm-lofi-house-01/-02/-03`: READ the track's `code` field first, then write `description` + `meta` that are TRUE to the code: `bpm` = the number in its `setcpm(N/4)` (01→78, 02→84, 03→92 — verify against the files); `genre` "lofi house" (vary the qualifier per the track's character); `key` from the `scale()`/`note()` roots in the code; `instruments` from the actual banks/sounds used (e.g. "CasioRZ1 kit", "casio keys", "triangle lead"); `mood` and `energy` (2–3) judged from the code's density and the track's directive; description 1–3 listener-facing sentences reflecting the arrangement's actual sections. Use the two seed backfills above as the quality bar.

- [ ] **Step 4: Validate the whole crate**

Run: `node scripts/validate.mjs tracks/*.json; echo exit=$?`
Expected: 5× PASS, exit=0. If a bpm mismatch fails, fix `meta.bpm` to match the code's setcpm (never the other way around).

- [ ] **Step 5: Update STRUDEL_GUIDE.md track format** — in the "## Track file format" JSON block, insert after the `"batch"` line:

```
  "description": "<1-3 sentences for a listener: what it sounds like, how it develops>",
  "meta": {
    "bpm": <integer matching your setcpm>,
    "genre": "<e.g. dub techno>",
    "mood": "<e.g. hypnotic, cavernous>",
    "key": "<e.g. F minor>",
    "instruments": ["<sounds/banks you actually used>"],
    "energy": <1-5>
  },
```

- [ ] **Step 6: Add a Metadata section to STRUDEL_GUIDE.md** — insert directly after the track-format section (before "## Code rules"):

```markdown
## Metadata rules

- `meta.bpm` MUST equal the BPM in your `setcpm(<bpm>/4)` — the validator cross-checks.
  No `setcpm` in the code → bpm must be 120 (the default).
- `energy`: 1 = ambient/beatless · 2 = downtempo · 3 = head-nod groove · 4 = dancefloor ·
  5 = peak-time. Match what the code actually does.
- `instruments`: the sounds you actually used, listener-facing (e.g. "RolandTR909 kit",
  "sawtooth bass", "piano") — not every control name.
- `key`: the musical key implied by your `scale()`/`note()` choices (e.g. "C minor").
- `description`: 1–3 sentences for a listener — what it sounds like and how it
  develops. No code talk.
```

- [ ] **Step 7: Update SKILL.md agent template** — in `.claude/skills/generate-tracks/SKILL.md`, replace template step 3:

```
   3. Write tracks/{id}.json with all required fields:
      id "{id}", batch "{batch}", prompt (the style brief verbatim),
      title (short, evocative, unique), createdAt "{timestamp}",
      code (your Strudel code — follow the guide's shape rules).
```

with:

```
   3. Write tracks/{id}.json with all required fields:
      id "{id}", batch "{batch}", prompt (the style brief verbatim),
      title (short, evocative, unique), createdAt "{timestamp}",
      description (1-3 listener-facing sentences),
      meta { bpm (must match your setcpm), genre, mood, key,
             instruments (sounds you used), energy (1-5) },
      code (your Strudel code — follow the guide's shape rules).
```

- [ ] **Step 8: Commit**

```bash
git add tracks/ STRUDEL_GUIDE.md .claude/
git commit -m "feat: backfill metadata on existing tracks; document in guide and skill"
```

---

### Task 3: Webapp — description + metadata chips

**Files:**
- Modify: `src/main.js` (trackCard: meta block ~line 96, code block ~line 140)
- Modify: `src/style.css` (after `.meta .id` rule)

- [ ] **Step 1: Render description + chips** — in `trackCard`, replace:

```js
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = `<h3></h3><span class="id"></span>`;
  $('h3', meta).textContent = track.title;
  $('.id', meta).textContent = track.id;
```

with:

```js
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = `<h3></h3><span class="id"></span><p class="desc"></p><div class="chips"></div>`;
  $('h3', meta).textContent = track.title;
  $('.id', meta).textContent = track.id;
  $('.desc', meta).textContent = track.description ?? '';
  const m = track.meta ?? {};
  const chips = $('.chips', meta);
  const chipValues = [
    m.genre,
    m.bpm && `${m.bpm} bpm`,
    m.key,
    m.energy && '▮'.repeat(m.energy) + '▯'.repeat(5 - m.energy),
    m.mood,
  ].filter(Boolean);
  for (const value of chipValues) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = value;
    chips.appendChild(chip);
  }
```

- [ ] **Step 2: Show instruments in the code details** — replace:

```js
  const code = document.createElement('details');
  code.className = 'code';
  code.innerHTML = `<summary>code</summary><pre></pre>`;
  $('pre', code).textContent = track.code;
```

with:

```js
  const code = document.createElement('details');
  code.className = 'code';
  code.innerHTML = `<summary>code</summary><p class="instruments"></p><pre></pre>`;
  $('.instruments', code).textContent = (track.meta?.instruments ?? []).join(' · ');
  $('pre', code).textContent = track.code;
```

- [ ] **Step 3: CSS** — in `src/style.css`, add after the `.meta .id` rule:

```css
.meta .desc { color: var(--dim); font-size: 12px; margin-top: 4px; max-width: 60ch; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.chip {
  font-size: 11px; color: var(--acid);
  border: 1px solid var(--line); padding: 2px 8px;
  background: var(--bg); white-space: nowrap;
}
.code .instruments { color: var(--dim); font-size: 11px; margin: 6px 0 0; }
```

- [ ] **Step 4: Verify**

Run: `npx vite build` → exit 0. Then start `node server/index.mjs &` + `npx vite &` (repo root), sleep 3:
- `curl -s localhost:5173/src/main.js | grep -c chips` → ≥1
- `curl -s localhost:3001/api/tracks | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const t=JSON.parse(d);console.log(t.every(x=>x.description && x.meta?.bpm))})"` → `true`
Kill both servers; `lsof -ti :3001 -ti :5173` → empty.

- [ ] **Step 5: Commit**

```bash
git add src/ && git commit -m "feat: show track description and metadata chips in webapp"
```

---

### Task 4: Feedback digest metadata + final verify

**Files:**
- Modify: `scripts/feedback.mjs`
- Test: `test/feedback.test.mjs` (append one test)

- [ ] **Step 1: Write the failing test** — append inside the existing describe in `test/feedback.test.mjs`:

```js
  it('appends genre and bpm when meta is present', () => {
    const digest = buildDigest([
      { ...track('hi', 5, ''), meta: { genre: 'techno', bpm: 130 } },
      { ...track('lo', 1, 'meh'), meta: { genre: 'house', bpm: 100 } },
    ]);
    expect(digest).toContain('— techno · 130bpm');
    expect(digest).toContain('— house · 100bpm');
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/feedback.test.mjs` → the new test FAILS.

- [ ] **Step 3: Implement** — in `scripts/feedback.mjs`, add after the `buildDigest` opening lines (before `const rated = ...` is fine; module scope also fine):

```js
const metaSuffix = (t) =>
  t.meta?.genre || t.meta?.bpm
    ? ` — ${[t.meta?.genre, t.meta?.bpm && `${t.meta.bpm}bpm`].filter(Boolean).join(' · ')}`
    : '';
```

(place it at module scope, above `buildDigest`). Then change the two output lines:
- Top header: `lines.push('', `### ${'★'.repeat(t.rating)} "${t.title}" (${t.id})${metaSuffix(t)}`);`
- Low line: `lines.push(`- ${'★'.repeat(t.rating)} "${t.title}"${metaSuffix(t)}: ${t.notes || '(no notes)'}`);`

- [ ] **Step 4: Full verification suite**

- `npx vitest run` → 32 passed.
- `node scripts/validate.mjs tracks/*.json` → 5× PASS.
- `npm run feedback` → digest shows `— acid techno · 130bpm` on Boiler Primer and `— ambient piano · 72bpm` on Felt Hammer.
- `npx vite build` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/feedback.mjs test/feedback.test.mjs
git commit -m "feat: surface genre/bpm metadata in feedback digest"
```
