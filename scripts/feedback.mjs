// Digest of cross-track lessons, consumed by /generate-tracks agents.
// A song's star rating and per-song notes apply ONLY to that song and are never
// injected here — only lessons apply across the board.
import { fileURLToPath } from 'node:url';

export function buildDigest(tracks) {
  const lessons = tracks.filter((t) => t.lesson?.trim());
  if (lessons.length === 0) {
    return 'No lessons yet — no cross-track feedback to apply.';
  }
  const lines = ['## Lessons for all future tracks'];
  for (const t of lessons) {
    lines.push(`- ${t.lesson.trim()} (from "${t.title}")`);
  }
  return lines.join('\n');
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const { adminDb, queryItems } = await import('./lib/instant.mjs');
  const ns = process.argv[2] === 'stems' ? 'stems' : 'tracks';
  console.log(buildDigest(await queryItems(adminDb, ns)));
}
