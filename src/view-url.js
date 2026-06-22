// Pure helpers for the shareable list-page view state — no DOM, no Instant —
// so they unit-test directly and are the single source of truth for the query
// string shape on `/` and `/stems`.
//
// Query params: batch (batch id), filter (all|unrated|top), user (author
// PROFILE id), play (playing song's entity id). Defaults are omitted so a clean
// view yields a clean URL: batch=all / filter=all and a null user/play are all
// dropped, so equal state always produces an identical (often empty) string.

const FILTERS = ['all', 'unrated', 'top'];

// Parse a list-page search string into { batch, filter, user, play }. Each
// field is null when the param is absent. batch=all / filter=all normalize to
// null ("no filter"); an unrecognized filter value is treated as absent.
export function readViewParams(search) {
  const p = new URLSearchParams(search);
  const batchRaw = p.get('batch');
  const filterRaw = p.get('filter');
  return {
    batch: batchRaw && batchRaw !== 'all' ? batchRaw : null,
    filter: FILTERS.includes(filterRaw) && filterRaw !== 'all' ? filterRaw : null,
    user: p.get('user') || null,
    play: p.get('play') || null,
  };
}

// Canonical query string (leading '?' or '') for a view state, omitting
// defaults/nulls. Key order is fixed (batch, filter, user, play) so equal
// state always serializes identically.
export function buildSearch({ batch, filter, user, play } = {}) {
  const p = new URLSearchParams();
  if (batch && batch !== 'all') p.set('batch', batch);
  if (filter && filter !== 'all' && FILTERS.includes(filter)) p.set('filter', filter);
  if (user) p.set('user', user);
  if (play) p.set('play', play);
  const s = p.toString();
  return s ? `?${s}` : '';
}
