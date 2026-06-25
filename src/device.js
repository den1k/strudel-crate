// Single source of truth for "may this device render downloads?". Desktop =
// a wide viewport AND a fine pointer (mouse/trackpad). Phones/tablets report a
// coarse pointer and are excluded — long OfflineAudioContext renders are gated
// to capable desktops by product decision.
const DESKTOP_QUERY = '(min-width: 768px) and (pointer: fine)';

export function isDesktop() {
  if (typeof matchMedia !== 'function') return false;
  return matchMedia(DESKTOP_QUERY).matches;
}
