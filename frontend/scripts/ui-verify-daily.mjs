// UI verification of the Daily tab: presets + due-med rows render, a
// check-off persists with attribution, mood buttons record who pressed,
// and the date-nav history browsing (dropdown + swipe + read-only past days).
// Needs AWS CLI creds (writes a plan.json history override for the throwaway).
//   node scripts/ui-verify-daily.mjs <email> <password>   (THROWAWAY ONLY)
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
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

  // The app opens on the Daily tab on phones — hop to Pets for the overview.
  await page.click('.tabbar__item:has-text("Pets")');
  await page.waitForTimeout(500);
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
  await page.click('.tabbar__item:has-text("Pets")'); // reload lands on Daily
  await page.waitForTimeout(500);
  await page.click('.pet-pin:has-text("Clover")');
  await page.click('.tab-bar__tab:has-text("Daily")'); // detail defaults to Records now
  await page.waitForSelector('.daily', { timeout: 15000 });
  check(await page.locator('.daily-item--done', { hasText: 'Breakfast' }).isVisible().catch(() => false), 'check persists across reload');
  check(await page.locator('.daily__mood-btn--active').isVisible().catch(() => false), 'mood persists across reload');

  // ---- date navigation on the pet-detail Daily tab (we're already on it) ----
  await page.waitForSelector('.date-nav__btn', { timeout: 15000 });
  check((await page.locator('.date-nav__btn').textContent()).startsWith('Today,'), 'date nav shows Today');

  // Swipe right (synthetic touch — React reads touches/changedTouches) → yesterday.
  const swipe = (fromX, toX) => page.evaluate(([x1, x2]) => {
    const el = document.querySelector('.pet-daily');
    const mk = (x) => new Touch({ identifier: 1, target: el, clientX: x, clientY: 300 });
    el.dispatchEvent(new TouchEvent('touchstart', { touches: [mk(x1)], changedTouches: [mk(x1)], bubbles: true }));
    el.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [mk(x2)], bubbles: true }));
  }, [fromX, toX]);
  await swipe(80, 260);
  await page.waitForSelector('.daily-past-note', { timeout: 10000 });
  check((await page.locator('.date-nav__btn').textContent()).startsWith('Yesterday,'), 'swipe right goes to yesterday');
  await page.waitForSelector('.daily .daily-item', { timeout: 10000 });
  check(await page.locator('.daily-item__check[disabled]').first().isVisible(), 'past-day checks are read-only');
  check(!(await page.locator('.daily button:has-text("Edit list")').first().isVisible().catch(() => false)), 'no Edit list on a past day');
  await page.screenshot({ path: `${OUT}/daily-yesterday.png`, fullPage: true });

  // Swipe left → back to today, editable again.
  await swipe(260, 80);
  await page.waitForFunction(
    () => document.querySelector('.date-nav__btn')?.textContent.startsWith('Today,'),
    { timeout: 10000 },
  );
  check(true, 'swipe left returns to today');

  // Dropdown: 14 quick days, picking one navigates.
  await page.click('.date-nav__btn');
  await page.waitForSelector('.date-nav__dropdown', { timeout: 10000 });
  check((await page.locator('.date-nav__option').count()) === 14, 'dropdown lists 14 days');
  await page.locator('.date-nav__option').nth(2).click();
  await page.waitForSelector('.daily-past-note', { timeout: 10000 });
  check(true, 'dropdown picks a past day');
  await page.click('.date-nav__btn');
  await page.locator('.date-nav__option').first().click();
  await page.waitForFunction(
    () => document.querySelector('.date-nav__btn')?.textContent.startsWith('Today,'),
    { timeout: 10000 },
  );
  check(true, 'dropdown returns to today');

  // ---- history window enforcement (API level) ----
  const sub = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
  const back10 = await api(token, 'GET', `/pets/${pet.id}/daily?date=${ymd(-10)}`);
  check(back10.status === 200, 'free plan reads 10 days back');
  const back20 = await api(token, 'GET', `/pets/${pet.id}/daily?date=${ymd(-20)}`);
  check(back20.status === 403 && back20.body.error === 'HISTORY_LIMIT', 'free plan blocked past 2 weeks');
  // Writes keep the tight anti-backfill window — a past-dated check must 400.
  const oldCheck = await api(token, 'POST', `/pets/${pet.id}/daily/check`, { date: ymd(-10), itemId: 'preset-breakfast', checked: true });
  check(oldCheck.status === 400, 'past-day check-off still rejected (no backfill)');
  // Paid-depth override: plan.json limits.dailyHistoryDays → archive-path read.
  execSync(`aws s3 cp - s3://petshots-uploads/users/${sub}/plan.json`, {
    input: JSON.stringify({ plan: 'free', limits: { dailyHistoryDays: 365 } }),
  });
  const back100 = await api(token, 'GET', `/pets/${pet.id}/daily?date=${ymd(-100)}`);
  check(back100.status === 200 && back100.body.mood === null, 'year history override reads 100 days back (archive path)');
  const back400 = await api(token, 'GET', `/pets/${pet.id}/daily?date=${ymd(-400)}`);
  check(back400.status === 403, 'beyond the plan window still blocked');
  execSync(`aws s3 rm s3://petshots-uploads/users/${sub}/plan.json`);

  await browser.close();
  const after = await api(token, 'GET', '/pets');
  for (const p of after.body.pets) await api(token, 'DELETE', `/pets/${p.id}`);
  console.log(`screenshots: ${OUT}`);
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('ERROR:', e.message || e); process.exit(1); });
