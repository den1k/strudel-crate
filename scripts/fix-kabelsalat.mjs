// @kabelsalat/web@0.4.x ships no "exports" map, so plain Node resolves its
// IIFE "main" bundle and `import { SalatRepl } from '@kabelsalat/web'` (inside
// @strudel/core) fails. Point Node at the ESM build. Bundlers are unaffected.
import { readFile, writeFile } from 'node:fs/promises';

const path = 'node_modules/@kabelsalat/web/package.json';
let raw;
try {
  raw = await readFile(path, 'utf8');
} catch {
  console.warn('fix-kabelsalat: @kabelsalat/web not found, skipping patch');
  process.exit(0);
}
const pkg = JSON.parse(raw);
if (!pkg.exports) {
  pkg.exports = { '.': { import: './dist/index.mjs', default: './dist/index.js' } };
  await writeFile(path, JSON.stringify(pkg, null, 2) + '\n');
  console.log('patched @kabelsalat/web exports for Node ESM');
}
