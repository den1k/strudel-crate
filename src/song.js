// The dedicated single-song page at /song/<slug>. Reuses the shared Strudel
// runtime (strudel-boot), the StrudelMirror editor (editor.js) and the pure
// transport helpers (transport.js) so playback matches the list pages.
import { getAudioContext } from '@strudel/webaudio';
import { mountEditor, getEditor, cyclePosition, seekEditor, panic } from './editor.js';
import { bootStrudel } from './strudel-boot.js';
import { exportSpec } from './export-spec.js';
import { groupVersions } from './versions.js';
import { mmss, hasTimeline, fractionToCycle, progressFraction, isFinished } from './transport.js';
import { idFromPath, songUrl } from './song-url.js';
import { db } from './db.js';

const $ = (sel, el = document) => el.querySelector(sel);
const NAMESPACES = ['tracks', 'stems'];

function renderEmpty(message) {
  $('#song').innerHTML = `<p class="empty">${message}</p>`;
}

// Map an Instant row to the render shape ({ ...fields, id: slug, artistName }).
// Mirrors app.js's mapRow; the slug is the identity editor.js/exportSpec use.
function mapRow(row) {
  const author = Array.isArray(row.author) ? row.author[0] : row.author;
  return { ...row, id: row.slug, entityId: row.id, artistName: author?.artistName ?? null };
}

// Resolve a URL param to { ns, item }. New links carry the globally-unique
// entity id, so we look that up first (no cross-namespace ambiguity). Older
// links carry the prompt slug; we fall back to that (tracks win on the rare
// slug collision) so previously-shared URLs keep working.
async function resolveItem(param) {
  for (const ns of NAMESPACES) {
    const res = await db.queryOnce({ [ns]: { author: {}, $: { where: { id: param } } } });
    const row = res.data?.[ns]?.[0];
    if (row) return { ns, item: mapRow(row) };
  }
  for (const ns of NAMESPACES) {
    const res = await db.queryOnce({ [ns]: { author: {}, $: { where: { slug: param } } } });
    const row = res.data?.[ns]?.[0];
    if (row) return { ns, item: mapRow(row) };
  }
  return null;
}

// The version family for an item: rows in the same namespace whose slug or
// versionOf equals the family root. Returns the matching family or null.
async function fetchFamily(ns, item) {
  const root = item.versionOf ?? item.id;
  const res = await db.queryOnce({
    [ns]: { $: { where: { or: [{ slug: root }, { versionOf: root }] } } },
  });
  const rows = (res.data?.[ns] ?? []).map((r) => ({ ...r, id: r.slug, entityId: r.id }));
  return groupVersions(rows).find((f) => f.versions.some((v) => v.id === item.id)) ?? null;
}

async function shareSong(item) {
  const url = location.origin + songUrl(item.entityId);
  if (navigator.share) {
    try { await navigator.share({ title: item.title, url }); } catch { /* user cancelled */ }
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    showToast('Link copied');
  } catch {
    showToast('Copy failed');
  }
}

