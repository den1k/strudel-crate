import { initApp } from './app.js';
import { setupAuth } from './auth.js';

setupAuth();

initApp({
  namespace: 'stems',
  emptyHint: 'conjure some stems: <code>/generate-stems "alien sound" 30</code>',
}).catch((err) => console.error('initApp failed', err));
