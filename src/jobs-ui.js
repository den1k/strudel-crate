// DOM wiring for UI-triggered generation: a generate panel that POSTs jobs, a
// poller that drives browser notifications, and a nav log dropdown. Pure logic
// is imported from notifications.js.
import { deepLink, unreadCount, newlyFinished, notificationText, progressText, retryBody } from './notifications.js';

const $ = (sel) => document.querySelector(sel);
const SEEN_KEY = 'strudel-jobs-last-seen';
const notifySupported = () => typeof Notification !== 'undefined';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function mountJobsUI({ collection, onBatchDone }) {
  const promptEl = $('#gen-prompt');
  const countEl = $('#gen-count');
  const statusEl = $('#gen-status');
  const bell = $('#job-bell');
  const unreadEl = $('#job-unread');
  const logEl = $('#job-log');
  if (!promptEl || !bell) return; // markup absent — nothing to mount

  let prevById = null;   // null until first poll (seed without notifying)
  let lastJobs = [];
  let activeJob = null; // the running job, else the next queued one, else null
  const startedAt = Date.now();
  // Failed-job ids the user has re-queued this session. The log re-renders from
  // scratch every poll (innerHTML), so this survives those rebuilds to keep the
  // retried row showing "re-queued" instead of flipping back to a live button.
  const retriedIds = new Set();

  // text + a state class ('busy' | 'err' | '') so the stylesheet can color/animate it
  function setStatus(text, state = '') {
    statusEl.textContent = text;
    statusEl.className = state ? `gen-status ${state}` : 'gen-status';
  }

  async function post(body) {
    setStatus('queued…', 'busy');
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) { setStatus('rejected', 'err'); return; }
      setStatus('running…', 'busy');
      if (notifySupported() && Notification.permission === 'default') Notification.requestPermission();
    } catch {
      setStatus('network error', 'err');
    }
  }

  $('#gen-go').addEventListener('click', () => {
    const prompt = promptEl.value.trim();
    if (!prompt) return;
    const count = Math.min(30, Math.max(1, Number(countEl.value) || 12));
    post({ type: collection === 'stems' ? 'generate-stems' : 'generate-tracks', prompt, count });
  });

  $('#gen-revise').addEventListener('click', () => {
    post({ type: 'revise-from-notes', prompt: collection });
  });

  function fire(job) {
    if (!(notifySupported() && Notification.permission === 'granted')) return;
    const { title, body } = notificationText(job);
    const n = new Notification(title, { body });
    n.onclick = () => { window.focus(); window.location.href = deepLink(job); };
  }

  function renderBadge(jobs) {
    const n = unreadCount(jobs, localStorage.getItem(SEEN_KEY));
    unreadEl.textContent = String(n);
    unreadEl.hidden = n === 0;
  }

  function renderLog(jobs) {
    const active = jobs.filter((j) => j.status === 'queued' || j.status === 'running');
    const finished = jobs.filter((j) => ['done', 'failed', 'interrupted'].includes(j.status));
    const activeHtml = active.map((j) =>
      `<span class="active">${escapeHtml(progressText(j, Date.now()))} — ${escapeHtml(j.prompt)}</span>`
    ).join('');
    const finishedHtml = finished.map((j) => {
      if (j.status === 'done') {
        const label = `${j.newItems?.length ?? 0} ${j.collection} — ${j.prompt}`;
        return `<a href="${deepLink(j)}" title="${escapeHtml(j.summary || '')}">${escapeHtml(label)}</a>`;
      }
      // failed / interrupted — show the reason and a retry affordance. The
      // button is omitted for non-retryable jobs (unknown shape); already
      // re-queued failures show a disabled marker instead.
      const reason = j.error || j.prompt;
      const text = `<span class="job-row-text">${escapeHtml(`${j.status}: ${reason}`)}</span>`;
      let action = '';
      if (retriedIds.has(j.id)) {
        action = '<span class="job-requeued" title="a new run was queued">re-queued ↑</span>';
      } else if (retryBody(j)) {
        action = `<button type="button" class="job-retry" data-id="${escapeHtml(j.id)}" title="run this job again">↻ retry</button>`;
      }
      return `<div class="job-row failed">${text}${action}</div>`;
    }).join('');
    logEl.innerHTML = (activeHtml + finishedHtml) || '<span class="empty">no jobs yet</span>';
  }

  // Re-render the status pill from the active job + the live clock. Called on
  // every poll AND once a second so the elapsed time advances between polls.
  // Also refreshes the open log dropdown so its pinned active line ticks too.
  function renderActive() {
    if (!logEl.hidden) renderLog(lastJobs);
    if (!activeJob) { setStatus('', ''); return; }
    setStatus(progressText(activeJob, Date.now()), 'busy');
  }

  bell.addEventListener('click', () => {
    logEl.hidden = !logEl.hidden;
    if (!logEl.hidden && lastJobs[0]) {
      localStorage.setItem(SEEN_KEY, lastJobs[0].id);
      renderBadge(lastJobs);
    }
  });

  // Retry a failed/interrupted job: re-POST its original request. Delegated so it
  // survives the log's per-poll innerHTML rebuilds. Optimistically marks the row
  // re-queued (persisted in retriedIds); rolls back + flashes on a POST error.
  logEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('.job-retry');
    if (!btn) return;
    const id = btn.dataset.id;
    const job = lastJobs.find((j) => j.id === id);
    const body = retryBody(job);
    if (!body) return;

    retriedIds.add(id);
    renderLog(lastJobs); // flip to "re-queued ↑" immediately
    setStatus('retrying…', 'busy');
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        retriedIds.delete(id);
        renderLog(lastJobs);
        setStatus(res.status === 401 ? 'sign in to retry' : 'retry rejected', 'err');
        return;
      }
      setStatus('running…', 'busy'); // next poll (≤3s) surfaces the new queued job
    } catch {
      retriedIds.delete(id);
      renderLog(lastJobs);
      setStatus('network error', 'err');
    }
  });

  async function poll() {
    try {
      const jobs = await (await fetch('/api/jobs')).json();
      lastJobs = jobs;
      if (prevById !== null) {
        for (const job of newlyFinished(prevById, jobs)) {
          if (new Date(job.finishedAt).getTime() >= startedAt) fire(job);
          if (job.status === 'done' && job.collection === collection) onBatchDone?.(job);
        }
      }
      prevById = new Map(jobs.map((j) => [j.id, j.status]));
      activeJob = jobs.find((j) => j.status === 'running')
        || jobs.find((j) => j.status === 'queued') || null;
      renderBadge(jobs);
      renderLog(jobs);
      renderActive();
    } catch {
      // network blip — retry next tick
    }
    setTimeout(poll, 3000);
  }
  poll();
  setInterval(renderActive, 1000);
}
