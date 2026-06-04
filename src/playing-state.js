// Pure transition for "which track is playing".
// Editors report scheduler toggle events (started/stopped). When one track
// replaces another, solo mode stops the old editor around the same time the
// new one starts, and the two events can land in either order — so a stop
// only clears the state if it belongs to the currently playing track.
export function nextPlayingId(current, trackId, started) {
  if (started) return trackId;
  return current === trackId ? null : current;
}
