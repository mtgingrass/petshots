// Visual verification of the AI upload flow in both themes at iPhone viewport.
// Walks the real thing end-to-end: picks a synthetic multi-vaccine cert PDF,
// waits for Claude to read it, screenshots the review screen, saves records.
// Makes 2 real Haiku calls (one per theme).
//
//   node scripts/ui-verify-ai-upload.mjs <email> <password>   (THROWAWAY user)
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import pkg from 'amazon-cognito-identity-js';
import { makeMultiVaccineCert } from './lib-cert-pdf.mjs';

const { CognitoUserPool, CognitoUser, AuthenticationDetails } = pkg;

const BASE = process.env.BASE_URL ?? 'https://petshots.app';
const API = process.env.API_URL ?? 'https://ycg5npcyk8.execute-api.us-east-1.amazonaws.com';
const OUT = '/tmp/petshots-ui-ai';
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

// ---- seed: one clean pet ----
const token = await login();
const pre = await api(token, 'GET', '/pets');
for (const p of pre.body?.pets ?? []) await api(token, 'DELETE', `/pets/${p.id}`);
await api(token, 'POST', '/pets', { name: 'Biscuit', species: 'dog' });
console.log('seeded Biscuit (no records)');

const certPath = join(tmpdir(), 'ui-verify-cert.pdf');
writeFileSync(certPath, makeMultiVaccineCert());

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

  // The app opens on the Daily tab on phones — hop to Pets for the overview.
  await page.click('.tabbar__item:has-text("Pets")');
  await page.waitForTimeout(500);
  await page.click('text=Biscuit');
  await page.waitForTimeout(1000);
  // Daily is the landing segment now — the upload input lives on Records.
  await page.click('.tab-bar__tab:has-text("Records")');
  await page.waitForTimeout(600);
  await shot(`ai-records-${theme}`); // empty state (dark) / 3 records (light)

  // Feed the hidden file input directly (the + Add record button opens it).
  await page.setInputFiles('input[type="file"]', certPath);
  // Uploading -> analyzing status card.
  await page.waitForSelector('.ai-status', { timeout: 15000 });
  await shot(`ai-analyzing-${theme}`);

  // Claude round trip: the review screen replaces the detail view.
  await page.waitForSelector('.screen-nav__title:has-text("Review")', { timeout: 45000 });
  await page.waitForTimeout(500);
  await shot(`ai-review-${theme}`);

  if (theme === 'dark') {
    // Save all three records + the profile fills, land back on the list.
    await page.click('button:has-text("Save 3 records")');
    await page.waitForSelector('.doc-list', { timeout: 20000 });
    await shot('ai-saved-dark');
  } else {
    // Light theme: 3 of 4 slots are used, so extra rows auto-deselect and the
    // slots-left note shows — screenshot that state, then bail out.
    await page.click('.screen-nav__back');
    await page.waitForTimeout(800);
  }

  // Phone viewport: the header back is hidden — the Pets tab pops to overview.
  await page.click('.tabbar__item:has-text("Pets")');
  await page.waitForTimeout(800);
}

await browser.close();

// ---- cleanup ----
const post = await api(token, 'GET', '/pets');
for (const p of post.body?.pets ?? []) await api(token, 'DELETE', `/pets/${p.id}`);
console.log('cleaned up pets');
console.log(`\nScreenshots in ${OUT}`);
