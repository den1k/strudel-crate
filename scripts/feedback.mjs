// Digest of listener ratings/lessons, consumed by /generate-tracks agents.
import { fileURLToPath } from 'node:url';
import { createStore } from '../server/store.mjs';

const metaSuffix = (t) =>
  t.meta?.genre || t.meta?.bpm
    ? ` — ${[t.meta?.genre, t.meta?.bpm && `${t.meta.bpm}bpm`].filter(Boolean).join(' · ')}`
    : '';

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

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const store = createStore({ tracksDir: 'tracks', ratingsDir: 'data/ratings' });
  console.log(buildDigest(await store.listTracks()));
}
