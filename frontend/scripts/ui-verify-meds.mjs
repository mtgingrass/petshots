// Visual verification of the Meds tab in both themes at iPhone viewport.
// Seeds the given (throwaway) account with pets + meds via the live API,
// then walks the UI. Usage: node scripts/ui-verify-meds.mjs <email> <password>
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pkg from 'amazon-cognito-identity-js';

const { CognitoUserPool, CognitoUser, AuthenticationDetails } = pkg;

const BASE = process.env.BASE_URL ?? 'https://petshots.app';
const API = process.env.API_URL ?? 'https://ycg5npcyk8.execute-api.us-east-1.amazonaws.com';
const OUT = '/tmp/petshots-ui-meds';
const [email, password] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(__dirname, '..', '.env'), 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

function login() {
  const pool = new CognitoUserPool({
    UserPoolId: env.VITE_COGNITO_USER_POOL_ID,
    ClientId: env.VITE_COGNITO_CLIENT_ID,
  });
  const user = new CognitoUser({ Username: email, Pool: pool });
  const details = new AuthenticationDetails({ Username: email, Password: password });
  return new Promise((resolve, reject) => {
    user.authenticateUser(details, {
      onSuccess: (s) => resolve(s.getAccessToken().getJwtToken()),
      onFailure: (e) => reject(e),
    });
  });
}

async function api(token, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const ymd = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// ---- seed ----
const token = await login();
const pre = await api(token, 'GET', '/pets');
for (const p of pre.body?.pets ?? []) await api(token, 'DELETE', `/pets/${p.id}`);
const dog = (await api(token, 'POST', '/pets', { name: 'Biscuit', species: 'dog' })).body.pet;
const cat = (await api(token, 'POST', '/pets', { name: 'Ziggy', species: 'cat' })).body.pet;
await api(token, 'PUT', `/pets/${dog.id}/meds`, {
  meds: [
    // Only 3 of the free tier's 4 med slots: the preset-chip step below needs
    // a free slot, or the chips are replaced by the at-limit message.
    { name: 'Heartworm prevention', interval: 1, unit: 'month', nextDue: ymd(-3), remindersEnabled: true, lastGiven: ymd(-33) },
    { name: 'Bravecto', interval: 12, unit: 'week', nextDue: ymd(0), remindersEnabled: true, lastGiven: ymd(-84) },
    { name: 'Insulin', interval: 1, unit: 'day', nextDue: ymd(1), remindersEnabled: false },
  ],
});
console.log('seeded Biscuit (3 meds) + Ziggy (none)');

// ---- walk UI ----
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();

async function shot(name) {
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  console.log(`✓ ${name}`);
}

await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
await page.fill('input[type="email"]', email);
await page.fill('input[type="password"]', password);
await page.click('button[type="submit"]');
await page.waitForURL('**/dashboard', { timeout: 20000 });
await page.waitForTimeout(1500);

for (const theme of ['dark', 'light']) {
  await page.evaluate((t) => localStorage.setItem('petshots.theme', t), theme);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  // Biscuit: full med list with mixed statuses.
  await page.click('text=Biscuit');
  await page.waitForTimeout(1000);
  await page.click('.tab-bar__tab:has-text("Meds")');
  await page.waitForTimeout(1000);
  await shot(`meds-list-${theme}`);

  // Preset chip -> prefilled add form.
  await page.click('.preset-chip:has-text("Joint supplement")');
  await page.waitForTimeout(400);
  await shot(`meds-add-preset-${theme}`);
  await page.click('button:has-text("Cancel")');

  // ⋯ menu open.
  await page.click('.med-item >> nth=0 >> .btn--icon');
  await page.waitForTimeout(300);
  await shot(`meds-menu-${theme}`);
  await page.keyboard.press('Escape');

  // Ziggy: empty state with preset chips. Phone viewport: the header back is
  // hidden — the Pets tab pops to overview.
  await page.click('.tabbar__item:has-text("Pets")');
  await page.waitForTimeout(800);
  await page.click('text=Ziggy');
  await page.waitForTimeout(1000);
  await page.click('.tab-bar__tab:has-text("Meds")');
  await page.waitForTimeout(800);
  await shot(`meds-empty-${theme}`);

  await page.click('.tabbar__item:has-text("Pets")');
  await page.waitForTimeout(800);
}

// Settings hint line (one theme is enough). Phone viewport → bottom tab bar.
await page.click('.tabbar__item:has-text("Settings")');
await page.waitForTimeout(1000);
await shot('settings-meds-hint');

await browser.close();
console.log(`\nScreenshots in ${OUT}`);
