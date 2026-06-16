// src/db.js
// One InstantDB client instance shared by auth.js and app.js. Passing `schema`
// gives query/transact type hints. VITE_INSTANT_APP_ID is inlined at build time.
import { init } from '@instantdb/core';
import schema from '../instant.schema';

const appId = import.meta.env.VITE_INSTANT_APP_ID;

// Null only if Instant isn't configured (no app id) — callers guard on it.
export const db = appId ? init({ appId, schema }) : null;
