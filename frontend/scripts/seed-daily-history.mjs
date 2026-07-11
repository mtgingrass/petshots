/**
 * seed-daily-history.mjs — Backfill ~3 months of realistic Daily-checklist
 * history (feedings, walks, mood, meds given) + a weight trend onto the
 * permanent demo@petshots.app account's existing pets (Bella + Luna), so the
 * weekly digest and the monthly-digest prototype have something real to
 * summarize. Safe to re-run — regenerates the same series each time (seeded
 * RNG) and fully overwrites daily.json / daily-archive / weights.json.
 *
 * Weights + meds go through the live API (both legitimately allow historical
 * dates). The daily checklist/mood log does NOT — DAILY.DATE_WINDOW_MS blocks
 * backfilling it by design (anti-forgery), so that part writes directly to
 * S3, bypassing the app. That's a deliberate admin/seed-only exception, not
 * a pattern any user-facing code path should copy.
 *
 * Usage:  node scripts/seed-daily-history.mjs
 */

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pkg from 'amazon-cognito-identity-js';

const { CognitoUserPool, CognitoUser, AuthenticationDetails } = pkg;

const API = 'https://ycg5npcyk8.execute-api.us-east-1.amazonaws.com';
const BUCKET = 'petshots-uploads';
const OWNER_SUB = 'c4885488-4001-7021-839e-508d6a38d346'; // demo@petshots.app
const __dirname = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(__dirname, '..', '.env'), 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

const EMAIL = 'demo@petshots.app';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'Petshots#Demo2026';
const ACTOR = EMAIL;
const DAYS_BACK = 92; // ~3 months
const LIVE_WINDOW_DAYS = 14; // must match DAILY.LOG_RETENTION_DAYS in shared/config.ts

// ── seeded RNG (mulberry32) — reproducible across reruns ───────────────────
function mulberry32(seed) {
  let a = seed;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── date helpers ─────────────────────────────────────────────────────────
const TODAY = new Date();
const dateStr = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => { const c = new Date(d); c.setUTCDate(c.getUTCDate() + n); return c; };

// ── Auth + API (same pattern as seed-marketing.mjs) ─────────────────────────
function login() {
  const pool = new CognitoUserPool({ UserPoolId: env.VITE_COGNITO_USER_POOL_ID, ClientId: env.VITE_COGNITO_CLIENT_ID });
  const user = new CognitoUser({ Username: EMAIL, Pool: pool });
  const details = new AuthenticationDetails({ Username: EMAIL, Password: PASSWORD });
  return new Promise((resolve, reject) =>
    user.authenticateUser(details, { onSuccess: (s) => resolve(s.getAccessToken().getJwtToken()), onFailure: reject }),
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

// ── direct S3 write (admin/seed-only — see file header) ─────────────────────
function s3PutJson(key, obj) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'petshots-seed-'));
  const tmpFile = join(tmpDir, 'body.json');
  writeFileSync(tmpFile, JSON.stringify(obj));
  execFileSync('aws', [
    's3api', 'put-object',
    '--bucket', BUCKET,
    '--key', key,
    '--body', tmpFile,
    '--content-type', 'application/json',
  ], { stdio: 'pipe' });
}

// ── per-pet history generator ───────────────────────────────────────────────
// Bella (dog) gets a deliberate ~2-week "rough patch" (illness-ish dip: lower
// mood, fewer walks/feedings) so the weekly/monthly reports have something
// real to notice — a flat, uneventful series is a bad test of a trend report.
// Luna (cat) stays comparatively flat/consistent, a realistic contrast.
function buildHistory({ species, roughPatchAgoStart, roughPatchAgoEnd, baseMood, roughMood, rng }) {
  const presets = species === 'dog' ? ['preset-breakfast', 'preset-dinner', 'preset-walk'] : ['preset-breakfast', 'preset-dinner'];
  const checksByDate = {};
  const moodsByDate = {};

  for (let agoDays = DAYS_BACK - 1; agoDays >= 0; agoDays--) {
    const date = dateStr(addDays(TODAY, -agoDays));
    const inRoughPatch = roughPatchAgoStart != null && agoDays <= roughPatchAgoStart && agoDays >= roughPatchAgoEnd;

    const dayChecks = {};
    for (const item of presets) {
      let p = item === 'preset-walk' ? 0.72 : item === 'preset-breakfast' ? 0.92 : 0.86;
      if (inRoughPatch) p *= item === 'preset-walk' ? 0.35 : 0.6;
      if (rng() < p) {
        const hour = item === 'preset-breakfast' ? 7 + Math.floor(rng() * 2)
          : item === 'preset-dinner' ? 18 + Math.floor(rng() * 2)
          : 16 + Math.floor(rng() * 3);
        const minute = String(Math.floor(rng() * 60)).padStart(2, '0');
        dayChecks[item] = { by: ACTOR, at: `${date}T${String(hour).padStart(2, '0')}:${minute}:00.000Z` };
      }
    }
    if (Object.keys(dayChecks).length > 0) checksByDate[date] = dayChecks;

    // ~60% of days get a mood press — real users don't press it daily.
    if (rng() < 0.6) {
      const base = inRoughPatch ? roughMood : baseMood;
      const value = Math.max(1, Math.min(5, Math.round(base + (rng() - 0.5) * 1.6)));
      const minute = String(Math.floor(rng() * 60)).padStart(2, '0');
      moodsByDate[date] = { value, by: ACTOR, at: `${date}T20:${minute}:00.000Z` };
    }
  }
  return { checksByDate, moodsByDate };
}

