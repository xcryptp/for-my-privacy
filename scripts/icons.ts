// Draws the extension icons (public/icon/16.png, 32.png, 48.png, 128.png) from one inline SVG:
// the banner's lock mark (docs/assets/banner.svg), white on a rounded square in the brand blue.
//
//   node scripts/icons.ts   (runs a .ts file directly: Node 22.18+ or 23.6+)
//
// It renders the SVG in Playwright's bundled Chromium (already a dev dependency for the e2e
// tests) at each size and saves a transparent PNG screenshot; nothing is fetched. WXT picks up
// public/icon/<size>.png and lists them under `icons` in the built manifest.
//
// Node runs this file with its built-in type stripping, so keep it to erasable TypeScript syntax.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'public/icon');
const SIZES = [16, 32, 48, 128];

// Brand blues: the banner mark's blue on top, the UI accent (src/ui/base.css) at the bottom, so
// the white glyph keeps a strong contrast.
const TOP = '#5b8cff';
const BOTTOM = '#2456c9';

/**
 * The icon on a 128-unit grid. Small sizes drop the keyhole and thicken the shackle. The 128 px
 * icon keeps the artwork to the middle 96 px with transparent padding, as the Chrome Web Store
 * image guidelines ask.
 */
function svg(size: number): string {
  const small = size <= 32;
  const frame = size === 128 ? 'transform="translate(12 12) scale(0.8125)"' : '';
  const keyhole = small
    ? ''
    : `<circle cx="64" cy="77" r="8" fill="${BOTTOM}"/><rect x="60" y="79" width="8" height="15" rx="4" fill="${BOTTOM}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${TOP}"/>
      <stop offset="1" stop-color="${BOTTOM}"/>
    </linearGradient>
  </defs>
  <g ${frame}>
  <rect x="${small ? 0 : 4}" y="${small ? 0 : 4}" width="${small ? 128 : 120}" height="${small ? 128 : 120}" rx="28" fill="url(#bg)"/>
  <path d="M44 58 V44 a20 20 0 0 1 40 0 V58" fill="none" stroke="#ffffff" stroke-width="${small ? 15 : 12}" stroke-linecap="round"/>
  <rect x="${small ? 28 : 32}" y="54" width="${small ? 72 : 64}" height="${small ? 52 : 48}" rx="10" fill="#ffffff"/>
  ${keyhole}
  </g>
</svg>`;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  for (const size of SIZES) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:transparent">${svg(size)}</body></html>`,
    );
    const file = path.join(OUT_DIR, `${size}.png`);
    await page.locator('svg').screenshot({ path: file, omitBackground: true });
    await page.close();
    console.log(`wrote ${path.relative(ROOT, file)}`);
  }
} finally {
  await browser.close();
}
