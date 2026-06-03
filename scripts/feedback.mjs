// Digest of listener ratings/notes, consumed by /generate-tracks agents.
import { fileURLToPath } from 'node:url';
import { createStore } from '../server/store.mjs';

export function buildDigest(tracks) {
  const rated = tracks.filter((t) => t.rating != null);
  if (rated.length === 0) {
    return 'No ratings yet — no listener feedback to apply.';
  }
  const lines = [`# Listener feedback (${rated.length} rated / ${tracks.length} total, ${tracks.length - rated.length} unrated)`];

  const top = rated.filter((t) => t.rating >= 4).sort((a, b) => b.rating - a.rating).slice(0, 5);
  if (top.length) {
    lines.push('', '## Top rated — emulate what works here');
    for (const t of top) {
      lines.push('', `### ${'★'.repeat(t.rating)} "${t.title}" (${t.id})`);
      if (t.notes) lines.push(`notes: ${t.notes}`);
      lines.push('```', t.code, '```');
    }
  }

  const low = rated.filter((t) => t.rating <= 2).slice(0, 10);
  if (low.length) {
    lines.push('', '## Low rated — avoid these mistakes');
    for (const t of low) {
      lines.push(`- ${'★'.repeat(t.rating)} "${t.title}": ${t.notes || '(no notes)'}`);
    }
  }
  return lines.join('\n');
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const store = createStore({ tracksDir: 'tracks', ratingsDir: 'data/ratings' });
  console.log(buildDigest(await store.listTracks()));
}
