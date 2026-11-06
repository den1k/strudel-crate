import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

const page = (p) => fileURLToPath(new URL(p, import.meta.url));

// /stems is a second MPA page (stems.html); rewrite the clean URL before the
// SPA fallback would serve index.html for it.
const rewriteStems = (server) => {
  server.middlewares.use((req, _res, next) => {
    if (req.url === '/stems' || req.url === '/stems/' || req.url?.startsWith('/stems?')) req.url = '/stems.html';
    next();
  });
};

// /song/<slug> is the per-song page; any path under /song/ serves song.html
// (song.js reads the slug from location.pathname).
const rewriteSong = (server) => {
  server.middlewares.use((req, _res, next) => {
    if (req.url?.startsWith('/song/')) req.url = '/song.html';
    next();
  });
};

export default defineConfig({
  plugins: [
    wasm(),
    topLevelAwait(),
    { name: 'stems-route', configureServer: rewriteStems, configurePreviewServer: rewriteStems },
    { name: 'song-route', configureServer: rewriteSong, configurePreviewServer: rewriteSong },
  ],
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        main: page('./index.html'),
        stems: page('./stems.html'),
        song: page('./song.html'),
        exportRender: page('./export-render.html'),
        strudelEngine: page('./strudel-engine.html'),
      },
    },
  },
  optimizeDeps: { esbuildOptions: { target: 'esnext' } },
  // API_PROXY lets verification scripts point an isolated vite at an isolated API
  server: { proxy: { '/api': process.env.API_PROXY ?? 'http://localhost:3001' } },
});
