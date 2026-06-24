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
