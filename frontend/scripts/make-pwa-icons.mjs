// Renders PWA icon PNGs from public/favicon.svg using headless chromium.
// The bolt sits at ~55% of the tile on the dark brand background, which keeps
// it inside the maskable safe zone (inner 80% circle) so one set of icons can
// serve both "any" and "maskable" purposes.
//
// Usage: node scripts/make-pwa-icons.mjs   (from frontend/)
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'public/favicon.svg'), 'utf8');

const TILE_BG = '#0f1220'; // matches --bg / theme-color
const SIZES = [
  { file: 'icon-512.png', px: 512 },
  { file: 'icon-192.png', px: 192 },
  { file: 'apple-touch-icon.png', px: 180 },
];

const html = `<!doctype html><html><head><style>
  * { margin: 0; padding: 0; }
  body { background: ${TILE_BG}; display: grid; place-items: center; width: 100vw; height: 100vh; }
  svg { width: 55vmin; height: auto; }
</style></head><body>${svg}</body></html>`;

const browser = await chromium.launch();
for (const { file, px } of SIZES) {
  const page = await browser.newPage({ viewport: { width: px, height: px } });
  await page.setContent(html);
  const buf = await page.screenshot({ type: 'png' });
  writeFileSync(join(root, 'public', file), buf);
  console.log(`${file} (${px}x${px}, ${buf.length} bytes)`);
  await page.close();
}
await browser.close();
