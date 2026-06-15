// DOM wiring for UI-triggered generation: a generate panel that POSTs jobs, a
// poller that drives browser notifications, and a nav log dropdown. Pure logic
// is imported from notifications.js.
import { deepLink, unreadCount, newlyFinished, notificationText } from './notifications.js';

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
  const startedAt = Date.now();

  async function post(body) {
    statusEl.textContent = 'queued…';
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) { statusEl.textContent = 'rejected'; return; }
      statusEl.textContent = 'running…';
      if (notifySupported() && Notification.permission === 'default') Notification.requestPermission();
    } catch {
      statusEl.textContent = 'network error';
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
    const finished = jobs.filter((j) => ['done', 'failed', 'interrupted'].includes(j.status));
    logEl.innerHTML = finished.length
      ? finished.map((j) => {
          const label = j.status === 'done'
            ? `${j.newItems?.length ?? 0} ${j.collection} — ${j.prompt}`
            : `${j.status}: ${j.prompt}`;
          return j.status === 'done'
            ? `<a href="${deepLink(j)}">${escapeHtml(label)}</a>`
            : `<span>${escapeHtml(label)}</span>`;
        }).join('')
      : '<span class="empty">no jobs yet</span>';
  }

  bell.addEventListener('click', () => {
    logEl.hidden = !logEl.hidden;
    if (!logEl.hidden && lastJobs[0]) {
      localStorage.setItem(SEEN_KEY, lastJobs[0].id);
      renderBadge(lastJobs);
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
      renderBadge(jobs);
      renderLog(jobs);
      const active = jobs.some((j) => j.status === 'queued' || j.status === 'running');
      statusEl.textContent = active ? 'running…' : '';
    } catch {
      // network blip — retry next tick
    }
    setTimeout(poll, 3000);
  }
  poll();
}
