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

      // Start indeterminate (pulsing) until the first real progress tick lands;
      // the first tick promotes the button to a determinate left-to-right fill
      // bar. wav/mp3 report per render-cycle, stems report per stem — both drive
      // the same bar. A format that emits no progress simply stays pulsing.
      btn.classList.add('export-rendering', 'export-rendering--indeterminate');
      btn.textContent = `rendering ${fmt}…`;

      try {
        const blob = await client.render(
          { id: track.id, code: track.code, meta: track.meta },
          fmt,
          {
            onProgress: ({ done, total }) => {
              if (!total) return;
              btn.classList.remove('export-rendering--indeterminate');
              const pct = Math.round((done / total) * 100);
              btn.style.setProperty('--export-fill', `${pct}%`);
              btn.textContent = `${fmt} ${pct}%`;
            },
          },
        );
        triggerBlobDownload(blob, exportFilename(track.id, fmt));
        btn.textContent = label;
      } catch {
        btn.textContent = 'failed — retry';
        setTimeout(() => { btn.textContent = label; }, 3000);
      } finally {
        btn.disabled = false;
        btn.classList.remove('export-rendering', 'export-rendering--indeterminate');
        btn.style.removeProperty('--export-fill');
        delete btn.dataset.busy;
      }
    });
    container.appendChild(btn);
  }
}
