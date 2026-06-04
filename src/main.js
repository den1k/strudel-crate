import { initApp } from './app.js';

initApp({
  apiBase: '/api/tracks',
  emptyHint: 'generate some tracks: <code>/generate-tracks "dark techno" 12</code>',
});