// Splits {checksByDate, moodsByDate} into the live daily.json window + one
// archive object per month, matching pruneDailyToArchive's exact shape.
function splitLiveVsArchive({ checksByDate, moodsByDate }) {
  const liveCutoff = dateStr(addDays(TODAY, -(LIVE_WINDOW_DAYS - 1)));
  const live = { items: null, log: {}, moods: {} };
  const archiveByMonth = {}; // 'YYYY-MM' -> { days: { date: {checks, mood} } }

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

// ── weight series (linear drift + noise), posted through the real API ──────
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

// ── main ─────────────────────────────────────────────────────────────────
console.log(`\nLogging in as ${EMAIL}...`);
const token = await login();
console.log('✓ Authenticated\n');

const { pets } = await api(token, 'GET', '/pets');
const bella = pets.find((p) => p.name === 'Bella');
const luna = pets.find((p) => p.name === 'Luna');
if (!bella || !luna) throw new Error('Expected Bella + Luna to already exist — run seed-marketing.mjs first.');

for (const [pet, cfg] of [
  [bella, {
    species: 'dog', roughPatchAgoStart: 35, roughPatchAgoEnd: 21, baseMood: 4.2, roughMood: 2.6,
    weight: { start: 62.0, end: 64.2, unit: 'lb' },
    med: { name: 'Heartworm & Flea Prevention', interval: 1, unit: 'month' },
    rngSeed: 42,
  }],
  [luna, {
    species: 'cat', roughPatchAgoStart: null, roughPatchAgoEnd: null, baseMood: 3.7, roughMood: 3.7,
    weight: { start: 8.4, end: 8.6, unit: 'lb' },
    med: { name: 'Revolution Plus (Flea/Heartworm)', interval: 1, unit: 'month' },
    rngSeed: 99,
  }],
]) {
  console.log(`\n${pet.name} (${cfg.species})`);
  const rng = mulberry32(cfg.rngSeed);

  // 1. Medication — real record via the API, so the live Daily tab/Meds tab
  // stay consistent with the historical "given" entries we're about to seed.
  const lastGiven = dateStr(addDays(TODAY, -10));
  const nextDue = dateStr(addDays(TODAY, 20));
  const { meds } = await api(token, 'PUT', `/pets/${pet.id}/meds`, {
    meds: [{ id: randomUUID(), name: cfg.med.name, interval: cfg.med.interval, unit: cfg.med.unit, nextDue, lastGiven, remindersEnabled: true }],
  });
  const medId = meds[0].id;
  console.log(`  ✓ Med: ${cfg.med.name} (next due ${nextDue})`);

  // 2. Checklist + mood history (direct S3 — see file header).
  const history = buildHistory({ species: cfg.species, roughPatchAgoStart: cfg.roughPatchAgoStart, roughPatchAgoEnd: cfg.roughPatchAgoEnd, baseMood: cfg.baseMood, roughMood: cfg.roughMood, rng });
  // Three "given" events roughly a month apart, landing near lastGiven for the most recent.
  for (const agoDays of [80, 50, 10]) {
    const date = dateStr(addDays(TODAY, -agoDays));
    history.checksByDate[date] ??= {};
    history.checksByDate[date][`med:${medId}`] = { by: ACTOR, at: `${date}T09:00:00.000Z` };
  }
  const { live, archiveByMonth } = splitLiveVsArchive(history);

  const petPrefix = `users/${OWNER_SUB}/pets/${pet.id}/`;
  s3PutJson(`${petPrefix}daily.json`, live);
  for (const [month, obj] of Object.entries(archiveByMonth)) {
    s3PutJson(`${petPrefix}daily-archive/${month}.json`, obj);
  }
  console.log(`  ✓ Daily history: ${Object.keys(live.log).length} live day(s) + ${Object.keys(archiveByMonth).length} archive month(s)`);

  // 3. Weight trend — through the real API (historical backfill is allowed here).
  for (const w of weightSeries({ start: cfg.weight.start, end: cfg.weight.end, points: 13, rng })) {
    await api(token, 'POST', `/pets/${pet.id}/weights`, { date: w.date, weight: w.weight, unit: cfg.weight.unit });
  }
  console.log(`  ✓ Weight: ${cfg.weight.start} → ${cfg.weight.end} ${cfg.weight.unit} across 13 entries`);
}

console.log(`\nDone! ~${DAYS_BACK} days of Daily-checklist/mood/weight/med history seeded for Bella + Luna.\n`);
