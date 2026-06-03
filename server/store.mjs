// File-backed store: tracks are JSON files written by generation agents,
// ratings are JSON files written here (server is the only ratings writer).
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function createStore({ tracksDir, ratingsDir }) {
  async function getRating(id) {
    try {
      const r = JSON.parse(await readFile(join(ratingsDir, `${id}.json`), 'utf8'));
      return { rating: r.rating ?? null, notes: r.notes ?? '' };
    } catch {
      return { rating: null, notes: '' };
    }
  }

  async function listTracks() {
    let files;
    try {
      files = await readdir(tracksDir);
    } catch {
      return [];
    }
    const tracks = [];
    for (const file of files.filter((f) => f.endsWith('.json')).sort()) {
      try {
        const track = JSON.parse(await readFile(join(tracksDir, file), 'utf8'));
        tracks.push({ ...track, ...(await getRating(track.id)) });
      } catch {
        // skip malformed track files rather than breaking the whole listing
      }
    }
    return tracks;
  }

  async function saveRating(id, { rating, notes }) {
    await mkdir(ratingsDir, { recursive: true });
    const record = {
      id,
      rating: rating ?? null,
      notes: notes ?? '',
      updatedAt: new Date().toISOString(),
    };
    await writeFile(join(ratingsDir, `${id}.json`), JSON.stringify(record, null, 2) + '\n');
    return record;
  }

  return { listTracks, saveRating };
}
