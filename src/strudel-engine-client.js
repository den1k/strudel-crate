// Page side of the Strudel engine. Stored track code runs only inside this frame, whose
// origin is opaque (sandbox without allow-same-origin): it can't reach the page, its
// storage, the Instant session or same-origin credentials. Everything it posts back is
// untrusted, so it's rendered as text or coerced to numbers by the receiver.
export const SANDBOX_ATTR = 'allow-scripts';

const HIDDEN = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
// A small control, not a takeover, however the frame came to be shown.
const GATE = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);width:min(320px,90vw);height:72px;'
  + 'border:0;border-radius:12px;z-index:1000;background:transparent';

export function createEngineClient({ doc = document, win = window, src = '/strudel-engine.html' } = {}) {
  let frame;
  let holdsStoredCode = false; // once a play is posted, that frame's DOM belongs to the track
  let pendingGate = false;

  const mount = () => {
    frame = doc.createElement('iframe');
    frame.setAttribute('sandbox', SANDBOX_ATTR);
    // The page's user activation carries into the frame only with autoplay delegated, and
    // `src`-style allowlists don't match an opaque origin.
    frame.setAttribute('allow', 'autoplay *');
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('title', 'audio engine');
    frame.style.cssText = HIDDEN;
    frame.src = src;
    doc.body.appendChild(frame);
    holdsStoredCode = false;
  };
  mount();

  const post = (msg) => frame.contentWindow?.postMessage(msg, '*');
  const revealGate = () => {
    frame.style.cssText = GATE;
    post({ type: 'gate', show: true });
  };
  const hideGate = () => {
    pendingGate = false;
    frame.style.cssText = HIDDEN;
  };

  const handlers = new Set();
  const onMessage = (e) => {
    if (e.source !== frame.contentWindow || !e.data || typeof e.data !== 'object') return;
    if (e.data.type === 'hello' && pendingGate && !holdsStoredCode) {
      pendingGate = false;
      revealGate();
    }
    for (const h of handlers) h(e.data);
  };
  win.addEventListener('message', onMessage);

  return {
    get frame() { return frame; },
    get holdsStoredCode() { return holdsStoredCode; },
    post: (msg) => {
      if (msg?.type === 'play') {
        hideGate(); // nothing evaluates in a frame the viewer can see
        holdsStoredCode = true;
      }
      post(msg);
    },
    on: (h) => { handlers.add(h); return () => handlers.delete(h); },
    // Last-resort audio unlock: a browser that won't honour the page's gesture gets a tap
    // landing inside the frame itself. Only a frame that has never run stored code may be
    // shown, because that code owns the frame's DOM and could draw anything under our address.
    // One that has is discarded (it was making no sound) and a fresh one shows the gate; the
    // track plays there after the tap. Returns true if the frame was replaced.
    showGate: (show) => {
      if (!show) {
        post({ type: 'gate', show: false });
        hideGate();
        return false;
      }
      if (!holdsStoredCode) {
        revealGate();
        return false;
      }
      frame.remove();
      mount();
      pendingGate = true;
      return true;
    },
  };
}
