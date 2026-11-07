// Imported first by each playback frame, so this runs before any stored code can.
// Stored code has no business opening a peer connection: connect-src doesn't cover one, and a
// STUN request goes to any host, carrying the listener's address. Chrome ignores CSP's
// `webrtc 'block'`, so the names go instead. A nested srcdoc frame would get them back in its own
// realm, which is why these frames' CSP has no data: in script-src (see FIXES.md, Round 5).
export function removeWebRTC(target) {
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection']) delete target[name];
}

// Superdough and kabelsalat ship their audio worklets as data: URLs, which that CSP refuses.
// The same text from a blob: URL is allowed, and a blob: made here is no use to a nested frame:
// its origin is a different opaque one.
export function loadWorkletsFromBlobs(proto) {
  const addModule = proto.addModule;
  proto.addModule = async function addModuleFromBlob(url, options) {
    if (!String(url).startsWith('data:')) return addModule.call(this, url, options);
    const blob = await (await fetch(url)).blob();
    const local = URL.createObjectURL(new Blob([blob], { type: 'text/javascript' }));
    try {
      return await addModule.call(this, local, options);
    } finally {
      URL.revokeObjectURL(local);
    }
  };
}

removeWebRTC(globalThis);
if (globalThis.AudioWorklet) loadWorkletsFromBlobs(globalThis.AudioWorklet.prototype);
