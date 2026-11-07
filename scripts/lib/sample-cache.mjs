// scripts/lib/sample-cache.mjs
// Vendor (cache-on-save) the external sample banks a track self-declares via
// `samples('github:user/repo')`, so a saved track never breaks when an upstream
// repo vanishes. On a successful validation, save-track/save-stem call cacheBank
// for each referenced bank, then writeTrackManifest to record the dependency.
//
// Cache layout (default root: data/sample-cache/):
//   banks/<slug>/strudel.json   manifest with _base rewritten to "./" (portable)
//   banks/<slug>/<relpath>      every referenced sample, mirrored by relative path
//   manifests/<track-id>.json   { banks: [...sources], slugs: [...bankSlugs] }
//
// The webapp serves banks/<slug>/strudel.json and loads it with samples(), naming that directory
// as the base (Strudel resolves a relative _base against the page, not the manifest). The mirrored
// layout means cached banks are self-contained.
import { mkdir, writeFile, readFile, access, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_CACHE_DIR = join(ROOT, 'data', 'sample-cache');

// Bound how much a single track can pull, per the design's security note.
const MAX_FILES_PER_BANK = 600;
const MAX_FILE_BYTES = 64 * 1024 * 1024; // largest vendored sample today is 16 MB
const MAX_BANK_BYTES = 1024 * 1024 * 1024; // largest vendored bank today is 177 MB
// The whole cache. Saves can name many banks and this disk is shared. Past it, new banks don't
// vendor: a save warns, and the track loads from upstream. Today: 582 MB.
const MAX_CACHE_BYTES = 4 * 1024 * 1024 * 1024;

// ---- manifest safety -------------------------------------------------------
// A manifest is attacker-controlled (any public repo, refetched at vendor time),
// so nothing in it reaches the network or the disk until it has been checked.

const AUDIO_FILE_RE = /\.(wav|ogg|mp3|flac|aif|aiff|m4a)$/i;

/** True only for a relative audio path that stays inside `bankDir`. */
export function isSafeSamplePath(rel, bankDir) {
  if (typeof rel !== 'string' || !rel) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(rel) || rel.startsWith('/')) return false; // URL or absolute
  if (/[\\\0-\x1f]/.test(rel) || /%(2e|2f|5c|00)/i.test(rel)) return false; // separators in disguise
  if (rel.split('/').includes('..')) return false;
  if (!AUDIO_FILE_RE.test(rel)) return false; // the path as written, so `a.wav?.html` fails
  return resolve(bankDir, rel).startsWith(resolve(bankDir) + sep);
}

// IPv4/IPv6 literals and names that reach this host or the tailnet. Literals only:
// internal services here speak plain http, which the https rule already excludes,
// so this is a second layer rather than a DNS-aware SSRF filter.
function isInternalHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h.includes(':')) return true; // no public bank is addressed by IPv6 literal
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** True for an https URL on a host that isn't an internal literal. */
export function isSafeRemoteUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !isInternalHost(u.hostname);
  } catch {
    return false;
  }
}

// Agent-written code picks these URLs, and agents hold private text. A URL is a way to send
// that text anywhere, so at save time sources may only name known sample CDNs, with nothing
// beyond a path. Repos on GitHub are still attacker-choosable, but a raw file fetch shows the
// repo's owner nothing.
export const ALLOWED_SAMPLE_HOSTS = new Set(['raw.githubusercontent.com', 'strudel.b-cdn.net']);

export function isAllowedSampleUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && ALLOWED_SAMPLE_HOSTS.has(u.hostname) && !u.port
      && !u.username && !u.password && !u.search && !u.hash;
  } catch {
    return false;
  }
}

// ---- pure helpers ----------------------------------------------------------

