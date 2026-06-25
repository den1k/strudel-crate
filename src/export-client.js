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

export function createExportClient({ src = '/export-render.html', connect = defaultConnect } = {}) {
  let transport = null;
  let readyPromise = null;
  const cache = new Map();    // key -> Blob (session memo)
  const inflight = new Map(); // key -> Promise<Blob>
  const waiters = new Map();  // key -> { resolve, reject, onProgress }

  function ensure() {
    if (transport) return readyPromise;
    transport = connect(src);
    readyPromise = new Promise((resolve) => {
      transport.onMessage((data) => {
        if (!data || data.type == null) return;
        if (data.type === 'ready') { resolve(); return; }
        const w = waiters.get(data.id);
        if (!w) return;
        if (data.type === 'progress') { w.onProgress?.({ done: data.done, total: data.total }); return; }
        if (data.type === 'done') { waiters.delete(data.id); w.resolve(data.blob); return; }
        if (data.type === 'error') { waiters.delete(data.id); w.reject(new Error(data.message || 'render failed')); }
      });
    });
    return readyPromise;
  }

  function render(track, fmt, { onProgress } = {}) {
    const key = `${track.id}:${fmt}`;
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      await ensure();
      const blob = await new Promise((resolve, reject) => {
        waiters.set(key, { resolve, reject, onProgress });
        transport.post({ type: 'render', id: key, track, format: fmt });
      });
      cache.set(key, blob);
      return blob;
    })().finally(() => inflight.delete(key));
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
