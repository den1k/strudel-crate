// scripts/lib/bank-index.mjs
// Pure, I/O-free helpers for the Strudel bank discovery crawler
// (scripts/crawl-banks.mjs). Everything here is deterministic and unit-tested
// against fixture manifests — no network, no filesystem, no LLM. The crawler
// composes these to turn a raw strudel.json into an index entry, and a set of
// entries into the compact in-prompt digest.
//
// See docs/superpowers/specs/2026-06-23-bank-discovery-crawler-design.md.

// ---- manifest parsing ------------------------------------------------------

/**
 * Parse a raw strudel.json body into a manifest object, or null if it is not
 * valid JSON or not a plain object. Arrays/scalars are rejected — a manifest is
 * a map of `soundName -> path(s)` plus optional `_`-prefixed meta keys.
 */
export function parseManifest(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

// Audio file extensions a Strudel bank's sample paths use. Matched
// case-insensitively, tolerating a trailing query string or fragment
// (e.g. `kick.wav?v=2`, `pad.mp3#a`).
const AUDIO_EXT_RE = /\.(wav|ogg|mp3|flac|aif|aiff|m4a)(?:[?#].*)?$/i;

// A manifest qualifies as a sample bank when at least this fraction of its
// string leaf values look like audio file paths. Tuned to admit real banks
// (whose leaves are ~100% audio) while rejecting app-config / data manifests
// that merely happen to be named strudel.json.
const AUDIO_MAJORITY = 0.6;

/**
 * Collect every string leaf under a manifest value, descending through arrays
 * and nested objects. Real Strudel banks come in three shapes, all handled:
 *   - array of paths:   "kick": ["a.wav", "b.wav"]
 *   - single path:      "kick": "a.wav"
 *   - nested object:    "wt": { "d2": ["a.wav", ...] }   (e.g. wavetable banks)
 */
function collectStrings(val, out) {
  if (typeof val === 'string') out.push(val);
  else if (Array.isArray(val)) for (const v of val) collectStrings(v, out);
  else if (val && typeof val === 'object') for (const v of Object.values(val)) collectStrings(v, out);
  return out;
}

/**
 * True if a non-`_` manifest value carries at least one sample path (i.e. it is
 * a string, array, or object that bottoms out in strings) — so it represents a
 * loadable sound rather than a scalar config field. The leaf strings still have
 * to pass the audio-majority check in `isSampleBank` for the bank to be kept.
 */
function valueHoldsSamples(val) {
  return collectStrings(val, []).length > 0;
}

/**
 * The sound names a manifest defines: every top-level key that is not a
 * `_`-prefixed meta key (`_base`, `_meta`, …) whose value carries sample paths
 * (a string, an array, or a nested object of strings). A plain config key whose
 * value bottoms out in a number/bool (no path strings) is never a sound. Order
 * is preserved.
 */
export function extractSounds(manifest) {
  if (!manifest || typeof manifest !== 'object') return [];
  return Object.keys(manifest).filter(
    (k) => !k.startsWith('_') && valueHoldsSamples(manifest[k]),
  );
}

// ---- bank-shape guard ------------------------------------------------------

// Generic container keys a package/asset-manifest uses to hold its file list
// (e.g. `{ name, version, resources: [...wav] }`). A real Strudel bank's
// top-level keys ARE the sound names, so a manifest whose ONLY audio-carrying
// key is one of these is a packaged asset list, not a bank.
const CONTAINER_KEYS = new Set(['resources', 'files', 'assets', 'samples', 'sounds']);

/**
 * The npm/package-manifest signature: top-level `name`, `version`, AND
 * `description` keys together. No real Strudel bank uses that combo as top-level
 * keys (those would register as bogus "sounds"), so it reliably marks a packaged
 * asset list whose .wav paths would otherwise pass the audio-majority check.
 */
function looksLikePackageManifest(manifest) {
  return 'name' in manifest && 'version' in manifest && 'description' in manifest;
}

/**
 * True only if `manifest` looks like a real Strudel sample bank, not an app
 * config, data file, or packaged asset list that merely shares the
 * `strudel.json` filename.
 *
 * Two guards, both required:
 *  1. Shape signature — reject the package-manifest shape: the npm-style
 *     `name`+`version`+`description` top-level triple, OR a manifest whose ONLY
 *     audio-carrying key is a generic container name (`resources`/`files`/
 *     `assets`/`samples`/`sounds`). A real bank's top-level keys are the sound
 *     names themselves, so neither signal can match a legitimate bank.
 *  2. Audio majority — gather every string leaf under the non-`_` keys
 *     (descending through arrays and nested objects, so the array / single-path /
 *     wavetable-object bank shapes all count) and keep only when there is at
 *     least one such leaf and a strong majority (>= AUDIO_MAJORITY = 60%) look
 *     like audio file paths. The `{id, name, url}` config shape fails here.
 *
 * Tradeoff: a rare bank that lists extensionless sample names
 * (e.g. ["break1","break2"]) has no audio-looking leaves and is dropped. That is
 * acceptable — the alternative would re-admit config manifests, and such banks
 * are uncommon and still loadable by hand once known.
 */
export function isSampleBank(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return false;

  // Guard 1a: the npm/package-manifest triple is never a real bank's key set.
  if (looksLikePackageManifest(manifest)) return false;

  // Guard 1b: if every audio-carrying top-level key is a generic container name,
  // this is a packaged asset list (one bogus "resources" sound), not a bank.
  const soundKeys = extractSounds(manifest);
  if (soundKeys.length > 0 && soundKeys.every((k) => CONTAINER_KEYS.has(k.toLowerCase()))) {
    return false;
  }

  // Guard 2: audio majority across all string leaves under the non-`_` keys.
  const leaves = [];
  for (const [key, val] of Object.entries(manifest)) {
    if (key.startsWith('_')) continue;
    collectStrings(val, leaves);
  }
  if (leaves.length === 0) return false;
  const audio = leaves.filter((s) => AUDIO_EXT_RE.test(s)).length;
  return audio / leaves.length >= AUDIO_MAJORITY;
}

// ---- loadable reference resolution -----------------------------------------

/**
 * The exact string an agent passes to `samples(...)` to load this bank.
 *
 * A root-level `strudel.json` on the `main` branch is loadable with the compact
 * `github:owner/repo` shorthand (which Strudel resolves to
 * raw…/owner/repo/main/strudel.json). Anything else — a sub-path manifest or a
 * non-`main` default branch — falls back to the full raw URL so the ref is
 * always loadable exactly as written.
 *
 * @param {{owner:string, repo:string, path:string, branch:string}} loc
 */
export function resolveRef({ owner, repo, path, branch }) {
  if (path === 'strudel.json' && branch === 'main') {
    return `github:${owner}/${repo}`;
  }
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
}

// ---- categorization --------------------------------------------------------

// Keyword table: category -> substrings that, when found inside a (lowercased)
// sound name, vote for that category. Matching is case-insensitive and on
// substrings, so compound names like `crate_bd` or `mychoir_01` still match.
// Keep tokens specific enough to avoid cross-category bleed (e.g. don't put a
// bare "s" anywhere).
export const CATEGORY_KEYWORDS = {
  drums: [
    'bd', 'sd', 'hh', 'kick', 'snare', 'snr', 'hat', 'hihat', 'clap', 'clp',
    'rim', 'tom', 'crash', 'ride', 'cym', 'cowbell', 'shaker', 'tamb',
    'perc', 'drum', '909', '808drum', '707', '606', 'cr78', 'linn',
  ],
  // '808' deliberately excluded: 808-drum-machine names (808bd, 808sd, …) already
  // vote drums via bd/sd, so counting '808' as bass mislabels whole drum kits
  // (e.g. tidalcycles/Dirt-Samples) as bass. Real bass hits 'bass'/'sub'/'reese'.
  bass: ['bass', 'sub', 'reese', 'wobble', 'moog', 'bassline'],
  lead: ['lead', 'arp', 'pluck', 'stab', 'acid', 'saw', 'synth', 'seq', 'blip', 'wt_', 'wavetable'],
  pad: ['pad', 'swpad', 'string', 'strings', 'warm', 'drone', 'ambient', 'atmos', 'chord'],
  vocal: ['vox', 'voc', 'voice', 'choir', 'vowel', 'breath', 'ooh', 'aah', 'ahh', 'sing', 'speak', 'word', 'phrase'],
  world: [
    'djembe', 'tabla', 'sitar', 'conga', 'bongo', 'kalimba', 'gamelan',
    'koto', 'shaku', 'mridangam', 'darbuka', 'udu', 'taiko', 'ethnic',
    'african', 'indian', 'latin', 'gong',
  ],
  breaks: ['amen', 'break', 'jungle', 'apache', 'funky', 'chopped'],
  fx: ['riser', 'sweep', 'impact', 'noise', 'fx', 'sfx', 'whoosh', 'glitch', 'foley', 'zap', 'downer', 'uplifter', 'boom'],
  melodic: [
    'piano', 'rhodes', 'epiano', 'guitar', 'organ', 'bell', 'marimba',
    'vibraphone', 'xylophone', 'flute', 'sax', 'brass', 'trumpet', 'violin',
    'cello', 'harp', 'mallet', 'keys', 'wurli', 'clav', 'mridang',
  ],
};

// Fixed tie-break order. When two categories tie on match count, the one earlier
// in this list wins. `misc` is always last and is the no-match fallback.
export const CATEGORY_PRIORITY = [
  'drums', 'bass', 'lead', 'pad', 'vocal', 'world', 'breaks', 'fx', 'melodic', 'misc',
];

/**
 * Classify a bank into exactly one category from a vote over its sound names.
 * Each sound name that contains a category's keyword adds one vote to that
 * category. The category with the most votes wins; ties break by
 * CATEGORY_PRIORITY; no votes at all → `misc`.
 */
export function categorize(sounds) {
  const votes = Object.create(null);
  for (const raw of sounds ?? []) {
    const name = String(raw).toLowerCase();
    for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
      if (keywords.some((kw) => name.includes(kw))) {
        votes[cat] = (votes[cat] ?? 0) + 1;
      }
    }
  }
  let best = 'misc';
  let bestVotes = 0;
  // Iterate in priority order so the first category reaching a given vote count
  // is kept and later (lower-priority) ties never displace it.
  for (const cat of CATEGORY_PRIORITY) {
    const v = votes[cat] ?? 0;
    if (v > bestVotes) {
      best = cat;
      bestVotes = v;
    }
  }
  return bestVotes === 0 ? 'misc' : best;
}

// ---- description -----------------------------------------------------------

/**
 * One-line human description for an index entry:
 *   "<category> · <n> sounds · <first up-to-3 names>[ …]"
 * The trailing " …" appears only when there are more than 3 sound names.
 */
export function describe(entry) {
  const { category, soundCount, sounds = [] } = entry;
  const head = sounds.slice(0, 3).join(', ');
  const ellipsis = sounds.length > 3 ? ' …' : '';
  return `${category} · ${soundCount} sounds · ${head}${ellipsis}`;
}

// ---- digest ----------------------------------------------------------------

const DEFAULT_PER_CATEGORY = 6;

/**
 * Build the compact, category-grouped digest injected into the Stage-1
 * kit-design prompt as {bank_digest}. Categories appear in CATEGORY_PRIORITY
 * order; within each, banks are listed `repo · ref · soundCount`, top-N by
 * stars, with a per-category footer "…and M more — grep `data/banks.json`."
 * when the category overflows the cap. No sound lists (those live in the full
 * index; agents grep for exact names).
 */
export function buildDigest(banks, { perCategory = DEFAULT_PER_CATEGORY } = {}) {
  const all = banks ?? [];
  const lines = ['## Loadable sample banks discovered on GitHub'];
  lines.push(
    'These are REAL, loadable Strudel banks (crawled from public repos). Reach ' +
    'past the base palette: load one with `samples(\'<ref>\')`. For a bank\'s exact ' +
    'sound names, grep `data/banks.json` before you write the `samples()` load.',
  );

  if (all.length === 0) {
    lines.push('');
    lines.push('_No banks indexed yet — run `npm run crawl-banks`._');
    return lines.join('\n');
  }

  for (const category of CATEGORY_PRIORITY) {
    const inCat = all
      .filter((b) => b.category === category)
      .sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0));
    if (inCat.length === 0) continue;

    lines.push('');
    lines.push(`### ${category} (${inCat.length})`);
    for (const b of inCat.slice(0, perCategory)) {
      lines.push(`- ${b.repo} · ${b.ref} · ${b.soundCount}`);
    }
    const more = inCat.length - perCategory;
    if (more > 0) {
      lines.push(`- …and ${more} more — grep \`data/banks.json\`.`);
    }
  }

  return lines.join('\n');
}