/** Filesystem-safe, stable slug for a bank source (shorthand or URL). */
export function bankSlug(source) {
  return source.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

/** The strudel.json manifest URL for a bank source. Mirrors webaudio's githubPath. */
export function manifestUrlFor(source) {
  if (source.startsWith('github:')) {
    const parts = source.slice('github:'.length).replace(/\/$/, '').split('/');
    const [user, repo = 'samples', branch = 'main', ...rest] = parts;
    return `https://raw.githubusercontent.com/${[user, repo, branch, ...rest, 'strudel.json'].join('/')}`;
  }
  return source; // already a URL
}

/** Every samples() source string referenced in a code blob, in order. */
export function extractSampleRefs(code) {
  const refs = [];
  const re = /samples\s*\(\s*(['"])([^'"]+)\1/g;
  let m;
  while ((m = re.exec(code)) !== null) refs.push(m[2]);
  return refs;
}

// ---- cache operations ------------------------------------------------------

// Beside a bank's manifest: the source it was vendored from. Never a sample path (not audio).
export const BANK_SOURCE_FILE = 'source.txt';
const sameSource = (a, b) => a.toLowerCase() === b.toLowerCase(); // GitHub names ignore case

async function dirBytes(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const sizes = await Promise.all(entries.map(async (e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return dirBytes(p);
    return e.isFile() ? (await stat(p)).size : 0;
  }));
  return sizes.reduce((sum, n) => sum + n, 0);
}

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

/** True if this bank has already been vendored to the cache. */
export async function isBankCached(source, { cacheDir = DEFAULT_CACHE_DIR } = {}) {
  return exists(join(cacheDir, 'banks', bankSlug(source), 'strudel.json'));
}

// A manifest maps each (non-underscore) key to a string or array of relative
// sample paths. Flatten to the unique set of relative paths to mirror locally.
function manifestSamplePaths(manifest) {
  const paths = new Set();
  for (const [key, val] of Object.entries(manifest)) {
    if (key.startsWith('_')) continue;
    for (const p of Array.isArray(val) ? val : [val]) {
      if (typeof p === 'string') paths.add(p);
    }
  }
  return [...paths];
}

// True only when every file the bank's manifest lists is on disk, at any depth (pitched maps too).
// Some banks were vendored without all their audio, and upstream may still have what they lack.
export async function isBankComplete(bankDir) {
  try {
    const manifest = JSON.parse(await readFile(join(bankDir, 'strudel.json'), 'utf8'));
    const paths = [];
    const collect = (v) => {
      if (typeof v === 'string') paths.push(v);
      else if (v && typeof v === 'object') Object.values(v).forEach(collect);
    };
    for (const [key, val] of Object.entries(manifest)) if (!key.startsWith('_')) collect(val);
    if (!paths.every((rel) => isSafeSamplePath(rel, bankDir))) return false;
    return (await Promise.all(paths.map((rel) => exists(join(bankDir, rel))))).every(Boolean);
  } catch {
    return false;
  }
}

/**
 * Return a copy of `manifest` keeping only sample paths present in `keep`
 * (a Set of relative paths). Used after a vendor that skipped 404'd samples so
 * the cached manifest lists only files we actually wrote. Preserves `_`-prefixed
 * metadata and the original value shape (string stays string, array stays array).
 */
export function pruneManifestPaths(manifest, keep) {
  const out = {};
  for (const [key, val] of Object.entries(manifest)) {
    if (key.startsWith('_')) { out[key] = val; continue; }
    if (Array.isArray(val)) {
      const filtered = val.filter((p) => typeof p === 'string' && keep.has(p));
      if (filtered.length) out[key] = filtered;
    } else if (typeof val === 'string') {
      if (keep.has(val)) out[key] = val;
    } else {
      out[key] = val;
    }
  }
  return out;
}

/**
 * Vendor a bank locally: fetch its manifest + every referenced sample, rewrite
 * the manifest's _base to "./", and write it all under banks/<slug>/. Idempotent:
 * a bank that is already fully cached is skipped without refetching samples.
 * On success, `files` is the number of samples kept and `skipped` lists referenced
 * samples that 404'd and were omitted.
 */
export async function cacheBank(source, opts = {}) {
  const {
    cacheDir = DEFAULT_CACHE_DIR,
    fetchImpl = fetch,
    isAllowed = isAllowedSampleUrl,
    maxFiles = MAX_FILES_PER_BANK,
    maxFileBytes = MAX_FILE_BYTES,
    maxBankBytes = MAX_BANK_BYTES,
    maxCacheBytes = MAX_CACHE_BYTES,
  } = opts;
  const slug = bankSlug(source);
  const bankDir = join(cacheDir, 'banks', slug);

  if (await isBankCached(source, { cacheDir })) {
    // bankSlug isn't injective (`a-b/c`, `a/b-c`), and a name someone else's bank holds isn't this bank.
    const holder = await readFile(join(bankDir, BANK_SOURCE_FILE), 'utf8').catch(() => null);
    if (holder !== null && !sameSource(holder, source)) return { ok: false, error: `bank name already holds ${holder}` };
    return { ok: true, slug, cached: true };
  }

  const manifestUrl = manifestUrlFor(source);
  if (!isSafeRemoteUrl(manifestUrl) || !isAllowed(manifestUrl)) return { ok: false, error: `unsafe bank source: ${source}` };

  let manifest;
  try {
    const res = await fetchImpl(manifestUrl, { redirect: 'error' });
    if (res.ok === false) return { ok: false, error: `manifest HTTP ${res.status} for ${source}` };
    manifest = await res.json();
  } catch (err) {
    return { ok: false, error: `manifest fetch failed for ${source}: ${err.message}` };
  }

  const base = manifest._base; // absolute base the relative paths hang off
  const paths = manifestSamplePaths(manifest);
  if (paths.length > maxFiles) {
    return { ok: false, error: `bank ${source} exceeds the ${maxFiles}-file bound (${paths.length}) — too many samples to vendor` };
  }

  // Whole-bank decision, before any fetch or write: one bad entry means the manifest
  // isn't a plain sample bank, so nothing from it is vendored. Callers fall back to
  // upstream, exactly as for any other vendoring miss.
  if (paths.length > 0 && (!isSafeRemoteUrl(base) || !isAllowed(base))) {
    return { ok: false, error: `unsafe or missing _base in ${source}` };
  }
  const unsafe = paths.find((rel) => !isSafeSamplePath(rel, bankDir));
  if (unsafe !== undefined) return { ok: false, error: `unsafe sample path in ${source}: ${JSON.stringify(unsafe)}` };

  // strudel.json is written last, so a half-vendored bank has samples but no
  // manifest — abort() removes the partial dir so it isn't left as an orphan.
  // A single missing sample (404) is common in community manifests that over-
  // list files; skip those and cache the rest. Other failures (network, 5xx,
  // timeout) are treated as transient and abort the whole bank.
  const abort = async (error) => { await rm(bankDir, { recursive: true, force: true }); return { ok: false, error }; };
  const kept = [];
  const skipped = [];
  let bankBytes = 0;
  const cacheBytes = await dirBytes(cacheDir);
  for (const rel of paths) {
    const url = new URL(rel, base).href;
    let buf;
    try {
      const res = await fetchImpl(url, { redirect: 'error' });
      if (res.status === 404) { skipped.push(rel); continue; }
      if (res.ok === false) return abort(`sample HTTP ${res.status}: ${url}`);
      if (Number(res.headers?.get?.('content-length')) > maxFileBytes) return abort(`sample too large: ${url}`);
      buf = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      return abort(`sample fetch failed (${url}): ${err.message}`);
    }
    if (buf.length > maxFileBytes) return abort(`sample too large: ${url}`);
    bankBytes += buf.length;
    if (bankBytes > maxBankBytes) return abort(`bank too large: ${source}`);
    if (cacheBytes + bankBytes > maxCacheBytes) return abort(`sample cache is full, not vendoring ${source}`);
    const dest = join(bankDir, rel);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, buf);
    kept.push(rel);
  }

  // A bank that referenced samples but landed none isn't worth caching — abort
  // so callers fall back to upstream. A manifest with no sample paths at all
  // (metadata-only) is still valid and falls through to be written.
  if (paths.length > 0 && kept.length === 0) {
    return abort(`all ${paths.length} samples 404'd for ${source}`);
  }

  // Rewrite _base relative and prune any skipped paths so the cached manifest
  // lists only files that physically exist under banks/<slug>/.
  const localManifest = { ...pruneManifestPaths(manifest, new Set(kept)), _base: './' };
  await mkdir(bankDir, { recursive: true });
  await writeFile(join(bankDir, BANK_SOURCE_FILE), source);
  await writeFile(join(bankDir, 'strudel.json'), JSON.stringify(localManifest, null, 2) + '\n');
  return { ok: true, slug, cached: false, files: kept.length, skipped };
}

/** Record which banks a saved track depends on (for offline re-validation / GC). */
export async function writeTrackManifest(trackId, sources, { cacheDir = DEFAULT_CACHE_DIR } = {}) {
  const dir = join(cacheDir, 'manifests');
  await mkdir(dir, { recursive: true });
  const manifest = { trackId, banks: sources, slugs: sources.map(bankSlug) };
  await writeFile(join(dir, `${trackId}.json`), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

/** Read a track's bank-dependency manifest, or null if none exists. */
export async function readTrackManifest(trackId, { cacheDir = DEFAULT_CACHE_DIR } = {}) {
  try {
    return JSON.parse(await readFile(join(cacheDir, 'manifests', `${trackId}.json`), 'utf8'));
  } catch {
    return null;
  }
}

// Literal sources a worker request names. Anything built at runtime isn't fetched, and fails
// in the evaluator, which has no network.
export function sourcesIn({ code, item, palette }) {
  const sources = [...extractSampleRefs(code ?? ''), ...extractSampleRefs(item?.code ?? '')];
  if (palette) {
    sources.push(...(Array.isArray(palette.samples) ? palette.samples : []));
    for (const v of Array.isArray(palette.voices) ? palette.voices : []) {
      sources.push(...(Array.isArray(v?.samples) ? v.samples : []), ...extractSampleRefs(typeof v?.frag === 'string' ? v.frag : ''));
    }
  }
  return [...new Set(sources.filter((s) => typeof s === 'string'))];
}

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_MANIFESTS = 32;

// Fetch, outside the evaluator, the manifests its samples() calls will ask for, keyed by the
// URL they'll ask for. Evaluates nothing.
export async function fetchManifests(sources, { fetchImpl = fetch } = {}) {
  if (sources.length > MAX_MANIFESTS) return { ok: false, error: `too many sample sources (${sources.length})` };
  const manifests = {};
  for (const source of sources) {
    const url = manifestUrlFor(source);
    if (!isAllowedSampleUrl(url)) {
      return { ok: false, error: `samples source not allowed: ${source.slice(0, 200)} (use github:user/repo, or a plain https URL on ${[...ALLOWED_SAMPLE_HOSTS].join(', ')})` };
    }
    try {
      const res = await fetchImpl(url, { redirect: 'error' });
      if (res.ok === false) return { ok: false, error: `samples() load failed: HTTP ${res.status} for ${source}` };
      const text = await res.text();
      if (text.length > MAX_MANIFEST_BYTES) return { ok: false, error: `samples() load failed: manifest too large for ${source}` };
      const manifest = JSON.parse(text);
      // Viewers' frames fetch samples from here, and may reach only the listed hosts. A relative
      // or missing _base stays on the manifest's own host.
      const base = manifest?._base;
      if (/^[a-z][a-z0-9+.-]*:/i.test(String(base ?? '')) && !isAllowedSampleUrl(base)) {
        return { ok: false, error: `samples() bank ${source} keeps its samples elsewhere (_base not on ${[...ALLOWED_SAMPLE_HOSTS].join(', ')})` };
      }
      manifests[url] = manifest;
    } catch (err) {
      return { ok: false, error: `samples() load failed for ${source}: ${err.message}` };
    }
  }
  return { ok: true, manifests };
}

/**
 * Vendor every bank a track/stem references and record the per-track manifest.
 * Best-effort but reports failures so the caller can warn. Returns
 * { ok, banks: [{ source, slug, ok, error?, skipped? }] }.
 */
export async function cacheTrackSamples(trackId, code, opts = {}) {
  const sources = extractSampleRefs(code);
  const banks = [];
  for (const source of sources) {
    const res = await cacheBank(source, opts);
    banks.push({ source, slug: bankSlug(source), ok: res.ok, error: res.error, skipped: res.skipped });
  }
  if (sources.length) await writeTrackManifest(trackId, sources, opts);
  return { ok: banks.every((b) => b.ok), banks };
}