let toastTimer = null;
function showToast(message) {
  let toast = $('.toast');
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

function renderSong(item, ns, family, ready) {
  const isStem = ns === 'stems';
  document.title = `${item.title} — STRUDEL`;

  // Reflect the namespace in the masthead (STRUDEL/SONG vs STRUDEL/STEM).
  const brandH1 = $('.masthead .brand h1');
  if (brandH1) brandH1.lastChild.textContent = isStem ? 'STEM' : 'SONG';

  const root = $('#song');
  root.innerHTML = '';

  const back = document.createElement('a');
  back.className = 'song-back';
  back.href = isStem ? '/stems' : '/';
  // ︎ (text variation selector) keeps the arrow monochrome on iOS, not emoji.
  back.textContent = isStem ? '←︎ back to stems' : '←︎ back to crate';
  root.appendChild(back);

  const head = document.createElement('div');
  head.className = 'song-head';
  const playBtn = document.createElement('button');
  playBtn.className = 'play song-play';
  playBtn.innerHTML = '▶︎'; // ▶ + U+FE0E text selector → monochrome on iOS
  playBtn.title = 'play';
  const title = document.createElement('div');
  title.className = 'song-title';
  const h2 = document.createElement('h2');
  h2.textContent = item.title;
  title.appendChild(h2);
  if (item.artistName) {
    const by = document.createElement('span');
    by.className = 'by';
    by.textContent = `by ${item.artistName}`;
    title.appendChild(by);
  }
  if (item.remixOf) {
    const from = document.createElement('a');
    from.className = 'remix-from';
    from.href = songUrl(item.remixOf);
    from.textContent = `remixed from ${item.remixOf}`;
    title.appendChild(from);
  }
  head.append(playBtn, title);
  root.appendChild(head);

  // Download + share row, mirroring the list pages (tracks also offer a per-sound
  // stems zip; a stem is a single sound, so its zip would just duplicate the wav).
  const exportRow = document.createElement('div');
  exportRow.className = 'exports song-exports';
  const splitStems = ns === 'tracks';
  for (const fmt of splitStems ? ['wav', 'mp3', 'stems'] : ['wav', 'mp3']) {
    const btn = document.createElement('button');
    btn.className = 'export';
    btn.textContent = `↓︎ ${fmt}`;
    btn.title =
      fmt === 'wav'
        ? 'download lossless wav'
        : fmt === 'mp3'
          ? 'download mp3 192kbps'
          : 'download per-sound 24-bit stems (zip)';
    btn.addEventListener('click', () => {
      // Server renders+caches; the browser downloads the file. No client render.
      const url = `/api/${ns}/${item.entityId}/audio.${fmt}`;
      const a = document.createElement('a');
      a.href = url;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
    exportRow.appendChild(btn);
  }
  const share = document.createElement('button');
  share.className = 'export song-share';
  share.textContent = '⤴︎ share';
  share.title = 'copy link to this song';
  share.addEventListener('click', () => shareSong(item));
  exportRow.appendChild(share);
  root.appendChild(exportRow);

  const meta = document.createElement('div');
  meta.className = 'song-meta';
  const m = item.meta ?? {};
  const chipValues = [
    m.genre,
    m.bpm && `${m.bpm} bpm`,
    m.key,
    m.mood,
    m.energy && '▮'.repeat(Math.min(m.energy, 5)) + '▯'.repeat(Math.max(0, 5 - m.energy)),
    (m.instruments ?? []).join(' · ') || null,
  ].filter(Boolean);
  const chips = document.createElement('div');
  chips.className = 'chips';
  for (const v of chipValues) {
    const c = document.createElement('span');
    c.className = 'chip';
    c.textContent = v;
    chips.appendChild(c);
  }
  meta.appendChild(chips);
  if (item.description) {
    const d = document.createElement('p');
    d.className = 'desc';
    d.textContent = item.description;
    meta.appendChild(d);
  }
  if (item.prompt) {
    const p = document.createElement('p');
    p.className = 'song-prompt';
    p.textContent = `prompt: ${item.prompt}`;
    meta.appendChild(p);
  }
  if (item.notes) {
    const label = document.createElement('span');
    label.className = 'creator-notes-label';
    label.textContent = "creator's notes";
    meta.appendChild(label);
    const notes = document.createElement('p');
    notes.className = 'creator-notes';
    notes.textContent = item.notes;
    meta.appendChild(notes);
  }
  root.appendChild(meta);

  const editorWrap = document.createElement('div');
  editorWrap.className = 'song-editor';
  editorWrap.innerHTML = `<p class="eval-error" hidden></p><div class="editor"></div>`;
  root.appendChild(editorWrap);

  if (family && family.versions.length > 1) {
    const vers = document.createElement('div');
    vers.className = 'song-versions';
    const label = document.createElement('span');
    label.className = 'song-versions-label';
    label.textContent = 'versions';
    vers.appendChild(label);
    for (const v of family.versions) {
      const a = document.createElement('a');
      a.className = 'version' + (v.id === item.id ? ' on' : '');
      a.href = songUrl(v.entityId);
      a.textContent = `v${v.version}`;
      a.title = `version ${v.version} — ${v.createdAt}`;
      vers.appendChild(a);
    }
    root.appendChild(vers);
  }

  wirePlayback(item, playBtn, editorWrap, ready);
}

// Play/stop + seek for the page's single track. Mirrors app.js's scrubber but
// against one editor (no multi-track switching).
function wirePlayback(item, playBtn, editorWrap, ready) {
  const rail = $('#seek-rail');
  const fill = $('#seek-fill');
  const elapsedEl = $('#elapsed');
  const totalEl = $('#total');
  const seekbar = $('#seekbar');
  const stopBtn = $('#stop');
  const nowPlaying = $('#now-playing');

  let spec = null;
  try { spec = exportSpec(item); } catch { spec = null; }
  let rafId = null;
  let scrubbing = false;
  let playingNow = false;   // synchronous "is playing" flag for the click toggles
  let pausedCycle = null;   // resume point while paused (null = idle, replays from 0)

  function paintSeek(fraction, elapsedSeconds) {
    fill.style.width = `${(fraction * 100).toFixed(2)}%`;
    elapsedEl.textContent = mmss(elapsedSeconds);
    rail.setAttribute('aria-valuenow', Math.round(fraction * 100));
  }

  // Three states: playing, paused (position kept), idle. The footer button is a
  // play/pause toggle (❚❚ PAUSE / ▶ PLAY) like the list pages — never a stop.
  function showTransport(playing) {
    const paused = !playing && pausedCycle != null;
    const seekable = (playing || paused) && hasTimeline(spec);
    seekbar.hidden = !seekable;
    if (seekable) totalEl.textContent = mmss(spec.seconds);
    stopBtn.disabled = false; // a song is always loaded on this page
    stopBtn.textContent = playing ? '❚❚ PAUSE' : '▶︎ PLAY';
    stopBtn.classList.toggle('is-play', !playing);
    nowPlaying.textContent = playing
      ? `NOW PLAYING — ${item.title}`
      : paused
        ? `PAUSED — ${item.title}`
        : '';
    playBtn.innerHTML = playing ? '<span class="eq"><i></i><i></i><i></i></span>' : '▶︎';
    playBtn.classList.toggle('playing', playing); // acid bg so the dark eq bars are visible
    playBtn.title = playing ? 'pause' : 'play';
    // Park the rail when not playing: at the resume point if paused, else 0.
    if (!playing && hasTimeline(spec)) {
      const cyc = pausedCycle ?? 0;
      paintSeek(progressFraction(cyc, spec.cycles), cyc / spec.cps);
    }
  }

  function startSeekLoop() {
    if (rafId != null) return;
    const tick = () => {
      rafId = requestAnimationFrame(tick);
      if (scrubbing || !hasTimeline(spec)) return;
      const cycle = cyclePosition(item.id);
      if (cycle == null) return;
      if (isFinished(cycle, spec.cycles)) { stop(); return; }
      paintSeek(progressFraction(cycle, spec.cycles), cycle / spec.cps);
    };
    rafId = requestAnimationFrame(tick);
  }

  function stopSeekLoop() {
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = null;
    scrubbing = false;
    // Rail position is parked by showTransport (at the resume point or 0).
  }

  const editor = mountEditor({
    track: item,
    root: $('.editor', editorWrap),
    prebake: () => ready,
    onToggle: (_id, started) => {
      playingNow = started;
      showTransport(started);
      if (started) startSeekLoop();
      else stopSeekLoop();
    },
    onError: (_id, err) => {
      const msg = $('.eval-error', editorWrap);
      msg.textContent = err ? `✖ ${err.message}` : '';
      msg.hidden = !err;
    },
  });

  async function play() {
    playingNow = true;
    const resumeCycle = pausedCycle; // captured before showTransport clears the paused UI
    pausedCycle = null;
    showTransport(true);
    await ready; // audio context unlocks via this click
    if (!playingNow) return; // paused again while samples loaded
    await getAudioContext().resume(); // post-export contexts start suspended
    editor.evaluate();
    // Resume from where we paused (re-anchor the freshly-started scheduler).
    if (resumeCycle != null && resumeCycle > 0) seekEditor(item.id, resumeCycle);
    startSeekLoop();
  }

  // Pause: silence the audio but keep the position, so ▶ PLAY resumes from where
  // it left off (mirrors the list pages). Capture the cycle before stop(), which
  // synchronously fires onToggle → showTransport(false).
  function pause() {
    const cycle = cyclePosition(item.id);
    pausedCycle = Number.isFinite(cycle) ? cycle : 0;
    playingNow = false;
    getEditor(item.id)?.stop();
    panic(); // cut tails still ringing out so pause is truly silent
    stopSeekLoop();
    showTransport(false);
  }

  // Full stop → idle: clear the position so ▶ replays from the top. Used at the
  // natural end of the arrangement (see the seek loop's isFinished check).
  function stop() {
    pausedCycle = null;
    playingNow = false;
    getEditor(item.id)?.stop(); // onToggle clears UI; this covers not-yet-evaluated
    panic(); // cut tails still ringing out so stop is truly silent
    stopSeekLoop();
    showTransport(false);
  }

  const toggle = () => (playingNow ? pause() : play());
  playBtn.addEventListener('click', toggle);
  stopBtn.addEventListener('click', toggle);

  function seekToPointer(e) {
    if (!hasTimeline(spec)) return;
    const rect = rail.getBoundingClientRect();
    const fraction = rect.width ? (e.clientX - rect.left) / rect.width : 0;
    const clamped = Math.min(1, Math.max(0, fraction));
    const cycle = fractionToCycle(clamped, spec.cycles);
    seekEditor(item.id, cycle);
    if (!playingNow) pausedCycle = cycle; // scrubbing while paused moves the resume point
    paintSeek(clamped, clamped * spec.seconds); // immediate feedback; loop paused while scrubbing
  }

  rail.addEventListener('pointerdown', (e) => {
    if (!hasTimeline(spec)) return;
    scrubbing = true;
    rail.setPointerCapture(e.pointerId);
    seekToPointer(e);
  });
  rail.addEventListener('pointermove', (e) => { if (scrubbing) seekToPointer(e); });
  const endScrub = (e) => {
    if (!scrubbing) return;
    scrubbing = false;
    try { rail.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };
  rail.addEventListener('pointerup', endScrub);
  rail.addEventListener('pointercancel', endScrub);

  showTransport(false); // initialize the footer button to "▶ PLAY" (enabled)
}

async function main() {
  if (!db) return renderEmpty('Instant not configured — set VITE_INSTANT_APP_ID');
  const songId = idFromPath(location.pathname);
  if (!songId) return renderEmpty('no song specified');

  const ready = bootStrudel();
  ready.then(() => {
    $('#status').textContent = '● samples loaded';
    $('#status').classList.add('ready');
  });

  const found = await resolveItem(songId);
  if (!found) return renderEmpty('song not found');
  const family = await fetchFamily(found.ns, found.item);
  renderSong(found.item, found.ns, family, ready);
}

main().catch((err) => {
  console.error('song page failed', err);
  renderEmpty('could not load this song');
});
