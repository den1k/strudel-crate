// The one place a page boots Strudel. The runtime itself lives in the sandboxed engine
// frame (strudel-engine.js); the page only drives it.
import { createEngineClient } from './strudel-engine-client.js';
import { attachEngine } from './editor.js';

const GESTURES = ['pointerdown', 'touchend', 'click', 'keydown'];

// Returns a promise that resolves when the sample banks are loaded. Call exactly once.
export function bootStrudel() {
  const engine = createEngineClient();
  // Forward each gesture synchronously: WebKit carries user activation across postMessage
  // only from inside the gesture, and Chrome walks up to the page's sticky activation.
  const unlock = () => engine.post({ type: 'unlock' });
  for (const ev of GESTURES) document.addEventListener(ev, unlock, { capture: true });
  attachEngine(engine);
  return new Promise((resolve) => {
    const off = engine.on((m) => {
      if (m.type !== 'ready') return;
      off();
      resolve();
    });
  });
}
