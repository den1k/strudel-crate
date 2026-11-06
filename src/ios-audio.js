// iOS routes Web Audio through an audio session that obeys the hardware silent
// switch, so a plain AudioContext is muted when the ringer is on Silent — even
// though playback runs (the scheduler animates and the seek timer moves, you
// just hear nothing). Strudel's initAudioOnFirstClick only resume()s the
// context, which does NOT change this. To play through Silent mode we tell
// WebKit our output is "playback" audio (exempt from the switch), two ways for
// coverage across iOS versions:
//   1. navigator.audioSession.type = 'playback' — official API (iOS/Safari
//      16.4+). Sufficient on modern iOS.
//   2. Play a tiny silent looping <audio> on the first user gesture — on older
//      iOS, *playing a media element* is what flips the WebKit audio session
//      into a playback category, which then carries over to the shared
//      AudioContext for the rest of the session.
// Both are no-ops on desktop, so this is safe to call unconditionally at boot.

// 0.05s of 16-bit PCM silence, mono @ 8kHz, as a data: URI WAV. Looped so the
// playback session stays active after the unlocking gesture.
const SILENT_WAV =
  'data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YSADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAEA/v8DAAAA//8AAAAAAAAA';

function setPlaybackSession(nav) {
  try {
    if (nav && nav.audioSession) nav.audioSession.type = 'playback';
  } catch {
    /* property read-only or unsupported — the silent-media trick covers us */
  }
}

const GESTURES = ['pointerdown', 'touchend', 'click'];

export function enableSilentSwitchPlayback({
  doc = typeof document !== 'undefined' ? document : undefined,
  nav = typeof navigator !== 'undefined' ? navigator : undefined,
  makeAudio = (src) => new Audio(src),
} = {}) {
  setPlaybackSession(nav); // modern iOS: takes effect immediately, no gesture needed
  if (!doc?.addEventListener) return; // non-browser (SSR/tests without a doc)

  const silent = makeAudio(SILENT_WAV);
  silent.loop = true;
  silent.setAttribute?.('playsinline', '');

  let unlocked = false;
  const unlock = () => {
    if (unlocked) return;
    unlocked = true;
    setPlaybackSession(nav); // re-assert inside the gesture for good measure
    Promise.resolve(silent.play?.()).catch(() => {}); // autoplay-blocked is fine
    for (const ev of GESTURES) doc.removeEventListener(ev, unlock);
  };
  for (const ev of GESTURES) doc.addEventListener(ev, unlock);
  return unlock;
}
