# Client-Side Desktop Audio Export — Design

**Status:** Approved design, pending spec review → implementation plan.
**Date:** 2026-06-25
**Supersedes:** `docs/superpowers/plans/2026-06-25-async-audio-export-jobs.md` (server-side approach — abandoned in favour of this).

## Problem

Song downloads (WAV / MP3 / stems) are broken and give no feedback. Root cause, established by investigation + benchmarking:

- The server renders audio by driving a **headless Chrome** (`server/render-audio.mjs`) that runs `OfflineAudioContext` synthesis, one render at a time behind a **serial lock**.
- The render builds a **full-length** audio graph held in memory until `startRendering()`. For the catalog's typical track this **OOM-crashes the Chrome tab** (~60s in) or exceeds puppeteer's **180s `protocolTimeout`** (→ HTTP 500). Measured: short ~60s tracks render fine (~11s, ~0.18× realtime); the *tracks* namespace has p50 **245s**, p90 338s, max 503s of audio — most of it in the crash/timeout zone. Stems render one full pass per sound (up to ~75 min of work for one download).
- The client download button is a bare `<a download>` with **no fetch, status, or error handling**, so a crash/500 shows the user nothing.

## Decision

Move rendering **into the user's browser**, and **gate it to desktop**. Desktop laptops have ample RAM/CPU and render in parallel per-user with no server bottleneck; gating off mobile removes the only device class that can't reliably handle a long `OfflineAudioContext` render. The server headless-audio path is deleted.

This was chosen over a server-side async-job-with-notifications approach because it removes the failure modes at the root (no server render queue, no `protocolTimeout`, no OOM, no Chrome RAM on the VM) rather than managing them, and reuses the existing render code unchanged.

**Format note:** MP3 is *not* cheaper to render than WAV — all formats pay the same `OfflineAudioContext` render; MP3 then adds LAME encoding (benchmark: mp3 ≈20% *slower* than wav). The cost driver is track length, not format, so the device gate is by device class, applied to all formats equally.

## Goals

- Downloads work on desktop for all formats (wav/mp3 on both namespaces; stems on tracks), rendered locally.
- Clear feedback while a render runs: a `rendering <fmt>…` button state + spinner; stems show `rendering stem k/N`.
- The render never interferes with live playback.
- Mobile shows a clear "Downloads are available on desktop" note; no render is attempted on mobile.
- The server headless-audio subsystem is removed.

## Non-Goals / Out of Scope

- Mobile downloads of any kind (explicit product decision; revisit later with a length-gated allowance if needed).
- Chunked/segmented rendering (unnecessary once rendering is on capable desktop hardware).
- A cancel button on an in-progress render (v1 uses a spinner; abort only happens implicitly if the user navigates away).
- Cross-session persistent caching (IndexedDB). v1 caches rendered Blobs in memory for the session only.
- Shared cross-user cache (gone with the server path; each desktop user renders their own).

## Architecture

### Render in a hidden iframe

The render code (`src/render.js` → `renderHapsToBuffer`) rebinds the **global** superdough audio context (`setAudioContext`, `resetGlobalEffects`, `setSuperdoughAudioController`). Running it in the main page would hijack live playback. Instead, run it in a **hidden `<iframe src="/export-render.html">`** — the same isolated page the headless server currently drives.

`export-render.html` is a built vite entry served at `/export-render.html` in dev and prod. It loads `src/export-render.js`, which already:
- registers strudel + all sample banks (`ready` promise), and
- listens for `window` message `{ type:'render', id, track, format }`, renders via `renderTrack`/`renderStemsZip`, and posts the result to **`parent`** as `{ type:'done', id, blob }` or `{ type:'error', id, message }`, plus a `{ type:'ready' }` on init.

In an iframe, `parent` is the main page, so **`export-render.js` works unchanged**. The iframe is a separate JS realm with its own audio context and its own superdough instance, so the render is fully isolated from the main page's playback. This is the in-browser twin of `server/render-audio.mjs`'s `inPageRender` protocol.

The iframe is created once on first download, kept alive, and reused across renders (sample-bank registration is paid once).

### Components

**New — `src/export-client.js`**
- `createExportClient()` → `{ render(track, fmt, { onProgress }) => Promise<Blob>, destroy() }`.
- Lazily injects a hidden `<iframe src="/export-render.html">`; resolves an internal `ready` promise on the iframe's `{type:'ready'}` message.
- `render()` posts `{type:'render', id, track, format}` to `iframe.contentWindow`, listens on the main `window` for the matching `{type:'done'|'error'|'progress', id}` reply, resolves the Blob / rejects on error / forwards progress to `onProgress`.
- Serializes renders (one at a time per iframe) and dedupes identical in-flight requests.
- In-memory Blob cache keyed by `track.id:fmt` for instant repeat downloads in the session.

