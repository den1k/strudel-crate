# Social Preview Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a `/song/<id>` link or the crate home page (`/`) is shared on iMessage, WhatsApp, Telegram, or social, it unfurls into a rich preview card with a unique, on-brand image generated from the song.

**Architecture:** Crawlers don't run JS, so the Express server (which serves the built SPA) injects Open Graph + Twitter Card `<meta>` tags into the HTML it returns for `/` and `/song/:slug`. The per-song `og:image` points at a new `/api/:ns/:id/card.jpg` route that renders a 1200×630 **"Acid Deck"** card in headless Chrome (reusing the repo's existing puppeteer-core pattern) and caches the JPEG on disk (mirroring the existing audio cache). The home page uses a brand card at `/og/home.jpg`.

**Card design ("Acid Deck"):** a record-label release card crossed with a drum-machine display — acid-green (`#c8f53c`) on near-black, Bricolage Grotesque display title, IBM Plex Mono. Two motifs are **generated deterministically from the song's content** so every track gets a unique, recognizable card that reads even as a chat thumbnail: an **oscilloscope waveform** ("the sound") and a **16-step sequencer grid** ("the pattern"). Atmosphere from scanlines + grain + dual radial blooms + the song's faded real Strudel code, with an acid→hot-pink baseline bar. This was prototyped and visually verified at full and thumbnail size before being locked into Task 2.

**Tech Stack:** Node ESM (`.mjs`), Express 4, `puppeteer-core` (already a dependency, drives system Chrome), Vitest + Supertest for tests. No new dependencies.

## Global Constraints

- All server modules are ESM `.mjs`; tests are `test/<name>.test.mjs` run via `npm test` (`vitest run`). One assertion-focused test file per module.
- **No new npm dependencies.** `puppeteer-core` and `express` are already in `package.json`; everything else is Node built-ins.
- Card dimensions are exactly **1200×630** (the standard `summary_large_image` / Open Graph ratio).
- Card image format is **JPEG at quality 90** (`og:image` served as `image/jpeg`, URL/cache extension `.jpg`). Verified empirically: the grain-textured card is ~447 KB as PNG (over WhatsApp's ~300 KB link-preview threshold) but ~79 KB as JPEG q90 with the design fully intact. JPEG is supported by all targets (iMessage, WhatsApp, Telegram, Twitter).
- CRATE palette (copy verbatim into card CSS): `--bg #0c0d0a`, `--panel #13150e`, `--ink #e9edda`, `--dim #7c856e`, `--acid #c8f53c`, `--hot #ff5ca8`, `--line #2b2f20`. Display font `Bricolage Grotesque` (weight 800), mono font `IBM Plex Mono`.
- Production origin for absolute crawler URLs is `https://crate.vimsical.com`, overridable via `CRATE_PUBLIC_ORIGIN`.
- **Escape every DB-sourced string** (`title`, `description`, `code`, `artistName`, `meta.*`) before putting it into HTML — these are user/AI-authored and flow into both the meta tags and the card markup.
- Follow the existing renderer/cache idioms exactly: lazy browser launch, serial render lock, idle-close (see `server/render-audio.mjs`); atime-LRU disk cache (see `server/audio-cache.mjs`).
- The Instant entity **id** (UUID) is the canonical URL param; `slug` is a legacy fallback (a track and stem can share a slug). Resolve id-first, then slug — mirroring `src/song.js`'s `resolveItem` and `src/song-url.js`.

---

### Task 1: OG meta-tag builder + content hash (`server/og.mjs`)

Pure, DOM-free helpers that build the `<meta>` block and the cache-busting card-image URL. Heavily unit-tested because escaping correctness is a security property.

**Files:**
- Create: `server/og.mjs`
- Test: `test/og.test.mjs`

**Interfaces:**
- Consumes: nothing (Node `crypto` only).
- Produces:
  - `escapeHtml(s: string): string`
  - `truncate(s: string, max=200): string`
  - `metaSummary(meta?: object): string` — `"dark techno · 140 bpm · F#min · moody"`
  - `songDescription(item): string`
  - `cardHash(item): string` — 12-char hex of card-visible fields
  - `cardImageUrl(origin, ns, item): string` — `<origin>/api/<ns>/<entityId>/card.jpg?v=<hash>`
  - `metaTagsHtml({title, description, image, url, type?, imageAlt?}): string`
  - `injectMeta(html, tagsHtml): string`
  - `songMetaTags(item, ns, origin): string`
  - `brandMetaTags(origin): string`
  - `item` shape (produced by Task 5's `resolvePublicItem`): `{ entityId, slug, title, description, code, meta, artistName }`.

- [ ] **Step 1: Write the failing test**

Create `test/og.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import {
  escapeHtml, truncate, metaSummary, songDescription, cardHash,
  cardImageUrl, metaTagsHtml, injectMeta, songMetaTags, brandMetaTags,
} from '../server/og.mjs';

const item = {
  entityId: 'e-123', slug: 'demo-01', title: 'Neon Rinse',
  description: 'A rolling sub-bass workout.', code: 's("bd*4")',
  meta: { genre: 'dark techno', bpm: 140, key: 'F#min', mood: 'moody', energy: 4, instruments: ['acid', 'sub'] },
  artistName: 'Dennnis',
};

describe('escapeHtml', () => {
  it('escapes the five HTML-significant chars', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });
  it('stringifies null/undefined to empty', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('truncate', () => {
  it('leaves short strings untouched', () => {
    expect(truncate('hello', 200)).toBe('hello');
  });
  it('cuts on a word boundary with an ellipsis', () => {
    const out = truncate('one two three four five', 12);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(12);
  });
});

describe('metaSummary', () => {
  it('joins present fields with a middot, skipping blanks', () => {
    expect(metaSummary(item.meta)).toBe('dark techno · 140 bpm · F#min · moody');
    expect(metaSummary({ bpm: 120 })).toBe('120 bpm');
    expect(metaSummary({})).toBe('');
  });
});

describe('songDescription', () => {
  it('combines summary, artist, and description', () => {
    const d = songDescription(item);
    expect(d).toContain('dark techno · 140 bpm');
    expect(d).toContain('by Dennnis');
    expect(d).toContain('rolling sub-bass');
  });
  it('falls back to a tagline when empty', () => {
    expect(songDescription({ meta: {} })).toBe('AI-generated music you can remix in code.');
  });
});

describe('cardHash + cardImageUrl', () => {
  it('is stable for the same content', () => {
    expect(cardHash(item)).toBe(cardHash({ ...item }));
  });
  it('changes when a visible field changes', () => {
    expect(cardHash(item)).not.toBe(cardHash({ ...item, title: 'Other' }));
  });
  it('builds an absolute, cache-busted url', () => {
    const url = cardImageUrl('https://crate.vimsical.com', 'tracks', item);
    expect(url).toBe(`https://crate.vimsical.com/api/tracks/e-123/card.jpg?v=${cardHash(item)}`);
  });
});

