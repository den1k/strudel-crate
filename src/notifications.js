// Pure helpers for the job notifications + nav log. No DOM, no network — the
// DOM/poller wiring lives in jobs-ui.js so this stays unit-testable.

const FINISHED = new Set(['done', 'failed', 'interrupted']);

export function deepLink(job) {
  const page = job.collection === 'stems' ? '/stems' : '/';
  return job.batch ? `${page}?batch=${encodeURIComponent(job.batch)}` : page;
}

// Jobs that reached a finished state since the previous poll snapshot.
// prevById: Map<id, status> captured on the last poll.
export function newlyFinished(prevById, jobs) {
  return jobs.filter((j) => FINISHED.has(j.status) && prevById.get(j.id) !== j.status);
}

// Count of finished jobs newer than lastSeenId. `jobs` is newest-first.
export function unreadCount(jobs, lastSeenId) {
  let n = 0;
  for (const j of jobs) {
    if (j.id === lastSeenId) break;
    if (FINISHED.has(j.status)) n += 1;
  }
  return n;
}

export function notificationText(job) {
  if (job.status === 'failed') return { title: 'Generation failed', body: job.prompt };
  if (job.status === 'interrupted') return { title: 'Generation interrupted', body: job.prompt };
  const n = job.newItems?.length ?? 0;
  return { title: `${n} ${job.collection} ready`, body: job.prompt };
}
