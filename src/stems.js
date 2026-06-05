import { initApp } from './app.js';

initApp({
  apiBase: '/api/stems',
  emptyHint: 'conjure some stems: <code>/generate-stems "alien sound" 30</code>',
}).catch((err) => console.error('initApp failed', err));
