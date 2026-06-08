import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import * as tonal from '@strudel/tonal';
import * as webaudio from '@strudel/webaudio';
import { initAudioOnFirstClick, registerSynthSounds, samples, getAudioContext } from '@strudel/webaudio';
import { mountEditor, getEditor, isStarted } from './editor.js';
import { nextPlayingId } from './playing-state.js';
import { exportTrack, isExporting } from './export.js';
import { groupVersions } from './versions.js';
import banks from '../shared/sample-banks.json';

const $ = (sel, el = document) => el.querySelector(sel);

export async function initApp({ apiBase, emptyHint }) {
  const state = { tracks: [], playingId: null, samplesReady: false, batch: 'all', filter: 'all' };

  // --- strudel init: load the same banks the validator allowlists ---------
  // NOT @strudel/web: its dist inlines private copies of core/webaudio, so
  // sounds registered through it are invisible to editor.js's webaudioOutput
  // (two sound registries — silent playback). evalScope mirrors
  // scripts/strudel-env.mjs but with real audio instead of stubs, keeping the
  // webapp on the exact module instances the editors play through.
  initAudioOnFirstClick(); // resume the AudioContext on the first user gesture
  const ready = (async () => {
    await core.evalScope(core, mini, tonal, webaudio);
    await Promise.all([
      registerSynthSounds(),
      ...banks.map((b) =>
        b.shorthand
          ? samples(b.shorthand)
          : samples(b.json, b.base, { prebake: b.prebake, tag: b.tag }),
      ),
    ]);
  })();
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
      if (!section.open) return;
      // accordion: only one editor open at a time (closing fires the others'
      // toggle listeners, which no-op because they're closed)
      for (const other of codeSections.values()) {
        if (other !== section) other.open = false;
      }
      ensureEditor(track); // lazy-mount on first open
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
    updatePlayingUi();
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
      updatePlayingUi();
      renderTransport();
    }
  }

  // Flip only the playing state on existing cards — a full renderTracks() here
  // would rebuild the whole list and yank the scroll position mid-listen.
  function updatePlayingUi() {
    for (const card of document.querySelectorAll('#tracks .track')) {
      const playing = card.dataset.id === state.playingId;
      card.classList.toggle('playing', playing);
      const btn = $('.play', card);
      btn.innerHTML = playing ? '<span class="eq"><i></i><i></i><i></i></span>' : '▶';
      btn.title = playing ? 'stop' : 'play';
    }
  }

  // --- playback (one StrudelMirror per track; solo mode keeps it exclusive) --
  async function play(track) {
    state.playingId = track.id;
    updatePlayingUi();
    renderTransport();
    await ready; // audio context unlocks via this click
    if (state.playingId !== track.id) return; // user moved on while samples loaded
    await getAudioContext().resume(); // post-export contexts start suspended
    // editor mounts hidden inside the closed <details>; the user opens it
    // explicitly when they want to watch the code (keeps cards compact)
    const editor = ensureEditor(track);
    editor.evaluate();
  }

  function stop() {
    getEditor(state.playingId)?.stop(); // onToggle clears state; next line covers the not-yet-evaluated case
    state.playingId = null;
    updatePlayingUi();
    renderTransport();
  }

  // --- ratings --------------------------------------------------------------
  async function putRating(track, patch) {
    const body = {
      rating: 'rating' in patch ? patch.rating : track.rating,
      notes: 'notes' in patch ? patch.notes : track.notes,
      lesson: 'lesson' in patch ? patch.lesson : track.lesson,
    };
    const res = await fetch(`${apiBase}/${track.id}/rating`, {
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

  // short, human date for version labels, e.g. "Jun 8"
  const fmtDate = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? ''
      : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  // --- rendering --------------------------------------------------------------
  // Group into version families, then filter by the LATEST version's props so a
  // whole family shows/hides as a unit (all versions share a batch).
  function visibleFamilies() {
    return groupVersions(state.tracks).filter((fam) => {
      const t = fam.latest;
      if (state.batch !== 'all' && t.batch !== state.batch) return false;
      if (state.filter === 'unrated') return t.rating == null;
      if (state.filter === 'top') return (t.rating ?? 0) >= 4;
      return true;
    });
  }

  function trackCard(family) {
    const card = document.createElement('article');
    card.className = 'track';
    let active = family.latest; // spec: default to the latest version

    mountBody();
    return card;

    function mountBody() {
      card.dataset.id = active.id;
      card.classList.toggle('playing', active.id === state.playingId);
      const track = active; // body below is per-version, keyed on `active`

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

      // version switcher — only when the family has more than one version
      if (family.versions.length > 1) {
        const versions = document.createElement('div');
        versions.className = 'versions';
        for (const v of family.versions) {
          const b = document.createElement('button');
          b.className = 'version' + (v.id === active.id ? ' on' : '');
          b.textContent = `v${v.version} · ${fmtDate(v.createdAt)}`;
          b.title = `version ${v.version} — ${v.createdAt}`;
          b.addEventListener('click', () => {
            if (v.id === active.id) return;
            active = v;
            mountBody();
          });
          versions.appendChild(b);
        }
        meta.appendChild(versions);
      }

      const exportRow = document.createElement('div');
      exportRow.className = 'exports';
      for (const fmt of ['wav', 'mp3']) {
        const btn = document.createElement('button');
        btn.className = 'export';
        btn.textContent = `↓ ${fmt}`;
        btn.title = fmt === 'wav' ? 'download lossless wav' : 'download mp3 192kbps';
        btn.addEventListener('click', async () => {
          if (isExporting()) return;
          document.querySelectorAll('button.export').forEach((el) => (el.disabled = true));
          const label = btn.textContent;
          try {
            await exportTrack(track, fmt, {
              stopPlayback: stop,
              onStatus: (s) => (btn.textContent = s),
            });
          } catch (err) {
            console.error(err);
            flashError(card);
          } finally {
            btn.textContent = label;
            document.querySelectorAll('button.export').forEach((el) => (el.disabled = false));
          }
        });
        exportRow.appendChild(btn);
      }
      meta.appendChild(exportRow);

      const rate = document.createElement('div');
      rate.className = 'rate';
      for (let n = 1; n <= 5; n++) {
        const b = document.createElement('button');
        b.className = 'block' + (track.rating != null && n <= track.rating ? ' on' : '');
        b.title = `${n}/5`;
        b.addEventListener('click', async () => {
          try {
            await putRating(track, { rating: track.rating === n ? null : n });
          } catch (err) {
            console.error(err);
            flashError(card);
            return;
          }
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

      card.replaceChildren(playBtn, meta, rate, feedback, code);
    }
  }

  function renderTracks() {
    const main = $('#tracks');
    main.replaceChildren();
    const families = visibleFamilies();
    if (families.length === 0) {
      main.innerHTML = `<p class="empty">nothing here — ${emptyHint}</p>`;
      return;
    }
    const byBatch = new Map();
    for (const fam of families) {
      const batch = fam.latest.batch;
      if (!byBatch.has(batch)) byBatch.set(batch, []);
      byBatch.get(batch).push(fam);
    }
    for (const [batch, list] of [...byBatch.entries()].sort().reverse()) {
      const section = document.createElement('section');
      section.className = 'batch';
      const h2 = document.createElement('h2');
      h2.textContent = batch;
      const promptSpan = document.createElement('span');
      promptSpan.textContent = list[0].latest.prompt;
      h2.appendChild(promptSpan);
      section.appendChild(h2);
      list.forEach((fam) => section.appendChild(trackCard(fam)));
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
    const res = await fetch(apiBase);
    state.tracks = await res.json();
    renderBatchFilter();
    renderTracks();
    renderTransport();
  } catch (err) {
    $('#tracks').innerHTML = `<p class="empty">API unreachable — is <code>npm run dev</code> running? (${err.message})</p>`;
  }
}
