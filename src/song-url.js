// Pure helpers for the /song/<slug> route — no DOM, no Instant — so they
// unit-test directly and are shared by app.js (share button) and song.js.

// Absolute path to a song's page. Slugs are [A-Za-z0-9_-] in practice so the
// encode is usually a no-op, but it keeps the URL valid for any input.
export function songUrl(slug) {
  return `/song/${encodeURIComponent(slug)}`;
}

// Decoded slug from a /song/<slug> pathname, or '' when there is none
// (tolerates a trailing slash).
export function slugFromPath(pathname) {
  const m = /^\/song\/([^/]+)\/?$/.exec(pathname);
  return m ? decodeURIComponent(m[1]) : '';
}
