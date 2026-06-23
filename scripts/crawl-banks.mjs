// scripts/crawl-banks.mjs
// The ONLY networked unit of the bank discovery crawler. It searches GitHub for
// public Strudel sample banks (`filename:strudel.json`), light-validates each,
// categorizes it with the pure helpers in scripts/lib/bank-index.mjs, and writes
// a committed `data/banks.json` index plus a compact `shared/banks-digest.md`
// digest that Stage-1 kit-design agents consume.
//
// Discovery uses the already-authenticated `gh` CLI (den1k token) so there is no
// new secret to manage. Search is throttled to GitHub's 30/min code-search limit.
//
// Writes are atomic (temp file → rename) and happen ONLY on a fully successful
// run: a search failure, a rate-limit we can't recover from, or a zero-result
// run all leave any existing index untouched (never overwrite a good index with
// a partial/empty one).
//
// CLI:  npm run crawl-banks   (node scripts/crawl-banks.mjs)
//       --max-pages N   cap pages (default: until exhausted)
//       --dry-run       crawl + log the summary, but do not write files
//
// See docs/superpowers/specs/2026-06-23-bank-discovery-crawler-design.md.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseManifest,
  extractSounds,
  isSampleBank,
  resolveRef,
  categorize,
  describe as describeBank,
  buildDigest,
} from './lib/bank-index.mjs';

const execFileP = promisify(execFile);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_PATH = join(ROOT, 'data', 'banks.json');
const DIGEST_PATH = join(ROOT, 'shared', 'banks-digest.md');

// GitHub code search caps at 100/page and ~30 requests/min. Sleep this long
// between search pages to stay comfortably under the limit (≈28/min).
const SEARCH_SLEEP_MS = 2200;
// GitHub code search only returns the first 1000 results (10 pages of 100).
const MAX_SEARCH_PAGES = 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);

// ---- gh CLI wrappers -------------------------------------------------------

