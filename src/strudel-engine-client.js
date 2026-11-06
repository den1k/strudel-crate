// Page side of the Strudel engine. Stored track code runs only inside this frame, whose
// origin is opaque (sandbox without allow-same-origin): it can't reach the page, its
// storage, the Instant session or same-origin credentials. Everything it posts back is
// untrusted, so it's rendered as text or coerced to numbers by the receiver.
export const SANDBOX_ATTR = 'allow-scripts';

export function createEngineClient({ doc = document, win = window, src = '/strudel-engine.html' } = {}) {
  const frame = doc.createElement('iframe');
  frame.setAttribute('sandbox', SANDBOX_ATTR);
  // The page's user activation carries into the frame only with autoplay delegated, and
  // `src`-style allowlists don't match an opaque origin.
  frame.setAttribute('allow', 'autoplay *');
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('title', 'audio engine');
  frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
  frame.src = src;
  doc.body.appendChild(frame);

  const handlers = new Set();
  const onMessage = (e) => {
    if (e.source !== frame.contentWindow || !e.data || typeof e.data !== 'object') return;
    for (const h of handlers) h(e.data);
  };
  win.addEventListener('message', onMessage);

  return {
    frame,
    post: (msg) => frame.contentWindow?.postMessage(msg, '*'),
    on: (h) => { handlers.add(h); return () => handlers.delete(h); },
    // Last-resort audio unlock: a browser that won't honour the page's gesture gets a
    // tap landing inside the frame itself.
    showGate: (show) => {
      frame.style.cssText = show
        ? 'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:1000;background:transparent'
        : 'position:absolute;width:0;height:0;border:0;visibility:hidden';
    },
  };
}
