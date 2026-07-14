/**
 * seed-my-history.mjs — Backfill ~5 months of realistic Daily-checklist
 * history (feedings, mood, care) + weight trend + real walk records onto
 * Mark's own production account (mark.gingrass@gmail.com), for Ollie
 * (dog), Pumpkin (cat), Vasya (cat) — so the Trends page has enough real
 * volume to judge the "On track / Slipping / Off track" gauge copy against.
 *
 * SAFE re: real data: the account is only ~5 days old as of 2026-07-13, so
 * any genuine check-ins/moods/weights land in the last 6 days. This script
 * generates synthetic history ONLY for agoDays 6..149 and always overlays
 * whatever is already live on top before writing — real entries always win,
 * nothing genuine gets clobbered. Custom Daily items (Pumpkin's "Brush")
 * are read back and preserved too.
 *
 * Weights go through the live API (historical dates are explicitly
 * allowed there). Walks do NOT — POST /walks requires startedAt/endedAt
 * within 24h of now (isIsoTimestamp's range check), so historical walks
 * are appended directly to users/{sub}/walks-index.json, same admin/
 * seed-only exception as the daily checklist backfill (which also can't go
 * through the API, for the same anti-forgery reason). Existing real
 * entries in both files are read back and preserved, never overwritten.
 * No meds are touched (none exist yet on this account — skipped entirely
 * so nothing fake generates real reminder emails/pushes).
 *
 * Usage:  MY_PASSWORD='...' node scripts/seed-my-history.mjs
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
const OWNER_SUB = '64686408-0081-70b4-7626-67875aba845a'; // mark.gingrass@gmail.com
const __dirname = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(__dirname, '..', '.env'), 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

const EMAIL = 'mark.gingrass@gmail.com';
const PASSWORD = process.env.MY_PASSWORD;
if (!PASSWORD) {
  console.error('Set MY_PASSWORD (not stored anywhere — pass it fresh each run).');
  process.exit(1);
}
const ACTOR = EMAIL;
const DAYS_BACK = 150; // ~5 months
const REAL_WINDOW_DAYS = 6; // leave the most recent 6 days alone — genuine usage lives there
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

// ── Auth + API ───────────────────────────────────────────────────────────
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

function s3GetJson(key) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'petshots-seed-'));
  const tmpFile = join(tmpDir, 'body.json');
  try {
    execFileSync('aws', ['s3api', 'get-object', '--bucket', BUCKET, '--key', key, tmpFile], { stdio: 'pipe' });
    return JSON.parse(readFileSync(tmpFile, 'utf8'));
  } catch {
    return null; // NoSuchKey — nothing there yet
  }
}
function s3PutJson(key, obj) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'petshots-seed-'));
  const tmpFile = join(tmpDir, 'body.json');
  writeFileSync(tmpFile, JSON.stringify(obj));
  execFileSync('aws', ['s3api', 'put-object', '--bucket', BUCKET, '--key', key, '--body', tmpFile, '--content-type', 'application/json'], { stdio: 'pipe' });
}

// ── per-pet history generator ───────────────────────────────────────────
// presets: item ids to check each day, with a base "shows up" probability.
// roughPatch: a multi-week dip (lower mood + fewer check-ins) so the Trends
// gauge actually swings through Slipping/Off track, not just a flat line.
function buildHistory({ presets, roughPatchAgoStart, roughPatchAgoEnd, baseMood, roughMood, basePresence, roughPresence, rng }) {
  const checksByDate = {};
  const moodsByDate = {};

  for (let agoDays = DAYS_BACK - 1; agoDays >= REAL_WINDOW_DAYS; agoDays--) {
    const date = dateStr(addDays(TODAY, -agoDays));
    const inRoughPatch = roughPatchAgoStart != null && agoDays <= roughPatchAgoStart && agoDays >= roughPatchAgoEnd;
    const presence = inRoughPatch ? roughPresence : basePresence;

    const dayChecks = {};
    for (const item of presets) {
      if (rng() < presence) {
        const hour = item.slot === 'am' ? 7 + Math.floor(rng() * 2) : item.slot === 'pm' ? 18 + Math.floor(rng() * 2) : 12 + Math.floor(rng() * 6);
        const minute = String(Math.floor(rng() * 60)).padStart(2, '0');
        dayChecks[item.id] = { by: ACTOR, at: `${date}T${String(hour).padStart(2, '0')}:${minute}:00.000Z` };
      }
    }
    if (Object.keys(dayChecks).length > 0) checksByDate[date] = dayChecks;

    if (rng() < 0.6) {
      const base = inRoughPatch ? roughMood : baseMood;
      const value = Math.max(1, Math.min(5, Math.round(base + (rng() - 0.5) * 1.6)));
      const minute = String(Math.floor(rng() * 60)).padStart(2, '0');
      moodsByDate[date] = { value, by: ACTOR, at: `${date}T20:${minute}:00.000Z` };
    }
  }
  return { checksByDate, moodsByDate };
}

// Merge synthetic history under whatever is already live — real entries win.
function mergeWithReal(existingLive, synthetic) {
  const log = { ...synthetic.checksByDate, ...(existingLive?.log ?? {}) };
  const moods = { ...synthetic.moodsByDate, ...(existingLive?.moods ?? {}) };
  return { items: existingLive?.items ?? null, log, moods };
}

// Splits a full {items, log, moods} object into the live 14-day window +
// one archive object per month, matching pruneDailyToArchive's exact shape.
function splitLiveVsArchive({ items, log, moods }) {
  const liveCutoff = dateStr(addDays(TODAY, -(LIVE_WINDOW_DAYS - 1)));
  const live = { items, log: {}, moods: {} };
  const archiveByMonth = {};

  const allDates = new Set([...Object.keys(log), ...Object.keys(moods)]);
  for (const date of allDates) {
    const checks = log[date];
    const mood = moods[date];
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

// ── weight series (linear drift + noise) ending a week before the real window ──
function weightSeries({ start, end, points, rng }) {
  const out = [];
  const seriesEndAgo = REAL_WINDOW_DAYS + 3; // stop short of any real entries
  for (let i = 0; i < points; i++) {
    const agoDays = Math.round((DAYS_BACK - 1) - (i / (points - 1)) * ((DAYS_BACK - 1) - seriesEndAgo));
    const date = dateStr(addDays(TODAY, -agoDays));
    const frac = i / (points - 1);
    const weight = Math.round((start + (end - start) * frac + (rng() - 0.5) * 0.4) * 10) / 10;
    out.push({ date, weight });
  }
  return out;
}

// ── walk series (dogs only) — probability of a walk per day + distance ──
function walkSeries({ roughPatchAgoStart, roughPatchAgoEnd, baseProb, roughProb, rng }) {
  const out = [];
  for (let agoDays = DAYS_BACK - 1; agoDays >= REAL_WINDOW_DAYS; agoDays--) {
    const inRoughPatch = roughPatchAgoStart != null && agoDays <= roughPatchAgoStart && agoDays >= roughPatchAgoEnd;
    const prob = inRoughPatch ? roughProb : baseProb;
    if (rng() < prob) {
      const date = addDays(TODAY, -agoDays);
      const hour = 7 + Math.floor(rng() * 11); // 7am-6pm
      const startedAt = new Date(date); startedAt.setUTCHours(hour, Math.floor(rng() * 60), 0, 0);
      const meters = Math.round((800 + rng() * 3200)); // ~0.5 - 2.9 mi
      const durationMin = Math.round(10 + (meters / 80) + rng() * 8);
      const endedAt = new Date(startedAt.getTime() + durationMin * 60000);
      out.push({ startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(), distanceMeters: meters });
    }
  }
  return out;
}

// ── main ─────────────────────────────────────────────────────────────────
console.log(`\nLogging in as ${EMAIL}...`);
const token = await login();
console.log('✓ Authenticated\n');

const { pets } = await api(token, 'GET', '/pets');
const ollie = pets.find((p) => p.name === 'Ollie');
const pumpkin = pets.find((p) => p.name === 'Pumpkin');
const vasya = pets.find((p) => p.name === 'Vasya');
if (!ollie || !pumpkin || !vasya) throw new Error('Expected Ollie, Pumpkin, and Vasya to already exist.');

const PLAN = [
  {
    pet: ollie, label: 'Ollie (dog)', rngSeed: 501,
    presets: [{ id: 'preset-breakfast', slot: 'am' }, { id: 'preset-dinner', slot: 'pm' }],
    roughPatchAgoStart: 55, roughPatchAgoEnd: 41, baseMood: 4.3, roughMood: 2.5,
    basePresence: 0.9, roughPresence: 0.45,
    weight: { start: 81.5, end: 88.0 },
    walk: { roughPatchAgoStart: 55, roughPatchAgoEnd: 41, baseProb: 0.55, roughProb: 0.15 },
  },
  {
    pet: pumpkin, label: 'Pumpkin (cat)', rngSeed: 502,
    presets: [{ id: 'preset-breakfast', slot: 'am' }, { id: 'preset-dinner', slot: 'pm' }, { id: '13ffc97b-3027-472f-83f1-506fd354a1e8', slot: 'any' }],
    roughPatchAgoStart: 95, roughPatchAgoEnd: 82, baseMood: 3.6, roughMood: 2.8,
    basePresence: 0.62, roughPresence: 0.3,
    weight: { start: 5.1, end: 5.4 },
    walk: null,
  },
  {
    pet: vasya, label: 'Vasya (cat)', rngSeed: 503,
    presets: [{ id: 'preset-breakfast', slot: 'am' }, { id: 'preset-dinner', slot: 'pm' }],
    roughPatchAgoStart: 30, roughPatchAgoEnd: 12, baseMood: 3.2, roughMood: 2.2,
    basePresence: 0.45, roughPresence: 0.2,
    weight: { start: 9.0, end: 9.4 }, // no real weight on file yet — reasonable adult-cat estimate
    walk: null,
  },
];

for (const cfg of PLAN) {
  const { pet } = cfg;
  console.log(`\n${cfg.label}`);
  const rng = mulberry32(cfg.rngSeed);

  // 1. Checklist + mood history (direct S3 — see file header), merged under
  // whatever real live data already exists so nothing genuine is lost.
  const synthetic = buildHistory({
    presets: cfg.presets,
    roughPatchAgoStart: cfg.roughPatchAgoStart, roughPatchAgoEnd: cfg.roughPatchAgoEnd,
    baseMood: cfg.baseMood, roughMood: cfg.roughMood,
    basePresence: cfg.basePresence, roughPresence: cfg.roughPresence,
    rng,
  });
  const dailyKey = `users/${OWNER_SUB}/pets/${pet.id}/daily.json`;
  const existingLive = s3GetJson(dailyKey);
  const merged = mergeWithReal(existingLive, synthetic);
  const { live, archiveByMonth } = splitLiveVsArchive(merged);
  s3PutJson(dailyKey, live);
  for (const [month, obj] of Object.entries(archiveByMonth)) {
    s3PutJson(`users/${OWNER_SUB}/pets/${pet.id}/daily-archive/${month}.json`, obj);
  }
  console.log(`  ✓ Daily history: ${Object.keys(live.log).length} live day(s) + ${Object.keys(archiveByMonth).length} archive month(s) (real recent days preserved)`);

  // 2. Weight trend — through the real API, skipping any date that already
  // has a real entry (Ollie has one real point on 2026-07-10).
  const existingWeights = new Set((s3GetJson(`users/${OWNER_SUB}/pets/${pet.id}/weights.json`)?.entries ?? []).map((e) => e.date));
  let added = 0;
  for (const w of weightSeries({ start: cfg.weight.start, end: cfg.weight.end, points: 15, rng })) {
    if (existingWeights.has(w.date)) continue;
    await api(token, 'POST', `/pets/${pet.id}/weights`, { date: w.date, weight: w.weight, unit: 'lb' });
    added++;
  }
  console.log(`  ✓ Weight: ${cfg.weight.start} → ${cfg.weight.end} lb across ${added} new entries`);

  // 3. Walks (dogs only) — appended directly to walks-index.json (POST
  // /walks rejects anything outside a 24h window of "now"), preserving
  // whatever real walks are already indexed.
  if (cfg.walk) {
    const generated = walkSeries({ ...cfg.walk, rng }).map((w) => ({
      id: randomUUID(), petIds: [pet.id], startedAt: w.startedAt, endedAt: w.endedAt, distanceMeters: w.distanceMeters, by: ACTOR,
    }));
    const indexKey = `users/${OWNER_SUB}/walks-index.json`;
    const existingIndex = s3GetJson(indexKey);
    const existingWalks = existingIndex?.walks ?? [];
    s3PutJson(indexKey, { walks: [...existingWalks, ...generated] });
    const totalMeters = generated.reduce((sum, w) => sum + w.distanceMeters, 0);
    console.log(`  ✓ Walks: ${generated.length} new walks, ${(totalMeters / 1609.34).toFixed(1)} miles (${existingWalks.length} real walk(s) preserved)`);
  }
}

console.log(`\nDone! ~${DAYS_BACK} days of history seeded for Ollie, Pumpkin, and Vasya (most recent ${REAL_WINDOW_DAYS} days left untouched).\n`);