describe('metaTagsHtml', () => {
  it('emits og + twitter tags and escapes values', () => {
    const html = metaTagsHtml({
      title: 'A "quoted" <title>', description: 'desc',
      image: 'https://x/y.png', url: 'https://x/', type: 'music.song',
    });
    expect(html).toContain('<meta property="og:title" content="A &quot;quoted&quot; &lt;title&gt;" />');
    expect(html).toContain('<meta property="og:image" content="https://x/y.png" />');
    expect(html).toContain('<meta property="og:image:width" content="1200" />');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(html).not.toContain('<title>'); // raw tag must be escaped, never present
  });
  it('omits empty values', () => {
    const html = metaTagsHtml({ title: 't', description: '', image: 'i', url: 'u' });
    expect(html).not.toContain('og:description');
  });
});

describe('injectMeta', () => {
  it('replaces the <!--OG--> marker when present', () => {
    expect(injectMeta('<head><!--OG--></head>', 'TAGS')).toBe('<head>TAGS</head>');
  });
  it('falls back to inserting before </head>', () => {
    expect(injectMeta('<head><title>x</title></head>', 'TAGS')).toContain('TAGS\n  </head>');
  });
});

describe('songMetaTags / brandMetaTags', () => {
  it('song tags carry the title and a music.song type', () => {
    const html = songMetaTags(item, 'tracks', 'https://crate.vimsical.com');
    expect(html).toContain('Neon Rinse — STRUDEL/CRATE');
    expect(html).toContain('og:type" content="music.song"');
    expect(html).toContain('/api/tracks/e-123/card.jpg?v=');
  });
  it('brand tags point at the home card', () => {
    const html = brandMetaTags('https://crate.vimsical.com');
    expect(html).toContain('STRUDEL/CRATE');
    expect(html).toContain('https://crate.vimsical.com/og/home.jpg');
    expect(html).toContain('og:url" content="https://crate.vimsical.com/"');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/og.test.mjs`
Expected: FAIL — `Cannot find module '../server/og.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `server/og.mjs`:

```js
// server/og.mjs
// Pure helpers for social link-unfurl previews (Open Graph + Twitter Card).
// No DOM, no Instant, no puppeteer — so they unit-test directly. app.mjs uses
// these to inject per-song / brand meta tags into the served HTML and to build
// the absolute, cache-busting card-image URL that crawlers fetch.
import { createHash } from 'node:crypto';

const BRAND = 'STRUDEL/CRATE';
const MARKER = '<!--OG-->';

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Trim to <= max chars on a word boundary, adding an ellipsis when cut.
export function truncate(s, max = 200) {
  const str = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (str.length <= max) return str;
  const cut = str.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + '…';
}

// "dark techno · 140 bpm · F#min · moody" — present fields only.
export function metaSummary(meta = {}) {
  return [meta.genre, meta.bpm && `${meta.bpm} bpm`, meta.key, meta.mood]
    .filter(Boolean).join(' · ');
}

// One-line social description for a song.
export function songDescription(item) {
  const summary = metaSummary(item.meta);
  const by = item.artistName ? `by ${item.artistName}` : '';
  const head = [summary, by].filter(Boolean).join(' — ');
  const tail = item.description ? ` ${item.description}` : '';
  const text = `${head}${tail}`.trim();
  return truncate(text || 'AI-generated music you can remix in code.');
}

// Stable hash of the fields the card image renders, so the og:image URL changes
// (busting crawler caches) only when the visible card content changes.
export function cardHash(item) {
  const basis = JSON.stringify({
    t: item.title ?? '',
    a: item.artistName ?? '',
    m: metaSummary(item.meta),
    e: item.meta?.energy ?? 0,
    i: (item.meta?.instruments ?? []).join(','),
    c: item.code ?? '',
  });
  return createHash('sha1').update(basis).digest('hex').slice(0, 12);
}

// Absolute URL of a song's card image (entity id + content hash for cache-bust).
export function cardImageUrl(origin, ns, item) {
  return `${origin}/api/${ns}/${encodeURIComponent(item.entityId)}/card.jpg?v=${cardHash(item)}`;
}

// Build the Open Graph + Twitter <meta> block. Every value is escaped; empty
// values are dropped so we never emit content="".
export function metaTagsHtml({ title, description, image, url, type = 'website', imageAlt }) {
  const og = [
    ['og:site_name', BRAND],
    ['og:type', type],
    ['og:title', title],
    ['og:description', description],
    ['og:url', url],
    ['og:image', image],
    ['og:image:secure_url', image],
    ['og:image:type', 'image/jpeg'],
    ['og:image:width', '1200'],
    ['og:image:height', '630'],
    ['og:image:alt', imageAlt ?? title],
  ].filter(([, v]) => v != null && v !== '')
    .map(([p, v]) => `<meta property="${p}" content="${escapeHtml(v)}" />`);

  const twitter = [
    ['twitter:card', 'summary_large_image'],
    ['twitter:title', title],
    ['twitter:description', description],
    ['twitter:image', image],
    ['twitter:image:alt', imageAlt ?? title],
  ].filter(([, v]) => v != null && v !== '')
    .map(([n, v]) => `<meta name="${n}" content="${escapeHtml(v)}" />`);

  const desc = description
    ? [`<meta name="description" content="${escapeHtml(description)}" />`] : [];

  return [...desc, ...og, ...twitter].join('\n    ');
}

// Replace the <!--OG--> marker, or insert before </head> if it isn't there.
export function injectMeta(html, tagsHtml) {
  if (html.includes(MARKER)) return html.replace(MARKER, tagsHtml);
  return html.replace('</head>', `    ${tagsHtml}\n  </head>`);
}

export function songMetaTags(item, ns, origin) {
  return metaTagsHtml({
    title: `${item.title} — ${BRAND}`,
    description: songDescription(item),
    image: cardImageUrl(origin, ns, item),
    url: `${origin}/song/${encodeURIComponent(item.entityId)}`,
    type: 'music.song',
    imageAlt: `${item.title} — Strudel code track`,
  });
}

export function brandMetaTags(origin) {
  return metaTagsHtml({
    title: `${BRAND} — AI-generated music you can remix in code`,
    description: 'A crate of AI-generated Strudel tracks. Play, remix, and export — all in the browser.',
    image: `${origin}/og/home.jpg`,
    url: `${origin}/`,
    type: 'website',
    imageAlt: BRAND,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/og.test.mjs`
Expected: PASS (all assertions green).

- [ ] **Step 5: Commit**

```bash
git add server/og.mjs test/og.test.mjs
git commit -m "feat(crate): OG/Twitter meta-tag builder + card-image hashing"
```

---

### Task 2: "Acid Deck" card templates (`server/og-card.mjs`)

Self-contained 1200×630 HTML documents (inline CSS + Google Fonts, no app bundle) that puppeteer screenshots. The card is a record-label release card crossed with a drum-machine display: a faded backdrop of the song's real Strudel code, an **oscilloscope waveform** and a **16-step sequencer grid** both generated deterministically from the song's content (so each card is unique yet on-brand), a bold title + artist, meta chips, and an acid→hot-pink baseline bar. This exact design was prototyped and screenshot-verified at full and chat-thumbnail size; the CSS/markup below is the verified result.

**Files:**
- Create: `server/og-card.mjs`
- Test: `test/og-card.test.mjs`

**Interfaces:**
- Consumes: `escapeHtml` from `server/og.mjs` (Task 1).
- Produces:
  - `seqRow(seed: string, density: number): boolean[]` — 16 deterministic step hits (downbeats biased on)
  - `scopePath(seed: string): string` — deterministic SVG `d` path for the oscilloscope (1200×220 viewBox)
  - `chipsHtml(meta?): string` — chip spans (first chip gets the acid `lead` class)
  - `codeArt(code): string` — escaped, length-capped (≤1100) code backdrop text
  - `songCardHtml(item): string` — full HTML doc for a song
  - `brandCardHtml(): string` — full HTML doc for the home/brand card
  - `item` shape: `{ title, artistName, code, meta }` (subset of Task 5's `resolvePublicItem` output).

- [ ] **Step 1: Write the failing test**

Create `test/og-card.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { seqRow, scopePath, chipsHtml, codeArt, songCardHtml, brandCardHtml } from '../server/og-card.mjs';

const item = {
  title: 'Neon Rinse', artistName: 'Dennnis', code: 's("bd*4").bank("RolandTR909")',
  meta: { genre: 'dark techno', bpm: 140, key: 'F#min', mood: 'hypnotic' },
};

describe('seqRow', () => {
  it('returns 16 booleans, deterministic per seed', () => {
    const a = seqRow('x', 0.4);
    expect(a).toHaveLength(16);
    expect(a.every((v) => typeof v === 'boolean')).toBe(true);
    expect(seqRow('x', 0.4)).toEqual(a);
    expect(seqRow('y', 0.4)).not.toEqual(a);
  });
});

describe('scopePath', () => {
  it('is a deterministic SVG path that varies by seed', () => {
    expect(scopePath('a').startsWith('M ')).toBe(true);
    expect(scopePath('a')).toBe(scopePath('a'));
    expect(scopePath('a')).not.toBe(scopePath('b'));
  });
});

describe('chipsHtml / codeArt', () => {
  it('marks the first chip as the acid lead and escapes values', () => {
    const html = chipsHtml({ genre: 'd&b', bpm: 174 });
    expect(html).toContain('class="chip lead"');
    expect(html).toContain('d&amp;b');
    expect(html).toContain('174 bpm');
  });
  it('is empty for empty meta', () => {
    expect(chipsHtml({})).toBe('');
  });
  it('escapes and length-caps the code', () => {
    expect(codeArt('a < b & "c"')).toBe('a &lt; b &amp; &quot;c&quot;');
    expect(codeArt('x'.repeat(5000)).length).toBe(1100);
  });
});

describe('songCardHtml', () => {
  it('is a 1200x630 doc with title, artist, chips, code, scope + sequencer', () => {
    const html = songCardHtml(item);
    expect(html).toContain('width: 1200px');
    expect(html).toContain('height: 630px');
    expect(html).toContain('Neon Rinse');
    expect(html).toContain('Dennnis');
    expect(html).toContain('dark techno');
    expect(html).toContain('RolandTR909');     // faded code backdrop
    expect(html).toContain('<path d="M ');      // oscilloscope
    expect(html).toContain('class="step');      // sequencer grid
  });
  it('escapes a hostile title (no raw script tag survives)', () => {
    const html = songCardHtml({ ...item, title: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
  it('handles a missing artist and empty meta', () => {
    const html = songCardHtml({ title: 'x', code: '', meta: {} });
    expect(html).toContain('width: 1200px');
    expect(html).not.toContain('class="by"');
    expect(html).toContain('from the crate'); // kicker fallback
  });
});

describe('brandCardHtml', () => {
  it('renders the brand card with a waveform', () => {
    const html = brandCardHtml();
    expect(html).toContain('STRUDEL');
    expect(html).toContain('width: 1200px');
    expect(html).toContain('<path d="M ');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/og-card.test.mjs`
Expected: FAIL — `Cannot find module '../server/og-card.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `server/og-card.mjs`:

```js
// server/og-card.mjs
// "Acid Deck" social card: a record-label release card crossed with a
// drum-machine display. Self-contained 1200×630 HTML (inline CSS + Google Fonts,
// no app bundle) rendered to a PNG by server/render-card.mjs. Two motifs are
// generated deterministically from the song's content — an oscilloscope waveform
// ("the sound") and a 16-step sequencer grid ("the pattern") — so every track
// gets a unique, recognizable card that reads even as a chat thumbnail.
import { escapeHtml } from './og.mjs';

const FONTS = 'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,300..800&family=IBM+Plex+Mono:wght@400;500;600&display=swap';

const SHELL = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="${FONTS}" rel="stylesheet" />
<style>
  * { margin: 0; box-sizing: border-box; }
  html, body { width: 1200px; height: 630px; }
  .card {
    --bg:#0c0d0a; --ink:#e9edda; --dim:#7c856e; --acid:#c8f53c; --hot:#ff5ca8; --line:#2b2f20;
    position:relative; width:1200px; height:630px; overflow:hidden;
    background:
      radial-gradient(1300px 620px at 82% -22%, #202a12 0%, transparent 58%),
      radial-gradient(900px 500px at 8% 118%, #1a1320 0%, transparent 55%),
      var(--bg);
    color:var(--ink); font-family:'IBM Plex Mono', monospace;
  }
  .card::before { content:""; position:absolute; inset:0; pointer-events:none;
    background:repeating-linear-gradient(0deg, transparent 0 3px, rgba(255,255,255,.018) 3px 4px);
    mix-blend-mode:overlay; }
  .card::after { content:""; position:absolute; inset:0; pointer-events:none; opacity:.45;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.4'/%3E%3C/svg%3E");
    mix-blend-mode:soft-light; }
  .code { position:absolute; inset:0; padding:54px 60px; z-index:0;
    font-size:26px; line-height:1.55; white-space:pre-wrap; word-break:break-word;
    color:var(--acid); opacity:.10; pointer-events:none; user-select:none;
    -webkit-mask-image:linear-gradient(165deg, #000 0%, #000 34%, transparent 70%);
            mask-image:linear-gradient(165deg, #000 0%, #000 34%, transparent 70%); }
  .scope { position:absolute; left:0; right:0; top:150px; height:220px; z-index:1; pointer-events:none; opacity:.32; }
  .scope svg { width:100%; height:100%; display:block; }
  .scope path { fill:none; stroke:var(--acid); stroke-width:3; stroke-linejoin:round; stroke-linecap:round;
    filter:drop-shadow(0 0 8px rgba(200,245,60,.6)); }
  .scope .base { stroke:var(--line); stroke-width:2; opacity:.7; filter:none; }
  .frame { position:absolute; inset:0; z-index:2; padding:56px 60px 0; display:flex; flex-direction:column; height:100%; }
  .top { display:flex; justify-content:space-between; align-items:flex-start; gap:24px; }
  .wordmark { font-family:'Bricolage Grotesque', sans-serif; font-weight:800; font-size:27px; letter-spacing:-.02em; line-height:1; }
  .wordmark b { color:var(--acid); }
  .cat { text-align:right; font-size:18px; line-height:1.5; letter-spacing:.14em; color:var(--dim); text-transform:uppercase; }
  .cat .k { color:var(--acid); }
  .hero { margin-top:auto; }
  .kicker { display:flex; align-items:center; gap:12px; margin-bottom:16px; font-size:19px; letter-spacing:.2em; text-transform:uppercase; color:var(--dim); }
  .kicker .dot { width:9px; height:9px; border-radius:50%; background:var(--acid); box-shadow:0 0 14px var(--acid); }
  .title { font-family:'Bricolage Grotesque', sans-serif; font-weight:800;
    font-size:104px; line-height:.92; letter-spacing:-.035em; max-width:980px; text-wrap:balance;
    overflow:hidden; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; }
  .by { margin-top:18px; font-size:25px; color:var(--ink); }
  .by span { color:var(--hot); }
  .seq { margin-top:30px; display:flex; flex-direction:column; gap:9px; }
  .seqrow { display:flex; align-items:center; gap:14px; }
  .seqlbl { width:42px; font-size:15px; letter-spacing:.12em; color:var(--dim); }
  .steps { display:grid; grid-template-columns:repeat(16, 1fr); gap:7px; flex:1; }
  .step { height:18px; border-radius:3px; background:#171a11; border:1px solid var(--line); }
  .step.beat { border-color:#3a4029; }
  .step.on { background:var(--acid); border-color:var(--acid); box-shadow:0 0 12px rgba(200,245,60,.55); }
  .step.on.hot { background:var(--hot); border-color:var(--hot); box-shadow:0 0 12px rgba(255,92,168,.5); }
  .foot { margin-top:30px; margin-bottom:36px; display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
  .chip { font-size:23px; padding:9px 20px; border:2px solid var(--line); border-radius:999px; color:var(--ink); background:rgba(19,21,14,.65); }
  .chip.lead { border-color:var(--acid); color:var(--acid); }
  .bar { position:absolute; left:0; right:0; bottom:0; height:12px; z-index:3;
    background:linear-gradient(90deg, var(--acid) 0%, var(--acid) 62%, var(--hot) 100%); }
</style></head><body><div class="card">${body}<div class="bar"></div></div></body></html>`;

// FNV-1a seed → mulberry32 PRNG. Deterministic for a given seed string.
function rng(seed) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
}

const seedOf = (item) => `${item.title ?? ''}|${item.code ?? ''}|${item.meta?.genre ?? ''}|${item.meta?.bpm ?? ''}`;

// 16 deterministic step hits at the given density; downbeats (every 4th) biased on.
export function seqRow(seed, density) {
  const r = rng(seed);
  return Array.from({ length: 16 }, (_, i) => (i % 4 === 0 ? r() < density + 0.25 : r() < density));
}

// Oscilloscope path ('d') in a 1200×220 viewBox: four seeded sines summed under a
// sine envelope so the line tapers at both ends. Deterministic per seed.
export function scopePath(seed) {
  const r = rng(seed);
  const W = 1200, mid = 110, N = 120, pad = 60, step = (W - pad * 2) / N;
  const waves = Array.from({ length: 4 }, () => ({ f: 0.4 + r() * 3.2, p: r() * 6.28, a: r() }));
  const amp = waves.reduce((s, w) => s + w.a, 0) || 1;
  let d = `M ${pad} ${mid}`;
  for (let i = 1; i <= N; i++) {
    const x = pad + i * step, t = (i / N) * 6.28;
    let y = 0; for (const w of waves) y += w.a * Math.sin(t * w.f * 2 + w.p);
    const env = Math.sin((i / N) * Math.PI);
    d += ` L ${x.toFixed(1)} ${(mid - (y / amp) * 88 * env).toFixed(1)}`;
  }
  return d;
}

function stepsHtml(row, hot) {
  return row
    .map((on, i) => `<div class="step${i % 4 === 0 ? ' beat' : ''}${on ? (hot ? ' on hot' : ' on') : ''}"></div>`)
    .join('');
}

function scopeSvg(seed) {
  return `<div class="scope"><svg viewBox="0 0 1200 220" preserveAspectRatio="none">
      <line class="base" x1="60" y1="110" x2="1140" y2="110" />
      <path d="${scopePath(seed)}" /></svg></div>`;
}

function seqHtml(seed) {
  return `<div class="seq">
        <div class="seqrow"><div class="seqlbl">KCK</div><div class="steps">${stepsHtml(seqRow(seed + ':kick', 0.32), false)}</div></div>
        <div class="seqrow"><div class="seqlbl">HAT</div><div class="steps">${stepsHtml(seqRow(seed + ':hat', 0.5), true)}</div></div>
      </div>`;
}

// Cap the backdrop so it stays legible + the screenshot stays fast/small.
export function codeArt(code) {
  return escapeHtml(String(code ?? '').slice(0, 1100));
}

export function chipsHtml(meta = {}) {
  const items = [meta.genre, meta.bpm && `${meta.bpm} bpm`, meta.key, meta.mood].filter(Boolean);
  return items
    .map((v, i) => `<span class="chip${i === 0 ? ' lead' : ''}">${escapeHtml(v)}</span>`)
    .join('');
}

export function songCardHtml(item) {
  const seed = seedOf(item);
  const meta = item.meta ?? {};
  const artist = item.artistName
    ? `<div class="by">by <span>${escapeHtml(item.artistName)}</span></div>` : '';
  const kicker = meta.genre ? escapeHtml(meta.genre) : 'from the crate';
  return SHELL(`
    <div class="code">${codeArt(item.code)}</div>
    ${scopeSvg(seed)}
    <div class="frame">
      <div class="top">
        <div class="wordmark">STRUDEL<b>/</b>CRATE</div>
        <div class="cat">CRATE · ${escapeHtml(String(meta.bpm ?? '—'))} BPM<br /><span class="k">${escapeHtml(meta.key ?? '∞')}</span></div>
      </div>
      <div class="hero">
        <div class="kicker"><span class="dot"></span> ${kicker}</div>
        <div class="title">${escapeHtml(item.title || 'untitled')}</div>
        ${artist}
        ${seqHtml(seed)}
        <div class="foot">${chipsHtml(meta)}</div>
      </div>
    </div>`);
}

export function brandCardHtml() {
  const seed = 'STRUDEL/CRATE/deck';
  return SHELL(`
    ${scopeSvg(seed)}
    <div class="frame">
      <div class="top">
        <div class="wordmark">STRUDEL<b>/</b>CRATE</div>
        <div class="cat">A CRATE OF<br /><span class="k">CODE-MUSIC</span></div>
      </div>
      <div class="hero">
        <div class="kicker"><span class="dot"></span> live-coded with strudel</div>
        <div class="title">AI music<br />you remix<br />in code</div>
        ${seqHtml(seed)}
        <div class="foot"><span class="chip lead">play</span><span class="chip">remix</span><span class="chip">export</span></div>
      </div>
    </div>`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/og-card.test.mjs`
Expected: PASS.

- [ ] **Step 5: (Recommended) Eyeball the rendered card**

Once Task 4's renderer exists you can render a sample card to a PNG and open it. Until then, a fast check is to write `songCardHtml(sample)` to a `.html` file and open it in a browser — it must show the wordmark, a big title, the oscilloscope, the KCK/HAT sequencer rows, acid chips, and the acid→pink baseline bar. (A verified reference render was produced during design.)

- [ ] **Step 6: Commit**

```bash
git add server/og-card.mjs test/og-card.test.mjs
git commit -m "feat(crate): Acid Deck OG card templates (waveform + sequencer)"
```

---

### Task 3: Card PNG disk cache (`server/card-cache.mjs`)

Flat atime-LRU disk cache for rendered card PNGs, mirroring `server/audio-cache.mjs`. Card files are named `<entityId>-<contentHash>.jpg`, so a content change yields a new file and the stale one ages out under the byte cap.

**Files:**
- Create: `server/card-cache.mjs`
- Test: `test/card-cache.test.mjs`

**Interfaces:**
- Produces: `createCardCache({ dir, maxBytes? }): { cachedPath(name), store(name, buffer), prune() }`. `name` is the filename stem (no extension); files land at `<dir>/<name>.jpg`.

- [ ] **Step 1: Write the failing test**

Create `test/card-cache.test.mjs` (mirrors `test/audio-cache.test.mjs`):

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCardCache } from '../server/card-cache.mjs';

let dir, cache;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'card-cache-'));
  cache = createCardCache({ dir, maxBytes: 1000 });
});

describe('createCardCache', () => {
  it('returns null for a miss', async () => {
    expect(await cache.cachedPath('nope')).toBeNull();
  });
  it('stores and reads back a buffer', async () => {
    const buf = Buffer.from('PNGDATA');
    const p = await cache.store('e1-abc', buf);
    expect(p).toBe(join(dir, 'e1-abc.jpg'));
    const hit = await cache.cachedPath('e1-abc');
    expect(hit).toBe(p);
    expect((await readFile(p)).equals(buf)).toBe(true);
  });
  it('prunes the least-recently-used file past the byte cap', async () => {
    await cache.store('old', Buffer.alloc(600));
    // Make "old" clearly older than "new" by back-dating its atime/mtime.
    const { utimes } = await import('node:fs/promises');
    await utimes(join(dir, 'old.jpg'), new Date(Date.now() - 60000), new Date(Date.now() - 60000));
    await cache.store('new', Buffer.alloc(600)); // total 1200 > 1000 → evict oldest
    expect(await cache.cachedPath('old')).toBeNull();
    expect(await cache.cachedPath('new')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/card-cache.test.mjs`
Expected: FAIL — `Cannot find module '../server/card-cache.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `server/card-cache.mjs`:

```js
// server/card-cache.mjs
// Flat disk cache for rendered OG card PNGs at <dir>/<name>.jpg, governed by a
// single LRU byte cap keyed on access time (atime) — mirrors audio-cache.mjs.
// Card files are named "<entityId>-<contentHash>.jpg" so a content change yields
// a new file and the stale one ages out under the cap.
import { mkdir, readdir, stat, writeFile, unlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';

export function createCardCache({ dir, maxBytes = 268435456 }) { // 256 MB
  const fileFor = (name) => join(dir, `${name}.jpg`);

  async function cachedPath(name) {
    const p = fileFor(name);
    try { await stat(p); } catch { return null; }
    const now = new Date();
    try { await utimes(p, now, now); } catch { /* mounts may be noatime; best effort */ }
    return p;
  }

  async function store(name, buffer) {
    await mkdir(dir, { recursive: true });
    const p = fileFor(name);
    await writeFile(p, buffer);
    await prune();
    return p;
  }

  async function prune() {
    let names = [];
    try { names = await readdir(dir); } catch { return 0; }
    const files = [];
    for (const f of names) {
      const p = join(dir, f);
      try { const s = await stat(p); if (s.isFile()) files.push({ p, size: s.size, atime: s.atimeMs }); }
      catch { /* vanished mid-scan */ }
    }
    let total = files.reduce((n, f) => n + f.size, 0);
    if (total <= maxBytes) return 0;
    files.sort((a, b) => a.atime - b.atime); // oldest access first
    let freed = 0;
    for (const f of files) {
      if (total <= maxBytes) break;
      try { await unlink(f.p); total -= f.size; freed += f.size; } catch { /* already gone */ }
    }
    return freed;
  }

  return { cachedPath, store, prune };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/card-cache.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/card-cache.mjs test/card-cache.test.mjs
git commit -m "feat(crate): atime-LRU disk cache for OG card PNGs"
```

---

### Task 4: Headless-Chrome card renderer (`server/render-card.mjs`)

Renders a card HTML doc to a PNG buffer via `puppeteer-core`, mirroring `server/render-audio.mjs` (lazy launch, serial lock, idle-close). Uses `page.setContent` (the template is self-contained) and waits for `document.fonts.ready` before the screenshot. Real-Chrome rendering is gated behind an env flag so `npm test` never launches a browser.

**Files:**
- Create: `server/render-card.mjs`
- Test: `test/render-card.test.mjs`

**Interfaces:**
- Consumes: `songCardHtml` from `server/og-card.mjs` (in the gated integration test only).
- Produces:
  - `CARD_W = 1200`, `CARD_H = 630`
  - `createCardRenderer({ chromePath?, idleMs?, launch? }): { render(html): Promise<Buffer>, close(): Promise<void>, CARD_W, CARD_H }`

- [ ] **Step 1: Write the failing test**

Create `test/render-card.test.mjs` (mirrors `test/render-audio.test.mjs`'s gating):

```js
import { describe, it, expect } from 'vitest';
import { CARD_W, CARD_H } from '../server/render-card.mjs';

describe('render-card constants', () => {
  it('are the standard OG card size', () => {
    expect(CARD_W).toBe(1200);
    expect(CARD_H).toBe(630);
  });
});

// Real render: needs system Chrome + CDN font access. Gated so `npm test` never
// launches Chrome. Run manually:
//   CRATE_RENDER_IT=1 npx vitest run test/render-card.test.mjs
const IT = process.env.CRATE_RENDER_IT === '1';
describe.runIf(IT)('render-card integration', () => {
  it('renders a song card to a non-empty JPEG', async () => {
    const { createCardRenderer } = await import('../server/render-card.mjs');
    const { songCardHtml } = await import('../server/og-card.mjs');
    const renderer = createCardRenderer({});
    try {
      const buf = await renderer.render(songCardHtml({
        title: 'It Renders', artistName: 'tester',
        code: 's("bd*4")', meta: { genre: 'techno', bpm: 130, key: 'Amin' },
      }));
      expect(buf.length).toBeGreaterThan(2000);
      // JPEG magic number (SOI marker).
      expect(Buffer.from(buf.subarray(0, 3)).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
    } finally {
      await renderer.close();
    }
  }, 120000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/render-card.test.mjs`
Expected: FAIL — `Cannot find module '../server/render-card.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `server/render-card.mjs`:

```js
// server/render-card.mjs
// Renders an OG card PNG by loading a self-contained HTML doc (server/og-card.mjs)
// in headless Chrome at 1200×630 and screenshotting it. Mirrors render-audio.mjs:
// lazy launch, serial render lock, idle-close. setContent (not a served URL)
// keeps the card template self-contained; we await document.fonts.ready so the
// display font is painted before the screenshot.
import puppeteer from 'puppeteer-core';

export const CARD_W = 1200;
export const CARD_H = 630;

export function createCardRenderer({
  chromePath = process.env.CRATE_CHROME ?? '/opt/google/chrome/chrome',
  idleMs = 60000,
  launch = (opts) => puppeteer.launch(opts),
}) {
  let browser = null;
  let chain = Promise.resolve(); // serial lock: renders run one at a time
  let idleTimer = null;

  function armIdleClose() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { close().catch(() => {}); }, idleMs);
    idleTimer.unref?.();
  }

  async function ensureBrowser() {
    if (browser) return browser;
    browser = await launch({
      executablePath: chromePath,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    browser.on('disconnected', () => { browser = null; });
    return browser;
  }

  async function renderOnce(html) {
    const b = await ensureBrowser();
    const page = await b.newPage();
    try {
      await page.setViewport({ width: CARD_W, height: CARD_H, deviceScaleFactor: 1 });
      await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
      await page.evaluate(() => document.fonts.ready);
      return await page.screenshot({
        type: 'jpeg',
        quality: 90,
        clip: { x: 0, y: 0, width: CARD_W, height: CARD_H },
      });
    } finally {
      await page.close().catch(() => {});
      armIdleClose();
    }
  }

  function render(html) {
    // Append to the serial chain; callers get their own result, errors isolated.
    const run = chain.then(() => renderOnce(html));
    chain = run.catch(() => {}); // keep the lock alive past a failed render
    return run;
  }

  async function close() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    const b = browser;
    browser = null;
    if (b) await b.close().catch(() => {});
  }

  return { render, close, CARD_W, CARD_H };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/render-card.test.mjs`
Expected: PASS (the gated integration block is skipped without `CRATE_RENDER_IT=1`).

- [ ] **Step 5: (Optional but recommended) Run the gated integration render once**

Run: `CRATE_RENDER_IT=1 npx vitest run test/render-card.test.mjs`
Expected: PASS — a real JPEG is produced. (Requires system Chrome at `/opt/google/chrome/chrome` and internet for fonts.)

- [ ] **Step 6: Commit**

```bash
git add server/render-card.mjs test/render-card.test.mjs
git commit -m "feat(crate): headless-Chrome OG card renderer"
```

---

### Task 5: Wire routes + meta injection into the app (`server/instant.mjs`, `server/app.mjs`)

Add a server-side item resolver, the `/api/:ns/:id/card.jpg` + `/og/home.jpg` image routes, and OG meta injection for `/` and `/song/:slug`. Full Supertest coverage with a fake admin + fake renderer + temp dist dir.

**Files:**
- Modify: `server/instant.mjs` (add `resolvePublicItem`)
- Modify: `server/app.mjs` (add `cardRoutes`, modify the `opts.distDir` block, accept `cardRenderer`/`cardCache`/`publicOrigin`)
- Test: `test/og-routes.test.mjs`

**Interfaces:**
- Consumes: `resolvePublicItem`, `songMetaTags`, `brandMetaTags`, `injectMeta`, `cardHash` (Task 1), `songCardHtml`, `brandCardHtml` (Task 2).
- Produces:
  - `resolvePublicItem(adminDb, namespaces, param): Promise<{ ns, item } | null>` where `item = { entityId, slug, title, description, code, meta, artistName }`.
  - `createApp(opts)` newly accepts `opts.cardRenderer`, `opts.cardCache`, `opts.publicOrigin`.
  - Routes: `GET /` (brand meta), `GET /song/:slug` (per-song meta), `GET /api/:ns/:id/card.jpg`, `GET /og/home.jpg`.

- [ ] **Step 1: Write the failing test**

Create `test/og-routes.test.mjs`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeAdmin } from './fake-admin.mjs';
import { createApp } from '../server/app.mjs';
import { createCardCache } from '../server/card-cache.mjs';

const INDEX = '<!doctype html><html><head><title>STRUDEL/CRATE</title><!--OG--></head><body>home</body></html>';
const SONG = '<!doctype html><html><head><title>STRUDEL/SONG</title><!--OG--></head><body>song</body></html>';

let app, adminDb, dist, renderCalls;
beforeEach(async () => {
  dist = await mkdtemp(join(tmpdir(), 'crate-dist-'));
  await writeFile(join(dist, 'index.html'), INDEX);
  await writeFile(join(dist, 'song.html'), SONG);

  adminDb = fakeAdmin({
    tracks: [{
      id: 'e-1', slug: 'demo-01', title: 'Neon Rinse',
      description: 'Rolling sub bass.', code: 's("bd*4")',
      meta: { genre: 'dark techno', bpm: 140, key: 'F#min', mood: 'moody', energy: 4, instruments: ['acid'] },
      author: [{ id: 'p1', artistName: 'Dennnis' }],
    }],
    stems: [],
  });

  renderCalls = 0;
  const cardRenderer = { render: async () => { renderCalls += 1; return Buffer.from('PNGDATA'); }, close: async () => {} };
  const cardCache = createCardCache({ dir: join(dist, 'card-cache'), maxBytes: 10_000_000 });

  app = createApp({
    adminDb, namespaces: ['tracks', 'stems'],
    distDir: dist, cardRenderer, cardCache,
    publicOrigin: 'https://crate.vimsical.com',
  });
});

describe('home meta injection', () => {
  it('GET / injects brand OG tags', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('og:site_name" content="STRUDEL/CRATE"');
    expect(res.text).toContain('https://crate.vimsical.com/og/home.jpg');
    expect(res.text).toContain('twitter:card" content="summary_large_image"');
  });
});

describe('song meta injection', () => {
  it('GET /song/<entityId> injects per-song tags + card url', async () => {
    const res = await request(app).get('/song/e-1');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Neon Rinse — STRUDEL/CRATE');
    expect(res.text).toContain('og:type" content="music.song"');
    expect(res.text).toContain('/api/tracks/e-1/card.jpg?v=');
  });
  it('GET /song/<slug> still resolves (legacy links)', async () => {
    const res = await request(app).get('/song/demo-01');
    expect(res.text).toContain('Neon Rinse');
  });
  it('GET /song/<unknown> falls back to brand tags', async () => {
    const res = await request(app).get('/song/missing');
    expect(res.status).toBe(200);
    expect(res.text).toContain('og:site_name" content="STRUDEL/CRATE"');
  });
  it('escapes a hostile song title in the meta block', async () => {
    adminDb._store.tracks[0].title = '"><script>alert(1)</script>';
    const res = await request(app).get('/song/e-1');
    expect(res.text).not.toContain('<script>alert(1)</script>');
  });
});

describe('card image route', () => {
  it('GET /api/tracks/:id/card.jpg returns a JPEG and caches it', async () => {
    const r1 = await request(app).get('/api/tracks/e-1/card.jpg');
    expect(r1.status).toBe(200);
    expect(r1.headers['content-type']).toContain('image/jpeg');
    expect(r1.body.equals(Buffer.from('PNGDATA'))).toBe(true);
    const r2 = await request(app).get('/api/tracks/e-1/card.jpg');
    expect(r2.status).toBe(200);
    expect(renderCalls).toBe(1); // second request served from cache
  });
  it('404s an unknown id', async () => {
    const res = await request(app).get('/api/tracks/nope/card.jpg');
    expect(res.status).toBe(404);
  });
  it('404s an unknown namespace', async () => {
    const res = await request(app).get('/api/bogus/e-1/card.jpg');
    expect(res.status).toBe(404);
  });
  it('GET /og/home.jpg returns the brand JPEG', async () => {
    const res = await request(app).get('/og/home.jpg');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/og-routes.test.mjs`
Expected: FAIL — `resolvePublicItem` is not exported / routes not present (404s, missing tags).

- [ ] **Step 3: Add `resolvePublicItem` to `server/instant.mjs`**

Append to `server/instant.mjs`:

```js
// Resolve a /song or /card URL param ({entity id} preferred, {slug} legacy) to
// { ns, item } across the given namespaces, in the render shape the OG helpers
// and card templates expect. Mirrors src/song.js's resolveItem (id-first, then
// slug; the first namespace wins a rare slug collision). Returns null on miss.
export async function resolvePublicItem(adminDb, namespaces, param) {
  const map = (row, ns) => {
    const author = Array.isArray(row.author) ? row.author[0] : row.author;
    return {
      ns,
      item: {
        entityId: row.id,
        slug: row.slug,
        title: row.title,
        description: row.description,
        code: row.code,
        meta: row.meta,
        artistName: author?.artistName ?? null,
      },
    };
  };
  for (const ns of namespaces) {
    const res = await adminDb.query({ [ns]: { author: {}, $: { where: { id: param } } } });
    if (res[ns][0]) return map(res[ns][0], ns);
  }
  for (const ns of namespaces) {
    const res = await adminDb.query({ [ns]: { author: {}, $: { where: { slug: param } } } });
    if (res[ns][0]) return map(res[ns][0], ns);
  }
  return null;
}
```

- [ ] **Step 4: Wire the routes into `server/app.mjs`**

At the top of `server/app.mjs`, add imports beneath the existing imports:

```js
import { readFile } from 'node:fs/promises';
import { resolvePublicItem } from './instant.mjs';
import { songMetaTags, brandMetaTags, injectMeta, cardHash } from './og.mjs';
import { songCardHtml, brandCardHtml } from './og-card.mjs';
```

(Keep the existing `import { setRating, setNotes, ... } from './instant.mjs';` line — add `resolvePublicItem` to it instead of a second import if you prefer; either works.)

Add this helper near the top-level helpers (after `clientIp`):

```js
// Absolute origin for crawler URLs: the configured public origin, else derived
// from the (proxy-aware) request. Behind nginx, app.set('trust proxy', true)
// makes req.protocol reflect X-Forwarded-Proto.
const originFor = (req, configured) => configured || `${req.protocol}://${req.get('host')}`;
```

Add a `cardRoutes` function (next to `audioRoutes`):

```js
// Social-preview card PNGs. /og/home.jpg is the static brand card; the per-song
// route resolves the item, renders the code-as-art card on a cache miss, and
// serves the cached PNG. Reads stay public (they mirror the public song pages).
function cardRoutes(app, { adminDb, namespaces, cardRenderer, cardCache }) {
  app.get('/og/home.jpg', wrap(async (_req, res) => {
    let p = await cardCache.cachedPath('brand');
    if (!p) p = await cardCache.store('brand', await cardRenderer.render(brandCardHtml()));
    res.type('jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(p);
  }));

  app.get('/api/:ns/:id/card.jpg', wrap(async (req, res) => {
    const { ns, id } = req.params;
    if (!namespaces.includes(ns)) return res.status(404).json({ error: 'not found' });
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'invalid id' });
    const found = await resolvePublicItem(adminDb, [ns], id);
    if (!found) return res.status(404).json({ error: 'not found' });
    const name = `${found.item.entityId}-${cardHash(found.item)}`;
    let p = await cardCache.cachedPath(name);
    if (!p) p = await cardCache.store(name, await cardRenderer.render(songCardHtml(found.item)));
    res.type('jpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(p);
  }));
}
```

Register `cardRoutes` — add this beside the existing `if (opts.audioExport) audioRoutes(...)` line inside `createApp`:

```js
  if (opts.cardRenderer && opts.cardCache && adminDb) {
    cardRoutes(app, { adminDb, namespaces, cardRenderer: opts.cardRenderer, cardCache: opts.cardCache });
  }
```

Finally, replace the existing `if (opts.distDir) { ... }` block with this OG-injecting version:

```js
  // Production: serve the built SPA (dev uses Vite). Defined AFTER the API so
  // /api/* always wins. `/` and /song/:slug get server-injected Open Graph +
  // Twitter meta so links unfurl as rich preview cards (crawlers don't run JS).
  if (opts.distDir) {
    app.set('trust proxy', true);
    const configuredOrigin = opts.publicOrigin;
    const sendInjected = async (res, file, tagsHtml) => {
      const html = await readFile(join(opts.distDir, file), 'utf8');
      res.type('html').send(injectMeta(html, tagsHtml));
    };

    app.get('/', wrap(async (req, res) => {
      await sendInjected(res, 'index.html', brandMetaTags(originFor(req, configuredOrigin)));
    }));

    app.get(['/stems', '/stems/'], (_req, res) => res.sendFile(join(opts.distDir, 'stems.html')));

    app.get('/song/:slug', wrap(async (req, res) => {
      const origin = originFor(req, configuredOrigin);
      let tags = brandMetaTags(origin);
      if (adminDb) {
        const found = await resolvePublicItem(adminDb, namespaces, req.params.slug);
        if (found) tags = songMetaTags(found.item, found.ns, origin);
      }
      await sendInjected(res, 'song.html', tags);
    }));

    app.use(express.static(opts.distDir));
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- test/og-routes.test.mjs`
Expected: PASS (all home/song/card assertions green).

- [ ] **Step 6: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: PASS — existing `api.test.mjs` etc. still pass (those call `createApp` without `distDir`/card opts, so the new routes simply aren't mounted).

- [ ] **Step 7: Commit**

```bash
git add server/instant.mjs server/app.mjs test/og-routes.test.mjs
git commit -m "feat(crate): inject OG/Twitter meta + serve card PNGs from the app"
```

---

### Task 6: HTML markers + production bootstrap + verification (`index.html`, `song.html`, `server/index.mjs`)

Add the `<!--OG-->` injection marker to the two served pages and construct the card renderer + cache in the production server entrypoint. Then build, run, and verify a real unfurl payload.

**Files:**
- Modify: `index.html` (add marker in `<head>`)
- Modify: `song.html` (add marker in `<head>`)
- Modify: `server/index.mjs` (build `cardRenderer` + `cardCache`, pass `publicOrigin`)

**Interfaces:**
- Consumes: `createCardRenderer` (Task 4), `createCardCache` (Task 3), the new `createApp` opts (Task 5).

- [ ] **Step 1: Add the marker to `index.html`**

In `index.html`, change the `<title>` line in `<head>` to be followed by the marker:

```html
  <title>STRUDEL/CRATE</title>
  <!--OG-->
```

- [ ] **Step 2: Add the marker to `song.html`**

In `song.html`, likewise:

```html
  <title>STRUDEL/SONG</title>
  <!--OG-->
```

- [ ] **Step 3: Wire the renderer + cache into `server/index.mjs`**

Add imports near the other `server/*.mjs` imports at the top of `server/index.mjs`:

```js
import { createCardRenderer } from './render-card.mjs';
import { createCardCache } from './card-cache.mjs';
```

After the `renderer`/`audioExport` setup (before `createRunner`), add:

```js
const cardCache = createCardCache({
  dir: join(repoRoot, 'data', 'card-cache'),
  maxBytes: Number(process.env.CRATE_CARD_CACHE_MAX_BYTES) || 268435456,
});
const cardRenderer = createCardRenderer({});
```

Then add the new options to the `createApp({ ... })` call:

```js
const app = createApp({
  adminDb,
  namespaces: ['tracks', 'stems'],
  jobStore, runner, progressFor, requireAuth, resolveUser, requireUser, allowedEmails,
  distDir: existsSync(distDir) ? distDir : undefined,
  sampleCacheDir: join(repoRoot, 'data', 'sample-cache'),
  audioExport,
  cardRenderer,
  cardCache,
  publicOrigin: process.env.CRATE_PUBLIC_ORIGIN || 'https://crate.vimsical.com',
});
```

- [ ] **Step 4: Build the SPA (so dist has the marker)**

Run: `npm run build`
Expected: build succeeds; `dist/index.html` and `dist/song.html` each contain `<!--OG-->` (Vite preserves HTML comments).
Verify: `grep -l OG dist/index.html dist/song.html` lists both files.

- [ ] **Step 5: Run the server and verify a real home unfurl payload**

Run (in one shell): `npm run dev` is Vite-only; instead start the API server with dist present:
```bash
PORT=3009 node server/index.mjs &
sleep 2
curl -s http://localhost:3009/ | grep -o 'og:[a-z_:]*\|twitter:[a-z_]*' | sort -u
curl -s http://localhost:3009/og/home.jpg -o /tmp/home.jpg && file /tmp/home.jpg
```
Expected: the curl prints `og:description og:image og:image:alt og:image:height og:image:secure_url og:image:type og:image:width og:site_name og:title og:type og:url twitter:card twitter:description twitter:image twitter:title`; `file` reports `/tmp/home.jpg: JPEG image data, ...` and the dimensions are 1200x630.

- [ ] **Step 6: Verify a real song unfurl payload**

Pick any real song entity id from the DB (e.g. via the running app's network tab, or `curl` the list), then:
```bash
SONG_ID=<a-real-entity-id>
curl -s "http://localhost:3009/song/$SONG_ID" | grep -o 'content="[^"]*card.jpg[^"]*"'
curl -s "http://localhost:3009/api/tracks/$SONG_ID/card.jpg" -o /tmp/song.jpg && file /tmp/song.jpg
```
Expected: the meta block references `/api/tracks/<id>/card.jpg?v=<hash>`; `file` reports `JPEG image data` at 1200x630. Open `/tmp/song.jpg` to eyeball the code-as-art card (title, artist, acid chips, faded code, acid bottom bar).

Then stop the server: `kill %1`.

- [ ] **Step 7: Commit**

```bash
git add index.html song.html server/index.mjs
git commit -m "feat(crate): mount OG card renderer/cache in production server + page markers"
```

- [ ] **Step 8: Deploy notes (do NOT run automatically — confirm with the user first)**

The live service runs from the main worktree. To deploy after merge:
```bash
# from /home/builder/apps/crate on the deployed branch, after merging this branch:
npm run build
sudo systemctl restart vimsical-crate
```
- Confirm the TLS cert + nginx already serve `crate.vimsical.com` (the app is already live there, so this should require no cert change). If a fresh subdomain were ever needed, follow the certbot steps in the global CLAUDE.md.
- First unfurl of each song lazily renders + caches its PNG (a one-time ~1–3s Chrome render). Subsequent fetches are cache hits. Validate live links with the platform debuggers: Facebook Sharing Debugger, Twitter Card Validator, and Telegram's `@WebpageBot` (post the link to refresh its cache).

---

## Self-Review

**1. Spec coverage:**
- "Preview cards for iOS Messages / WhatsApp / Telegram" → all consume Open Graph (`og:title`/`og:description`/`og:image` + `og:image:width`/`height`), emitted by `metaTagsHtml` (Task 1) and injected server-side (Task 5). ✓
- "Posts on social" → `twitter:card=summary_large_image` + `twitter:*` tags (Task 1). ✓
- "/song page" → per-song injection on `GET /song/:slug` with a unique code-as-art card (Tasks 2/5). ✓
- "home page of crate" → `GET /` brand injection + `/og/home.jpg` brand card (Tasks 2/5). ✓
- Dynamic per-song image + code-as-art art direction (user's chosen options) → Tasks 2 + 4. ✓

**2. Placeholder scan:** No TBD/TODO; every code step contains complete, runnable code; every test step shows real assertions. ✓

**3. Type/name consistency:** `resolvePublicItem` returns `{ ns, item: { entityId, slug, title, description, code, meta, artistName } }` and that exact shape is consumed by `songMetaTags`/`cardHash`/`cardImageUrl` (Task 1) and `songCardHtml`/`codeArt`/`chipsHtml` (Task 2). `cardHash` is the single source of the cache-bust hash, used identically in `cardImageUrl` (the URL) and the `/api/:ns/:id/card.jpg` route's cache key (Task 5). `createCardCache` exposes `cachedPath(name)`/`store(name, buffer)` used consistently by `cardRoutes`. `createCardRenderer().render(html)` takes the HTML string produced by `og-card.mjs` and returns a `Buffer`, matching the fake renderer in the Task 5 test. ✓
