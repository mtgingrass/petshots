// Visual verification: screenshots of key pages in both themes at iPhone viewport.
// Serves against `vite preview` (built bundle, real API/Cognito config).
// Usage: node scripts/ui-verify.mjs <email> <password>
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://localhost:4173';
const OUT = '/tmp/petshots-ui';
const [email, password] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();

async function shot(name) {
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  console.log(`✓ ${name}`);
}

async function setTheme(theme) {
  await page.evaluate((t) => {
    localStorage.setItem('petshots.theme', t);
  }, theme);
  await page.reload({ waitUntil: 'domcontentloaded' });
}

for (const theme of ['dark', 'light']) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await setTheme(theme);

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await shot(`landing-${theme}`);

  await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
  await shot(`login-${theme}`);

  await page.goto(BASE + '/signup', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500); // let Turnstile render
  await shot(`signup-${theme}`);
}

// Log in once (dark first), then screenshot dashboard + settings in both themes.
if (email && password) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await setTheme('dark');
  await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/dashboard', { timeout: 15000 });
  await page.waitForTimeout(1500);

  for (const theme of ['dark', 'light']) {
    await setTheme(theme);
    await page.waitForTimeout(1200);
    // The app opens on the Daily tab on phones — hop to Pets for the overview.
    await page.click('.tabbar__item:has-text("Pets")');
    await page.waitForTimeout(500);
    await shot(`dashboard-${theme}`);

    // Open settings via the header avatar menu (Settings left the tab bar
    // in the Bevel-style header redesign).
    await page.click('.profile-menu__trigger');
    await page.click('.profile-menu__dropdown button:has-text("Settings")');
    await page.waitForTimeout(800);
    await shot(`settings-${theme}`);
    await page.click('.tabbar__item:has-text("Pets")');
    await page.waitForTimeout(500);
  }
}

await browser.close();
console.log(`\nScreenshots in ${OUT}`);
