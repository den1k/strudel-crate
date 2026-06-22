// Persists list-page state (filters + scroll) so a Back navigation can restore
// it. Pure + storage-injected (defaults to sessionStorage) so it unit-tests
// without a DOM. The snapshot shape is:
//   { batch: string, filter: string, user: string | null,
//     selectedByFamily: [[famId, verId], ...], scrollY: number }
// selectedByFamily is a serialized Map (entries array); the caller rehydrates.

// Namespaced so the tracks and stems pages never clobber each other.
const keyFor = (namespace) => `crate:list:${namespace}`;

export function saveListState(namespace, snapshot, storage = sessionStorage) {
  // Storage can throw on quota or in private mode (SecurityError) — a failed
  // save must never bubble into the page that's just trying to leave.
  try {
    storage.setItem(keyFor(namespace), JSON.stringify(snapshot));
  } catch {
    /* best-effort: restoration is a nicety, not a guarantee */
  }
}

export function loadListState(namespace, storage = sessionStorage) {
  // Tolerates a missing key (null) and a corrupt value (bad JSON / throwing
  // storage) by returning null — boot must never crash on a stale entry.
  try {
    const raw = storage.getItem(keyFor(namespace));
    if (raw == null) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
