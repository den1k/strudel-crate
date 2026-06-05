import { createApp } from './app.mjs';
import { createStore } from './store.mjs';

const app = createApp({
  tracks: createStore({ tracksDir: 'tracks', ratingsDir: 'data/ratings' }),
  stems: createStore({ tracksDir: 'stems', ratingsDir: 'data/stem-ratings' }),
});
const port = process.env.PORT ?? 3001;
app.listen(port, () => console.log(`strudel-ai api listening on http://localhost:${port}`));
