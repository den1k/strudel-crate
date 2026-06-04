# Feedback Lesson Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split listener feedback into two channels: per-track `notes` (never leave the track) and an optional `lesson` (global guidance injected into every future generation batch).

**Architecture:** Thread one new optional string field, `lesson`, through the existing rating pipeline — rating file → store → API → webapp card — and restructure the digest so track notes never appear in it while lessons appear regardless of star rating. No new endpoints, files, or stores.

**Tech Stack:** Node ESM, Express 4, vanilla JS + Vite webapp, Vitest + supertest.

**Spec:** `docs/superpowers/specs/2026-06-04-feedback-lesson-channel-design.md`

**Run all tests with:** `npx vitest run` (from repo root `/Users/den/dev/code/strudel-ai`)

---

### Task 1: Store — persist and surface `lesson`

**Files:**
- Modify: `server/store.mjs`
- Test: `test/store.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append inside the `describe('createStore', ...)` block in `test/store.test.mjs`:

```js
  it('round-trips lesson through saveRating/listTracks', async () => {
    await writeFile(join(dirs.tracksDir, 'a.json'), JSON.stringify(track('a')));
    await store.saveRating('a', { rating: 3, notes: 'meh mix', lesson: 'keep drums under synths' });
    const tracks = await store.listTracks();
    expect(tracks[0]).toMatchObject({ rating: 3, notes: 'meh mix', lesson: 'keep drums under synths' });
  });

  it('defaults lesson to empty string for unrated tracks and pre-lesson rating files', async () => {
    await writeFile(join(dirs.tracksDir, 'a.json'), JSON.stringify(track('a')));
    await writeFile(join(dirs.tracksDir, 'b.json'), JSON.stringify(track('b')));
    // simulate a rating file written before the lesson field existed
    await mkdir(dirs.ratingsDir, { recursive: true });
    await writeFile(join(dirs.ratingsDir, 'b.json'), JSON.stringify({ id: 'b', rating: 2, notes: 'old' }));
    const tracks = await store.listTracks();
    expect(tracks.find((t) => t.id === 'a')).toMatchObject({ rating: null, lesson: '' });
    expect(tracks.find((t) => t.id === 'b')).toMatchObject({ rating: 2, notes: 'old', lesson: '' });
  });
```

(`mkdir` is already imported at the top of this test file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/store.test.mjs`
Expected: 2 new tests FAIL (received object lacks `lesson`), 4 existing PASS.

- [ ] **Step 3: Implement in `server/store.mjs`**

In `getRating`, change both return values:

```js
      return { rating: r.rating ?? null, notes: r.notes ?? '', lesson: r.lesson ?? '' };
    } catch {
      return { rating: null, notes: '', lesson: '' };
    }
```

In `saveRating`, change the signature and record:

```js
  async function saveRating(id, { rating, notes, lesson }) {
    await mkdir(ratingsDir, { recursive: true });
    const record = {
      id,
      rating: rating ?? null,
      notes: notes ?? '',
      lesson: lesson ?? '',
      updatedAt: new Date().toISOString(),
    };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/store.test.mjs`
Expected: all 6 PASS.

- [ ] **Step 5: Commit**

```bash
git add server/store.mjs test/store.test.mjs
git commit -m "feat: persist optional lesson field in rating records"
```

---

### Task 2: API — accept `lesson` on the rating endpoint

