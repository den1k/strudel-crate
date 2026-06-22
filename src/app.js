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
import { aggregateAvg, isTopAggregate, myRatingOf } from './ratings.js';

const $ = (sel, el = document) => el.querySelector(sel);

export async function initApp({ namespace, emptyHint, splitStems = false }) {
  const state = { tracks: [], playingId: null, playingSpec: null, samplesReady: false, batch: 'all', filter: 'all', playsBySlug: {}, myRatings: {} };
  let playTimer = null; // pending "count this play" timer (fires after 4s of playback)
  let myProfileId = null;

  // scrubber DOM + loop state (elements exist in the footer of both pages)
  const seekbar = $('#seekbar');
  const rail = $('#seek-rail');
  const fill = $('#seek-fill');
  const elapsedEl = $('#elapsed');
  const totalEl = $('#total');
  let rafId = null;
  let scrubbing = false;

  const collection = namespace; // 'tracks' | 'stems'
  const urlBatch = new URLSearchParams(location.search).get('batch');
  if (urlBatch) state.batch = urlBatch;

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
  }

  // --- notes ---------------------------------------------------------------
  async function putNotes(track, patch) {
    const res = await fetch(`/api/${namespace}/${track.id}/notes`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`save failed: ${res.status}`);
    const saved = await res.json();
    track.notes = saved.notes;
    track.lesson = saved.lesson;
  }

  // --- ratings --------------------------------------------------------------
  async function putRating(track, value) {
    const res = await fetch(`/api/${namespace}/${track.id}/rating`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });
    if (!res.ok) throw new Error(`save failed: ${res.status}`);
    const saved = await res.json(); // { you, avg, count }
    state.myRatings = { ...state.myRatings, [track.id]: saved.you };
    track.ratingSum = saved.count ? Math.round(saved.avg * saved.count) : 0;
    track.ratingCount = saved.count;
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

  // Group into version families, then filter by the LATEST version's props so a
  // whole family shows/hides as a unit (all versions share a batch).
  function visibleFamilies() {
    return groupVersions(state.tracks).filter((fam) => {
      const t = fam.latest;
      if (state.batch !== 'all' && t.batch !== state.batch) return false;
      if (state.filter === 'unrated') return myRatingOf(state, t.id) == null;
      if (state.filter === 'top') return isTopAggregate(t);
      if (state.filter === 'mine') return myProfileId != null && t.authorProfileId === myProfileId;
      return true;
    });
  }

  // Remembers which version the user switched a family to, so a full
  // renderTracks() (e.g. when a play/rating bumps a row) doesn't snap the card
  // back to the latest version. Keyed by family root id → selected version id.
  const selectedByFamily = new Map();

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
      if (track.remixOf) {
        const src = state.tracks.find((t) => t.id === track.remixOf);
        const from = document.createElement('a');
        from.className = 'remix-from';
        from.href = songUrl(src ? src.entityId : track.remixOf);
        from.textContent = `remixed from ${track.remixOf}`;
        meta.querySelector('h3').after(from);
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
      if (document.querySelector('#gen-prompt')) {
        const remixBtn = document.createElement('button');
        remixBtn.className = 'export remix';
        remixBtn.textContent = '⎋ remix';
        remixBtn.title = 'remix this into a new song you own';
        remixBtn.addEventListener('click', async () => {
          const instructions = prompt(`Remix "${track.title}" — describe the changes:`);
          if (!instructions || !instructions.trim()) return;
          if (instructions.includes('"')) { flashError(card); return; }
          try {
            const res = await fetch('/api/jobs', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ type: 'remix', namespace, slug: track.id, instructions: instructions.trim() }),
            });
            if (!res.ok) { flashError(card); return; }
          } catch { flashError(card); }
        });
        exportRow.appendChild(remixBtn);
      }
      meta.appendChild(exportRow);

      const rate = document.createElement('div');
      rate.className = 'rate';
      const mine = myRatingOf(state, track.id);
      const signedIn = !!myProfileId;
      for (let n = 1; n <= 5; n++) {
        const b = document.createElement('button');
        b.className = 'block' + (mine != null && n <= mine ? ' on' : '');
        b.title = signedIn ? `${n}/5` : 'sign in to rate';
        b.disabled = !signedIn;
        b.addEventListener('click', async () => {
          const cur = myRatingOf(state, track.id);
          try {
            await putRating(track, cur === n ? null : n);
          } catch (err) { console.error(err); flashError(card); return; }
          renderTracks();
        });
        rate.appendChild(b);
      }
      const badge = document.createElement('span');
      badge.className = 'agg';
      const avg = aggregateAvg(track);
      badge.textContent = avg != null ? `★ ${avg} · ${track.ratingCount}` : 'unrated';
      badge.title = avg != null ? `${track.ratingCount} rating(s)` : 'no ratings yet';
      rate.appendChild(badge);

      const autosaveArea = (className, placeholder, value, field) => {
        const ta = document.createElement('textarea');
        ta.className = className;
        ta.placeholder = placeholder;
        ta.value = value ?? '';
        const save = debounce(async () => {
          try {
            await putNotes(track, { [field]: ta.value });
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

      const ownerId = track.author?.[0]?.id ?? null;
      const isOwner = myProfileId != null && ownerId === myProfileId;

      const feedback = document.createElement('div');
      feedback.className = 'feedback';
      if (isOwner) {
        feedback.append(
          autosaveArea('notes', 'notes — what works, what to change… (this track only)', track.notes, 'notes'),
          autosaveArea('notes lesson', 'lesson for future tracks — applies to every new batch…', track.lesson, 'lesson'),
        );
      }

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
    const showSeek = !!playing && hasTimeline(state.playingSpec);
    seekbar.hidden = !showSeek;
    if (showSeek) totalEl.textContent = mmss(state.playingSpec.seconds);
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

  // --- boot --------------------------------------------------------------
  $('#stop').addEventListener('click', stop);
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

  // --- live data from Instant ------------------------------------------------
  function applyRows(rows) {
    state.tracks = rows.map(mapRow);
    renderBatchFilter();
    renderTracks();
    renderTransport();
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

  // Track the signed-in user → reveal "mine", resolve their profile id, and
  // subscribe to their plays (slug → count) for the per-user counters + dots.
  const mineBtn = document.querySelector('.seg button[data-filter="mine"]');
  let profileUnsub = null;
  let playsUnsub = null;
  let ratingsUnsub = null;
  const stopPlays = () => { if (playsUnsub) { playsUnsub(); playsUnsub = null; } state.playsBySlug = {}; };
  const stopRatings = () => { if (ratingsUnsub) { ratingsUnsub(); ratingsUnsub = null; } state.myRatings = {}; };
  onUser((user) => {
    if (mineBtn) mineBtn.hidden = !user;
    if (profileUnsub) { profileUnsub(); profileUnsub = null; }
    stopPlays();
    stopRatings();
    myProfileId = null;
    if (user && db) {
      profileUnsub = db.subscribeQuery(
        { profiles: { $: { where: { 'user.id': user.id } } } },
        (res) => {
          const pid = res.data?.profiles?.[0]?.id ?? null;
          if (pid !== myProfileId) {
            myProfileId = pid;
            stopPlays();
            stopRatings();
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
              ratingsUnsub = db.subscribeQuery(
                { ratings: { $: { where: { 'profile.id': pid, namespace } } } },
                (r) => {
                  const map = {};
                  for (const rr of r.data?.ratings ?? []) map[rr.slug] = rr.value;
                  state.myRatings = map;
                  renderTracks();
                },
              );
            }
          }
          if (state.filter === 'mine') renderTracks();
        },
      );
    }
    if (state.filter === 'mine') renderTracks();
  });

  const { mountJobsUI } = await import('./jobs-ui.js');
  mountJobsUI({ collection, onBatchDone: () => { /* subscription updates live */ } });
}
