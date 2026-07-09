// App Store screenshot capture: logs into petshots.app as the demo account
// at exactly the 6.9" iPhone size (440x956 css @3x = 1320x2868 px) with the
// native CSS flag set, and captures the five listing screenshots.
//   node appstore-shots.mjs <email> <password>
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = 'https://petshots.app';
const OUT = process.env.OUT ?? '/tmp/petshots-appstore';
const [email, password] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 440, height: 956 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});
await context.addInitScript(() => {
  const set = () => {
    if (document.documentElement) document.documentElement.dataset.native = 'true';
  };
  set();
  document.addEventListener('DOMContentLoaded', set);
});
const page = await context.newPage();
const shot = async (name) => {
  await page.waitForTimeout(900); // let transitions settle
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`captured ${name}`);
};

// Log in
await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
await page.fill('input[type="email"]', email);
await page.fill('input[type="password"]', password);
await page.click('button[type="submit"]');
await page.waitForURL('**/dashboard', { timeout: 20000 });
await page.waitForSelector('.pet-pin', { timeout: 20000 });
await page.waitForTimeout(2500); // avatars load
await shot('01-pets-overview');

// Pet detail — Records (Luna has the full badge variety)
await page.click('.pet-pin:has-text("Luna")');
await page.waitForSelector('.tab-bar__tab', { timeout: 10000 });
await page.waitForTimeout(1500); // docs + thumbnails
await shot('02-records');

// Present at the door (the founder moment)
await page.click('.present-trigger');
await page.waitForTimeout(2000); // doc image loads
await shot('03-present');

// Daily tab (bottom bar) — fresh load to escape the Present overlay
await page.goto(BASE + '/dashboard', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.tabbar__item', { timeout: 15000 });
await page.click('.tabbar__item:has-text("Daily")');
await page.waitForTimeout(1500);
await shot('04-daily');

// Passport with QR — generate for Bella, capture, then revoke
await page.click('.tabbar__item:has-text("Pets")');
await page.waitForSelector('.pet-pin', { timeout: 10000 });
await page.click('.pet-pin:has-text("Bella")');
await page.waitForSelector('.tab-bar__tab', { timeout: 10000 });
await page.click('.tab-bar__tab:has-text("Passport")');
await page.waitForTimeout(800);
const gen = page.locator('button:has-text("Generate passport")');
if (await gen.count()) {
  await gen.click();
  console.log('generated passport');
}
await page.waitForSelector('canvas, img[alt*="QR"], .share-tab__qr', { timeout: 15000 });
await page.waitForTimeout(1200);
await shot('05-passport');
const revoke = page.locator('button:has-text("Revoke link")');
if (await revoke.count()) {
  await revoke.click();
  await page.waitForTimeout(1500);
  console.log('passport revoked');
}

await browser.close();
console.log('done');
