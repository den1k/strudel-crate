import { getAudioContext } from '@strudel/webaudio';
import { mountEditor, getEditor, isStarted, cyclePosition, seekEditor } from './editor.js';
import { nextPlayingId } from './playing-state.js';
import { exportTrack, isExporting } from './export.js';
import { groupVersions } from './versions.js';
import { exportSpec } from './export-spec.js';
import { mmss, hasTimeline, fractionToCycle, progressFraction, isFinished } from './transport.js';
import { db } from './db.js';
import { onUser } from './auth.js';
import { bootStrudel } from './strudel-boot.js';
import { songUrl } from './song-url.js';
import { readViewParams, buildSearch } from './view-url.js';
import { saveListState, loadListState } from './list-state.js';

const $ = (sel, el = document) => el.querySelector(sel);

export async function initApp({ namespace, emptyHint, splitStems = false }) {
  // cuedId/cuedSpec: a song primed in the footer transport (from a ?play= link)
  // but not yet started — the footer button shows ▶ PLAY and one click starts it.
  const state = { tracks: [], playingId: null, playingSpec: null, cuedId: null, cuedSpec: null, samplesReady: false, batch: 'all', filter: 'all', user: null, playsBySlug: {} };
  let playTimer = null; // pending "count this play" timer (fires after 4s of playback)
  let myProfileId = null;
  // The auth-gated "mine" button — a one-click shortcut into the author axis.
  // Resolved up front so the filter wiring and renderUserFilter() can use it.
  const mineBtn = document.querySelector('.seg button[data-filter="mine"]');

  // scrubber DOM + loop state (elements exist in the footer of both pages)
  const seekbar = $('#seekbar');
  const rail = $('#seek-rail');
  const fill = $('#seek-fill');
  const elapsedEl = $('#elapsed');
  const totalEl = $('#total');
  let rafId = null;
  let scrubbing = false;

  const collection = namespace; // 'tracks' | 'stems'
  // The URL is the authoritative source of view state (see view-url.js). Each
  // field is null when its param is absent; we apply the non-null ones below.
  const urlView = readViewParams(location.search);
  if (urlView.batch) state.batch = urlView.batch;
  if (urlView.filter) state.filter = urlView.filter;
  if (urlView.user) state.user = urlView.user;
  // The play param cues a song after first content (see applyRows); it is read
  // only from the URL, never from the sessionStorage restore.
  const cueEntityId = urlView.play;

  // --- list state restoration (see list-state.js) --------------------------
  // Take scroll control away from the browser: the list height is unknown at
  // load (Instant streams it in), so the browser's own restore would fire too
  // early and land at the top. We restore manually once the list has height.
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  // Restore on a genuine Back/Forward nav (browser back button) OR when we
  // arrived here straight from a song page — the song page's "← back to crate"
  // / "← back to stems" links and header nav are plain forward navigations, so
  // they don't count as back_forward, but they're a "return to the list" intent
  // all the same. A fresh reload or external entry restores nothing.
  const navType = performance.getEntriesByType('navigation')[0]?.type;
  const cameFromSong = (() => {
    try {
      const ref = document.referrer ? new URL(document.referrer) : null;
      return !!ref && ref.origin === location.origin && /^\/song\//.test(ref.pathname);
    } catch {
      return false;
    }
  })();
  const restored = navType === 'back_forward' || cameFromSong ? loadListState(namespace) : null;
  if (restored) {
    // Precedence per axis: URL param wins, else honor what we left on. (Going
    // Back to a list page replays its ?query via replaceState, so the URL
    // usually already carries the left-on view; the restore covers older
    // snapshots and the bare-path case.)
    if (!urlView.batch) state.batch = restored.batch;
    if (!urlView.filter) state.filter = restored.filter;
    if (!urlView.user) state.user = restored.user ?? null;
  }
  // One-shot: restore scroll only on the first render that produced content,
  // so later live Instant pushes never yank the user's scroll (set below).
  let pendingScrollRestore = !!restored;

  let toastTimer = null;
  function showToast(message) {
    let toast = document.querySelector('.toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('on');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('on'), 1600);
  }

  async function shareTrack(track) {
    const url = location.origin + songUrl(track.entityId);
    if (navigator.share) {
      try { await navigator.share({ title: track.title, url }); } catch { /* cancelled */ }
      return;
    }
    try { await navigator.clipboard.writeText(url); showToast('Link copied'); }
    catch { showToast('Copy failed'); }
  }

  // --- strudel init: one shared runtime for every page (see strudel-boot.js) -
  const ready = bootStrudel();
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
    if (!next) {
      state.playingSpec = null;
      stopSeekLoop();
    }
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
      state.playingSpec = null;
      stopSeekLoop();
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

  // --- scrubber: rAF position loop + pointer seeking ------------------------
  // The single-track /song page reimplements this loop in song.js's
  // wirePlayback() — keep the two in sync when changing seek behavior.
  function paintSeek(fraction, elapsedSeconds) {
    fill.style.width = `${(fraction * 100).toFixed(2)}%`;
    elapsedEl.textContent = mmss(elapsedSeconds);
    rail.setAttribute('aria-valuenow', Math.round(fraction * 100));
  }

  function startSeekLoop() {
    if (rafId != null) return;
    const tick = () => {
      rafId = requestAnimationFrame(tick);
      if (scrubbing || !hasTimeline(state.playingSpec)) return;
      const cycle = cyclePosition(state.playingId);
      if (cycle == null) return;
      const spec = state.playingSpec;
      // The Cyclist loops the arrangement; stop at its end so audio doesn't
      // replay past the duration shown on the bar.
      if (isFinished(cycle, spec.cycles)) { stop(); return; }
      paintSeek(progressFraction(cycle, spec.cycles), cycle / spec.cps);
    };
    rafId = requestAnimationFrame(tick);
  }

  function stopSeekLoop() {
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = null;
    scrubbing = false;
    paintSeek(0, 0);
  }

  function seekToPointer(e) {
    const spec = state.playingSpec;
    if (!hasTimeline(spec) || !state.playingId) return;
    const rect = rail.getBoundingClientRect();
    const fraction = rect.width ? (e.clientX - rect.left) / rect.width : 0;
    const clamped = Math.min(1, Math.max(0, fraction));
    seekEditor(state.playingId, fractionToCycle(clamped, spec.cycles));
    paintSeek(clamped, clamped * spec.seconds); // immediate feedback; loop is paused while scrubbing
  }

  // --- playback (one StrudelMirror per track; solo mode keeps it exclusive) --
  async function play(track) {
    clearTimeout(playTimer);
    // Starting playback consumes any cued/ready song (incl. this one).
    state.cuedId = null;
    state.cuedSpec = null;
    document.querySelector('.track.cued')?.classList.remove('cued');
    state.playingId = track.id;
    // exportSpec assumes track.meta.bpm; a stem without it throws → no timeline
    state.playingSpec = (() => {
      try {
        return exportSpec(track);
      } catch {
        return null;
      }
    })();
    updatePlayingUi();
    renderTransport();
    syncUrl(); // surface the now-playing song in the address bar
    await ready; // audio context unlocks via this click
    if (state.playingId !== track.id) return; // user moved on while samples loaded
    await getAudioContext().resume(); // post-export contexts start suspended
    // editor mounts hidden inside the closed <details>; the user opens it
    // explicitly when they want to watch the code (keeps cards compact)
    const editor = ensureEditor(track);
    editor.evaluate();
    startSeekLoop();
    // Count a play only once it has survived 4s of continuous playback.
    playTimer = setTimeout(() => {
      if (state.playingId === track.id && isStarted(track.id)) {
        fetch(`/api/${namespace}/${track.id}/play`, { method: 'POST' }).catch(() => {});
      }
    }, 4000);
  }

  function stop() {
    clearTimeout(playTimer);
    getEditor(state.playingId)?.stop(); // onToggle clears state; next line covers the not-yet-evaluated case
    state.playingId = null;
    state.playingSpec = null;
    stopSeekLoop();
    updatePlayingUi();
    renderTransport();
    syncUrl(); // drop the ?play= param now that nothing is playing
  }

  // --- ratings --------------------------------------------------------------
  async function putRating(track, patch) {
    const body = {
      rating: 'rating' in patch ? patch.rating : track.rating,
      notes: 'notes' in patch ? patch.notes : track.notes,
      lesson: 'lesson' in patch ? patch.lesson : track.lesson,
    };
    const res = await fetch(`/api/${namespace}/${track.id}/rating`, {
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
  // Present each Instant entity to the render code as { ...fields, id: slug }.
  // InstaQL returns a link as a list, so unwrap the single author either way.
  function mapRow(row) {
    const author = Array.isArray(row.author) ? row.author[0] : row.author;
    return {
      ...row,
      id: row.slug,
      entityId: row.id, // globally-unique Instant id; the /song URL uses this, not the slug
      artistName: author?.artistName ?? null,
      authorProfileId: author?.id ?? null,
    };
  }

  // Mirror the current view state into the address bar so it's copyable (see
  // view-url.js). The `play` param is the entity id, resolved from the playing
  // slug via state.tracks. replaceState (never pushState) so filtering and
  // play/stop don't spam Back history. Called on every view-state change.
  function syncUrl() {
    const playing = state.tracks.find((t) => t.id === state.playingId);
    const search = buildSearch({
      batch: state.batch,
      filter: state.filter,
      user: state.user,
      play: playing?.entityId ?? null,
    });
    history.replaceState(null, '', location.pathname + search);
  }

  // Group into version families, then filter by the LATEST version's props so a
  // whole family shows/hides as a unit (all versions share a batch). The rating
  // axis (state.filter) and the author axis (state.user) compose with AND.
  function visibleFamilies() {
    return groupVersions(state.tracks).filter((fam) => {
      const t = fam.latest;
      if (state.batch !== 'all' && t.batch !== state.batch) return false;
      if (state.user && t.authorProfileId !== state.user) return false;
      if (state.filter === 'unrated') return t.rating == null;
      if (state.filter === 'top') return (t.rating ?? 0) >= 4;
      return true;
    });
  }

  // Remembers which version the user switched a family to, so a full
  // renderTracks() (e.g. when a play/rating bumps a row) doesn't snap the card
  // back to the latest version. Keyed by family root id → selected version id.
  const selectedByFamily = new Map();
  // Rehydrate the per-family version choices so restored cards mount on the
  // version the user had selected (trackCard falls back to latest if gone).
  if (restored) for (const [fam, ver] of restored.selectedByFamily) selectedByFamily.set(fam, ver);

  // Tap-away closes any open plays breakdown (mobile). The plays element's own
  // click calls stopPropagation, so tapping it never reaches this handler.
  document.addEventListener('click', () => {
    for (const el of document.querySelectorAll('.plays.open')) el.classList.remove('open');
  });

  function trackCard(family) {
    const card = document.createElement('article');
    card.className = 'track';
    // Default to the latest version, but honor a prior in-session selection
    // (falling back to latest if that version no longer exists).
    const chosen = family.versions.find((v) => v.id === selectedByFamily.get(family.family));
    let active = chosen ?? family.latest;

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
      meta.innerHTML = `<h3></h3><span class="id"></span><span class="plays"></span><p class="desc"></p><div class="chips"></div>`;
      const titleLink = document.createElement('a');
      titleLink.className = 'title-link';
      titleLink.href = songUrl(track.entityId);
      titleLink.textContent = track.title;
      $('h3', meta).appendChild(titleLink);
      $('.id', meta).textContent = track.id;
      const playsEl = $('.plays', meta);
      const total = track.playCount ?? 0;
      const totalLabel = `▶ ${total} ${total === 1 ? 'play' : 'plays'}`;
      if (myProfileId != null) {
        const you = state.playsBySlug[track.id] ?? 0; // track.id === slug
        const others = Math.max(0, total - you); // everyone else: other users + anons
        // Hover (desktop) / tap (mobile) swaps the total for a you-vs-others breakdown.
        playsEl.classList.add('has-breakdown');
        playsEl.innerHTML = '<span class="plays-total"></span><span class="plays-breakdown"></span>';
        $('.plays-total', playsEl).textContent = totalLabel;
        $('.plays-breakdown', playsEl).textContent = `you ${you} · others ${others}`;
        playsEl.addEventListener('click', (e) => { e.stopPropagation(); playsEl.classList.toggle('open'); });
        if (!(you > 0)) {
          const dot = document.createElement('span');
          dot.className = 'unplayed-dot';
          dot.title = "you haven't played this yet";
          $('h3', meta).prepend(dot);
        }
      } else {
        playsEl.textContent = totalLabel;
      }
      $('.desc', meta).textContent = track.description ?? '';
      if (track.artistName) {
        const by = document.createElement('span');
        by.className = 'by';
        by.textContent = `by ${track.artistName}`;
        meta.querySelector('h3').after(by);
      }
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
            selectedByFamily.set(family.family, v.id);
            active = v;
            mountBody();
          });
          versions.appendChild(b);
        }
        meta.appendChild(versions);
      }

      const exportRow = document.createElement('div');
      exportRow.className = 'exports';
      for (const fmt of splitStems ? ['wav', 'mp3', 'stems'] : ['wav', 'mp3']) {
        const btn = document.createElement('button');
        btn.className = 'export';
        btn.textContent = `↓ ${fmt}`;
        btn.title =
          fmt === 'wav'
            ? 'download lossless wav'
            : fmt === 'mp3'
              ? 'download mp3 192kbps'
              : 'download per-sound 24-bit stems (zip)';
        btn.addEventListener('click', async () => {
          if (isExporting()) return;
          document.querySelectorAll('button.export').forEach((el) => (el.disabled = true));
          const label = btn.textContent;
          try {
            await exportTrack(track, fmt, {
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
      const shareBtn = document.createElement('button');
      shareBtn.className = 'export share';
      shareBtn.textContent = '⤴ share';
      shareBtn.title = 'copy link to this song';
      shareBtn.addEventListener('click', () => shareTrack(track));
      exportRow.appendChild(shareBtn);
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
    // When nothing is playing, a cued song (from a ?play= link) is shown "ready".
    const cued = !playing && state.cuedId ? state.tracks.find((t) => t.id === state.cuedId) : null;
    const current = playing ?? cued;
    const spec = playing ? state.playingSpec : cued ? state.cuedSpec : null;
    $('#now-playing').textContent = playing
      ? `NOW PLAYING — ${playing.title}`
      : cued
        ? `READY — ${cued.title}`
        : '';
    // The footer button is a play/stop toggle: ▶ PLAY when a song is cued,
    // ■ STOP while one is playing, and disabled when nothing is loaded.
    const btn = $('#stop');
    btn.textContent = playing ? '■ STOP' : '▶ PLAY';
    btn.disabled = !current;
    btn.classList.toggle('is-play', !!cued);
    const showSeek = !!current && hasTimeline(spec);
    seekbar.hidden = !showSeek;
    if (showSeek) {
      totalEl.textContent = mmss(spec.seconds);
      if (!playing) paintSeek(0, 0); // cued: show the rail parked at the start
    }
  }

  // Footer play/stop toggle: stop what's playing, else start the cued song.
  function transportToggle() {
    if (state.playingId) { stop(); return; }
    const cued = state.cuedId && state.tracks.find((t) => t.id === state.cuedId);
    if (cued) play(cued);
  }

  function renderBatchFilter() {
    const select = $('#batch-filter');
    select.length = 1; // keep the "all batches" option, drop any previously-added ones
    const batches = [...new Set(state.tracks.map((t) => t.batch))].sort().reverse();
    for (const b of batches) {
      const opt = document.createElement('option');
      opt.value = opt.textContent = b;
      select.appendChild(opt);
    }
    if (state.batch !== 'all') select.value = state.batch;
  }

  // Build the author dropdown from the authors present in state.tracks
  // (profileId → artistName). Names come from the public profiles data on each
  // row, so labels render for logged-out viewers too. The signed-in user's own
  // entry is suffixed "(you)" and sorted to the top; the rest sort by name.
  function renderUserFilter() {
    const select = $('#user-filter');
    if (!select) return;
    const byId = new Map();
    for (const t of state.tracks) {
      if (t.authorProfileId && t.artistName) byId.set(t.authorProfileId, t.artistName);
    }
    const authors = [...byId.entries()]
      .map(([id, name]) => ({ id, name, you: id === myProfileId }))
      .sort((a, b) => (a.you === b.you ? a.name.localeCompare(b.name) : a.you ? -1 : 1));
    select.length = 1; // keep the "all artists" option, drop previously-added ones
    for (const a of authors) {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.you ? `${a.name} (you)` : a.name;
      select.appendChild(opt);
    }
    // Reflect state.user (falls back to "all" when the author isn't present).
    select.value = state.user && byId.has(state.user) ? state.user : 'all';
  }

  // Keep the dropdown and the auth-gated "mine" button reflecting state.user:
  // mine is "on" only when the author axis is the signed-in user's own profile.
  function syncUserControls() {
    const select = $('#user-filter');
    if (select) select.value = state.user && [...select.options].some((o) => o.value === state.user) ? state.user : 'all';
    if (mineBtn) mineBtn.classList.toggle('on', state.user != null && state.user === myProfileId);
  }

  // --- boot --------------------------------------------------------------
  $('#stop').addEventListener('click', transportToggle);
  rail.addEventListener('pointerdown', (e) => {
    if (!hasTimeline(state.playingSpec)) return;
    scrubbing = true;
    rail.setPointerCapture(e.pointerId);
    seekToPointer(e);
  });
  rail.addEventListener('pointermove', (e) => {
    if (scrubbing) seekToPointer(e);
  });
  // pointercancel too: an OS-interrupted drag must clear `scrubbing`, else the
  // rAF position loop stays frozen (it yields whenever scrubbing) until replay.
  const endScrub = (e) => {
    if (!scrubbing) return;
    scrubbing = false;
    try {
      rail.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  };
  rail.addEventListener('pointerup', endScrub);
  rail.addEventListener('pointercancel', endScrub);
  $('#batch-filter').addEventListener('change', (e) => {
    state.batch = e.target.value;
    syncUrl();
    renderTracks();
  });
  // Author axis via the dropdown. Selecting "all artists" clears it; either way
  // the "mine" button is re-synced (it's just a shortcut into the same axis).
  $('#user-filter')?.addEventListener('change', (e) => {
    state.user = e.target.value === 'all' ? null : e.target.value;
    syncUserControls();
    syncUrl();
    renderTracks();
  });
  // Rating segment: mutually-exclusive all/unrated/top. The "mine" button lives
  // in the same .seg group but drives the AUTHOR axis, so it's excluded here.
  document.querySelectorAll('.seg button[data-filter]:not([data-filter="mine"])').forEach((btn) =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('.seg button[data-filter]:not([data-filter="mine"])').forEach((b) => b.classList.remove('on'));
      btn.classList.add('on');
      state.filter = btn.dataset.filter;
      syncUrl();
      renderTracks();
    }),
  );
  // "mine" → author axis shortcut: toggle the signed-in user's own profile on/off.
  mineBtn?.addEventListener('click', () => {
    if (myProfileId == null) return; // shouldn't fire (hidden when logged out)
    state.user = state.user === myProfileId ? null : myProfileId;
    syncUserControls();
    syncUrl();
    renderTracks();
  });
  // Reflect a restored rating filter on the segment controls (the batch <select>
  // is handled by renderBatchFilter(), the author axis by renderUserFilter()).
  if (restored) {
    document.querySelectorAll('.seg button[data-filter]:not([data-filter="mine"])').forEach((b) =>
      b.classList.toggle('on', b.dataset.filter === state.filter),
    );
  }
  // Write the load-time state (URL ∪ restore ∪ defaults) back so the address bar
  // is canonical from the first paint — but preserve any ?play= cue param until
  // it's consumed (syncUrl resolves play from state.playingId, which is null now).
  if (!cueEntityId) syncUrl();

  // Snapshot on leave. pagehide (not beforeunload, which iOS ignores) fires
  // reliably on iOS Safari Back, including into bfcache — the iOS-correct hook.
  window.addEventListener('pagehide', () => {
    saveListState(namespace, {
      batch: state.batch,
      filter: state.filter,
      user: state.user,
      selectedByFamily: [...selectedByFamily.entries()],
      scrollY: window.scrollY,
    });
  });

  // Cue-on-load: when the URL carries ?play=<entityId>, land the recipient on
  // that song — select its version within the family, scroll its card into view,
  // and ring it with .cued. No autoplay (browsers block it without a gesture);
  // one click on the card's ▶ starts it. Runs once on first content; if the
  // target is missing or filtered out of view, it's silently skipped.
  let pendingCue = !!cueEntityId;

  // Pick the cued version inside its family *before* the render so the card
  // mounts on the right version. Must run before renderTracks(). Returns the
  // row (entity-shaped, with .id === slug) when found & visible, else null.
  function resolveCue() {
    const row = state.tracks.find((t) => t.entityId === cueEntityId);
    if (!row) return null;
    const fam = groupVersions(state.tracks).find((f) =>
      f.versions.some((v) => v.entityId === cueEntityId),
    );
    if (!fam) return null;
    selectedByFamily.set(fam.family, row.id);
    // Honor the active filters: only cue when the family is actually visible.
    return visibleFamilies().some((f) => f.family === fam.family) ? row : null;
  }

  // --- live data from Instant ------------------------------------------------
  function applyRows(rows) {
    state.tracks = rows.map(mapRow);
    // Select the cued version before rendering so its card mounts correctly.
    let cuedRow = null;
    if (pendingCue) cuedRow = resolveCue();
    renderBatchFilter();
    renderUserFilter();
    renderTracks();
    renderTransport();
    // First render with content: run the cue (if any) or the scroll restore.
    // The cue wins — when a ?play= target exists, its scroll must not fight the
    // saved scrollY — so we only restore scroll when there's no pending cue.
    if (pendingCue && cuedRow) {
      pendingCue = false;
      pendingScrollRestore = false; // cue scroll wins over saved scrollY
      // Prime the song in the footer transport, ready to play (no autoplay).
      state.cuedId = cuedRow.id;
      state.cuedSpec = (() => { try { return exportSpec(cuedRow); } catch { return null; } })();
      renderTransport();
      const card = document.querySelector(`#tracks .track[data-id="${CSS.escape(cuedRow.id)}"]`);
      if (card) {
        card.classList.add('cued');
        requestAnimationFrame(() => card.scrollIntoView({ block: 'center' }));
      }
    } else if (pendingCue && visibleFamilies().length > 0) {
      // Target wasn't found / is filtered out: give up cueing silently, and let
      // the normal scroll restore (if any) proceed below.
      pendingCue = false;
    }
    if (pendingScrollRestore && visibleFamilies().length > 0) {
      pendingScrollRestore = false;
      requestAnimationFrame(() => window.scrollTo(0, restored.scrollY));
    }
  }

  if (!db) {
    $('#tracks').innerHTML = `<p class="empty">Instant not configured — set VITE_INSTANT_APP_ID</p>`;
  } else {
    db.subscribeQuery(
      { [namespace]: { author: {}, $: { order: { createdAt: 'desc' } } } },
      (res) => {
        if (res.error) {
          $('#tracks').innerHTML = `<p class="empty">could not load: ${res.error.message}</p>`;
          return;
        }
        if (res.data) applyRows(res.data[namespace] ?? []);
      },
    );
  }

  // Track the signed-in user → reveal "mine", resolve their profile id (for the
  // author-axis shortcut, the "(you)" dropdown label, and per-user play
  // counters), and subscribe to their plays (slug → count) for counters + dots.
  let profileUnsub = null;
  let playsUnsub = null;
  const stopPlays = () => { if (playsUnsub) { playsUnsub(); playsUnsub = null; } state.playsBySlug = {}; };
  onUser((user) => {
    if (mineBtn) mineBtn.hidden = !user;
    if (profileUnsub) { profileUnsub(); profileUnsub = null; }
    stopPlays();
    myProfileId = null;
    syncUserControls(); // signed out: hide mine, drop its .on
    if (user && db) {
      profileUnsub = db.subscribeQuery(
        { profiles: { $: { where: { 'user.id': user.id } } } },
        (res) => {
          const pid = res.data?.profiles?.[0]?.id ?? null;
          if (pid !== myProfileId) {
            myProfileId = pid;
            stopPlays();
            if (pid) {
              playsUnsub = db.subscribeQuery(
                { plays: { $: { where: { 'profile.id': pid, namespace } } } },
                (r) => {
                  const map = {};
                  for (const p of r.data?.plays ?? []) map[p.slug] = p.count;
                  state.playsBySlug = map;
                  renderTracks();
                },
              );
            }
            // myProfileId affects the dropdown's "(you)" label/sort + mine's .on.
            renderUserFilter();
            syncUserControls();
          }
        },
      );
    }
  });

  const { mountJobsUI } = await import('./jobs-ui.js');
  mountJobsUI({ collection, onBatchDone: () => { /* subscription updates live */ } });
}
