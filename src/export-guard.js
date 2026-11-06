// export-render.js evaluates track code it receives by postMessage, so only the
// window that legitimately drives it may talk to it: the embedding app (iframe flow),
// or the page itself (scripts/verify-segment-fidelity.mjs, where parent === self).
// A top-level page's parent is itself, so a popup's opener never passes.
export function isTrustedExportMessage(event, win) {
  return event.source === win.parent && event.origin === win.location.origin;
}
