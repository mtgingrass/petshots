// Retake shot 01 (native-faithful: upgrade CTA removed like the iOS build)
// and shoot 03 as the public passport page (what the front desk sees).
//   node scripts/appstore-retake.mjs <email> <password>
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = 'https://petshots.app';
const OUT = '/tmp/petshots-appstore';
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

await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
await page.fill('input[type="email"]', email);
await page.fill('input[type="password"]', password);
await page.click('button[type="submit"]');
await page.waitForURL('**/dashboard', { timeout: 20000 });
// The app opens on the Daily tab on phones — hop to Pets for the overview.
await page.click('.tabbar__item:has-text("Pets")');
await page.waitForSelector('.pet-pin', { timeout: 20000 });
await page.waitForTimeout(2500);
// Match the native build exactly: it renders no upgrade link here.
await page.evaluate(() => document.querySelector('.pet-pins__limit button')?.remove());
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/01-pets-overview.png` });
console.log('captured 01-pets-overview');

// Public passport page: generate for Bella, visit /p/{token}, then revoke.
// Passport lives on the bottom tab bar now — scope to Bella's section
await page.click('.tabbar__item:has-text("Passport")');
await page.waitForTimeout(800);
const bellaPass = page.locator('.passport-all__pet:has-text("Bella")');
const gen = bellaPass.locator('button:has-text("Generate passport")');
if (await gen.count()) {
  await gen.click();
  console.log('generated passport');
}
await page.waitForSelector('text=/petshots\\.app\\/p\\//', { timeout: 15000 });
const linkText = await page
  .locator('text=/petshots\\.app\\/p\\//')
  .first()
  .textContent();
const url = 'https://' + linkText.replace(/\s/g, '').replace(/^https?:\/\//, '');
console.log('passport url:', url);

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500); // hero + docs load
await page.screenshot({ path: `${OUT}/03-passport-public.png` });
console.log('captured 03-passport-public');

// Revoke: back to the Passport tab
await page.goto(BASE + '/dashboard', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.pet-pin', { timeout: 15000 });
await page.click('.tabbar__item:has-text("Passport")');
const revoke = page.locator('button:has-text("Revoke link")');
await revoke.waitFor({ timeout: 10000 });
await revoke.click();
await page.waitForTimeout(1500);
console.log('passport revoked');

await browser.close();
console.log('done');
