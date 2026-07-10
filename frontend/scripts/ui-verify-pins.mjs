// Screenshot the new pet-pins overview, detail nav consistency, and photo lightbox.
// Usage: BASE_URL=... node scripts/ui-verify-pins.mjs <email> <password>
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://localhost:5173';
const OUT = '/tmp/petshots-ui2';
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
// The app opens on the Daily tab on phones — hop to Pets for the overview.
await page.click('.tabbar__item:has-text("Pets")');
await page.waitForSelector('.pet-pin', { timeout: 15000 });
await page.waitForTimeout(1500); // let status lines + avatars load
await shot('overview-pins');

// Open Ollie (has photo + both doc states)
await page.click('.pet-pin:has-text("Ollie")');
await page.waitForSelector('.pet-detail__hero', { timeout: 10000 });
// Daily is the landing segment now — hop to Records for this shot.
await page.click('.tab-bar__tab:has-text("Records")');
await page.waitForTimeout(600);
await shot('detail-records');

// Lightbox
await page.click('.pet-detail__hero-photo');
await page.waitForSelector('.lightbox', { timeout: 5000 });
await shot('lightbox');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// Profile opens from the hero row now (it left the segmented control)
await page.click('.pet-detail__hero-profile');
await shot('detail-profile');

// Passport lives on the bottom tab bar now (per-pet sections)
await page.click('.tabbar__item:has-text("Passport")');
await page.waitForTimeout(600);
await shot('detail-share');

await browser.close();
console.log(`\nScreenshots in ${OUT}`);
