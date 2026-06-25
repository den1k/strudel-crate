import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');

// PNG width/height live in the IHDR chunk at byte offsets 16/20.
function pngSize(p) {
  const b = readFileSync(join(root, p));
  expect(b.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a'); // PNG signature
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

describe('PWA manifest', () => {
  const m = JSON.parse(read('public/manifest.webmanifest'));
  it('has the required install fields', () => {
    expect(m.name).toBe('STRUDEL/CRATE');
    expect(m.short_name).toBe('Crate');
    expect(m.start_url).toBe('/');
    expect(m.scope).toBe('/');
    expect(m.display).toBe('standalone');
    expect(m.background_color).toBe('#0c0d0a');
    expect(m.theme_color).toBe('#0c0d0a');
  });
  it('declares 192, 512, and a maskable icon', () => {
    const bySize = Object.fromEntries(m.icons.map((i) => [`${i.sizes}:${i.purpose ?? 'any'}`, i.src]));
    expect(bySize['192x192:any']).toBe('/icons/icon-192.png');
    expect(bySize['512x512:any']).toBe('/icons/icon-512.png');
    expect(bySize['512x512:maskable']).toBe('/icons/maskable-512.png');
  });
});

describe('PWA icons exist at the right sizes', () => {
  it.each([
    ['public/icons/apple-touch-icon.png', 180],
    ['public/icons/icon-192.png', 192],
    ['public/icons/icon-512.png', 512],
    ['public/icons/maskable-512.png', 512],
    ['public/icons/favicon-32.png', 32],
  ])('%s is %ipx square', (p, size) => {
    expect(pngSize(p)).toEqual({ w: size, h: size });
  });
});

describe('PWA head tags on every page', () => {
  it.each(['index.html', 'stems.html', 'song.html'])('%s has manifest, apple meta, icons, viewport-fit', (file) => {
    const html = read(file);
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(html).toContain('<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />');
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="apple-mobile-web-app-title" content="Crate"');
    expect(html).toContain('name="apple-mobile-web-app-status-bar-style" content="black"');
    expect(html).toContain('name="theme-color" content="#0c0d0a"');
  });
});
