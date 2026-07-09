// UI verification of the Daily tab: presets + due-med rows render, a
// check-off persists with attribution, mood buttons record who pressed.
//   node scripts/ui-verify-daily.mjs <email> <password>   (THROWAWAY ONLY)
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pkg from 'amazon-cognito-identity-js';

const { CognitoUserPool, CognitoUser, AuthenticationDetails } = pkg;
const BASE = process.env.BASE_URL ?? 'https://petshots.app';
const API = process.env.API_URL ?? 'https://ycg5npcyk8.execute-api.us-east-1.amazonaws.com';
const OUT = '/tmp/petshots-ui-daily';
const [email, password] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(__dirname, '..', '.env'), 'utf8')
    .split('\n').filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

let pass = 0, fail = 0;
const check = (c, l) => { console.log(`${c ? '  ✅' : '  ❌'} ${l}`); c ? pass++ : fail++; };

const pool = new CognitoUserPool({ UserPoolId: env.VITE_COGNITO_USER_POOL_ID, ClientId: env.VITE_COGNITO_CLIENT_ID });
const login = () => new Promise((res, rej) => {
  const u = new CognitoUser({ Username: email, Pool: pool });
  u.authenticateUser(new AuthenticationDetails({ Username: email, Password: password }), {
    onSuccess: (s) => res(s.getAccessToken().getJwtToken()), onFailure: rej,
  });
});
const api = async (t, m, p, b) => {
  const r = await fetch(API + p, { method: m, headers: { Authorization: `Bearer ${t}`, ...(b ? { 'content-type': 'application/json' } : {}) }, body: b ? JSON.stringify(b) : undefined });
  const x = await r.text();
  return { status: r.status, body: x ? JSON.parse(x) : null };
};
const ymd = (o) => { const d = new Date(); d.setDate(d.getDate() + o); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

async function main() {
  const token = await login();
  const pre = await api(token, 'GET', '/pets');
  for (const p of pre.body?.pets ?? []) await api(token, 'DELETE', `/pets/${p.id}`);
  const pet = (await api(token, 'POST', '/pets', { name: 'Clover', species: 'dog' })).body.pet;
  await api(token, 'PUT', `/pets/${pet.id}/meds`, {
    meds: [{ name: 'Heartworm prevention', interval: 1, unit: 'month', nextDue: ymd(0), remindersEnabled: true }],
  });
  console.log('seeded Clover + due med');

  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/dashboard', { timeout: 20000 });
  await page.waitForTimeout(1200);

  // Click the pet PIN, not `text=Clover` — the med-due notice strip also
  // contains the pet name and deep-links to the Meds tab.
  await page.click('.pet-pin:has-text("Clover")');
  // Records is the default tab since the bottom-bar redesign — the app-level
  // Daily tab owns the every-day surface; click into the pet's Daily tab.
  await page.click('.tab-bar__tab:has-text("Daily")');
  await page.waitForSelector('.daily', { timeout: 15000 });
  check(true, 'pet Daily tab renders');
  check(await page.locator('.daily-item__name', { hasText: 'Breakfast' }).isVisible(), 'Breakfast preset renders');
  check(await page.locator('.daily-item__name', { hasText: 'Walk' }).first().isVisible(), 'Walk preset renders');
  check(await page.locator('.daily-item__name', { hasText: 'Heartworm' }).isVisible(), 'due med appears on the list');

  const poopRow = page.locator('.daily-item', { hasText: 'Poop' });
  check(await poopRow.locator('.daily-item__countpill').isVisible(), 'poop counter row renders');
  await poopRow.locator('button:has-text("+")').click();
  await page.waitForFunction(
    () => document.querySelector('.daily-item__countpill')?.textContent === '1',
    { timeout: 10000 },
  );
  check(true, 'counter increments to 1');
  check(await poopRow.locator('.daily-item__who').isVisible(), 'counter shows last actor');

  await page.locator('.daily-item', { hasText: 'Breakfast' }).locator('.daily-item__check').click();
  const breakfastDone = page.locator('.daily-item--done', { hasText: 'Breakfast' });
  await breakfastDone.waitFor({ timeout: 10000 });
  check(await breakfastDone.locator('.daily-item__who').isVisible(), 'check-off shows who + when');

  await page.click('.daily__mood-btn[title="Good"]');
  await page.waitForSelector('.daily__mood-btn--active', { timeout: 10000 });
  check(await page.locator('.daily__mood-who').isVisible(), 'mood press shows attribution');
  await page.screenshot({ path: `${OUT}/daily-tab.png`, fullPage: true });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await page.click('.pet-pin:has-text("Clover")');
  await page.click('.tab-bar__tab:has-text("Daily")'); // detail defaults to Records now
  await page.waitForSelector('.daily', { timeout: 15000 });
  check(await page.locator('.daily-item--done', { hasText: 'Breakfast' }).isVisible().catch(() => false), 'check persists across reload');
  check(await page.locator('.daily__mood-btn--active').isVisible().catch(() => false), 'mood persists across reload');

  await browser.close();
  const after = await api(token, 'GET', '/pets');
  for (const p of after.body.pets) await api(token, 'DELETE', `/pets/${p.id}`);
  console.log(`screenshots: ${OUT}`);
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('ERROR:', e.message || e); process.exit(1); });
