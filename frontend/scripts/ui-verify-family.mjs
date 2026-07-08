// UI verification of family mode against live: owner creates an invite in
// Settings, a member accepts it via the /join page, and the member's
// dashboard shows the household pet with the right restrictions.
//
//   node scripts/ui-verify-family.mjs <ownerEmail> <ownerPass> <memberEmail> <memberPass>
//
// THROWAWAY USERS ONLY. Seeds the owner with a pet via the API; deletes all
// pets at the end (user deletion is the runner's job).
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pkg from 'amazon-cognito-identity-js';

const { CognitoUserPool, CognitoUser, AuthenticationDetails } = pkg;

const BASE = process.env.BASE_URL ?? 'https://petshots.app';
const API = process.env.API_URL ?? 'https://ycg5npcyk8.execute-api.us-east-1.amazonaws.com';
const OUT = '/tmp/petshots-ui-family';
const [ownerEmail, ownerPass, memberEmail, memberPass] = process.argv.slice(2);
if (!memberPass) {
  console.error('usage: node scripts/ui-verify-family.mjs <ownerEmail> <ownerPass> <memberEmail> <memberPass>');
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

const pool = new CognitoUserPool({
  UserPoolId: env.VITE_COGNITO_USER_POOL_ID,
  ClientId: env.VITE_COGNITO_CLIENT_ID,
});
function sdkLogin(email, password) {
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

async function uiLogin(page, email, password) {
  await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/dashboard', { timeout: 20000 });
  await page.waitForTimeout(1200);
}

async function main() {
  // Seed: owner gets a pet.
  const ownerToken = await sdkLogin(ownerEmail, ownerPass);
  const pre = await api(ownerToken, 'GET', '/pets');
  for (const p of pre.body?.pets ?? []) await api(ownerToken, 'DELETE', `/pets/${p.id}`);
  await api(ownerToken, 'POST', '/pets', { name: 'Maple', species: 'dog' });
  console.log('seeded Maple for the owner');

  const browser = await chromium.launch();

  console.log('\n[1] owner: Settings → Family → create invite');
  const ownerCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const ownerPage = await ownerCtx.newPage();
  await uiLogin(ownerPage, ownerEmail, ownerPass);
  await ownerPage.click('.profile-menu__trigger');
  await ownerPage.click('.profile-menu__dropdown >> text=Settings');
  await ownerPage.waitForSelector('legend:has-text("Family")', { timeout: 15000 });
  check(true, 'Family card renders in Settings');
  await ownerPage.click('button:has-text("Invite a family member")');
  await ownerPage.waitForSelector('text=Invite link (pending)', { timeout: 15000 });
  check(true, 'invite created and listed as pending');
  await ownerPage.screenshot({ path: `${OUT}/owner-family-card.png`, fullPage: true });

  // Grab the invite URL via the API (clipboard is flaky headless).
  const hh = await api(ownerToken, 'GET', '/household');
  const inviteUrl = hh.body.invites[0]?.url;
  check(!!inviteUrl, `invite url resolvable (${inviteUrl})`);

  console.log('\n[2] member: /join preview while logged out');
  const memberCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const memberPage = await memberCtx.newPage();
  await memberPage.goto(inviteUrl, { waitUntil: 'domcontentloaded' });
  await memberPage.waitForSelector(`text=${ownerEmail}`, { timeout: 15000 });
  check(true, 'join page shows who invited (logged out)');
  await memberPage.screenshot({ path: `${OUT}/join-logged-out.png`, fullPage: true });

  console.log('\n[3] member: log in via the join page hop, accept');
  await memberPage.click('a:has-text("Log in")');
  await memberPage.fill('input[type="email"]', memberEmail);
  await memberPage.fill('input[type="password"]', memberPass);
  await memberPage.click('button[type="submit"]');
  // Dashboard bounces back to /join/{token} via the pending-invite pickup.
  await memberPage.waitForURL('**/join/**', { timeout: 20000 });
  check(true, 'login hop returns to the join page');
  await memberPage.click('button:has-text("Accept invite")');
  await memberPage.waitForURL('**/dashboard', { timeout: 20000 });
  check(true, 'accept lands on the dashboard');
  await memberPage.waitForSelector('text=Maple', { timeout: 20000 });
  check(true, "member's dashboard shows the household pet");
  await memberPage.screenshot({ path: `${OUT}/member-dashboard.png`, fullPage: true });

  console.log('\n[4] member: household pet restrictions in UI');
  await memberPage.click('text=Maple');
  await memberPage.waitForSelector('.pet-detail__hero', { timeout: 15000 });
  await memberPage.click('button:has-text("✎ Edit")');
  const deleteVisible = await memberPage
    .locator('button:has-text("Delete Maple")')
    .isVisible()
    .catch(() => false);
  check(!deleteVisible, 'delete-pet hidden for the member');
  const familyNote = await memberPage
    .locator('text=family pet')
    .first()
    .isVisible()
    .catch(() => false);
  check(familyNote, 'family-pet note shown instead');
  await memberPage.screenshot({ path: `${OUT}/member-edit-pet.png`, fullPage: true });

  console.log('\n[5] cleanup');
  await browser.close();
  const after = await api(ownerToken, 'GET', '/pets');
  for (const p of after.body?.pets ?? []) await api(ownerToken, 'DELETE', `/pets/${p.id}`);
  const memberToken = await sdkLogin(memberEmail, memberPass);
  await api(memberToken, 'POST', '/household/leave');
  check((await api(ownerToken, 'GET', '/pets')).body.pets.length === 0, 'pets deleted, member left');

  console.log(`\nscreenshots: ${OUT}`);
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('ERROR:', e.message || e);
  process.exit(1);
});
