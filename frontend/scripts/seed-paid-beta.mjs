/**
 * seed-paid-beta.mjs — Populate the permanent paid-beta@petshots.app account
 * (created for Mark to beta-test the paid-tier experience — Trends monthly
 * rollup, higher limits, no upgrade nags) with one dog pet + ~3 months of
 * realistic Daily-checklist/mood/weight history, then flips plan.json to
 * paid. Safe to re-run; wipes and rebuilds the pet each time.
 *
 * Usage:  node scripts/seed-paid-beta.mjs
 *
 * Account: paid-beta@petshots.app (permanent, production)
 * Password stored in Claude memory only — never committed to git.
 */

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pkg from 'amazon-cognito-identity-js';

const { CognitoUserPool, CognitoUser, AuthenticationDetails } = pkg;

const API = 'https://ycg5npcyk8.execute-api.us-east-1.amazonaws.com';
const BUCKET = 'petshots-uploads';
const __dirname = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(__dirname, '..', '.env'), 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

const EMAIL = 'paid-beta@petshots.app'; // Cognito login — unchanged
const PASSWORD = process.env.PAID_BETA_PASSWORD; // never hardcode - this is a real production account
if (!PASSWORD) {
  console.error('Set PAID_BETA_PASSWORD (credentials live in Claude memory, never in git).');
  process.exit(1);
}
// Notification email is deliberately a REAL inbox, not the login address —
// Mark needs to actually receive the report emails this account is for
// testing. Login (Cognito username) and notification email are independent
// fields in this product; don't "fix" this back to EMAIL.
const NOTIFY_EMAIL = process.env.PAID_BETA_NOTIFY_EMAIL ?? 'mark.gingrass@gmail.com';
const ACTOR = EMAIL;
const DAYS_BACK = 92;
const LIVE_WINDOW_DAYS = 14; // must match DAILY.LOG_RETENTION_DAYS in shared/config.ts

function mulberry32(seed) {
  let a = seed;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TODAY = new Date();
const dateStr = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => { const c = new Date(d); c.setUTCDate(c.getUTCDate() + n); return c; };

function login() {
  const pool = new CognitoUserPool({ UserPoolId: env.VITE_COGNITO_USER_POOL_ID, ClientId: env.VITE_COGNITO_CLIENT_ID });
  const user = new CognitoUser({ Username: EMAIL, Pool: pool });
  const details = new AuthenticationDetails({ Username: EMAIL, Password: PASSWORD });
  return new Promise((resolve, reject) =>
    user.authenticateUser(details, {
      onSuccess: (s) => resolve({ token: s.getAccessToken().getJwtToken(), sub: s.getIdToken().payload.sub }),
      onFailure: reject,
      // Admin-created users start in FORCE_CHANGE_PASSWORD; complete it with the same password.
      newPasswordRequired: () => user.completeNewPasswordChallenge(PASSWORD, {}, {
        onSuccess: (s) => resolve({ token: s.getAccessToken().getJwtToken(), sub: s.getIdToken().payload.sub }),
        onFailure: reject,
      }),
    }),
  );
}
async function api(token, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body != null ? { 'content-type': 'application/json' } : {}) },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
function s3PutJson(key, obj) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'petshots-seed-'));
  const tmpFile = join(tmpDir, 'body.json');
  writeFileSync(tmpFile, JSON.stringify(obj));
  execFileSync('aws', ['s3api', 'put-object', '--bucket', BUCKET, '--key', key, '--body', tmpFile, '--content-type', 'application/json'], { stdio: 'pipe' });
}

