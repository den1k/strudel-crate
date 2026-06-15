import { initApp } from './app.js';

initApp({
  apiBase: '/api/tracks',
  emptyHint: 'generate some tracks: <code>/generate-tracks "dark techno" 12</code>',
  splitStems: true,
}).catch((err) => console.error('initApp failed', err));
