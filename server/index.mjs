import { createApp } from './app.mjs';
import { createStore } from './store.mjs';

const store = createStore({ tracksDir: 'tracks', ratingsDir: 'data/ratings' });
const app = createApp(store);
const port = process.env.PORT ?? 3001;
app.listen(port, () => console.log(`strudel-ai api listening on http://localhost:${port}`));
