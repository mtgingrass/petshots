// Capture documentation screenshots against LIVE petshots.app using the demo account.
// Output: docs/images/*.png  (iPhone viewport, dark theme)
// Usage: node scripts/shoot-docs.mjs
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pkg from 'amazon-cognito-identity-js';

const { CognitoUserPool, CognitoUser, AuthenticationDetails } = pkg;

const BASE = 'https://petshots.app';
const API = 'https://ycg5npcyk8.execute-api.us-east-1.amazonaws.com';
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', '..', 'docs', 'images');
mkdirSync(OUT, { recursive: true });

const env = Object.fromEntries(
  readFileSync(join(__dirname, '..', '.env'), 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

const EMAIL = 'demo@petshots.app';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'Petshots#Demo2026';

function cognitoLogin() {
  const pool = new CognitoUserPool({
    UserPoolId: env.VITE_COGNITO_USER_POOL_ID,
    ClientId: env.VITE_COGNITO_CLIENT_ID,
  });
  const user = new CognitoUser({ Username: EMAIL, Pool: pool });
  const details = new AuthenticationDetails({ Username: EMAIL, Password: PASSWORD });
  return new Promise((resolve, reject) =>
    user.authenticateUser(details, {
      onSuccess: (s) => resolve(s.getAccessToken().getJwtToken()),
      onFailure: reject,
    }),
  );
}

async function api(token, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 150)}`);
  return text ? JSON.parse(text) : null;
}

// Create a passport link for Luna via the API so we can screenshot the public page.
const token = await cognitoLogin();
const { pets } = await api(token, 'GET', '/pets');
const luna = pets.find((p) => p.name === 'Luna');
const bella = pets.find((p) => p.name === 'Bella');
if (!luna || !bella) throw new Error('Demo pets not found — run seed-marketing.mjs first');
const passport = await api(token, 'POST', `/pets/${luna.id}/passport`, { expiry: '2026-12-31' });
console.log(`✓ Passport created: ${passport.url}`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

async function shot(name) {
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  console.log(`✓ ${name}.png`);
}

// Log in through the real UI
await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => localStorage.setItem('petshots.theme', 'dark'));
await page.fill('input[type="email"]', EMAIL);
await page.fill('input[type="password"]', PASSWORD);
await page.click('button[type="submit"]');
await page.waitForURL('**/dashboard', { timeout: 20000 });
await page.waitForTimeout(2000);
// The app opens on the Daily tab on phones — hop to Pets for the overview.
await page.click('.tabbar__item:has-text("Pets")');
await page.waitForTimeout(500);

// 1. Dashboard overview — pinned portraits with status rings
await shot('app-dashboard');

// 2. Pet detail — Luna shows all four badge states in one records list
await page.click(`.pet-pin:has-text("Luna")`);
await page.waitForTimeout(1500);
await shot('app-pet-records');

// 3. Public passport page (no login — new context to prove it)
const pub = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const pubPage = await pub.newPage();
await pubPage.goto(passport.url, { waitUntil: 'domcontentloaded' });
await pubPage.waitForTimeout(2500);
await pubPage.screenshot({ path: `${OUT}/app-passport.png`, fullPage: false });
console.log('✓ app-passport.png');

await browser.close();
console.log(`\nDone → ${OUT}`);
