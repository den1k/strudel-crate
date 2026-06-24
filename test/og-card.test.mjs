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
