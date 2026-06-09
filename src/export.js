// Export is rendered in a hidden, same-origin iframe (export-render.html) that
// owns its own audio context, so the main page's live playback is never
// interrupted. This module is the main-page orchestrator: spawn the iframe, run
// the postMessage protocol, download the returned blob, tear the iframe down.
let exporting = false;
export const isExporting = () => exporting;

const RENDER_TIMEOUT_MS = 5 * 60_000; // offline render is fast; this only guards a stuck iframe

export async function exportTrack(track, format, { onStatus = () => {} } = {}) {
  if (exporting) throw new Error('an export is already running');
  exporting = true;
  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  iframe.src = '/export-render.html';
  const id = `${track.id}:${format}`;
  try {
    onStatus('rendering…');
    const blob = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('export timed out')), RENDER_TIMEOUT_MS);
      let started = false;
      function cleanup() {
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
      }
      function onMessage(e) {
        if (e.source !== iframe.contentWindow) return; // ignore other frames
        const data = e.data || {};
        if (data.type === 'ready' && !started) {
          started = true; // render once, even if 'ready' somehow repeats
          iframe.contentWindow.postMessage({ type: 'render', id, track, format }, '*');
        } else if (data.type === 'done' && data.id === id) {
          cleanup();
          resolve(data.blob);
        } else if (data.type === 'error' && data.id === id) {
          cleanup();
          reject(new Error(data.message));
        }
      }
      window.addEventListener('message', onMessage);
      document.body.appendChild(iframe); // load starts here; iframe posts 'ready'
    });
    onStatus('encoding…'); // cosmetic — encoding already happened in the iframe
    download(blob, `${track.id}.${format}`);
  } finally {
    iframe.remove(); // terminate the render context on completion or failure
    exporting = false;
  }
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
