import { initStrudel } from '@strudel/web';
import { mountEditor, getEditor, isStarted } from './editor.js';
import { nextPlayingId } from './playing-state.js';
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

// --- code sections + editors ---------------------------------------------
// renderTracks() rebuilds every card with replaceChildren(), so the <details>
// holding each editor is cached per track and *moved* into the new card —
// preserving the CodeMirror instance, session-only edits, and open state.
const codeSections = new Map(); // trackId -> <details class="code">

function codeSection(track) {
  let section = codeSections.get(track.id);
  if (section) return section;
  section = document.createElement('details');
  section.className = 'code';
  section.innerHTML = `<summary>code</summary><p class="instruments"></p><p class="eval-error" hidden></p><div class="editor"></div>`;
  $('.instruments', section).textContent = (track.meta?.instruments ?? []).join(' · ');
  section.addEventListener('toggle', () => {
    if (section.open) ensureEditor(track); // lazy-mount on first open
  });
  codeSections.set(track.id, section);
  return section;
}

function ensureEditor(track) {
  return mountEditor({
    track,
    root: $('.editor', codeSection(track)),
    prebake: () => ready,
    onToggle: onEditorToggle,
    onError: onEditorError,
  });
}

function onEditorToggle(trackId, started) {
  const next = nextPlayingId(state.playingId, trackId, started);
  if (next === state.playingId) return;
  state.playingId = next;
  renderTracks();
  renderTransport();
}

function onEditorError(trackId, err) {
  const section = codeSections.get(trackId);
  if (section) {
    const msg = $('.eval-error', section);
    msg.textContent = err ? `✖ ${err.message}` : '';
    msg.hidden = !err;
  }
  // a failed eval that never started the scheduler must not leave a phantom
  // "now playing" state (a failed *re*-eval keeps the old pattern running)
  if (err && state.playingId === trackId && !isStarted(trackId)) {
    state.playingId = null;
    renderTracks();
    renderTransport();
  }
}

// --- playback (one StrudelMirror per track; solo mode keeps it exclusive) --
async function play(track) {
  state.playingId = track.id;
  renderTracks();
  renderTransport();
  await ready; // audio context unlocks via this click
  if (state.playingId !== track.id) return; // user moved on while samples loaded
  const editor = ensureEditor(track);
  codeSection(track).open = true; // reveal the editor so highlighting is visible
  editor.evaluate();
}

function stop() {
  getEditor(state.playingId)?.stop(); // onToggle clears state; next line covers the not-yet-evaluated case
  state.playingId = null;
  renderTracks();
  renderTransport();
}

// --- ratings --------------------------------------------------------------
async function putRating(track, patch) {
  const body = {
    rating: 'rating' in patch ? patch.rating : track.rating,
    notes: 'notes' in patch ? patch.notes : track.notes,
    lesson: 'lesson' in patch ? patch.lesson : track.lesson,
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
  track.lesson = saved.lesson;
}

const debounce = (fn, ms) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

const flashError = (el) => {
  el.classList.add('error');
  setTimeout(() => el.classList.remove('error'), 1200);
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
    m.energy && '▮'.repeat(Math.min(m.energy, 5)) + '▯'.repeat(Math.max(0, 5 - m.energy)),
    m.mood,
  ].filter(Boolean);
  for (const value of chipValues) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = value;
    chips.appendChild(chip);
  }

  const rate = document.createElement('div');
  rate.className = 'rate';
  for (let n = 1; n <= 5; n++) {
    const b = document.createElement('button');
    b.className = 'block' + (track.rating != null && n <= track.rating ? ' on' : '');
    b.title = `${n}/5`;
    b.addEventListener('click', async () => {
      try {
        await putRating(track, { rating: track.rating === n ? null : n }); // click again to clear
      } catch (err) {
        console.error(err);
        flashError(card);
        return;
      }
      // update blocks in place — a full re-render would wipe unsaved notes in other cards
      rate.querySelectorAll('.block').forEach((el, i) =>
        el.classList.toggle('on', track.rating != null && i < track.rating),
      );
    });
    rate.appendChild(b);
  }

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

  const code = codeSection(track);

  card.append(playBtn, meta, rate, feedback, code);
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