// Same generator as seed-daily-history.mjs — one dog, a mild mid-window dip
// so the digest/Trends insight logic has something real to notice.
function buildHistory(rng) {
  const presets = ['preset-breakfast', 'preset-dinner', 'preset-walk'];
  const checksByDate = {};
  const moodsByDate = {};
  for (let agoDays = DAYS_BACK - 1; agoDays >= 0; agoDays--) {
    const date = dateStr(addDays(TODAY, -agoDays));
    const inRoughPatch = agoDays <= 28 && agoDays >= 18;
    const dayChecks = {};
    for (const item of presets) {
      let p = item === 'preset-walk' ? 0.78 : item === 'preset-breakfast' ? 0.94 : 0.9;
      if (inRoughPatch) p *= item === 'preset-walk' ? 0.4 : 0.65;
      if (rng() < p) {
        const hour = item === 'preset-breakfast' ? 7 + Math.floor(rng() * 2) : item === 'preset-dinner' ? 18 + Math.floor(rng() * 2) : 16 + Math.floor(rng() * 3);
        const minute = String(Math.floor(rng() * 60)).padStart(2, '0');
        dayChecks[item] = { by: ACTOR, at: `${date}T${String(hour).padStart(2, '0')}:${minute}:00.000Z` };
      }
    }
    if (Object.keys(dayChecks).length > 0) checksByDate[date] = dayChecks;
    if (rng() < 0.65) {
      const base = inRoughPatch ? 2.8 : 4.3;
      const value = Math.max(1, Math.min(5, Math.round(base + (rng() - 0.5) * 1.6)));
      const minute = String(Math.floor(rng() * 60)).padStart(2, '0');
      moodsByDate[date] = { value, by: ACTOR, at: `${date}T20:${minute}:00.000Z` };
    }
  }
  return { checksByDate, moodsByDate };
}
function splitLiveVsArchive({ checksByDate, moodsByDate }) {
  const liveCutoff = dateStr(addDays(TODAY, -(LIVE_WINDOW_DAYS - 1)));
  const live = { items: null, log: {}, moods: {} };
  const archiveByMonth = {};
  const allDates = new Set([...Object.keys(checksByDate), ...Object.keys(moodsByDate)]);
  for (const date of allDates) {
    const checks = checksByDate[date];
    const mood = moodsByDate[date];
    if (date >= liveCutoff) {
      if (checks) live.log[date] = checks;
      if (mood) live.moods[date] = mood;
    } else {
      const month = date.slice(0, 7);
      archiveByMonth[month] ??= { days: {} };
      archiveByMonth[month].days[date] = { ...(checks ? { checks } : {}), ...(mood ? { mood } : {}) };
    }
  }
  return { live, archiveByMonth };
}
function weightSeries({ start, end, points, rng }) {
  const out = [];
  for (let i = 0; i < points; i++) {
    const agoDays = Math.round(DAYS_BACK - 1 - (i / (points - 1)) * (DAYS_BACK - 1));
    const date = dateStr(addDays(TODAY, -agoDays));
    const frac = i / (points - 1);
    const weight = Math.round((start + (end - start) * frac + (rng() - 0.5) * 0.5) * 10) / 10;
    out.push({ date, weight });
  }
  return out;
}

console.log(`\nLogging in as ${EMAIL}...`);
const { token, sub } = await login();
console.log(`✓ Authenticated (sub ${sub})\n`);

const { pets: existing = [] } = await api(token, 'GET', '/pets');
for (const p of existing) await api(token, 'DELETE', `/pets/${p.id}`);
if (existing.length) console.log(`Cleared ${existing.length} prior pet(s)`);

console.log('Creating Rex (Labrador)...');
const { pet } = await api(token, 'POST', '/pets', { name: 'Rex', species: 'dog' });
await api(token, 'PUT', `/pets/${pet.id}`, {
  name: 'Rex', species: 'dog', breed: 'Labrador Retriever',
  dob: '2022-03-15', allergies: 'None known', notes: 'Beta-test pet for the paid tier — safe to reset any time.',
});

const rng = mulberry32(7);
const lastGiven = dateStr(addDays(TODAY, -8));
const nextDue = dateStr(addDays(TODAY, 22));
const { meds } = await api(token, 'PUT', `/pets/${pet.id}/meds`, {
  meds: [{ name: 'Heartworm & Flea Prevention', interval: 1, unit: 'month', nextDue, lastGiven, remindersEnabled: true }],
});
const medId = meds[0].id;
console.log(`  ✓ Med: Heartworm & Flea Prevention (next due ${nextDue})`);

const history = buildHistory(rng);
for (const agoDays of [80, 50, 8]) {
  const date = dateStr(addDays(TODAY, -agoDays));
  history.checksByDate[date] ??= {};
  history.checksByDate[date][`med:${medId}`] = { by: ACTOR, at: `${date}T09:00:00.000Z` };
}
const { live, archiveByMonth } = splitLiveVsArchive(history);
const petPrefix = `users/${sub}/pets/${pet.id}/`;
s3PutJson(`${petPrefix}daily.json`, live);
for (const [month, obj] of Object.entries(archiveByMonth)) s3PutJson(`${petPrefix}daily-archive/${month}.json`, obj);
console.log(`  ✓ Daily history: ${Object.keys(live.log).length} live day(s) + ${Object.keys(archiveByMonth).length} archive month(s)`);

for (const w of weightSeries({ start: 68.0, end: 70.5, points: 13, rng })) {
  await api(token, 'POST', `/pets/${pet.id}/weights`, { date: w.date, weight: w.weight, unit: 'lb' });
}
console.log('  ✓ Weight: 68.0 → 70.5 lb across 13 entries');

await api(token, 'PUT', '/settings', { email: NOTIFY_EMAIL, remindersEnabled: true, reminderDays: [7, 30], weeklyDigest: true });
console.log('  ✓ Settings: reminders + weekly digest on');

s3PutJson(`users/${sub}/plan.json`, { plan: 'paid' });
console.log('  ✓ Plan: paid');

console.log(`\nDone! paid-beta@petshots.app is ready:\n  Pet: Rex (Labrador, ~3 months of history)\n  Plan: paid (Trends monthly rollup, higher limits, no upgrade nags)\n`);
