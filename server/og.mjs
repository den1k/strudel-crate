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
  if (html.includes(MARKER)) return html.replace(MARKER, () => tagsHtml);
  return html.replace('</head>', () => `    ${tagsHtml}\n  </head>`);
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