**Files:**
- Modify: `server/app.mjs:19-26`
- Test: `test/api.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append inside the `describe('API', ...)` block in `test/api.test.mjs`:

```js
  it('PUT saves and echoes lesson', async () => {
    const res = await request(app)
      .put('/api/tracks/a/rating')
      .send({ rating: 3, notes: 'n', lesson: 'less reverb on pads' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'a', rating: 3, notes: 'n', lesson: 'less reverb on pads' });
  });

  it('rejects non-string lesson', async () => {
    const res = await request(app).put('/api/tracks/a/rating').send({ lesson: 42 });
    expect(res.status).toBe(400);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/api.test.mjs`
Expected: "PUT saves and echoes lesson" FAILS (no `lesson` in body — store ignores it until app passes it through; after Task 1 the store supports it but the route drops it). "rejects non-string lesson" FAILS (200 instead of 400).

- [ ] **Step 3: Implement in `server/app.mjs`**

Replace the body destructure/validation block of the PUT route:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/api.test.mjs`
Expected: all 6 PASS.

- [ ] **Step 5: Commit**

```bash
git add server/app.mjs test/api.test.mjs
git commit -m "feat: accept lesson field on rating endpoint"
```

---

### Task 3: Digest — lessons in, track notes out

**Files:**
- Modify: `scripts/feedback.mjs` (`buildDigest`)
- Test: `test/feedback.test.mjs`

Two EXISTING tests assert the old behavior and must be rewritten, not just appended to: `includes code of top-rated tracks and notes of low-rated ones` and `appends genre and bpm when meta is present` (its low-rated expectation dies with the low-rated section).

- [ ] **Step 1: Rewrite/extend the tests**

In `test/feedback.test.mjs`, change the track helper to carry a lesson:

```js
const track = (id, rating, notes, code = `code-${id}`, lesson = '') => ({
  id, title: `Title ${id}`, prompt: 'p', batch: 'b', code,
  createdAt: 'x', rating, notes, lesson,
});
```

Replace the test `includes code of top-rated tracks and notes of low-rated ones` with:

```js
  it('includes code of top-rated tracks; track notes never appear', () => {
    const digest = buildDigest([
      track('hi', 5, 'love the bass', 'TOP_CODE'),
      track('lo', 1, 'too harsh', 'LOW_CODE'),
      track('mid', null, ''),
    ]);
    expect(digest).toContain('TOP_CODE');
    expect(digest).not.toContain('love the bass');
    expect(digest).not.toContain('too harsh');
    expect(digest).not.toContain('LOW_CODE');
    expect(digest).toMatch(/1 unrated/);
  });
```

Replace the test `appends genre and bpm when meta is present` with (top-rated only — low-rated tracks are no longer listed):

```js
  it('appends genre and bpm when meta is present', () => {
    const digest = buildDigest([
      { ...track('hi', 5, ''), meta: { genre: 'techno', bpm: 130 } },
    ]);
    expect(digest).toContain('— techno · 130bpm');
  });
```

Append new tests inside the describe block:

```js
  it('lists lessons from any track regardless of rating', () => {
    const digest = buildDigest([
      track('a', 3, 'mid note', 'CODE_A', 'keep drums under the synths'),
      track('b', null, '', 'CODE_B', 'shorter intros'),
    ]);
    expect(digest).toContain('## Lessons for all future tracks');
    expect(digest).toContain('- keep drums under the synths (from "Title a")');
    expect(digest).toContain('- shorter intros (from "Title b")');
    expect(digest).not.toContain('mid note');
  });

  it('is non-empty when there are lessons but zero ratings', () => {
    const digest = buildDigest([track('a', null, '', 'C', 'use more swing')]);
    expect(digest).not.toMatch(/no ratings yet/i);
    expect(digest).toContain('use more swing');
  });

  it('omits the lessons section when no lessons exist', () => {
    const digest = buildDigest([track('hi', 5, '')]);
    expect(digest).not.toContain('## Lessons for all future tracks');
  });
```

(The existing `says so when nothing is rated` test already covers the no-ratings-no-lessons fallback, since the helper defaults `lesson` to `''` — leave it as is.)

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run test/feedback.test.mjs`
Expected: the rewritten + new tests FAIL (notes still present, no Lessons section); `caps top tracks at 5` and `handles meta with only one of genre/bpm` still PASS.

- [ ] **Step 3: Implement in `scripts/feedback.mjs`**

Replace `buildDigest` with:

```js
export function buildDigest(tracks) {
  const rated = tracks.filter((t) => t.rating != null);
  const lessons = tracks.filter((t) => t.lesson);
  if (rated.length === 0 && lessons.length === 0) {
    return 'No ratings yet — no listener feedback to apply.';
  }
  const lines = [`# Listener feedback (${rated.length} rated / ${tracks.length} total, ${tracks.length - rated.length} unrated)`];

  const top = rated.filter((t) => t.rating >= 4).sort((a, b) => b.rating - a.rating).slice(0, 5);
  if (top.length) {
    lines.push('', '## Top rated — emulate what works here');
    for (const t of top) {
      lines.push('', `### ${'★'.repeat(t.rating)} "${t.title}" (${t.id})${metaSuffix(t)}`);
      lines.push('```', t.code, '```');
    }
  }

  if (lessons.length) {
    lines.push('', '## Lessons for all future tracks');
    for (const t of lessons) {
      lines.push(`- ${t.lesson} (from "${t.title}")`);
    }
  }
  return lines.join('\n');
}
```

(Keep `metaSuffix` and the CLI block at the bottom unchanged. The whole low-rated section and the `if (t.notes)` line are gone.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/feedback.test.mjs`
Expected: all 8 PASS.

- [ ] **Step 5: Update the digest comment**

First line of `scripts/feedback.mjs` becomes:

```js
// Digest of listener ratings/lessons, consumed by /generate-tracks agents.
```

- [ ] **Step 6: Commit**

```bash
git add scripts/feedback.mjs test/feedback.test.mjs
git commit -m "feat: digest carries general lessons; track notes stay track-local"
```

---

### Task 4: Webapp — lesson textarea on each card

**Files:**
- Modify: `src/main.js` (putRating ~line 42, trackCard notes block ~line 140, card.append ~line 162)
- Modify: `src/style.css` (`.notes` block ~line 111)

No DOM test harness exists in this project — this task is verified manually (Step 4) plus the full suite.

- [ ] **Step 1: Round-trip `lesson` in `putRating`**

In `src/main.js`, replace the body construction and the post-save assignments:

```js
  const body = {
    rating: 'rating' in patch ? patch.rating : track.rating,
    notes: 'notes' in patch ? patch.notes : track.notes,
    lesson: 'lesson' in patch ? patch.lesson : track.lesson,
  };
```

```js
  track.rating = saved.rating;
  track.notes = saved.notes;
  track.lesson = saved.lesson;
```

- [ ] **Step 2: Replace the notes textarea block in `trackCard`**

Delete the current `const notes = document.createElement('textarea'); … notes.addEventListener('input', saveNotes);` block (src/main.js:140-154) and put in its place:

```js
  const autosaveArea = (className, placeholder, value, field) => {
    const ta = document.createElement('textarea');
    ta.className = className;
    ta.placeholder = placeholder;
    ta.value = value ?? '';
    const save = debounce(async () => {
      try {
        await putRating(track, { [field]: ta.value });
        ta.classList.add('saved');
        setTimeout(() => ta.classList.remove('saved'), 600);
      } catch (err) {
        console.error(err);
        flashError(ta);
      }
    }, 600);
    ta.addEventListener('input', save);
    return ta;
  };

  const feedback = document.createElement('div');
  feedback.className = 'feedback';
  feedback.append(
    autosaveArea('notes', 'notes — what works, what to change… (this track only)', track.notes, 'notes'),
    autosaveArea('notes lesson', 'lesson for future tracks — applies to every new batch…', track.lesson, 'lesson'),
  );
```

Then change the append line:

```js
  card.append(playBtn, meta, rate, feedback, code);
```

- [ ] **Step 3: CSS — wrapper takes the grid area**

In `src/style.css`, replace the `.notes { … }` rule (keep the `.notes:focus`/`.notes.saved`/`.notes.error` rules below it unchanged):

```css
.feedback { grid-area: notes; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.notes {
  background: var(--bg); color: var(--ink);
  border: 1px solid var(--line); font-family: var(--mono); font-size: 12px;
  padding: 8px; min-height: 56px; resize: vertical;
  transition: border-color 0.3s ease;
}
.lesson { min-height: 36px; border-style: dashed; }
```

(The only change to `.notes` itself is removing `grid-area: notes;` — the wrapper owns placement now, and the mobile media query's `'notes notes'` area applies to `.feedback` unchanged.)

- [ ] **Step 4: Manual verification**

Run: `npm run dev`, open http://localhost:5173 and check:
1. Each card shows the solid-border notes box and a dashed, shorter "lesson for future tracks" box below it.
2. Type in the lesson box → border flashes acid (saved); reload → text persists.
3. Type in notes → still saves; star clicks still work; neither wipes the other (check `data/ratings/<id>.json` contains both fields).
4. Run `node scripts/feedback.mjs` → the lesson you typed appears under `## Lessons for all future tracks`; no track notes anywhere in the output. Clear the test lesson in the UI afterwards.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main.js src/style.css
git commit -m "feat: lesson textarea on track cards — global guidance channel"
```
