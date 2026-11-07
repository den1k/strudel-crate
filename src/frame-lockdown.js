// Imported first by each playback frame, so this runs before any stored code can.
// Stored code has no business opening a peer connection: connect-src doesn't cover one, and a
// STUN request goes to any host, carrying the listener's address. Chrome ignores CSP's
// `webrtc 'block'`, so the names go instead. This reduces rather than closes the route: a nested
// srcdoc frame running a data: script gets a fresh realm (see FIXES.md, Round 5).
export function removeWebRTC(target) {
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection']) delete target[name];
}

removeWebRTC(globalThis);
