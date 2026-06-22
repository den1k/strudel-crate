// Pure helpers for the /song/<id> route — no DOM, no Instant — so they
// unit-test directly and are shared by app.js (title link, share) and song.js.
//
// The id in the URL is the entity's globally-unique Instant id, NOT the prompt
// slug: a track and a stem generated from the same prompt share a slug, so a
// slug-based URL can't tell them apart. The entity id never collides.

// Absolute path to a song's page. The id is [A-Za-z0-9-] in practice so the
// encode is usually a no-op, but it keeps the URL valid for any input.
export function songUrl(id) {
  return `/song/${encodeURIComponent(id)}`;
}

// Decoded id from a /song/<id> pathname, or '' when there is none
// (tolerates a trailing slash).
export function idFromPath(pathname) {
  const m = /^\/song\/([^/]+)\/?$/.exec(pathname);
  return m ? decodeURIComponent(m[1]) : '';
}
