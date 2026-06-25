// In-browser twin of server/render-audio.mjs: drives a hidden iframe running
// export-render.html (its own JS realm + audio context, so renders never touch
// live playback) over the same postMessage protocol, and downloads the Blob.
const EXT = { wav: 'wav', mp3: 'mp3', stems: 'zip' };

export function exportFilename(slug, fmt) {
  return `${slug}.${EXT[fmt] ?? fmt}`;
}

function defaultConnect(src) {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
  iframe.src = src;
  document.body.appendChild(iframe);
  const handlers = new Set();
  // export-render.js posts to `parent`; only accept messages from OUR iframe.
  const onWin = (e) => { if (e.source === iframe.contentWindow) for (const h of handlers) h(e.data); };
  window.addEventListener('message', onWin);
  return {
    post: (msg) => iframe.contentWindow?.postMessage(msg, '*'),
    onMessage: (h) => { handlers.add(h); return () => handlers.delete(h); },
    destroy: () => { window.removeEventListener('message', onWin); iframe.remove(); },
  };
}

export function createExportClient({
  src = '/export-render.html',
  connect = defaultConnect,
  readyTimeoutMs = 30000,
  renderTimeoutMs = 300000,
} = {}) {
  let transport = null;
  let readyPromise = null;
  const cache = new Map();    // key -> Blob (session memo)
  const inflight = new Map(); // key -> Promise<Blob>
  const waiters = new Map();  // key -> { resolve, reject, onProgress, timer }

  // Serial chain: only one render cycle (post→done/error) outstanding at a time.
  let chain = Promise.resolve();

  function ensure() {
    if (transport) return readyPromise;
    transport = connect(src);
    readyPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Reset so a later call can retry from scratch.
        transport = null;
        readyPromise = null;
        reject(new Error('export iframe did not become ready in time'));
      }, readyTimeoutMs);

      transport.onMessage((data) => {
        if (!data || data.type == null) return;
        if (data.type === 'ready') { clearTimeout(timer); resolve(); return; }
        const w = waiters.get(data.id);
        if (!w) return;
        if (data.type === 'progress') { w.onProgress?.({ done: data.done, total: data.total }); return; }
        if (data.type === 'done') {
          clearTimeout(w.timer);
          waiters.delete(data.id);
          w.resolve(data.blob);
          return;
        }
        if (data.type === 'error') {
          clearTimeout(w.timer);
          waiters.delete(data.id);
          w.reject(new Error(data.message || 'render failed'));
        }
      });
    });
    return readyPromise;
  }

  function render(track, fmt, { onProgress } = {}) {
    const key = `${track.id}:${fmt}`;
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    if (inflight.has(key)) return inflight.get(key);

    // Eagerly set up the transport + ready listener so messages emitted
    // before our chain slot fires are still captured.
    const readyP = ensure();

    // Enqueue the actual post behind the serial chain.
    const run = chain.then(() => readyP).then(() => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(key);
        reject(new Error(`render timed out: ${key}`));
      }, renderTimeoutMs);

      waiters.set(key, { resolve, reject, onProgress, timer });
      transport.post({ type: 'render', id: key, track, format: fmt });
    })).then((blob) => {
      cache.set(key, blob);
      return blob;
    });

    // p is what callers hold. Attach a no-op catch synchronously so Node never
    // sees `run` as an unhandled rejection (p's finally is async, too late).
    const p = run.finally(() => inflight.delete(key));
    // eslint-disable-next-line no-unused-expressions
    p.catch(() => {});  // suppress unhandled-rejection on run/p immediately

    // Keep chain alive past failures so the next render can proceed.
    chain = p.catch(() => {});

    inflight.set(key, p);
    return p;
  }

  return {
    render,
    destroy() { transport?.destroy(); transport = null; readyPromise = null; waiters.clear(); },
  };
}

let singleton = null;
export function getExportClient() { return (singleton ??= createExportClient()); }

export function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