/** Run `gh api <path>` and return parsed JSON, or throw with a useful message. */
async function ghApi(path) {
  try {
    const { stdout } = await execFileP('gh', ['api', path], { maxBuffer: 32 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (err) {
    // gh writes API errors (403/422/etc) to stderr with a non-zero exit.
    const detail = err.stderr || err.message || String(err);
    const e = new Error(`gh api ${path} failed: ${detail.trim()}`);
    e.cause = err;
    throw e;
  }
}

/**
 * One page of code-search results for `filename:strudel.json`. Returns
 * { total, items }. Throws on API failure (caller decides whether to abort).
 */
async function searchPage(page) {
  const q = encodeURIComponent('filename:strudel.json');
  const data = await ghApi(`/search/code?q=${q}&per_page=100&page=${page}`);
  return { total: data.total_count ?? 0, items: data.items ?? [] };
}

/** Repo metadata (stars + default branch) — uses the core limit, not search. */
async function repoMeta(owner, repo) {
  const data = await ghApi(`/repos/${owner}/${repo}`);
  return { stars: data.stargazers_count ?? 0, defaultBranch: data.default_branch ?? 'main' };
}

// ---- discovery -------------------------------------------------------------

/**
 * Paginate the code search and collect one candidate per owner/repo, preferring
 * a root-level `strudel.json` over a nested one. Only files whose basename is
 * exactly `strudel.json` count (the search also matches e.g. `apple-strudel.json`).
 * Returns a Map keyed by `owner/repo`.
 */
async function discoverCandidates({ maxPages = MAX_SEARCH_PAGES, log = console.error } = {}) {
  const byRepo = new Map();
  let total = 0;
  let seen = 0;

  for (let page = 1; page <= maxPages; page++) {
    const { total: t, items } = await searchPage(page);
    total = t;
    if (items.length === 0) break;
    seen += items.length;

    for (const it of items) {
      const path = it.path ?? '';
      // exact basename match — drop apple-strudel.json, foo/strudel.json.bak, …
      if (path.split('/').pop() !== 'strudel.json') continue;
      const full = it.repository?.full_name;
      if (!full || !full.includes('/')) continue;
      const [owner, repo] = full.split('/');
      const isRoot = path === 'strudel.json';

      const existing = byRepo.get(full);
      // Prefer the root-level manifest; otherwise keep the first seen.
      if (!existing || (isRoot && !existing.isRoot)) {
        byRepo.set(full, { owner, repo, full, path, isRoot });
      }
    }

    log(`  search page ${page}: +${items.length} items (running ${byRepo.size} repos, ${total} total matches)`);
    if (seen >= total) break;
    if (page < maxPages) await sleep(SEARCH_SLEEP_MS);
  }

  return byRepo;
}

// ---- enrichment ------------------------------------------------------------

/**
 * Fetch + light-validate + enrich one candidate into an index entry, or return
 * { skipped, reason } when it should be dropped. Never throws.
 */
async function enrichCandidate(cand, { fetchImpl = fetch } = {}) {
  let meta;
  try {
    meta = await repoMeta(cand.owner, cand.repo);
  } catch (err) {
    return { skipped: true, reason: `repo-meta failed: ${err.message}` };
  }
  const branch = meta.defaultBranch;
  const rawUrl = `https://raw.githubusercontent.com/${cand.owner}/${cand.repo}/${branch}/${cand.path}`;

  let res, text;
  try {
    res = await fetchImpl(rawUrl);
  } catch (err) {
    return { skipped: true, reason: `fetch error: ${err.message}` };
  }
  if (!res.ok) return { skipped: true, reason: `HTTP ${res.status}` };
  try {
    text = await res.text();
  } catch (err) {
    return { skipped: true, reason: `body read error: ${err.message}` };
  }

  const manifest = parseManifest(text);
  if (!manifest) return { skipped: true, reason: 'not a JSON object' };
  // Shape guard: a strudel.json that is really an app config / data file
  // (string/object values, no audio paths) is NOT a sample bank — drop it so it
  // never pollutes the index or the digest agents read.
  if (!isSampleBank(manifest)) return { skipped: true, reason: 'not a sample bank' };
  const sounds = extractSounds(manifest);
  if (sounds.length === 0) return { skipped: true, reason: 'no sounds' };

  const ref = resolveRef({ owner: cand.owner, repo: cand.repo, path: cand.path, branch });
  const category = categorize(sounds);
  const entry = {
    ref,
    repo: cand.full,
    category,
    soundCount: sounds.length,
    sounds,
    description: '',
    stars: meta.stars,
    lastSeen: today(),
  };
  entry.description = describeBank(entry);
  return { entry };
}

// ---- atomic writes ---------------------------------------------------------

async function writeAtomic(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, contents);
  await rename(tmp, path);
}

// ---- orchestrator ----------------------------------------------------------

export async function crawl({
  maxPages = MAX_SEARCH_PAGES,
  fetchImpl = fetch,
  log = console.error,
} = {}) {
  log('Searching GitHub for strudel.json banks…');
  let candidates;
  try {
    candidates = await discoverCandidates({ maxPages, log });
  } catch (err) {
    throw new Error(`search failed — keeping existing index: ${err.message}`);
  }
  if (candidates.size === 0) {
    throw new Error('search returned zero candidates — keeping existing index');
  }
  log(`Found ${candidates.size} unique repos. Fetching + validating manifests…`);

  const entries = [];
  const skips = [];
  for (const cand of candidates.values()) {
    const r = await enrichCandidate(cand, { fetchImpl });
    if (r.entry) entries.push(r.entry);
    else skips.push({ repo: cand.full, reason: r.reason });
  }

  if (entries.length === 0) {
    throw new Error('no valid banks after fetch/parse — keeping existing index');
  }

  // Sort the index deterministically: category priority, then stars desc, then repo.
  entries.sort((a, b) =>
    (b.stars ?? 0) - (a.stars ?? 0) || a.repo.localeCompare(b.repo));

  return { entries, skips, totalCandidates: candidates.size };
}

function categoryBreakdown(entries) {
  const counts = {};
  for (const e of entries) counts[e.category] = (counts[e.category] ?? 0) + 1;
  return counts;
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const mpIdx = argv.indexOf('--max-pages');
  const maxPages = mpIdx >= 0 ? Number.parseInt(argv[mpIdx + 1], 10) : MAX_SEARCH_PAGES;

  const { entries, skips, totalCandidates } = await crawl({ maxPages });

  const breakdown = categoryBreakdown(entries);
  const notBankCount = skips.filter((s) => s.reason === 'not a sample bank').length;
  console.error(`\nIndexed ${entries.length} banks (from ${totalCandidates} repos; ${skips.length} skipped).`);
  console.error(`  of which ${notBankCount} dropped by the bank-shape filter (not a sample bank).`);
  console.error('Category breakdown:', JSON.stringify(breakdown));
  if (skips.length) {
    console.error('Skipped (first 25):');
    for (const s of skips.slice(0, 25)) console.error(`  - ${s.repo}: ${s.reason}`);
  }

  if (dryRun) {
    console.error('\n--dry-run: not writing files.');
    return;
  }

  await writeAtomic(INDEX_PATH, JSON.stringify(entries, null, 2) + '\n');
  await writeAtomic(DIGEST_PATH, buildDigest(entries) + '\n');
  console.error(`\nWrote ${INDEX_PATH}`);
  console.error(`Wrote ${DIGEST_PATH}`);
}

// Run only when invoked directly (so tests can import crawl()/helpers).
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`\nCrawl aborted: ${err.message}`);
    process.exit(1);
  });
}
