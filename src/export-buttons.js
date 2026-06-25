import { getExportClient, exportFilename, triggerBlobDownload } from './export-client.js';
import { isDesktop } from './device.js';

const TITLES = {
  wav: 'download lossless wav',
  mp3: 'download mp3 192kbps',
  stems: 'download per-sound 24-bit stems (zip)',
};

// Append download controls to `container`. Desktop → render buttons; mobile →
// a "downloads available on desktop" note (no render is ever attempted). The
// render runs in-browser via the hidden export iframe.
export function wireExports({ container, track, splitStems, client = getExportClient(), desktop = isDesktop() }) {
  if (!desktop) {
    const note = document.createElement('span');
    note.className = 'export export-note';
    note.textContent = 'downloads available on desktop';
    container.appendChild(note);
    return;
  }
  for (const fmt of splitStems ? ['wav', 'mp3', 'stems'] : ['wav', 'mp3']) {
    const btn = document.createElement('button');
    btn.className = 'export';
    const label = `↓︎ ${fmt}`;
    btn.textContent = label;
    btn.title = TITLES[fmt];
    btn.addEventListener('click', async () => {
      if (btn.dataset.busy) return;
      btn.dataset.busy = '1';
      btn.disabled = true;
      btn.textContent = `rendering ${fmt}…`;
      try {
        const blob = await client.render(
          { id: track.id, code: track.code, meta: track.meta },
          fmt,
          { onProgress: ({ done, total }) => { if (total) btn.textContent = `stem ${done}/${total}…`; } },
        );
        triggerBlobDownload(blob, exportFilename(track.id, fmt));
        btn.textContent = label;
      } catch {
        btn.textContent = 'failed — retry';
        setTimeout(() => { btn.textContent = label; }, 3000);
      } finally {
        btn.disabled = false;
        delete btn.dataset.busy;
      }
    });
    container.appendChild(btn);
  }
}
