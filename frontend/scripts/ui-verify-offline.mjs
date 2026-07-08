// Offline door-mode smoke: proves the founder moment survives zero bars.
// Seeds a throwaway account with a pet + an image record via the live API,
// logs in through the real UI (which fills the door cache), then cuts the
// network and asserts:
//   - /door renders from the local cache and Present shows the record image
//   - /dashboard redirects to /door when its data can't load offline
//   - a cold page reload offline still boots the app (service worker shell)
//
//   node scripts/ui-verify-offline.mjs <email> <password>
//
// THROWAWAY USER ONLY. Cleans up its pets at the end (network restored first).
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pkg from 'amazon-cognito-identity-js';

const { CognitoUserPool, CognitoUser, AuthenticationDetails } = pkg;

const BASE = process.env.BASE_URL ?? 'https://petshots.app';
const API = process.env.API_URL ?? 'https://ycg5npcyk8.execute-api.us-east-1.amazonaws.com';
const OUT = '/tmp/petshots-ui-offline';
const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error('usage: node scripts/ui-verify-offline.mjs <email> <password>');
  process.exit(1);
}
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

let pass = 0;
let fail = 0;
const check = (cond, label) => {
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}`);
  cond ? pass++ : fail++;
};

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

// A visibly non-trivial PNG (16x16 red square) so the Present screenshot
// shows a real image, not a transparent pixel.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAG0lEQVR42mP8z8BQz0AEYBxVSF+FowqHi0IA0hgP8Rk6X8IAAAAASUVORK5CYII=',
  'base64',
);

async function seed() {
  const token = await login();
  const pre = await api(token, 'GET', '/pets');
  for (const p of pre.body?.pets ?? []) await api(token, 'DELETE', `/pets/${p.id}`);
  const pet = (await api(token, 'POST', '/pets', { name: 'Biscuit', species: 'dog' })).body.pet;
  const presign = await api(token, 'POST', `/pets/${pet.id}/docs/upload-url`, {
    filename: 'rabies.png',
    label: 'Rabies',
    expiry: '2027-06-01',
    contentType: 'image/png',
  });
  const form = new FormData();
  for (const [k, v] of Object.entries(presign.body.fields)) form.append(k, v);
  form.append('file', new Blob([PNG], { type: 'image/png' }));
  const up = await fetch(presign.body.url, { method: 'POST', body: form });
  if (up.status !== 204) throw new Error(`seed upload failed: ${up.status}`);
  console.log('seeded Biscuit + Rabies record');
  return token;
}

async function main() {
  const token = await seed();

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();

  console.log('\n[1] login online — door cache fills in the background');
  await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/dashboard', { timeout: 20000 });

  // Wait for the metadata AND the doc bytes to land in the door cache.
  const cached = await page
    .waitForFunction(
      async () => {
        if (!localStorage.getItem('petshots.doorCache')) return false;
        const cache = await caches.open('petshots-door-v1');
        return (await cache.keys()).length >= 1;
      },
      { timeout: 20000 },
    )
    .then(() => true)
    .catch(() => false);
  check(cached, 'door cache filled (metadata + doc bytes)');

  // Give the SW time to finish activating + asset precache before the cord is cut.
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, { timeout: 15000 })
    .catch(() => {});
  await page.waitForTimeout(1500);

  console.log('\n[2] offline: /door renders from the local cache');
  await ctx.setOffline(true);
  await page.goto(BASE + '/door', { waitUntil: 'domcontentloaded' });
  const h1 = await page.textContent('h1').catch(() => null);
  check(h1 === 'Door mode', `door page boots offline (h1: ${h1})`);
  check(
    await page.locator('.door-pet__name', { hasText: 'Biscuit' }).isVisible().catch(() => false),
    'cached pet listed',
  );

  console.log('\n[3] offline: Present shows the record');
  await page.click('.door-pet button');
  await page.waitForSelector('.present', { timeout: 10000 });
  check(
    await page.locator('.present__doc-label', { hasText: 'Rabies' }).isVisible().catch(() => false),
    'record label shown',
  );
  const imgOk = await page
    .waitForFunction(() => {
      const img = document.querySelector('.present__doc-img');
      return img && img.naturalWidth > 0;
    }, { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  check(imgOk, 'record image renders from cached bytes (no network)');
  await page.screenshot({ path: `${OUT}/offline-present.png` });
  await page.keyboard.press('Escape');

  console.log('\n[4] offline: /dashboard falls back to door mode');
  await page.goto(BASE + '/dashboard', { waitUntil: 'domcontentloaded' });
  const landed = await page
    .waitForURL('**/door', { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check(landed, `dashboard offline redirects to /door (at: ${page.url()})`);
  await page.screenshot({ path: `${OUT}/offline-door.png` });

  console.log('\n[5] cleanup (network restored)');
  await ctx.setOffline(false);
  await browser.close();
  const after = await api(token, 'GET', '/pets');
  for (const p of after.body?.pets ?? []) await api(token, 'DELETE', `/pets/${p.id}`);
  check((await api(token, 'GET', '/pets')).body.pets.length === 0, 'seeded pets deleted');

  console.log(`\nscreenshots: ${OUT}`);
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('ERROR:', e.message || e);
  process.exit(1);
});