**New — `src/device.js`**
- `isDesktop()` → `window.matchMedia('(min-width: 768px) and (pointer: fine)').matches`. Single source of truth for the gate.

**Modified — `src/export-render.js`** (small, additive)
- Emit `{ type:'progress', id, stage }` messages during a render: for stems, `stage = { kind:'stems', done, total }` as each sound finishes; (wav/mp3 may emit a single indeterminate `started`). No behavioural change to the render itself.

**Modified — `src/song.js` and `src/app.js`**
- Replace the bare `<a download>` button handlers with a shared flow: on desktop, call `exportClient.render(track, fmt, { onProgress })`, set the button to `rendering <fmt>…` (disabled, spinner), then trigger a Blob download (`URL.createObjectURL` + `<a download>`); restore the button on completion; on error show `render failed — retry`.
- On non-desktop, render a small inline note "Downloads are available on desktop" in place of the buttons.
- Both pages use a shared helper (e.g. in `src/export-client.js` or a thin `src/export-buttons.js`) so the button wiring is DRY.

**Removed — server audio render path**
- Delete the `/api/:ns/:id/audio.:fmt` route, `server/audio-export.mjs`, `server/render-audio.mjs`, `server/audio-cache.mjs`, the `audioExport` wiring in `server/index.mjs`, and the runner's MP3 prewarm (`server/runner.mjs`).
- **Keep** puppeteer + `server/render-card.mjs` / `og.mjs` (OG cards still render server-side).
- Remove the now-unused audio-export/audio-cache tests; keep card tests.

### Data flow (desktop download click)

```
button click (fmt)
  └─ isDesktop()? no → (buttons already replaced by desktop-only note; n/a)
     yes:
       exportClient.render(track, fmt, { onProgress })
         ├─ ensure hidden iframe /export-render.html, await ready
         ├─ cache hit (track.id:fmt)? → return Blob
         ├─ postMessage {render} → iframe
         │    iframe export-render.js: renderTrack/renderStemsZip
         │      └─ posts {progress…} then {done, blob} | {error}
         └─ resolve Blob (cache it)
       → URL.createObjectURL(blob) + <a download=filename> click + revoke
```

### Error handling

- Iframe `{type:'error'}` → reject; button shows `render failed — retry`; the error message is logged to the console. Re-click retries.
- Iframe fails to load / no `ready` within a timeout (e.g. 30s) → reject with a load error; same button treatment.
- A render that throws inside the iframe is already caught by `export-render.js` (try/catch → `{type:'error'}`), so no uncaught failures escape.

### Filenames

Preserve current download names: `<slug>.<wav|mp3>` and `<slug>-stems.zip` (or the per-sound names already produced by `renderStemsZip`/`stemFilenames`). The client sets the `<a download>` filename from the track slug + format.

## Testing

- **`src/device.js`** — `isDesktop()` reads the injected matchMedia; unit-test with a stubbed `matchMedia`.
- **`src/export-client.js`** — unit-test the postMessage protocol against a fake iframe window: ready handshake, render→done returns Blob, render→error rejects, progress forwarded, cache hit skips a second postMessage, serialization of concurrent calls.
- **`src/export-render.js`** — extend existing render coverage to assert progress messages are posted for stems (`done/total`).
- **Button wiring** (`song.js`/`app.js`) — manual verification (DOM/integration): desktop renders + downloads each format with the `rendering…` state; stems show `stem k/N`; mobile shows the desktop-only note; repeat click is instant.
- **Server removal** — delete the corresponding server audio tests; run the full suite to confirm nothing else referenced the removed modules.

## Risks & Mitigations

- **Same-origin iframe shares the event loop** — a heavy synchronous stretch could jank the main page. Mitigated by the async per-hap loop + `startRendering()` running on the audio thread; acceptable for v1. If jank shows up, move heavier scheduling into chunked yields.
- **Sample loading in the iframe** — uses the same sample resolution the app already uses for playback (and that the headless render already uses successfully), including the server `/sample-cache` proxy. Low risk.
- **Very large stems on a modest laptop** — a low-RAM desktop could still struggle on an 8-min/10-stem export. Acceptable: it's the user's own machine, fails locally with a retryable error rather than breaking a shared server. Revisit with chunking only if reported.
- **Desktop detection edge cases** (touch laptops, tablets) — `(pointer: fine)` + width is a reasonable heuristic; a touchscreen laptop with a trackpad reports `fine` and is allowed (correct). iPad reports `coarse` → treated as mobile (acceptable).

## Rollout

Implement on an isolated git worktree (the main worktree has concurrent edits to `src/app.js`/`src/song.js`). Merge to the main worktree and `sudo systemctl restart vimsical-crate` to deploy. Removing the server audio path also drops the audio-render Chrome RAM; verify OG card rendering still works post-deploy.
