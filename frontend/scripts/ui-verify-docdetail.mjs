// Verify: record detail has top-right Edit + no Update record; ⋯ menu is
// Edit/Delete only; Add-pet pin is visibly purple without hover.
// Usage: BASE_URL=... node scripts/ui-verify-docdetail.mjs <email> <password>
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://localhost:5173';
const OUT = '/tmp/petshots-ui3';
const [email, password] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();

async function shot(name) {
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`✓ ${name}`);
}

await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
await page.fill('input[type="email"]', email);
await page.fill('input[type="password"]', password);
await page.click('button[type="submit"]');
await page.waitForURL('**/dashboard', { timeout: 15000 });
await page.waitForSelector('.pet-pin', { timeout: 15000 });
await page.waitForTimeout(1200);
await shot('overview-add-pin');

await page.click('.pet-pin:has-text("Ollie")');
await page.waitForSelector('.doc-item', { timeout: 10000 });

// ⋯ menu should show Edit + Delete only
await page.click('.doc-item >> nth=0 >> .btn--icon');
await shot('doc-menu');
await page.keyboard.press('Escape');

// Record detail: Edit top-right, no secondary links
await page.click('.doc-main >> nth=0');
await page.waitForSelector('.doc-detail', { timeout: 10000 });
await shot('doc-detail');

// Top-right Edit opens the label/date editor
await page.click('.screen-nav__action');
await page.waitForSelector('input', { timeout: 5000 });
await shot('doc-edit');

await browser.close();
console.log(`\nScreenshots in ${OUT}`);
