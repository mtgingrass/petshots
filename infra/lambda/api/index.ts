import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import {
  CognitoIdentityProviderClient,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import Stripe from 'stripe';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
// All product-tunable numbers (limits, caps, TTLs, windows) live in one
// documented file — edit values there, not here. Env vars (set from the same
// file by api-stack.ts) still win over the code fallbacks.
import {
  LIMITS_FREE,
  LIMITS_PAID,
  UPLOADS,
  REMINDERS,
  DAILY,
  DIGEST,
  WEIGHTS,
  MEDS,
  FAMILY,
  AI,
  EMAIL,
  ACHIEVEMENTS,
  WALKS,
  SUMMARY,
  REVENUECAT,
} from '../shared/config';
// Window-stats math (archive-merging, tallies, the "we noticed" line) is
// shared with the reminder Lambda's report emails — see that file's header.
import {
  mergedDailyEntries as mergedDailyEntriesShared,
  rangeStats,
  pickInsight,
  overallCompletionPct,
  type RangeStats,
  type MergedEntries,
} from '../shared/dailyStats';
// "Email me this report" (POST /trends/send) reuses the exact same copy the
// proactive monthly report email uses — see shared/copy/digest.ts.
import { monthlyReportCopy, weeklyReportCopy, photoCopy } from '../shared/copy';
// The Summary story pipeline (photo picking, Bedrock call, chips/stats
// shaping) is shared with the reminder Lambda's weekly/monthly story crons —
// one code path means the tone guardrails and the feeding-stays-out-of-the-
// story rule can't drift between the daily and persistent stories.
import {
  pickWindowPhotos,
  fetchImageBlocks,
  generateWindowStory,
  buildChips,
  buildStatsForModel,
  type StoryPetStats,
} from '../shared/summaryStory';
import { escapeHtml, emailHtml, petCardHtml, petRowHtml, insightRowHtml, ctaButtonHtml } from '../shared/emailHtml';
// Real-time push (e.g. "new photo added" to household members) — shared with
// the reminder Lambda's daily/weekly nudges. See that file's header.
import { sendPushes } from '../shared/push';

// One Lambda fronts every route (a tiny router on event.routeKey). Fewer moving
// parts than a function per route, and IAM is identical across them anyway.
//
// requestChecksumCalculation: 'WHEN_REQUIRED' - the AWS SDK now adds a CRC32
// checksum to PutObject by default, which makes presigned PUT URLs require a
// checksum header the browser can't compute at sign time -> S3 returns 403.
// Opting out restores plain SigV4 presigned uploads.
const s3 = new S3Client({
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
const cognito = new CognitoIdentityProviderClient({});
const ses = new SESv2Client({});
const FROM_EMAIL = process.env.FROM_EMAIL ?? EMAIL.FROM_EMAIL;
const BUCKET = process.env.UPLOADS_BUCKET!;
const USER_POOL_ID = process.env.USER_POOL_ID ?? '';
const MAX_PETS = Number(process.env.MAX_PETS ?? LIMITS_FREE.MAX_PETS);
const MAX_DOCS = Number(process.env.MAX_DOCS ?? LIMITS_FREE.MAX_DOCS);
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES ?? UPLOADS.MAX_FILE_BYTES);
const MAX_AVATAR_BYTES = UPLOADS.MAX_AVATAR_BYTES;
const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
// Casual album photos — a daily-per-pet cap (like MAX_AI_SCANS below), not a
// total count-under-prefix cap like docs, so a normal photo session never
// feels throttled. Deliberately not surfaced in the UI until someone hits it.
const MAX_PHOTOS_PER_DAY = Number(process.env.MAX_PHOTOS_PER_DAY ?? LIMITS_FREE.MAX_PHOTOS_PER_DAY);
const PAID_MAX_PHOTOS_PER_DAY = Number(
  process.env.PAID_MAX_PHOTOS_PER_DAY ?? LIMITS_PAID.MAX_PHOTOS_PER_DAY,
);
const MAX_PHOTO_BYTES = Number(process.env.MAX_PHOTO_BYTES ?? UPLOADS.MAX_PHOTO_BYTES);
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// Per-doc metadata lives JSON-encoded in one key segment (no DB, no x-amz-*
// headers). Adding fields later just extends this object; old keys that hold a
// plain label string still decode (fallback below).
interface DocMeta {
  label: string;
  expiry?: string; // YYYY-MM-DD
  given?: string; // YYYY-MM-DD date administered
  remindersEnabled?: boolean; // per-record opt-out; absent/true = remind, false = skip
}
const encodeMeta = (m: DocMeta): string => encodeURIComponent(JSON.stringify(m));
function decodeMeta(seg: string | undefined): DocMeta {
  const raw = decodeURIComponent(seg ?? '');
  try {
    const m = JSON.parse(raw);
    if (m && typeof m === 'object') {
      return {
        label: String(m.label ?? ''),
        expiry: m.expiry ? String(m.expiry) : undefined,
        given: m.given ? String(m.given) : undefined,
        // Legacy keys have no remindersEnabled — treat absence as true (opted in).
        remindersEnabled: m.remindersEnabled !== false,
      };
    }
  } catch {
    /* legacy key: the segment is just the label, no JSON */
  }
  return { label: raw, remindersEnabled: true };
}
// Accept only a strict YYYY-MM-DD date; ignore anything else.
const cleanExpiry = (v: unknown): string | undefined =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;

const isUuid = (v: string | undefined): v is string =>
  !!v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

// Client-generated walk start/end timestamps — a real ISO string, not
// wildly out of range (guards against garbage, not a precise clock check;
// the client's own clock is trusted the same way daily-check dates are).
const isIsoTimestamp = (v: unknown): v is string => {
  if (typeof v !== 'string') return false;
  const t = Date.parse(v);
  return !Number.isNaN(t) && Math.abs(t - Date.now()) < 24 * 3600_000;
};

// ---- walks (see the GET/POST/DELETE /walks + GET /achievements cases) ----
interface WalkRecord {
  id: string;
  petIds: string[];
  startedAt: string; // ISO timestamp
  endedAt: string; // ISO timestamp
  distanceMeters: number;
  // Actor email, server-stamped like DailyCheck.by — feeds the family
  // leaderboard. Walks logged before 2026-07-12 predate attribution and
  // simply don't count toward any member's tally.
  by?: string;
}
// One species-dispatch convention (review finding, 2026-07-12): cats get no
// walk cards/stats anywhere. dailyPresetsFor's separate /dog/i test is a
// different question ("who gets the Walk preset"), not a duplicate of this.
const isCatSpecies = (species?: string) => /cat/i.test(species ?? '');
const METERS_PER_MILE = 1609.344;
const toMiles = (meters: number) => Math.round((meters / METERS_PER_MILE) * 10) / 10;
// Dog energy-burn estimate (WALKS.DOG_KCAL_PER_KG_KM, see config.ts):
// kcal ≈ factor × latest-logged-weight(kg) × distance(km). null when the pet
// has no weight log — an estimate from a made-up weight would be worse than
// none. Rendered with "≈" everywhere.
const LB_PER_KG = 2.204623;
function latestWeightKg(entries: { date: string; weight: number; unit: 'lb' | 'kg' }[] | undefined): number | null {
  if (!entries?.length) return null;
  const latest = entries.reduce((a, b) => (a.date > b.date ? a : b));
  return latest.unit === 'kg' ? latest.weight : latest.weight / LB_PER_KG;
}
function dogKcal(weightKg: number | null, distanceMeters: number): number | null {
  if (weightKg === null || distanceMeters <= 0) return null;
  return Math.round(WALKS.DOG_KCAL_PER_KG_KM * weightKg * (distanceMeters / 1000));
}
// All of a pool's walks live in ONE compact users/{poolSub}/walks-index.json
// (records are ~120 bytes; years of daily walks stay well under 1 MB) instead
// of one object per walk — the original per-object layout meant one S3
// GetObject PER WALK on every walks/achievements view, unbounded as history
// grows (hardening pass, 2026-07-12). Legacy per-walk objects under
// users/{poolSub}/walks/ are folded in lazily the first time the index is
// read, then left in place (deletes remove both copies so a re-backfill can
// never resurrect a deleted walk).
async function readWalksIndex(poolSub: string): Promise<WalkRecord[]> {
  const key = `users/${poolSub}/walks-index.json`;
  const stored = await readJson<{ walks: WalkRecord[] }>(key);
  if (stored) return stored.walks;
  const list = await s3.send(
    new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `users/${poolSub}/walks/` }),
  );
  const legacy = (
    await Promise.all((list.Contents ?? []).map((it) => readJson<WalkRecord>(it.Key!)))
  ).filter((w): w is WalkRecord => w !== null);
  await putJson(key, { walks: legacy });
  return legacy;
}
// Read-modify-write under an ETag guard — two family phones can save walks
// at the same moment (same pattern as daily.json / household.json).
async function mutateWalksIndex(
  poolSub: string,
  fn: (walks: WalkRecord[]) => WalkRecord[],
): Promise<boolean> {
  const key = `users/${poolSub}/walks-index.json`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { value, etag } = await readJsonTagged<{ walks: WalkRecord[] }>(key);
    // Missing index: run the lazy backfill first so a mutation never races
    // the legacy fold-in and drops history.
    if (value === null) {
      await readWalksIndex(poolSub);
      continue;
    }
    if (await putJsonGuarded(key, { walks: fn(value.walks) }, etag)) return true;
  }
  return false;
}

// ---- achievement badges (see the GET /achievements case) ----
// Each stat card carries a ladder of locked/unlocked badges. Earned badges
// persist in the pet's badges.json and NEVER un-earn (deleting a walk drops
// the card's number but keeps the trophy) — so week-shaped conditions are
// evaluated against the best calendar week (Mon-Sun) in full history, not
// just the card's rolling 7-day window, and a raised threshold only affects
// future earns. Thresholds live in shared/config.ts (ACHIEVEMENTS); the
// catalog (ids, icons, copy) lives here because only this route serves it.
interface BadgeDef {
  id: string;
  icon: string;
  name: string;
  /** The goal, phrased as something still to do. Shown on locked badges. */
  description: string;
  /** Celebration line shown once earned (frontend prefixes the 🎉). */
  congrats: string;
}
interface PetBadgeStats {
  totalWalks: number;
  totalMiles: number;
  maxWalksInWeek: number;
  maxWalkDaysInWeek: number;
  longestWalkWeekStreak: number;
  totalPhotos: number;
  maxPhotoDaysInWeek: number;
  hasWeekendPhotoPair: boolean; // photos on both Sat AND Sun of one weekend
  hasBirthdayPhoto: boolean; // a photo dated the pet's dob month-day (false when no dob)
  photoMonths: number; // distinct calendar months with >= 1 photo
}
interface BadgesFile {
  earned: Record<string, { earnedAt: string }>; // badgeId -> local YYYY-MM-DD
}
const badgeCatalog: Record<string, { def: BadgeDef; done: (s: PetBadgeStats) => boolean }[]> = {
  'walks-week': [
    {
      def: { id: 'walk-first', icon: '🐾', name: 'First Steps', description: 'Log your first walk.', congrats: 'You logged your first walk!' },
      done: (s) => s.totalWalks >= 1,
    },
    {
      def: { id: 'walk-week-count', icon: '🎩', name: 'Hat Trick', description: `Walk ${ACHIEVEMENTS.WALKS_IN_WEEK} times in one week.`, congrats: `You walked ${ACHIEVEMENTS.WALKS_IN_WEEK} times in one week!` },
      done: (s) => s.maxWalksInWeek >= ACHIEVEMENTS.WALKS_IN_WEEK,
    },
    {
      def: { id: 'walk-week-days', icon: '🌟', name: 'Seven for Seven', description: 'Walk every day of a week.', congrats: 'You walked all 7 days this week!' },
      done: (s) => s.maxWalkDaysInWeek >= ACHIEVEMENTS.WALK_DAYS_IN_WEEK,
    },
    {
      def: { id: 'walk-week-streak', icon: '🔥', name: 'Three-Week Streak', description: `Walk at least once a week, ${ACHIEVEMENTS.WALK_WEEK_STREAK} weeks in a row.`, congrats: `You've walked ${ACHIEVEMENTS.WALK_WEEK_STREAK} weeks in a row!` },
      done: (s) => s.longestWalkWeekStreak >= ACHIEVEMENTS.WALK_WEEK_STREAK,
    },
  ],
  'distance-week': [
    {
      def: { id: 'miles-first', icon: '🥇', name: 'First Mile', description: 'Walk your first mile, all-time.', congrats: 'You walked your first mile!' },
      done: (s) => s.totalMiles >= ACHIEVEMENTS.MILES_FIRST,
    },
    {
      def: { id: 'miles-club', icon: '🏅', name: '10-Mile Club', description: `Walk ${ACHIEVEMENTS.MILES_CLUB} miles, all-time.`, congrats: `${ACHIEVEMENTS.MILES_CLUB} miles walked together!` },
      done: (s) => s.totalMiles >= ACHIEVEMENTS.MILES_CLUB,
    },
    {
      def: { id: 'miles-marathon', icon: '🏆', name: 'Marathon', description: `Walk ${ACHIEVEMENTS.MILES_MARATHON} miles, all-time.`, congrats: `A full marathon — ${ACHIEVEMENTS.MILES_MARATHON} miles walked!` },
      done: (s) => s.totalMiles >= ACHIEVEMENTS.MILES_MARATHON,
    },
    {
      def: { id: 'miles-century', icon: '💯', name: 'Century Club', description: `Walk ${ACHIEVEMENTS.MILES_CENTURY} miles, all-time.`, congrats: `${ACHIEVEMENTS.MILES_CENTURY} miles walked — century club!` },
      done: (s) => s.totalMiles >= ACHIEVEMENTS.MILES_CENTURY,
    },
    {
      def: { id: 'miles-250', icon: '🧭', name: 'Trailblazer', description: `Walk ${ACHIEVEMENTS.MILES_250} miles, all-time.`, congrats: `${ACHIEVEMENTS.MILES_250} miles — a real trailblazer!` },
      done: (s) => s.totalMiles >= ACHIEVEMENTS.MILES_250,
    },
    {
      def: { id: 'miles-500', icon: '💪', name: 'Iron Paws', description: `Walk ${ACHIEVEMENTS.MILES_500} miles, all-time.`, congrats: `${ACHIEVEMENTS.MILES_500} miles of iron-paw dedication!` },
      done: (s) => s.totalMiles >= ACHIEVEMENTS.MILES_500,
    },
    {
      def: { id: 'miles-1000', icon: '🌍', name: 'World Walker', description: `Walk ${ACHIEVEMENTS.MILES_1000} miles, all-time.`, congrats: `${ACHIEVEMENTS.MILES_1000} miles walked — world walker!` },
      done: (s) => s.totalMiles >= ACHIEVEMENTS.MILES_1000,
    },
  ],
  'photo-days-week': [
    {
      def: { id: 'photo-first', icon: '🖼️', name: 'First Portrait', description: 'Save your first photo.', congrats: 'You saved your first photo!' },
      done: (s) => s.totalPhotos >= 1,
    },
    {
      def: { id: 'photo-week-days', icon: '🎬', name: 'Camera Ready', description: `Take photos on ${ACHIEVEMENTS.PHOTO_DAYS_IN_WEEK} different days in one week.`, congrats: `Photos on ${ACHIEVEMENTS.PHOTO_DAYS_IN_WEEK} different days this week!` },
      done: (s) => s.maxPhotoDaysInWeek >= ACHIEVEMENTS.PHOTO_DAYS_IN_WEEK,
    },
    {
      def: { id: 'photo-week-perfect', icon: '✨', name: 'Paparazzi Week', description: 'Take a photo every day for a week.', congrats: 'A photo every single day this week!' },
      done: (s) => s.maxPhotoDaysInWeek >= ACHIEVEMENTS.PHOTO_DAYS_PERFECT_WEEK,
    },
    // Creative badges (2026-07-13, replacing Shutterbug's stored-photo
    // count): each needs at most one photo per qualifying day/month, so
    // none of them pays the user to hoard storage. UTC day boundaries.
    {
      def: { id: 'photo-weekend', icon: '🎞️', name: 'Weekend Shooter', description: 'Save a photo on both Saturday and Sunday of one weekend.', congrats: 'A full weekend behind the camera!' },
      done: (s) => s.hasWeekendPhotoPair,
    },
    {
      def: { id: 'photo-birthday', icon: '🎂', name: 'Birthday Portrait', description: 'Save a photo on their birthday.', congrats: 'A birthday captured forever!' },
      done: (s) => s.hasBirthdayPhoto,
    },
    {
      def: { id: 'photo-seasons', icon: '🍂', name: 'Through the Seasons', description: `Save photos in ${ACHIEVEMENTS.PHOTO_SEASONS_MONTHS} different months.`, congrats: `Photos across ${ACHIEVEMENTS.PHOTO_SEASONS_MONTHS} months — through the seasons!` },
      done: (s) => s.photoMonths >= ACHIEVEMENTS.PHOTO_SEASONS_MONTHS,
    },
  ],
};

// Monday of the calendar week containing `ymd` — badge conditions group
// walks/photos by these keys.
function weekStartOf(ymd: string): string {
  const back = (new Date(`${ymd}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addToDay(ymd, { days: -back });
}
// Given per-day event dates, the best calendar week by count and by distinct
// days, plus the longest run of consecutive weeks with >= 1 event.
function weeklyBests(dates: string[]): { maxCount: number; maxDays: number; longestStreak: number } {
  const weeks = new Map<string, { count: number; days: Set<string> }>();
  for (const d of dates) {
    const ws = weekStartOf(d);
    const w = weeks.get(ws) ?? { count: 0, days: new Set<string>() };
    w.count++;
    w.days.add(d);
    weeks.set(ws, w);
  }
  let maxCount = 0;
  let maxDays = 0;
  for (const w of weeks.values()) {
    maxCount = Math.max(maxCount, w.count);
    maxDays = Math.max(maxDays, w.days.size);
  }
  let longestStreak = 0;
  let run = 0;
  let prev: string | null = null;
  for (const ws of [...weeks.keys()].sort()) {
    run = prev !== null && addToDay(prev, { days: 7 }) === ws ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
    prev = ws;
  }
  return { maxCount, maxDays, longestStreak };
}

// ---- medications ----
// Per-pet medication list stored whole in meds.json (same no-DB pattern as
// pet.json). The reminder Lambda reads this nightly, so a med that passes
// validation here must always be schedulable there — reject the whole PUT on
// any bad entry rather than storing a partially-valid list.
interface Med {
  id: string;
  name: string;
  interval: number; // paired with unit: "every {interval} {unit}s"
  unit: 'day' | 'week' | 'month';
  nextDue: string; // YYYY-MM-DD
  remindersEnabled: boolean;
  lastGiven?: string; // YYYY-MM-DD
  // "Stop tracking": the med stays on record but banners, overview status, the
  // public passport, and reminder email all skip it. Distinct from muting
  // reminders — a dismissed med is no longer considered due at all.
  dismissed?: boolean;
  // Server-stamped (ISO) when an id first appears in a PUT; never trusted from
  // the client. Lets the reminder Lambda fire a one-time nag for a med added
  // already-overdue (the doc side uses S3 LastModified; meds.json is one
  // whole-list file, so per-med stamps are the only usable signal). Legacy
  // meds stored before this field stay unstamped — they never spuriously nag.
  createdAt?: string;
}
const MAX_MEDS = Number(process.env.MAX_MEDS ?? LIMITS_FREE.MAX_MEDS);
const MED_UNIT_MAX: Record<Med['unit'], number> = MEDS.UNIT_MAX;

// Strict calendar date: correct shape AND a real day. Round-trip through Date
// components — V8 string parsing silently rolls Feb 30 over to Mar 2, so a
// NaN check alone is not enough.
function isStrictDay(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function cleanMeds(
  input: unknown,
  maxMeds: number,
  storedMeds: Med[] = [],
): { meds: Med[] } | { error: string } {
  if (!Array.isArray(input)) return { error: 'meds must be an array' };
  if (input.length > maxMeds) return { error: `limit of ${maxMeds} medications per pet` };
  const storedById = new Map(storedMeds.map((m) => [m.id, m]));
  const seenIds = new Set<string>();
  const meds: Med[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') return { error: 'each medication must be an object' };
    const m = raw as Record<string, unknown>;
    const name = String(m.name ?? '').trim().slice(0, 100);
    if (!name) return { error: 'medication name required' };
    const unit = m.unit === 'day' || m.unit === 'week' || m.unit === 'month' ? m.unit : null;
    if (!unit) return { error: 'unit must be day, week, or month' };
    if (
      typeof m.interval !== 'number' ||
      !Number.isInteger(m.interval) ||
      m.interval < 1 ||
      m.interval > MED_UNIT_MAX[unit]
    ) {
      return { error: `interval must be a whole number between 1 and ${MED_UNIT_MAX[unit]} ${unit}s` };
    }
    if (!isStrictDay(m.nextDue)) return { error: 'nextDue must be a valid YYYY-MM-DD date' };
    if (m.lastGiven !== undefined && !isStrictDay(m.lastGiven)) {
      return { error: 'lastGiven must be a valid YYYY-MM-DD date' };
    }
    // Client supplies ids so unsaved UI state can key rows; regenerate anything
    // malformed or duplicated instead of trusting it.
    const id = isUuid(typeof m.id === 'string' ? m.id : undefined) && !seenIds.has(m.id as string)
      ? (m.id as string)
      : randomUUID();
    seenIds.add(id);
    meds.push({
      id,
      name,
      interval: m.interval,
      unit,
      nextDue: m.nextDue,
      remindersEnabled: m.remindersEnabled !== false,
      lastGiven: m.lastGiven as string | undefined,
      dismissed: m.dismissed === true ? true : undefined,
      // Known id keeps its stored stamp (even undefined, for legacy meds);
      // a new id is stamped now. Client-sent values are never trusted.
      createdAt: storedById.has(id) ? storedById.get(id)!.createdAt : new Date().toISOString(),
    });
  }
  return { meds };
}

const str = (v: unknown, max: number) => String(v ?? '').slice(0, max) || undefined;
const cleanPet = (input: Record<string, unknown>) => ({
  name:              String(input.name ?? '').slice(0, 100),
  species:           String(input.species ?? '').slice(0, 50),
  breed:             str(input.breed, 100),
  dob:               str(input.dob, 10),      // YYYY-MM-DD
  weight:            str(input.weight, 50),
  allergies:         str(input.allergies, 500),
  behavior:          str(input.behavior, 500),
  vetName:           str(input.vetName, 150),
  vetPhone:          str(input.vetPhone, 50),
  emergencyContact:  str(input.emergencyContact, 200),
  microchip:         str(input.microchip, 50),
  fixed:             input.fixed === true ? true : undefined,
  notes:             str(input.notes, 1000),
  // Memorial state (2026-07-13): a passed pet stays fully viewable
  // (records/photos/passport) but is excluded from stories, reminders,
  // digests, achievements, Daily, and walk pickers — see the isMemorial
  // filters at each of those sites.
  memorial:          input.memorial === true ? true : undefined,
  passedOn:          str(input.passedOn, 10), // YYYY-MM-DD, optional
});

async function readJson<T>(key: string): Promise<T | null> {
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return JSON.parse(await obj.Body!.transformToString()) as T;
  } catch (e) {
    if ((e as { name?: string }).name === 'NoSuchKey') return null;
    throw e;
  }
}

// Optimistic-concurrency pair for objects that several people update at once
// (the daily checklist): read captures the ETag, the guarded put only lands
// if the object hasn't changed since (S3 conditional writes). A false return
// means someone else wrote in between — re-read and re-apply.
async function readJsonTagged<T>(key: string): Promise<{ value: T | null; etag: string | null }> {
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return {
      value: JSON.parse(await obj.Body!.transformToString()) as T,
      etag: obj.ETag ?? null,
    };
  } catch (e) {
    if ((e as { name?: string }).name === 'NoSuchKey') return { value: null, etag: null };
    throw e;
  }
}
async function putJsonGuarded(key: string, body: unknown, etag: string | null): Promise<boolean> {
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: JSON.stringify(body),
        ContentType: 'application/json',
        ...(etag ? { IfMatch: etag } : { IfNoneMatch: '*' }),
      }),
    );
    return true;
  } catch (e) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (
      err.name === 'PreconditionFailed' ||
      err.name === 'ConditionalRequestConflict' ||
      err.$metadata?.httpStatusCode === 412 ||
      err.$metadata?.httpStatusCode === 409
    ) {
      return false;
    }
    throw e;
  }
}

// ---- plans / entitlements ----
// Free-tier limits come from the env; a paid user has users/{sub}/plan.json,
// written only by billing tooling or an operator — never by any user-writable
// route — so a user can't grant themselves the paid tier. plan.json may carry
// per-user limit overrides (comped accounts, support bumps).
//
// Limits gate CREATION only. A user over their limit (downgrade, cap change)
// keeps everything and can view/edit/delete freely; they just can't add more.
interface Limits {
  maxPets: number;
  maxDocs: number;
  maxMeds: number;
  maxMembers: number; // family members (besides the owner) this plan allows
  dailyHistoryDays: number; // how far back the Daily tab can browse
}
// billingSource distinguishes a Stripe (web) subscriber from a RevenueCat
// (App Store/iOS) one, so the Settings billing card on native can tell them
// apart — a web subscriber who later installs the app still gets "managed
// on the web" instead of an App Store deep link. Defaults to 'stripe' for
// paid accounts written before this field existed.
type BillingSource = 'stripe' | 'revenuecat';
type Entitlements = Limits & { plan: 'free' | 'paid'; billingSource?: BillingSource };
const PLAN_LIMITS: Record<Entitlements['plan'], Limits> = {
  free: {
    maxPets: MAX_PETS,
    maxDocs: MAX_DOCS,
    maxMeds: MAX_MEDS,
    maxMembers: Number(process.env.MAX_MEMBERS ?? LIMITS_FREE.MAX_MEMBERS),
    dailyHistoryDays: DAILY.HISTORY_DAYS_FREE,
  },
  paid: {
    maxPets: Number(process.env.PAID_MAX_PETS ?? LIMITS_PAID.MAX_PETS),
    maxDocs: Number(process.env.PAID_MAX_DOCS ?? LIMITS_PAID.MAX_DOCS),
    maxMeds: Number(process.env.PAID_MAX_MEDS ?? LIMITS_PAID.MAX_MEDS),
    maxMembers: Number(process.env.PAID_MAX_MEMBERS ?? LIMITS_PAID.MAX_MEMBERS),
    dailyHistoryDays: DAILY.HISTORY_DAYS_PAID,
  },
};
const posInt = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : fallback;
async function getEntitlements(sub: string): Promise<Entitlements> {
  const file = await readJson<{
    plan?: string;
    limits?: Partial<Limits>;
    billingSource?: BillingSource;
  }>(`users/${sub}/plan.json`);
  const plan = file?.plan === 'paid' ? 'paid' : 'free';
  const base = PLAN_LIMITS[plan];
  return {
    plan,
    ...(plan === 'paid' ? { billingSource: file?.billingSource ?? 'stripe' } : {}),
    maxPets: posInt(file?.limits?.maxPets, base.maxPets),
    maxDocs: posInt(file?.limits?.maxDocs, base.maxDocs),
    maxMeds: posInt(file?.limits?.maxMeds, base.maxMeds),
    maxMembers: posInt(file?.limits?.maxMembers, base.maxMembers),
    dailyHistoryDays: posInt(file?.limits?.dailyHistoryDays, base.dailyHistoryDays),
  };
}

// ---- family / household ----
// One owner account holds the shared pets; members get access through an
// indirection pair (same pattern as passports — a small pointer object, no
// data moves). users/{owner}/household.json lists members + pending invites;
// each member carries users/{member}/memberOf.json pointing back. A member
// belongs to at most ONE household, and a user with members of their own
// can't also join one (no chains). Invite tokens live at the bucket root
// (invites/{token}.json) so the join route can resolve them without knowing
// the owner.
//
// Pets stay physically under the owner's prefix, so the OWNER's plan governs
// the shared pool (docs/meds caps, AI scan budget, active-pets ranking) no
// matter who's acting. Members keep any pets of their own under their own
// prefix with their own plan — the two pools never mix.
interface HouseholdMember {
  sub: string;
  email: string;
  joinedAt: string;
}
interface HouseholdInvite {
  token: string;
  createdAt: string;
  expiresAt: string;
  sentTo?: string; // set when the invite was emailed rather than link-shared
}
interface HouseholdFile {
  members: HouseholdMember[];
  invites: HouseholdInvite[];
}
interface MemberOf {
  ownerSub: string;
  ownerEmail: string;
  joinedAt: string;
}
const INVITE_TTL_MS = FAMILY.INVITE_TTL_MS;
const MEMBER_FORBIDDEN_ERROR =
  'Only the family owner can do that.';
// Destructive-container actions members can never take on household pets.
const MEMBER_BLOCKED_ROUTES = new Set([
  'DELETE /pets/{petId}',
  'POST /pets/{petId}/passport',
  'DELETE /pets/{petId}/passport',
]);

function normalizeHousehold(h: Partial<HouseholdFile> | null): HouseholdFile {
  return {
    members: Array.isArray(h?.members) ? h.members : [],
    invites: Array.isArray(h?.invites) ? h.invites : [],
  };
}
async function readHousehold(sub: string): Promise<HouseholdFile> {
  return normalizeHousehold(await readJson<Partial<HouseholdFile>>(`users/${sub}/household.json`));
}

// household.json is written from several flows that can race across family
// devices (invite, join, remove, leave, account deletion) — same ETag-guarded
// read-mutate-write as daily.json. `mutate` returns null to abort untouched.
async function updateHousehold<T>(
  ownerSub: string,
  mutate: (h: HouseholdFile) => { result: T } | null,
): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    const { value, etag } = await readJsonTagged<Partial<HouseholdFile>>(
      `users/${ownerSub}/household.json`,
    );
    const h = normalizeHousehold(value ?? null);
    const out = mutate(h);
    if (out === null) return null;
    if (await putJsonGuarded(`users/${ownerSub}/household.json`, h, etag)) return out.result;
    if (attempt >= 3) throw new Error('household write contention');
  }
}

// Daily cap on emailed invites: the invite CREATE is already seat-capped, but
// create→revoke→create would otherwise loop unlimited SES sends to arbitrary
// addresses from any account.
const MAX_INVITE_EMAILS_PER_DAY = Number(
  process.env.MAX_INVITE_EMAILS ?? FAMILY.MAX_INVITE_EMAILS_PER_DAY,
);
async function bumpInviteEmailQuota(sub: string): Promise<boolean> {
  const key = `users/${sub}/invite-emails.json`;
  const today = new Date().toISOString().slice(0, 10);
  const usage = await readJson<{ date?: string; count?: number }>(key);
  const count = usage?.date === today ? Math.max(0, Number(usage.count) || 0) : 0;
  if (count >= MAX_INVITE_EMAILS_PER_DAY) return false;
  await putJson(key, { date: today, count: count + 1 });
  return true;
}
const readMemberOf = (sub: string) => readJson<MemberOf>(`users/${sub}/memberOf.json`);

// Display email for a sub. The access token the client sends carries no email
// claim, so member emails come from Cognito at invite/join time.
async function getUserEmail(sub: string): Promise<string> {
  const res = await cognito.send(
    new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: sub }),
  );
  return res.UserAttributes?.find((a) => a.Name === 'email')?.Value ?? '';
}

// Cache sub→email per container: daily check-offs stamp the actor on every
// toggle and shouldn't pay a Cognito round-trip each time.
const emailCache = new Map<string, string>();
async function actorEmail(sub: string): Promise<string> {
  const hit = emailCache.get(sub);
  if (hit) return hit;
  const email = await getUserEmail(sub);
  emailCache.set(sub, email);
  return email;
}

// ---- daily care checklist ----
// Per-pet shared to-do for the day (Breakfast, Dinner, walks, plus every med
// due today). Lives in daily.json under the pet, so family members see and
// check the same list; each check-off is stamped server-side with WHO did it
// (the verified JWT's user — unforgeable) and when. Log is keyed by the
// CLIENT's local date: feeding days are local days, and a UTC key would reset
// the list at 8pm Eastern.
interface DailyItem {
  id: string;
  name: string;
  // 'counter' rows tally repeatable events (poops, walks) instead of a
  // single check-off; each increment is logged with who + when.
  kind?: 'check' | 'counter';
  // Effective-dating (local YYYY-MM-DD, stamped by PUT items): history must
  // keep showing what the list looked like THAT day. A deleted item is never
  // dropped from the array — it gets removedOn and disappears from that day
  // forward; a new item gets addedOn so it doesn't retro-appear in the past.
  // Missing fields = existed forever (presets, pre-tombstone lists).
  addedOn?: string;
  removedOn?: string;
}

// Is this item on the list as of `date`? Visible from addedOn (inclusive)
// until removedOn (exclusive — "removed that day and going forward").
function itemVisibleOn(i: DailyItem, date: string): boolean {
  return (!i.addedOn || i.addedOn <= date) && (!i.removedOn || date < i.removedOn);
}
interface DailyCheck {
  by: string; // actor email, server-stamped (counters: the LAST increment)
  at: string; // ISO timestamp
  // Med check-offs advance the med schedule; the prior state rides along so
  // unchecking can restore it exactly.
  prev?: { lastGiven?: string; nextDue: string };
  // Counter rows only: running total + every increment (report material).
  count?: number;
  events?: { by: string; at: string }[];
}
// One mood reading per pet per day ("how does your pet feel and act today"),
// 1 (rough) … 5 (great). First press wins and is attributed; pressing a
// DIFFERENT value overrides and re-attributes; re-pressing the same value
// never steals the original attribution.
interface DailyMood {
  value: number; // 1..5
  by: string;
  at: string;
}
interface DailyFile {
  items: DailyItem[] | null; // null = never customized; presets apply
  log: Record<string, Record<string, DailyCheck>>; // date -> itemId -> check
  moods?: Record<string, DailyMood>; // date -> mood
}
// Species-aware defaults (they apply only until the user customizes the
// list): dogs get walks; anything else starts with just meals. Counter items
// (the old 💩 preset) were removed from the product in s26 — the check/count
// API semantics remain for lists that still carry stored counter items.
function dailyPresetsFor(species: string | undefined): DailyItem[] {
  const meals: DailyItem[] = [
    { id: 'preset-breakfast', name: 'Breakfast' },
    { id: 'preset-dinner', name: 'Dinner' },
  ];
  if (/dog/i.test(species ?? '')) {
    return [...meals, { id: 'preset-walk', name: 'Walk' }];
  }
  return meals;
}
// Feeding items get special handling in two places: the Summary story never
// narrates them (GET /summary withholds them from the model — a stat, not
// story material), and the Daily tab offers to drop them after prolonged
// disuse (GET daily's feedingIdle hint). Matches the presets plus custom
// items with meal-ish names.
const isFeedingDailyItem = (id: string, name: string) =>
  id === 'preset-breakfast' ||
  id === 'preset-dinner' ||
  /\b(breakfast|lunch|dinner|meal|feed(ing)?)\b/i.test(name);
// ---- Trends tab (GET /trends) ----
// Window-stats computation (archive-merging, tallies, the "we noticed"
// picker) lives in shared/dailyStats.ts — the reminder Lambda's new monthly
// report email needs the exact same logic, and a third independent copy was
// judged too likely to drift (see that file's header for the bug that
// motivated the extraction).
const mergedDailyEntries = (petPrefix: string, daily: DailyFile | null, dates: string[], todayKey: string) =>
  mergedDailyEntriesShared(BUCKET, petPrefix, daily, dates, todayKey, DAILY_LOG_RETENTION_DAYS, addToDay);

// One pet's stats for ONE view+offset — week (every plan) or month (paid
// only), swipeable back in time (offset 0 = most recent window, offset N =
// N windows further back, non-overlapping). Reused by both GET /trends (the
// Trends tab) and POST /trends/send ("email me this report") so they never
// drift apart. Overloaded purely for call-site typing — week and month
// pets have different shapes (count/total vs pctThis/pctLast, insight vs
// headline) and callers already know which one they asked for.
interface TrendsWeekPet {
  petId: string; name: string;
  careConsistency: number;
  moodAvg: number | null;
  checklist: { id: string; label: string; count: number; total: number }[];
  medsGiven: number;
  weight: { value: number; unit: string; deltaWeek: number | null } | null;
  // null for cats (no walk features), matching the achievements cards.
  // kcal: dog energy estimate for the window; null when no weight is logged.
  walks: { count: number; miles: number; kcal: number | null } | null;
  insight: string | null;
  moodSeries: { date: string; value: number | null }[];
  weightSeries: { date: string; value: number | null }[];
  weightUnit: string | null;
  checklistSeries: { id: string; label: string; days: boolean[] }[];
}
interface TrendsMonthPet {
  petId: string; name: string;
  headline: string | null;
  careConsistency: number;
  moodAvg: number | null;
  moodAvgLastMonth: number | null;
  medsGiven: number;
  medsGivenLastMonth: number;
  weight: { value: number; unit: string; deltaMonth: number | null } | null;
  walks: { count: number; miles: number; kcal: number | null; countLast: number; milesLast: number } | null;
  checklist: { id: string; label: string; pctThis: number; pctLast: number }[];
  moodSeries: { date: string; value: number | null }[];
  weightSeries: { date: string; value: number | null }[];
  weightUnit: string | null;
  checklistSeries: { id: string; label: string; days: boolean[] }[];
}
async function computeTrendsView(
  poolPrefix: string, view: 'week', offset: number,
): Promise<{ pets: TrendsWeekPet[]; rangeStart: string; rangeEnd: string }>;
async function computeTrendsView(
  poolPrefix: string, view: 'month', offset: number,
): Promise<{ pets: TrendsMonthPet[]; rangeStart: string; rangeEnd: string }>;
async function computeTrendsView(
  poolPrefix: string,
  view: 'week' | 'month',
  offset: number,
): Promise<{ pets: (TrendsWeekPet | TrendsMonthPet)[]; rangeStart: string; rangeEnd: string }> {
  // Pool walks are read ONCE per view (they're account-level, shared across
  // every pet in the window) — the per-pet loop only filters them.
  const trendsPoolSub = poolPrefix.slice('users/'.length, -'/pets/'.length);
  const [list, poolWalks] = await Promise.all([
    s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: poolPrefix })),
    readWalksIndex(trendsPoolSub),
  ]);
  const trendsPetIds = (list.Contents ?? [])
    .filter((it) => it.Key!.endsWith('/pet.json'))
    .map((it) => it.Key!.slice(poolPrefix.length).split('/')[0]);

  const todayKey = new Date().toISOString().slice(0, 10);
  const windowLen = view === 'week' ? DIGEST.LOOKBACK_DAYS : 30;
  // offset 0 = today back (windowLen-1) days; offset N = the Nth window back,
  // non-overlapping with offset 0 — "swipe back" one window per step.
  const rangeDates = (o: number) =>
    Array.from({ length: windowLen }, (_, i) => addToDay(todayKey, { days: -(o * windowLen + windowLen - 1 - i) }));
  const thisDates = rangeDates(offset);
  // Month's "vs last month" comparison always looks at the window immediately
  // before the one being viewed, regardless of offset.
  const priorDates = rangeDates(offset + 1);

  const pets = (
    await Promise.all(
      trendsPetIds.map(async (petId) => {
        const petPrefix = `${poolPrefix}${petId}/`;
        const [pet, daily, weightsStored] = await Promise.all([
          readJson<{ name?: string; species?: string; memorial?: boolean }>(`${petPrefix}pet.json`),
          readJson<DailyFile>(`${petPrefix}daily.json`),
          readJson<{ entries: WeightEntry[] }>(`${petPrefix}weights.json`),
        ]);
        if (!pet?.name) return null;
        // Memorial pets are excluded from every stats/story surface this
        // feeds (Summary, trends routes, report emails) — records stay
        // viewable, but nothing narrates or nudges about them.
        if (pet.memorial) return null;
        const petName = pet.name;
        const weights = weightsStored?.entries ?? [];
        const activeItems = (daily?.items ?? dailyPresetsFor(pet.species)).filter((i) =>
          itemVisibleOn(i, todayKey),
        );
        const itemLabel = (id: string) => activeItems.find((i) => i.id === id)?.name ?? id;

        const seriesFor = (entries: MergedEntries, dates: string[], weightUnit: string | null) => ({
          moodSeries: dates.map((d) => ({ date: d, value: entries[d]?.mood?.value ?? null })),
          weightSeries: dates.map((d) => ({ date: d, value: weights.find((w) => w.date === d)?.weight ?? null })),
          weightUnit,
          checklistSeries: activeItems.map((i) => ({
            id: i.id,
            label: i.name,
            days: dates.map((d) => Boolean(entries[d]?.checks?.[i.id])),
          })),
        });
        const weightUnit = weights[0]?.unit ?? null;

        // Month view needs the prior window too — start both merges together
        // instead of paying the archive round-trips twice in sequence.
        const priorEntriesPromise =
          view === 'month' ? mergedDailyEntries(petPrefix, daily, priorDates, todayKey) : null;
        const thisEntries = await mergedDailyEntries(petPrefix, daily, thisDates, todayKey);
        const thisStats = rangeStats(thisEntries, thisDates, weights);

        // Walk tallies for a window: this pet's walks whose start date falls
        // inside it. Cats get null (no walk features), same as achievements.
        const petKgForWalks = latestWeightKg(weights);
        const walksIn = (dates: string[]) => {
          const inWindow = poolWalks.filter(
            (w) =>
              w.petIds.includes(petId) &&
              w.startedAt.slice(0, 10) >= dates[0] &&
              w.startedAt.slice(0, 10) <= dates[dates.length - 1],
          );
          const meters = inWindow.reduce((sum, w) => sum + w.distanceMeters, 0);
          return {
            count: inWindow.length,
            miles: toMiles(meters),
            kcal: dogKcal(petKgForWalks, meters),
          };
        };
        const petIsCat = isCatSpecies(pet.species);

        if (view === 'week') {
          const weekPet: TrendsWeekPet = {
            petId, name: petName,
            careConsistency: overallCompletionPct(thisStats, activeItems.map((i) => i.id)),
            moodAvg: thisStats.moodAvg,
            checklist: activeItems.map((i) => ({
              id: i.id, label: i.name,
              count: thisStats.checkCountsByItemId.get(i.id) ?? 0,
              total: thisStats.totalDays,
            })),
            medsGiven: thisStats.medsGiven,
            weight: thisStats.weightLatest && {
              value: thisStats.weightLatest.weight,
              unit: thisStats.weightLatest.unit,
              deltaWeek:
                thisStats.weightFirst &&
                thisStats.weightFirst.unit === thisStats.weightLatest.unit &&
                thisStats.weightFirst !== thisStats.weightLatest
                  ? Math.round((thisStats.weightLatest.weight - thisStats.weightFirst.weight) * 100) / 100
                  : null,
            },
            walks: petIsCat ? null : walksIn(thisDates),
            insight: pickInsight(petName, thisStats, itemLabel),
            ...seriesFor(thisEntries, thisDates, weightUnit),
          };
          return weekPet;
        }

        const priorEntries = await priorEntriesPromise!;
        const priorStats = rangeStats(priorEntries, priorDates, weights);
        const monthPet: TrendsMonthPet = {
          petId, name: petName,
          headline: pickInsight(petName, thisStats, itemLabel),
          careConsistency: overallCompletionPct(thisStats, activeItems.map((i) => i.id)),
          moodAvg: thisStats.moodAvg,
          moodAvgLastMonth: priorStats.moodAvg,
          medsGiven: thisStats.medsGiven,
          medsGivenLastMonth: priorStats.medsGiven,
          weight: thisStats.weightLatest && {
            value: thisStats.weightLatest.weight,
            unit: thisStats.weightLatest.unit,
            deltaMonth:
              thisStats.weightFirst &&
              thisStats.weightFirst.unit === thisStats.weightLatest.unit &&
              thisStats.weightFirst !== thisStats.weightLatest
                ? Math.round((thisStats.weightLatest.weight - thisStats.weightFirst.weight) * 100) / 100
                : null,
          },
          walks: petIsCat
            ? null
            : (() => {
                const thisWalks = walksIn(thisDates);
                const lastWalks = walksIn(priorDates);
                return { ...thisWalks, countLast: lastWalks.count, milesLast: lastWalks.miles };
              })(),
          checklist: activeItems.map((i) => ({
            id: i.id, label: i.name,
            pctThis: Math.round(((thisStats.checkCountsByItemId.get(i.id) ?? 0) / thisStats.totalDays) * 100),
            pctLast: Math.round(((priorStats.checkCountsByItemId.get(i.id) ?? 0) / priorStats.totalDays) * 100),
          })),
          ...seriesFor(thisEntries, thisDates, weightUnit),
        };
        return monthPet;
      }),
    )
  ).filter((p): p is NonNullable<typeof p> => p !== null);

  return { pets, rangeStart: thisDates[0], rangeEnd: thisDates[thisDates.length - 1] };
}

// Renders computeTrendsView's output as a plain-text email — the on-demand
// ("email me this report") flow. Always offset 0 (the current week/month);
// swiping to older periods is a Trends-tab-only feature for now.
function composeReportEmail(
  period: 'week' | 'month',
  pets: TrendsWeekPet[] | TrendsMonthPet[],
  unsubUrl: string,
): { subject: string; body: string } {
  const sections =
    period === 'week'
      ? (pets as TrendsWeekPet[]).map((w) => {
          const lines = [w.name];
          if (w.moodAvg !== null) lines.push(`  Mood: ${w.moodAvg.toFixed(1)}/5`);
          for (const c of w.checklist) lines.push(`  ${c.label}: ${c.count} of ${c.total} days`);
          if (w.weight) lines.push(`  ${weeklyReportCopy.weight(w.weight.value, w.weight.unit, w.weight.deltaWeek)}`);
          if (w.walks && w.walks.count > 0) lines.push(`  ${weeklyReportCopy.walks(w.walks.count, w.walks.miles, w.walks.kcal)}`);
          if (w.insight) lines.push(`  ${w.insight}`);
          return lines.join('\n');
        })
      : (pets as TrendsMonthPet[]).map((m) => {
          const lines = [m.name, `  ${monthlyReportCopy.careConsistency(m.careConsistency)}`];
          if (m.moodAvg !== null) lines.push(`  ${monthlyReportCopy.mood(m.moodAvg, m.moodAvgLastMonth)}`);
          for (const c of m.checklist) lines.push(`  ${c.label}: ${c.pctThis}% of days (last month: ${c.pctLast}%)`);
          if (m.weight) lines.push(`  ${monthlyReportCopy.weight(m.weight.value, m.weight.unit, m.weight.deltaMonth)}`);
          if (m.walks && (m.walks.count > 0 || m.walks.countLast > 0)) {
            lines.push(`  ${monthlyReportCopy.walks(m.walks.count, m.walks.miles, m.walks.kcal, m.walks.countLast, m.walks.milesLast)}`);
          }
          if (m.headline) lines.push(`  ${m.headline}`);
          return lines.join('\n');
        });

  const copy = period === 'month' ? monthlyReportCopy : weeklyReportCopy;
  const petNames = pets.map((p) => p.name);
  const subject = petNames.length === 1 ? copy.subjectSingle(petNames[0]) : copy.subjectMulti;
  const body = [
    copy.greeting,
    ``,
    copy.intro,
    ``,
    sections.join('\n\n'),
    ``,
    copy.onDemandNote,
    ``,
    copy.cta(`${APP_URL}/dashboard`),
    ``,
    copy.signoff,
    ``,
    copy.unsubscribeLine(unsubUrl),
  ].join('\n');
  return { subject, body };
}

// HTML twin of composeReportEmail — same pets data, rendered as one card per
// pet (same visual language as the reminder/digest/monthly-report emails,
// see shared/emailHtml.ts).
function composeReportEmailHtml(
  period: 'week' | 'month',
  pets: TrendsWeekPet[] | TrendsMonthPet[],
  unsubUrl: string,
): string {
  const sectionsHtml =
    period === 'week'
      ? (pets as TrendsWeekPet[]).map((w) => {
          const rows: string[] = [];
          if (w.moodAvg !== null) rows.push(petRowHtml(`Mood: ${w.moodAvg.toFixed(1)}/5`));
          for (const c of w.checklist) rows.push(petRowHtml(`${escapeHtml(c.label)}: ${c.count} of ${c.total} days`));
          if (w.weight) rows.push(petRowHtml(escapeHtml(weeklyReportCopy.weight(w.weight.value, w.weight.unit, w.weight.deltaWeek))));
          if (w.walks && w.walks.count > 0) rows.push(petRowHtml(escapeHtml(weeklyReportCopy.walks(w.walks.count, w.walks.miles, w.walks.kcal))));
          const insight = w.insight ? insightRowHtml(escapeHtml(w.insight)) : '';
          return petCardHtml(w.name, rows.join('') + insight);
        })
      : (pets as TrendsMonthPet[]).map((m) => {
          const rows: string[] = [petRowHtml(escapeHtml(monthlyReportCopy.careConsistency(m.careConsistency)))];
          if (m.moodAvg !== null) rows.push(petRowHtml(escapeHtml(monthlyReportCopy.mood(m.moodAvg, m.moodAvgLastMonth))));
          for (const c of m.checklist) rows.push(petRowHtml(`${escapeHtml(c.label)}: ${c.pctThis}% of days (last month: ${c.pctLast}%)`));
          if (m.weight) rows.push(petRowHtml(escapeHtml(monthlyReportCopy.weight(m.weight.value, m.weight.unit, m.weight.deltaMonth))));
          if (m.walks && (m.walks.count > 0 || m.walks.countLast > 0)) {
            rows.push(petRowHtml(escapeHtml(monthlyReportCopy.walks(m.walks.count, m.walks.miles, m.walks.kcal, m.walks.countLast, m.walks.milesLast))));
          }
          const insight = m.headline ? insightRowHtml(escapeHtml(m.headline)) : '';
          return petCardHtml(m.name, rows.join('') + insight);
        });

  const copy = period === 'month' ? monthlyReportCopy : weeklyReportCopy;
  const footerHtml = `<a href="${unsubUrl}" style="color:#8a8a9a;">Unsubscribe from all Petshots email</a>`;
  return emailHtml(
    copy.intro,
    sectionsHtml.join('') + ctaButtonHtml(`${APP_URL}/dashboard`, 'See the full breakdown'),
    footerHtml,
  );
}

const MAX_DAILY_ITEMS = DAILY.MAX_ITEMS;
const MAX_COUNTER_PER_DAY = DAILY.MAX_COUNTER_PER_DAY;
const DAILY_LOG_RETENTION_DAYS = DAILY.LOG_RETENTION_DAYS;

// Days older than the retention window move from daily.json into per-month
// archive objects instead of being dropped: mood + feeding history is the
// raw material for future "he's seemed slow all week — what changed?"
// reports, so nothing is ever thrown away. Archives are append-only and
// nothing reads them yet.
async function pruneDailyToArchive(
  petPrefix: string,
  file: DailyFile,
  date: string,
): Promise<void> {
  const cutoff = addToDay(date, { days: -DAILY_LOG_RETENTION_DAYS });
  const moved: Record<string, { checks?: Record<string, DailyCheck>; mood?: DailyMood }> = {};
  for (const k of Object.keys(file.log)) {
    if (k < cutoff) {
      moved[k] = { ...(moved[k] ?? {}), checks: file.log[k] };
      delete file.log[k];
    }
  }
  for (const k of Object.keys(file.moods ?? {})) {
    if (k < cutoff) {
      moved[k] = { ...(moved[k] ?? {}), mood: file.moods![k] };
      delete file.moods![k];
    }
  }
  const days = Object.keys(moved);
  if (days.length === 0) return;
  const byMonth = new Map<string, string[]>();
  for (const d of days) {
    const m = d.slice(0, 7);
    byMonth.set(m, [...(byMonth.get(m) ?? []), d]);
  }
  for (const [month, monthDays] of byMonth) {
    const key = `${petPrefix}daily-archive/${month}.json`;
    const existing = (await readJson<{ days: Record<string, unknown> }>(key)) ?? { days: {} };
    for (const d of monthDays) existing.days[d] = moved[d];
    await putJson(key, existing);
  }
}

// WRITE guard (check/mood/items): accept only a real calendar day within
// DAILY.DATE_WINDOW_MS of server time — enough for any timezone, too tight to
// backfill or forge history. Reads use the wider plan-gated window inline in
// the GET route.
function isDailyDate(v: unknown): v is string {
  if (!isStrictDay(v)) return false;
  return Math.abs(Date.parse(`${v}T00:00:00Z`) - Date.now()) <= DAILY.DATE_WINDOW_MS;
}

// Med items due on `date` (or already checked that day — a given med advances
// nextDue past today and would otherwise vanish while checked).
function dailyMedItems(
  meds: Med[],
  date: string,
  checks: Record<string, DailyCheck>,
): (DailyItem & { med: true })[] {
  return meds
    .filter(
      (m) =>
        m.dismissed !== true &&
        ((m.nextDue && m.nextDue <= date) || checks[`med:${m.id}`] !== undefined),
    )
    .map((m) => ({ id: `med:${m.id}`, name: m.name, med: true as const }));
}

// ---- public roadmap ----
// Curated board at /roadmap: items live in roadmap/items.json (edited by the
// operator with `aws s3 cp` — no deploy needed), votes as one empty object
// per user per item under roadmap/votes/{itemId}/{sub}. Count = LIST, toggle
// = put/delete your own key: no read-modify-write, no races. Logged-in users
// vote; everyone sees counts.
interface RoadmapItem {
  id: string;
  title: string;
  description?: string;
  status: 'planned' | 'in-progress' | 'complete';
  completedAt?: string; // YYYY-MM-DD; drives "shipped" chips + the landing teaser
}
const isRoadmapId = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-z0-9-]{1,60}$/.test(v);

async function readRoadmapItems(): Promise<RoadmapItem[]> {
  const file = await readJson<{ items?: RoadmapItem[] }>('roadmap/items.json');
  return (file?.items ?? []).filter(
    (i) =>
      isRoadmapId(i?.id) &&
      typeof i?.title === 'string' &&
      ['planned', 'in-progress', 'complete'].includes(i?.status),
  );
}

async function countVotes(itemId: string): Promise<number> {
  const list = await s3.send(
    new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `roadmap/votes/${itemId}/` }),
  );
  return list.KeyCount ?? 0;
}

// ---- weight log ----
// Weight over time per pet (vets ask at every visit; sudden loss is often the
// first symptom of something). One entry per date — re-logging a date
// replaces it. The latest entry also updates pet.json's display weight so the
// profile and passport stay current.
interface WeightEntry {
  date: string; // YYYY-MM-DD
  weight: number;
  unit: 'lb' | 'kg';
  by: string; // who logged it, server-stamped
  at: string;
}
const MAX_WEIGHT_ENTRIES = WEIGHTS.MAX_ENTRIES;
const formatWeight = (e: WeightEntry): string => `${e.weight} ${e.unit}`;

// Any real past-or-today date is loggable (historical backfill from old vet
// records is legitimate); +1 day of slack covers timezones ahead of UTC.
function isWeightDate(v: unknown): v is string {
  if (!isStrictDay(v)) return false;
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  return v <= tomorrow;
}

// Drop expired invites from a household file AND their bucket-root token
// objects. Returns the pruned file; caller persists it if it changed.
async function pruneInvites(h: HouseholdFile): Promise<{ h: HouseholdFile; changed: boolean }> {
  const now = Date.now();
  const live = h.invites.filter((i) => Date.parse(i.expiresAt) > now);
  const dead = h.invites.filter((i) => Date.parse(i.expiresAt) <= now);
  for (const i of dead) {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: `invites/${i.token}.json` }));
  }
  return { h: { members: h.members, invites: live }, changed: dead.length > 0 };
}

// ---- AI document extraction (Bedrock / Claude Haiku) ----
// Uploads land in tmp/{sub}/{uploadId}/ first (a lifecycle rule expires the
// prefix after a day), get read by Claude, and only become doc records when the
// user confirms the extraction on the review screen (POST .../docs/commit).
// bedrock-runtime path with a cross-region inference profile id. (The newer
// Mantle endpoint still doesn't work for this account — retested 2026-07-07:
// every Sonnet 4.6 id 404s "model does not exist" on Mantle, and the Haiku
// alias still 403s on entitlement. Stay on legacy AnthropicBedrock.)
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID ?? AI.BEDROCK_MODEL_ID;
const MAX_AI_SCANS = Number(process.env.MAX_AI_SCANS ?? LIMITS_FREE.MAX_AI_SCANS_PER_DAY);
const PAID_MAX_AI_SCANS = Number(
  process.env.PAID_MAX_AI_SCANS ?? LIMITS_PAID.MAX_AI_SCANS_PER_DAY,
);
// Bedrock InvokeModel caps the request body at 25 MB; base64 inflates 4/3, so
// anything over MAX_AI_FILE_BYTES can't be analyzed and falls back to manual entry.
const MAX_AI_FILE_BYTES = UPLOADS.MAX_AI_FILE_BYTES;
const AI_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

let claudeClient: AnthropicBedrock | null = null;
function getClaude(): AnthropicBedrock {
  if (!claudeClient) {
    claudeClient = new AnthropicBedrock({
      awsRegion: process.env.AWS_REGION ?? 'us-east-1',
      // Finish (or fail) before API Gateway's ~30s integration cap so the
      // client always gets a real response it can fall back from.
      timeout: AI.CLIENT_TIMEOUT_MS,
      maxRetries: 0,
    });
  }
  return claudeClient;
}

// Structured-outputs schema: every property required-but-nullable, since the
// API demands additionalProperties:false + full required lists.
const nullableString = { type: ['string', 'null'] };
const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['isPetHealthDocument', 'pet', 'vet', 'vaccines'],
  properties: {
    isPetHealthDocument: { type: 'boolean' },
    pet: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'species', 'breed', 'birthday', 'weight', 'microchip'],
      properties: {
        name: nullableString,
        species: nullableString,
        breed: nullableString,
        birthday: nullableString,
        weight: nullableString,
        microchip: nullableString,
      },
    },
    vet: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'clinic', 'phone'],
      properties: { name: nullableString, clinic: nullableString, phone: nullableString },
    },
    vaccines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'dateGiven', 'expiry', 'validityText'],
        properties: {
          name: { type: 'string' },
          dateGiven: nullableString,
          expiry: nullableString,
          validityText: nullableString,
        },
      },
    },
  },
};

const EXTRACTION_PROMPT = `You are reading a document uploaded to a pet health records app — usually a vaccination certificate or vet record, as a photo or PDF.

Extract ONLY information explicitly printed in the document:
- Pet details: name, species (dog, cat, ...), breed, birth date, weight (as written, e.g. "62 lbs"), microchip number.
- Veterinarian: doctor name, clinic name, phone number.
- EVERY vaccination listed: its common name (e.g. "Rabies", "DHPP (Distemper/Parvo)", "Bordetella", "FVRCP", "FeLV", "Leptospirosis"), the date it was administered, and its expiration/due date.

Rules:
- name is the vaccine's common name ONLY — never append durations or parenthetical validity periods like "(1 Year)" or "(3 Months)" to it.
- If the document states a validity period or duration instead of (or alongside) a date — e.g. "1 year", "(3 Months)", "annual", "good for 36 months" — copy that phrase verbatim into validityText.
- Vet visit summaries and invoices often print ONE service/visit date for the whole document (e.g. "Service Date", "Date of Service", "Visit Date") next to a list of services received. That date IS the administered date (dateGiven) for every vaccine in the list, unless a line shows its own date.
- All dates in YYYY-MM-DD. If a date is partial or unreadable, use null for it.
- NEVER infer or calculate an expiration date that is not written in the document (do not guess 1-year vs 3-year durations); expiry is only for an explicitly printed date. Printed durations belong in validityText.
- Use null for anything not present or not legible.
- If this is not a pet health document at all, set isPetHealthDocument to false and return an empty vaccines list.`;

interface Extraction {
  isPetHealthDocument: boolean;
  pet: { name?: string; species?: string; breed?: string; birthday?: string; weight?: string; microchip?: string };
  vet: { name?: string; clinic?: string; phone?: string };
  vaccines: {
    name: string;
    dateGiven?: string;
    expiry?: string;
    validityText?: string; // duration as printed, e.g. "1 year", "(3 Months)"
    suggestedExpiry?: string; // dateGiven + validityText, computed server-side
  }[];
}

// "1 year" / "(3 Months)" / "annual" / "good for 36 months" -> a day/month
// offset. Month math must be calendar-clamped (Jan 31 + 1mo = Feb 28), same
// rule as the meds cadence code in the frontend.
function parseValidity(text: string): { months?: number; days?: number } | null {
  const t = text.toLowerCase();
  if (/\bannual(ly)?\b/.test(t)) return { months: 12 };
  const m = t.match(/(\d+(?:\.\d+)?)\s*(year|yr|month|mo|week|wk|day)s?\b/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0 || n > 120) return null;
  const unit = m[2];
  if (unit.startsWith('y')) return Number.isInteger(n) ? { months: n * 12 } : { days: Math.round(n * 365) };
  if (unit.startsWith('mo')) return Number.isInteger(n) ? { months: n } : { days: Math.round(n * 30) };
  if (unit.startsWith('w')) return { days: Math.round(n * 7) };
  return { days: Math.round(n) };
}

function addToDay(ymd: string, offset: { months?: number; days?: number }): string {
  const [y, mo, d] = ymd.split('-').map(Number);
  let r: Date;
  if (offset.months) {
    r = new Date(y, mo - 1 + offset.months, 1);
    const lastDay = new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate();
    r.setDate(Math.min(d, lastDay));
  } else {
    r = new Date(y, mo - 1, d + (offset.days ?? 0));
  }
  const p = (n: number) => String(n).padStart(2, '0');
  return `${r.getFullYear()}-${p(r.getMonth() + 1)}-${p(r.getDate())}`;
}

// Model output is never trusted: structured outputs constrain the shape, not
// the semantics — re-validate every date (real calendar day) and cap lengths.
function cleanExtraction(raw: unknown): Extraction {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const day = (v: unknown): string | undefined => (isStrictDay(v) ? v : undefined);
  const pet = (r.pet ?? {}) as Record<string, unknown>;
  const vet = (r.vet ?? {}) as Record<string, unknown>;
  const vaccines = (Array.isArray(r.vaccines) ? r.vaccines : [])
    .slice(0, AI.MAX_VACCINES_PER_EXTRACTION)
    .map((v: Record<string, unknown>) => {
      const dateGiven = day(v?.dateGiven);
      const expiry = day(v?.expiry);
      const validityText = str(v?.validityText, 60);
      // The document printed a duration instead of a date: given + duration is
      // grounded in the document itself, so surface it as a suggestion. (Bare
      // known-cadence guesses stay client-side as tap-to-fill chips.)
      let suggestedExpiry: string | undefined;
      if (!expiry && dateGiven && validityText) {
        const offset = parseValidity(validityText);
        if (offset) suggestedExpiry = addToDay(dateGiven, offset);
      }
      // Prompt says common-name only, but strip stray duration suffixes
      // anyway: "Rabies (1 Year)" / "Bordetella - 6 months" -> clean name.
      const name = String(v?.name ?? '')
        .replace(/\s*[-–—]?\s*\(?\s*\d+(?:\.\d+)?\s*(?:year|yr|month|mo|week|wk|day)s?\s*\)?\s*$/i, '')
        .trim()
        .slice(0, 100);
      return { name, dateGiven, expiry, validityText, suggestedExpiry };
    })
    .filter((v: { name: string }) => v.name.length > 0);
  return {
    isPetHealthDocument: r.isPetHealthDocument === true,
    pet: {
      name: str(pet.name, 100),
      species: str(pet.species, 50),
      breed: str(pet.breed, 100),
      birthday: day(pet.birthday),
      weight: str(pet.weight, 50),
      microchip: str(pet.microchip, 50),
    },
    vet: { name: str(vet.name, 150), clinic: str(vet.clinic, 150), phone: str(vet.phone, 50) },
    vaccines,
  };
}

// Best-effort daily counter in users/{sub}/ai-usage.json. A race between two
// tabs can under-count by one — acceptable; this guards cost abuse, not billing.
async function bumpAiQuota(
  sub: string,
  cap: number,
): Promise<{ ok: true; remaining: number } | { ok: false }> {
  const key = `users/${sub}/ai-usage.json`;
  const today = new Date().toISOString().slice(0, 10);
  const usage = await readJson<{ date?: string; count?: number }>(key);
  const count = usage?.date === today ? Math.max(0, Number(usage.count) || 0) : 0;
  if (count >= cap) return { ok: false };
  await putJson(key, { date: today, count: count + 1 });
  return { ok: true, remaining: cap - count - 1 };
}

// Same shape as bumpAiQuota, scoped per-pet instead of per-user (Mark's call:
// "10/100 saved photos, not photos shot" — so this is bumped once per SAVED
// photo, at upload-url time, not per shutter press; a discard never calls
// this at all).
async function bumpPhotoQuota(
  petPrefix: string,
  cap: number,
): Promise<{ ok: true; remaining: number } | { ok: false }> {
  const key = `${petPrefix}photo-usage.json`;
  const today = new Date().toISOString().slice(0, 10);
  const usage = await readJson<{ date?: string; count?: number }>(key);
  const count = usage?.date === today ? Math.max(0, Number(usage.count) || 0) : 0;
  if (count >= cap) return { ok: false };
  await putJson(key, { date: today, count: count + 1 });
  return { ok: true, remaining: cap - count - 1 };
}

async function putJson(key: string, body: unknown): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: JSON.stringify(body),
      ContentType: 'application/json',
    }),
  );
}

// Deletes every object under a prefix, paginated — a paid account can hold
// >1000 objects (10 pets x 999 docs), past a single ListObjectsV2 page.
async function deletePrefix(prefix: string): Promise<void> {
  let token: string | undefined;
  do {
    const list = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }),
    );
    const keys = (list.Contents ?? []).map((it) => ({ Key: it.Key! }));
    if (keys.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys, Quiet: true } }),
      );
    }
    token = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (token);
}

// Active-pets rule: an account holding more pets than its plan allows
// (downgrade, lapsed trial) keeps every pet fully visible and presentable,
// but only the OLDEST maxPets pets accept new docs/meds. Otherwise one month's
// payment would buy write access to 10 pets forever. Legacy pets without a
// createdAt stamp sort as oldest; ids break ties so the set is deterministic.
function rankActivePets(pets: { id: string; createdAt?: string }[], maxPets: number): Set<string> {
  const byAge = [...pets].sort(
    (a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id),
  );
  return new Set(byAge.slice(0, maxPets).map((p) => p.id));
}

async function petAcceptsWrites(petsPrefix: string, petId: string, maxPets: number): Promise<boolean> {
  const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: petsPrefix }));
  const ids = (list.Contents ?? [])
    .map((it) => it.Key!)
    .filter((k) => k.endsWith('/pet.json'))
    .map((k) => k.slice(petsPrefix.length).split('/')[0]);
  if (ids.length <= maxPets) return true;
  const stamped = await Promise.all(
    ids.map(async (id) => ({
      id,
      createdAt: (await readJson<{ createdAt?: string }>(`${petsPrefix}${id}/pet.json`))?.createdAt,
    })),
  );
  return rankActivePets(stamped, maxPets).has(petId);
}
const READ_ONLY_PET_ERROR =
  'This pet is read-only on your current plan. Upgrade to add new records.';

// ---- billing (Stripe) ----
// The Stripe secret key, webhook signing secret, and price ids live in one
// Secrets Manager secret (written by infra/scripts/setup-stripe.mjs), fetched
// lazily so non-billing routes never pay the lookup. plan.json is written
// ONLY here (webhook) or by an operator — no user-authed route can touch it.
const STRIPE_SECRET_NAME = process.env.STRIPE_SECRET_NAME ?? 'petshots/stripe';
const APP_URL = process.env.APP_URL ?? EMAIL.APP_URL;
interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  priceMonthly?: string;
  priceYearly?: string;
}
const sm = new SecretsManagerClient({});
let stripeCache: { stripe: Stripe; config: StripeConfig } | null = null;
async function getStripe(): Promise<{ stripe: Stripe; config: StripeConfig }> {
  if (!stripeCache) {
    const res = await sm.send(new GetSecretValueCommand({ SecretId: STRIPE_SECRET_NAME }));
    const config = JSON.parse(res.SecretString!) as StripeConfig;
    stripeCache = { stripe: new Stripe(config.secretKey), config };
  }
  return stripeCache;
}

async function handleStripeWebhook(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const { stripe, config } = await getStripe();
  const sig = event.headers?.['stripe-signature'];
  if (!sig) return json(400, { error: 'missing signature' });
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : (event.body ?? '');
  let evt: Stripe.Event;
  try {
    evt = stripe.webhooks.constructEvent(raw, sig, config.webhookSecret);
  } catch {
    return json(400, { error: 'invalid signature' });
  }

  switch (evt.type) {
    case 'checkout.session.completed': {
      const session = evt.data.object as Stripe.Checkout.Session;
      const userSub = session.client_reference_id;
      const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
      if (!userSub || !customerId) break;
      // customer -> Cognito sub mapping, so later subscription.* events (which
      // carry only the customer id) can find the user's plan.json.
      await putJson(`billing/customers/${customerId}.json`, { sub: userSub });
      await putJson(`users/${userSub}/plan.json`, {
        plan: 'paid',
        billingSource: 'stripe',
        stripeCustomerId: customerId,
        stripeSubscriptionId:
          typeof session.subscription === 'string' ? session.subscription : session.subscription?.id,
      });
      break;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscription = evt.data.object as Stripe.Subscription;
      const customerId =
        typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
      const mapping = await readJson<{ sub: string }>(`billing/customers/${customerId}.json`);
      if (!mapping) break; // customer not created through our checkout — ignore
      // past_due stays paid: Stripe retries the charge for days before firing
      // subscription.deleted, and yanking access mid-retry punishes card hiccups.
      const stillPaid =
        evt.type !== 'customer.subscription.deleted' &&
        ['active', 'trialing', 'past_due'].includes(subscription.status);
      await putJson(`users/${mapping.sub}/plan.json`, {
        plan: stillPaid ? 'paid' : 'free',
        billingSource: 'stripe',
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscription.id,
      });
      break;
    }
  }
  return json(200, { received: true });
}

// ---- billing (RevenueCat / Apple In-App Purchase, iOS app only) ----
// Stripe (above) still owns web billing untouched. RevenueCat's app_user_id
// is always the Cognito sub (configured client-side at Purchases.configure
// time), so both the webhook and the authed sync route below write straight
// to users/{sub}/plan.json — no reverse customer-id mapping needed, unlike
// Stripe's billing/customers/{id}.json (Stripe's customer id isn't known
// until after checkout; RevenueCat's app_user_id is ours from the start).
const REVENUECAT_SECRET_NAME = process.env.REVENUECAT_SECRET_NAME ?? 'petshots/revenuecat';
interface RevenueCatConfig {
  secretApiKey: string;
  webhookSigningSecret: string;
}
let revenueCatCache: RevenueCatConfig | null = null;
async function getRevenueCatConfig(): Promise<RevenueCatConfig> {
  if (!revenueCatCache) {
    const res = await sm.send(new GetSecretValueCommand({ SecretId: REVENUECAT_SECRET_NAME }));
    revenueCatCache = JSON.parse(res.SecretString!) as RevenueCatConfig;
  }
  return revenueCatCache;
}

// Never trusts a webhook payload's entitlement state directly — RevenueCat's
// own guidance is to re-fetch GET /subscribers after any webhook, since it's
// the canonical, consistently-formatted view. This same function backs both
// the webhook (out-of-band renewals/cancellations) and the authed sync route
// the app calls right after a purchase/restore (for instant UI correctness,
// instead of waiting on the webhook to land).
async function syncRevenueCatEntitlement(appUserId: string): Promise<void> {
  const { secretApiKey } = await getRevenueCatConfig();
  const res = await fetch(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(appUserId)}`, {
    headers: { Authorization: `Bearer ${secretApiKey}` },
  });
  if (!res.ok) throw new Error(`RevenueCat subscriber lookup failed: ${res.status}`);
  const data = (await res.json()) as {
    subscriber?: { entitlements?: Record<string, { expires_date?: string | null }> };
  };
  const entitlement = data.subscriber?.entitlements?.[REVENUECAT.ENTITLEMENT_ID];
  // No expires_date (lifetime/non-expiring) counts as active; otherwise
  // compare against now the same way Stripe's past_due/active check does.
  const isPaid = !!entitlement && (!entitlement.expires_date || new Date(entitlement.expires_date) > new Date());
  await putJson(`users/${appUserId}/plan.json`, {
    plan: isPaid ? 'paid' : 'free',
    billingSource: 'revenuecat',
  });
}

async function handleRevenueCatWebhook(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const { webhookSigningSecret } = await getRevenueCatConfig();
  const sigHeader = event.headers?.['x-revenuecat-webhook-signature'];
  if (!sigHeader) return json(400, { error: 'missing signature' });
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : (event.body ?? '');

  // Format: "t=<unix_ts>,v1=<hmac_sha256_hex>" over "<ts>.<raw body>".
  const parts = Object.fromEntries(
    sigHeader.split(',').map((p) => p.split('=') as [string, string]),
  );
  const timestamp = parts.t;
  const providedSig = parts.v1;
  if (!timestamp || !providedSig) return json(400, { error: 'invalid signature' });
  const expectedSig = createHmac('sha256', webhookSigningSecret)
    .update(`${timestamp}.${raw}`)
    .digest('hex');
  const expected = Buffer.from(expectedSig, 'hex');
  const provided = Buffer.from(providedSig, 'hex');
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return json(400, { error: 'invalid signature' });
  }

  const body = JSON.parse(raw) as { event?: { app_user_id?: string } };
  const appUserId = body.event?.app_user_id;
  if (!appUserId) return json(400, { error: 'missing app_user_id' });
  await syncRevenueCatEntitlement(appUserId);
  return json(200, { received: true });
}

// ---- public passport (no JWT required) ----
async function handlePublicPassport(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const token = event.pathParameters?.token;
  if (!token || !isUuid(token)) return json(400, { error: 'invalid token' });

  const passportRecord = await readJson<{ userId: string; petId: string; expiry?: string }>(
    `passports/${token}.json`,
  );
  if (!passportRecord) return json(404, { error: 'passport not found' });

  if (passportRecord.expiry) {
    const exp = new Date(`${passportRecord.expiry}T00:00:00`);
    exp.setDate(exp.getDate() + 1); // expired after end-of-day on the expiry date
    if (exp < new Date()) return json(410, { error: 'passport has expired' });
  }

  const { userId, petId } = passportRecord;
  const petKey = `users/${userId}/pets/${petId}/pet.json`;
  const pet = await readJson<Record<string, unknown>>(petKey);
  if (!pet) return json(404, { error: 'pet not found' });

  // Presign avatar if it exists.
  const avatarKey = `users/${userId}/pets/${petId}/avatar`;
  let avatarUrl: string | undefined;
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: avatarKey }));
    avatarUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: BUCKET, Key: avatarKey }),
      { expiresIn: UPLOADS.DOWNLOAD_URL_TTL_SECONDS },
    );
  } catch { /* no avatar */ }

  // List and presign all current docs.
  const docsPrefix = `users/${userId}/pets/${petId}/docs/`;
  const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: docsPrefix }));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const statusRank = (expiry?: string) => {
    if (!expiry) return 3;
    const d = new Date(`${expiry}T00:00:00`);
    const days = Math.round((d.getTime() - today.getTime()) / 86_400_000);
    return days < 0 ? 0 : days <= 30 ? 1 : 2;
  };
  const docs = await Promise.all(
    (list.Contents ?? []).filter((it) => !it.Key!.includes('/_archived/')).map(async (it) => {
      const key = it.Key!;
      const parts = key.split('/');
      const meta = decodeMeta(parts[6]);
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: BUCKET, Key: key }),
        { expiresIn: UPLOADS.DOWNLOAD_URL_TTL_SECONDS },
      );
      return {
        id: parts[5],
        label: meta.label,
        expiry: meta.expiry,
        given: meta.given,
        filename: parts.slice(7).join('/'),
        url,
      };
    }),
  );
  docs.sort((a, b) => statusRank(a.expiry) - statusRank(b.expiry) || (a.expiry ?? '').localeCompare(b.expiry ?? ''));

  // Medication list for boarding facilities/sitters: name + schedule, minus
  // anything the owner stopped tracking. Reminder toggles are private.
  const medsStored = await readJson<{ meds: Med[] }>(
    `users/${userId}/pets/${petId}/meds.json`,
  );
  const meds = (medsStored?.meds ?? [])
    .filter((m) => m.dismissed !== true)
    .map((m) => ({
      name: m.name,
      interval: m.interval,
      unit: m.unit,
      nextDue: m.nextDue,
      lastGiven: m.lastGiven,
    }));

  return json(200, {
    pet: {
      name: pet.name, species: pet.species, breed: pet.breed, dob: pet.dob,
      weight: pet.weight, allergies: pet.allergies, behavior: pet.behavior,
      vetName: pet.vetName, vetPhone: pet.vetPhone, emergencyContact: pet.emergencyContact,
      microchip: pet.microchip, fixed: pet.fixed, notes: pet.notes, avatarUrl,
    },
    docs,
    meds,
    expiresAt: passportRecord.expiry,
  });
}

// ---- public unsubscribe (no JWT required) ----
// The link in every reminder email lands on the SPA's /unsubscribe page, which
// POSTs here after one confirm click (a plain GET link would let mail-scanner
// prefetch unsubscribe people silently). Auth = possession of the per-user
// unsubToken from settings.json, which is only ever sent to the user's own
// inbox. Flips the master kill-switch; per-med/vaccine reminder config is left
// intact so re-enabling in Settings restores exactly what they had.
async function handleUnsubscribe(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  let input: { sub?: unknown; token?: unknown };
  try {
    input = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'invalid request' });
  }
  const sub = typeof input.sub === 'string' ? input.sub : undefined;
  const token = typeof input.token === 'string' ? input.token : undefined;
  // Both are UUIDs (Cognito sub / randomUUID); reject other shapes before they
  // touch a key. Wrong or unknown values all 404 so subs can't be probed.
  if (!isUuid(sub) || !isUuid(token)) return json(404, { error: 'not found' });
  // ETag-guarded read-modify-write: an unguarded put here could clobber a
  // concurrent Settings save (dropping its keys) or itself be lost.
  for (let attempt = 0; ; attempt++) {
    const { value: settings, etag } = await readJsonTagged<Record<string, unknown>>(
      `users/${sub}/settings.json`,
    );
    const stored = typeof settings?.unsubToken === 'string' ? settings.unsubToken : '';
    const given = Buffer.from(token);
    const expected = Buffer.from(stored);
    if (!stored || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return json(404, { error: 'not found' });
    }
    if (await putJsonGuarded(`users/${sub}/settings.json`, { ...settings, emailOptOut: true }, etag)) {
      return json(200, { ok: true });
    }
    if (attempt >= 3) return json(409, { error: 'busy, try again' });
  }
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  // Public routes handled before auth check.
  // Invite preview for the /join page — token possession is the only auth,
  // same trust model as passports (unguessable UUID, short-lived).
  if (event.routeKey === 'GET /household/invites/{token}') {
    try {
      const token = event.pathParameters?.token;
      if (!isUuid(token)) return json(404, { error: 'not found' });
      const inv = await readJson<{ ownerEmail?: string; expiresAt?: string }>(
        `invites/${token}.json`,
      );
      if (!inv || !inv.expiresAt || Date.parse(inv.expiresAt) <= Date.now()) {
        return json(404, { error: 'not found' });
      }
      return json(200, { ownerEmail: inv.ownerEmail, expiresAt: inv.expiresAt });
    } catch (e) {
      console.error('invite info error', e);
      return json(500, { error: 'internal error' });
    }
  }
  // Public roadmap: curated items + vote counts, no login needed to look.
  if (event.routeKey === 'GET /roadmap') {
    try {
      const items = await readRoadmapItems();
      const withVotes = await Promise.all(
        items.map(async (i) => ({ ...i, votes: await countVotes(i.id) })),
      );
      // The landing page fetches this on every visit — let browsers cache it
      // for a few minutes rather than re-listing vote prefixes each load.
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
        body: JSON.stringify({ items: withVotes }),
      };
    } catch (e) {
      console.error('roadmap error', e);
      return json(500, { error: 'internal error' });
    }
  }
  if (event.routeKey === 'GET /passport/{token}') {
    try { return await handlePublicPassport(event); }
    catch (e) { console.error('passport error', e); return json(500, { error: 'internal error' }); }
  }
  if (event.routeKey === 'POST /unsubscribe') {
    try { return await handleUnsubscribe(event); }
    catch (e) { console.error('unsubscribe error', e); return json(500, { error: 'internal error' }); }
  }
  // Stripe calls this server-to-server; auth is the webhook signature, not a JWT.
  if (event.routeKey === 'POST /billing/webhook') {
    try { return await handleStripeWebhook(event); }
    catch (e) { console.error('webhook error', e); return json(500, { error: 'internal error' }); }
  }
  // RevenueCat calls this server-to-server; auth is the HMAC signature, not a JWT.
  if (event.routeKey === 'POST /billing/revenuecat-webhook') {
    try { return await handleRevenueCatWebhook(event); }
    catch (e) { console.error('revenuecat webhook error', e); return json(500, { error: 'internal error' }); }
  }

  // The Cognito JWT authorizer already verified the token; we just read claims.
  // sub is the stable per-user id we scope every S3 key to - a user can never
  // name a key outside their own prefix, so authz is the prefix itself.
  const sub = event.requestContext.authorizer?.jwt?.claims?.sub as string | undefined;
  if (!sub) return json(401, { error: 'unauthorized' });

  // Pet-scoped routes carry {petId}; validate the shape before it touches a key.
  const petId = event.pathParameters?.petId;
  if (event.routeKey.includes('{petId}') && !isUuid(petId)) {
    return json(400, { error: 'invalid pet id' });
  }

  // Family resolution. A petId not under the caller's own prefix may live in
  // the household they belong to — if so, every prefix below swaps to the
  // owner's, and the case code runs unchanged against the shared pool (the
  // owner's entitlements govern it — see dataSub uses in the cases). Checked
  // per-request, so removing a member cuts access immediately regardless of
  // how long their JWT lives.
  let dataSub = sub;
  let role: 'owner' | 'member' = 'owner';
  if (event.routeKey.includes('{petId}')) {
    if ((await readJson(`users/${sub}/pets/${petId}/pet.json`)) === null) {
      const membership = await readMemberOf(sub);
      if (
        membership &&
        (await readJson(`users/${membership.ownerSub}/pets/${petId}/pet.json`)) !== null
      ) {
        dataSub = membership.ownerSub;
        role = 'member';
      }
    }
    if (role === 'member' && MEMBER_BLOCKED_ROUTES.has(event.routeKey)) {
      return json(403, { error: MEMBER_FORBIDDEN_ERROR });
    }
  }

  const petsPrefix = `users/${dataSub}/pets/`;
  const petPrefix = `${petsPrefix}${petId}/`;
  const petKey = `${petPrefix}pet.json`;
  const avatarKey = `${petPrefix}avatar`;
  const docsPrefix = `${petPrefix}docs/`;
  const photosPrefix = `${petPrefix}photos/`;

  try {
    switch (event.routeKey) {
      // ---- pets (each a small JSON object under its own prefix, no DB) ----
      case 'GET /pets': {
        // One LIST per pool covers everything under pets/: pet.json keys
        // identify the pets, an `avatar` key marks a photo.
        const loadPool = async (poolSub: string) => {
          const poolPrefix = `users/${poolSub}/pets/`;
          const [list, ent] = await Promise.all([
            s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: poolPrefix })),
            getEntitlements(poolSub),
          ]);
          const keys = (list.Contents ?? []).map((it) => it.Key!);
          const ids = keys
            .filter((k) => k.endsWith('/pet.json'))
            .map((k) => k.slice(poolPrefix.length).split('/')[0]);
          const pets = await Promise.all(
            ids.map(async (id) => {
              const pet = await readJson<{ name: string; species: string }>(
                `${poolPrefix}${id}/pet.json`,
              );
              const hasAvatar = keys.includes(`${poolPrefix}${id}/avatar`);
              const avatarUrl = hasAvatar
                ? await getSignedUrl(
                    s3,
                    new GetObjectCommand({ Bucket: BUCKET, Key: `${poolPrefix}${id}/avatar` }),
                    { expiresIn: UPLOADS.DOWNLOAD_URL_TTL_SECONDS },
                  )
                : undefined;
              return { id, ...pet, avatarUrl };
            }),
          );
          // Over-cap accounts: flag which pets still accept new docs/meds —
          // ranked within their own pool, by that pool's plan.
          const activeIds = rankActivePets(
            pets as { id: string; createdAt?: string }[],
            ent.maxPets,
          );
          return { pets: pets.map((p) => ({ ...p, active: activeIds.has(p.id) })), ent };
        };

        const membership = await readMemberOf(sub);
        const own = await loadPool(sub);
        let pets: Record<string, unknown>[] = own.pets;
        // The client reads its limits from here — never hardcode them in the UI.
        // For members, creation targets the household pool, so those are the
        // limits that matter.
        let limits = own.ent;
        let family: Record<string, unknown> | undefined;
        if (membership) {
          const shared = await loadPool(membership.ownerSub);
          pets = [...shared.pets.map((p) => ({ ...p, household: true })), ...own.pets];
          limits = shared.ent;
          family = { role: 'member', ownerEmail: membership.ownerEmail };
        } else {
          const household = await readHousehold(sub);
          if (household.members.length > 0) {
            family = { role: 'owner', memberCount: household.members.length };
          }
        }
        // Stable order so the switcher doesn't shuffle between loads.
        pets.sort((a, b) =>
          String((a as { name?: string }).name ?? '').localeCompare(
            String((b as { name?: string }).name ?? ''),
          ),
        );
        return json(200, { pets, limits, family });
      }

      case 'GET /trends': {
        // Account-level, not pet-scoped — every pet in the caller's pool
        // (their own, or their household's if they're a member). Weekly
        // summary is free-tier (swipeable back 1 window, 2 weeks total);
        // monthly is a paid perk (any offset within dailyHistoryDays), same
        // free/paid split as DAILY.HISTORY_DAYS_*. offset 0 = most recent
        // window; each step back is one full window further (swipe-to-go-
        // back-in-time on the Trends tab).
        const membership = await readMemberOf(sub);
        const poolSub = membership?.ownerSub ?? sub;
        const poolPrefix = `users/${poolSub}/pets/`;
        const ent = await getEntitlements(poolSub);
        const view = event.queryStringParameters?.view === 'month' ? 'month' : 'week';
        const offsetRaw = Number(event.queryStringParameters?.offset ?? '0');
        const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
        if (view === 'month' && ent.plan !== 'paid') {
          return json(403, { error: 'Monthly trends are a paid feature' });
        }
        const windowLen = view === 'week' ? DIGEST.LOOKBACK_DAYS : 30;
        const maxOffset = Math.max(0, Math.floor(ent.dailyHistoryDays / windowLen) - 1);
        if (offset > maxOffset) {
          return json(403, { error: 'HISTORY_LIMIT', maxOffset });
        }
        const { pets, rangeStart, rangeEnd } =
          view === 'week'
            ? await computeTrendsView(poolPrefix, 'week', offset)
            : await computeTrendsView(poolPrefix, 'month', offset);
        return json(200, { plan: ent.plan, view, offset, maxOffset, rangeStart, rangeEnd, pets });
      }

      case 'POST /trends/send': {
        // On-demand version of the same content GET /trends renders — "email
        // me this report" from the Trends tab. Always the current (offset 0)
        // period; emailing an older swiped-to period isn't supported yet.
        // Week is available to every plan; month is paid-only (403
        // otherwise), same split as the tab.
        const input = JSON.parse(event.body ?? '{}');
        const period = input.period === 'month' ? 'month' : 'week';
        const membership = await readMemberOf(sub);
        const poolSub = membership?.ownerSub ?? sub;
        const poolPrefix = `users/${poolSub}/pets/`;
        const ent = await getEntitlements(poolSub);
        if (period === 'month' && ent.plan !== 'paid') {
          return json(403, { error: 'Monthly reports are a paid feature' });
        }
        const settings = await readJson<{ email?: string; unsubToken?: string }>(`users/${sub}/settings.json`);
        if (!settings?.email || !settings.unsubToken) {
          return json(400, { error: 'Add your email in Settings before requesting a report' });
        }
        const { pets: withData } =
          period === 'week'
            ? await computeTrendsView(poolPrefix, 'week', 0)
            : await computeTrendsView(poolPrefix, 'month', 0);
        if (withData.length === 0) {
          return json(200, { ok: true, sent: false, reason: 'Nothing to report yet' });
        }
        const unsubUrl = `${APP_URL}/unsubscribe?u=${sub}&t=${settings.unsubToken}`;
        const { subject, body } = composeReportEmail(period, withData, unsubUrl);
        const html = composeReportEmailHtml(period, withData, unsubUrl);
        await ses.send(
          new SendEmailCommand({
            FromEmailAddress: FROM_EMAIL,
            Destination: { ToAddresses: [settings.email] },
            Content: {
              Simple: {
                Subject: { Data: subject, Charset: 'UTF-8' },
                Body: {
                  Text: { Data: body, Charset: 'UTF-8' },
                  Html: { Data: html, Charset: 'UTF-8' },
                },
              },
            },
          }),
        );
        return json(200, { ok: true, sent: true });
      }

      // ---- daily summary (the Summary tab) — a warm AI-written story of
      // the pool's last SUMMARY.LOOKBACK_DAYS, illustrated with recent
      // photos. Generated at most once per day per pool and cached at
      // users/{poolSub}/summary/{YYYY-MM-DD}.json; family members share the
      // day's story. Two phones racing the first GET of the day may both
      // call the model and last-write wins — same accepted looseness as
      // badges.json (harmless, pennies). Failures are NOT cached so the
      // next GET retries. ----
      case 'GET /summary': {
        const membership = await readMemberOf(sub);
        const poolSub = membership?.ownerSub ?? sub;
        const poolPrefix = `users/${poolSub}/pets/`;
        const todayKey = new Date().toISOString().slice(0, 10);
        const cacheKey = `users/${poolSub}/summary/${todayKey}.json`;

        interface SummaryPhotoRef { petId: string; id: string; filename: string }
        interface SummaryChip {
          petId: string; name: string; carePct: number; moodAvg: number | null;
          walks: { count: number; miles: number; kcal: number | null } | null;
          meals: { done: number; total: number } | null;
        }
        interface SummaryCache {
          generatedAt: string; story: string;
          rangeStart: string; rangeEnd: string;
          photoRefs: SummaryPhotoRef[]; pets: SummaryChip[];
        }
        const presignPhotos = (refs: SummaryPhotoRef[]) =>
          Promise.all(
            refs.map(async (r) => ({
              petId: r.petId,
              id: r.id,
              filename: r.filename,
              url: await getSignedUrl(
                s3,
                new GetObjectCommand({
                  Bucket: BUCKET,
                  Key: `${poolPrefix}${r.petId}/photos/${r.id}/${r.filename}`,
                }),
                { expiresIn: UPLOADS.DOWNLOAD_URL_TTL_SECONDS },
              ),
            })),
          );

        const cached = await readJson<SummaryCache>(cacheKey);
        if (cached) {
          return json(200, {
            story: cached.story,
            generatedAt: cached.generatedAt,
            rangeStart: cached.rangeStart,
            rangeEnd: cached.rangeEnd,
            pets: cached.pets,
            photos: await presignPhotos(cached.photoRefs),
          });
        }

        const { pets: weekPets, rangeStart, rangeEnd } = await computeTrendsView(
          poolPrefix,
          'week',
          0,
        );
        // Chips + model stats come from the shared story pipeline (feeding
        // folded into a meals stat and withheld from the model there —
        // shared with the weekly/monthly story crons so the rules can't
        // drift). computeTrendsView's richer week shape maps down to the
        // module's leaner one; kcal rides along inside walks.
        const storyPets: StoryPetStats[] = weekPets.map((p) => ({
          petId: p.petId,
          name: p.name,
          species: '',
          carePct: p.careConsistency,
          moodAvg: p.moodAvg,
          medsGiven: p.medsGiven,
          weight: p.weight ? { value: p.weight.value, unit: p.weight.unit, delta: p.weight.deltaWeek } : null,
          walks: p.walks,
          checklist: p.checklist,
        }));
        const chips: SummaryChip[] = buildChips(storyPets);
        const photoRefs = await pickWindowPhotos(
          BUCKET,
          poolSub,
          weekPets.map((p) => p.petId),
          rangeStart,
          rangeEnd,
        );

        // Min-signal gate: distinct window days where anything at all was
        // logged (any checklist item or a mood press, any pet). Derived from
        // the series computeTrendsView already built — no extra reads.
        const windowDays = weekPets[0]?.moodSeries.length ?? 0;
        let activeDays = 0;
        for (let i = 0; i < windowDays; i++) {
          const active = weekPets.some(
            (p) =>
              p.moodSeries[i]?.value !== null ||
              p.checklistSeries.some((c) => c.days[i]),
          );
          if (active) activeDays++;
        }
        if (activeDays < SUMMARY.MIN_ACTIVE_DAYS && photoRefs.length === 0) {
          return json(200, {
            story: null,
            reason: 'NOT_ENOUGH_DATA',
            rangeStart,
            rangeEnd,
            pets: chips,
            photos: [],
          });
        }

        let story: string;
        try {
          const imageBlocks = await fetchImageBlocks(BUCKET, photoRefs);
          story = await generateWindowStory({
            petNames: weekPets.map((p) => p.name),
            days: SUMMARY.LOOKBACK_DAYS,
            statsForModel: buildStatsForModel(storyPets),
            imageBlocks,
          });
        } catch (e) {
          console.error('bedrock summary error', e);
          return json(200, {
            story: null,
            reason: 'AI_FAILED',
            rangeStart,
            rangeEnd,
            pets: chips,
            photos: await presignPhotos(photoRefs),
          });
        }

        const generatedAt = new Date().toISOString();
        await putJson(cacheKey, {
          generatedAt,
          story,
          rangeStart,
          rangeEnd,
          photoRefs: photoRefs.map(({ petId, id, filename }) => ({ petId, id, filename })),
          pets: chips,
        } satisfies SummaryCache);
        return json(200, {
          story,
          generatedAt,
          rangeStart,
          rangeEnd,
          pets: chips,
          photos: await presignPhotos(photoRefs),
        });
      }

      // ---- story archive — the persistent weekly/monthly stories the
      // reminder Lambda's crons write (summary/weeks/, summary/months/).
      // List is metadata + a preview line; the entry route returns the full
      // story with fresh presigned photos. Reads every stored story on each
      // list call — fine for years of weeklies (small JSONs, ~52/yr),
      // revisit if it ever isn't. ----
      case 'GET /summary/archive': {
        const membership = await readMemberOf(sub);
        const poolSub = membership?.ownerSub ?? sub;
        interface StoredStory {
          rangeStart: string; rangeEnd: string; story: string; monthLabel?: string;
        }
        const listKind = async (kind: 'weeks' | 'months') => {
          const list = await s3.send(
            new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `users/${poolSub}/summary/${kind}/` }),
          );
          const keys = (list.Contents ?? []).map((it) => it.Key!).sort().reverse(); // newest first
          return Promise.all(
            keys.map(async (k) => {
              const stored = await readJson<StoredStory>(k);
              const key = k.split('/').pop()!.replace('.json', '');
              return stored
                ? {
                    key,
                    rangeStart: stored.rangeStart,
                    rangeEnd: stored.rangeEnd,
                    ...(stored.monthLabel ? { monthLabel: stored.monthLabel } : {}),
                    preview: stored.story.slice(0, 140),
                  }
                : null;
            }),
          ).then((rows) => rows.filter((r) => r !== null));
        };
        const [weeks, months] = await Promise.all([listKind('weeks'), listKind('months')]);
        return json(200, { weeks, months });
      }

      case 'GET /summary/archive/{kind}/{key}': {
        const kind = event.pathParameters?.kind;
        const key = event.pathParameters?.key ?? '';
        if (kind !== 'weeks' && kind !== 'months') return json(400, { error: 'kind must be weeks or months' });
        if (!/^\d{4}-\d{2}(-\d{2})?$/.test(key)) return json(400, { error: 'bad key' });
        const membership = await readMemberOf(sub);
        const poolSub = membership?.ownerSub ?? sub;
        interface StoredStory {
          rangeStart: string; rangeEnd: string; story: string; monthLabel?: string;
          photoRefs: { petId: string; id: string; filename: string }[];
          pets: unknown[]; generatedAt: string;
        }
        const stored = await readJson<StoredStory>(`users/${poolSub}/summary/${kind}/${key}.json`);
        if (!stored) return json(404, { error: 'not found' });
        const photos = await Promise.all(
          (stored.photoRefs ?? []).map(async (r) => ({
            ...r,
            url: await getSignedUrl(
              s3,
              new GetObjectCommand({
                Bucket: BUCKET,
                Key: `users/${poolSub}/pets/${r.petId}/photos/${r.id}/${r.filename}`,
              }),
              { expiresIn: UPLOADS.DOWNLOAD_URL_TTL_SECONDS },
            ),
          })),
        );
        return json(200, {
          key,
          kind,
          rangeStart: stored.rangeStart,
          rangeEnd: stored.rangeEnd,
          ...(stored.monthLabel ? { monthLabel: stored.monthLabel } : {}),
          story: stored.story,
          generatedAt: stored.generatedAt,
          pets: stored.pets ?? [],
          photos,
        });
      }

      // ---- walks (account-level, not pet-scoped — one walk can cover
      // multiple pets, e.g. walking two dogs together, so it can't nest
      // under a single pet's prefix like docs/meds/photos/weights do).
      // Same pool-resolution pattern as GET /trends above. ----
      case 'GET /walks': {
        const membership = await readMemberOf(sub);
        const poolSub = membership?.ownerSub ?? sub;
        const walks = [...(await readWalksIndex(poolSub))].sort((a, b) =>
          b.startedAt.localeCompare(a.startedAt),
        );
        // Per-dog energy estimates for every walk (latest weight × distance).
        // One weights+pet read per UNIQUE pet, not per walk. Cats never get
        // an estimate (walk features are dog-only throughout).
        const walkPetIds = [...new Set(walks.flatMap((w) => w.petIds))];
        const kgByPet = new Map<string, number | null>();
        await Promise.all(
          walkPetIds.map(async (petId) => {
            const [pet, stored] = await Promise.all([
              readJson<{ species?: string }>(`users/${poolSub}/pets/${petId}/pet.json`),
              readJson<{ entries: WeightEntry[] }>(`users/${poolSub}/pets/${petId}/weights.json`),
            ]);
            kgByPet.set(petId, isCatSpecies(pet?.species) ? null : latestWeightKg(stored?.entries));
          }),
        );
        const withKcal = walks.map((w) => {
          const kcalByPet: Record<string, number> = {};
          for (const petId of w.petIds) {
            const kcal = dogKcal(kgByPet.get(petId) ?? null, w.distanceMeters);
            if (kcal !== null) kcalByPet[petId] = kcal;
          }
          return { ...w, kcalByPet };
        });
        return json(200, { walks: withKcal });
      }

      case 'POST /walks': {
        const input = JSON.parse(event.body ?? '{}');
        const petIds = Array.isArray(input.petIds)
          ? [...new Set(input.petIds.filter((id: unknown) => isUuid(typeof id === 'string' ? id : undefined)))]
          : [];
        const startedAt = isIsoTimestamp(input.startedAt) ? input.startedAt : null;
        const endedAt = isIsoTimestamp(input.endedAt) ? input.endedAt : null;
        const distanceMeters =
          typeof input.distanceMeters === 'number' && input.distanceMeters >= 0
            ? Math.round(input.distanceMeters)
            : 0;
        if (petIds.length === 0) return json(400, { error: 'at least one pet is required' });
        if (!startedAt || !endedAt || Date.parse(endedAt) < Date.parse(startedAt)) {
          return json(400, { error: 'startedAt/endedAt required (endedAt >= startedAt)' });
        }

        const membership = await readMemberOf(sub);
        const poolSub = membership?.ownerSub ?? sub;
        const poolPrefix = `users/${poolSub}/pets/`;
        // Confirm every petId actually belongs to this pool before writing —
        // a walk can't be tagged onto a pet the caller can't see.
        const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: poolPrefix }));
        const validIds = new Set(
          (list.Contents ?? [])
            .filter((it) => it.Key!.endsWith('/pet.json'))
            .map((it) => it.Key!.slice(poolPrefix.length).split('/')[0]),
        );
        const confirmedPetIds = petIds.filter((id): id is string => validIds.has(id as string));
        if (confirmedPetIds.length === 0) return json(404, { error: 'no matching pets found' });

        const who = await actorEmail(sub);
        const walk: WalkRecord = {
          id: randomUUID(),
          petIds: confirmedPetIds,
          startedAt,
          endedAt,
          distanceMeters,
          by: who,
        };
        if (!(await mutateWalksIndex(poolSub, (walks) => [...walks, walk]))) {
          return json(409, { error: 'could not save the walk, try again' });
        }

        // Auto-check the existing Daily "Walk" preset for each pet on the
        // walk, for the local day it ended — written fresh (not by calling
        // into POST /pets/{petId}/daily/check) since that route also carries
        // med side-effects and counter logic this doesn't need. Best-effort
        // per pet: one pet's daily.json contention shouldn't fail the walk
        // save that already landed.
        const walkDay = endedAt.slice(0, 10);
        await Promise.all(
          confirmedPetIds.map(async (petId) => {
            const dailyKey = `${poolPrefix}${petId}/daily.json`;
            for (let attempt = 0; attempt < 3; attempt++) {
              const { value, etag } = await readJsonTagged<DailyFile>(dailyKey);
              const file: DailyFile = value ?? { items: null, log: {} };
              const day = file.log[walkDay] ?? {};
              if (day['preset-walk']) return; // already checked today
              day['preset-walk'] = { by: who, at: new Date().toISOString() };
              file.log[walkDay] = day;
              if (await putJsonGuarded(dailyKey, file, etag)) return;
            }
          }),
        );

        // Per-dog energy estimate rides back on the save response so the
        // "Walk saved" toast can say who burned what (same math as GET /walks).
        const kcalByPet: Record<string, number> = {};
        await Promise.all(
          confirmedPetIds.map(async (petId) => {
            const [petInfo, stored] = await Promise.all([
              readJson<{ species?: string }>(`${poolPrefix}${petId}/pet.json`),
              readJson<{ entries: WeightEntry[] }>(`${poolPrefix}${petId}/weights.json`),
            ]);
            if (isCatSpecies(petInfo?.species)) return;
            const kcal = dogKcal(latestWeightKg(stored?.entries), distanceMeters);
            if (kcal !== null) kcalByPet[petId] = kcal;
          }),
        );

        return json(200, { walk, kcalByPet });
      }

      case 'DELETE /walks/{id}': {
        const id = event.pathParameters?.id;
        if (!id || !isUuid(id)) return json(400, { error: 'id required' });
        const membership = await readMemberOf(sub);
        const poolSub = membership?.ownerSub ?? sub;
        await mutateWalksIndex(poolSub, (walks) => walks.filter((w) => w.id !== id));
        // Remove any legacy per-walk object too, so a future index backfill
        // can never resurrect a deleted walk.
        await s3.send(
          new DeleteObjectCommand({ Bucket: BUCKET, Key: `users/${poolSub}/walks/${id}.json` }),
        );
        return { statusCode: 204 };
      }

      // ---- achievements (account-level) — live rolling stat cards per pet,
      // each carrying its ladder of locked/unlocked badges (catalog +
      // persistence notes at badgeCatalog above). Card numbers stay the
      // rolling last-7-days window; badge conditions use best-ever calendar
      // weeks / all-time totals so trophies never un-earn. Cats get no walk
      // cards (Mark, 2026-07-13) — just the photo card. The Care-streak card
      // (consecutive perfect Daily days) was removed entirely 2026-07-14;
      // any badges pets already earned under it stay as harmless orphaned
      // keys in badges.json (same precedent as removing Shutterbug).
      case 'GET /achievements': {
        const membership = await readMemberOf(sub);
        const poolSub = membership?.ownerSub ?? sub;
        const poolPrefix = `users/${poolSub}/pets/`;
        const todayKey = new Date().toISOString().slice(0, 10);
        const windowDates = new Set(
          Array.from({ length: DIGEST.LOOKBACK_DAYS }, (_, i) =>
            addToDay(todayKey, { days: -(DIGEST.LOOKBACK_DAYS - 1 - i) }),
          ),
        );
        const windowStart = [...windowDates].sort()[0];

        // All-time walks, not window-filtered: badge conditions need full history.
        const [petList, allWalks] = await Promise.all([
          s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: poolPrefix })),
          readWalksIndex(poolSub),
        ]);
        const petIds = (petList.Contents ?? [])
          .filter((it) => it.Key!.endsWith('/pet.json'))
          .map((it) => it.Key!.slice(poolPrefix.length).split('/')[0]);

        const pets = await Promise.all(
          petIds.map(async (petId) => {
            const petPrefix = `${poolPrefix}${petId}/`;
            const [pet, daily, photosList] = await Promise.all([
              readJson<{ name?: string; species?: string; dob?: string; memorial?: boolean }>(`${petPrefix}pet.json`),
              readJson<DailyFile>(`${petPrefix}daily.json`),
              s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${petPrefix}photos/` })),
            ]);
            if (!pet?.name) return null;
            // Memorial pets keep their earned badges in badges.json but the
            // cards (and any new earns) stop — achievements are for living
            // routines, not memorials.
            if (pet.memorial) return null;

            const petWalks = allWalks.filter((w) => w.petIds.includes(petId));
            const weekWalks = petWalks.filter((w) => w.startedAt.slice(0, 10) >= windowStart);
            const weekMiles = toMiles(weekWalks.reduce((sum, w) => sum + w.distanceMeters, 0));
            const walkBests = weeklyBests(petWalks.map((w) => w.startedAt.slice(0, 10)));

            const photoDates = (photosList.Contents ?? [])
              .map((it) => it.LastModified?.toISOString().slice(0, 10))
              .filter((d): d is string => !!d);
            const daysWithPhoto = new Set(photoDates.filter((d) => windowDates.has(d)));
            const photoBests = weeklyBests(photoDates);
            // Creative photo badges (UTC day boundaries throughout):
            // Weekend Shooter — some calendar week has a photo on BOTH its
            // Saturday and its Sunday (Sunday belongs to the following
            // Mon-start week, so pair Sat with the NEXT day, not weekStartOf).
            const photoDateSet = new Set(photoDates);
            const hasWeekendPhotoPair = photoDates.some(
              (d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 6 && photoDateSet.has(addToDay(d, { days: 1 })),
            );
            const hasBirthdayPhoto =
              !!pet.dob && pet.dob.length >= 10 && photoDates.some((d) => d.slice(5) === pet.dob!.slice(5));
            const photoMonths = new Set(photoDates.map((d) => d.slice(0, 7))).size;

            const badgesKey = `${petPrefix}badges.json`;
            const stored = (await readJson<BadgesFile>(badgesKey)) ?? { earned: {} };

            const stats: PetBadgeStats = {
              totalWalks: petWalks.length,
              totalMiles: petWalks.reduce((sum, w) => sum + w.distanceMeters, 0) / METERS_PER_MILE,
              maxWalksInWeek: walkBests.maxCount,
              maxWalkDaysInWeek: walkBests.maxDays,
              longestWalkWeekStreak: walkBests.longestStreak,
              totalPhotos: photoDates.length,
              maxPhotoDaysInWeek: photoBests.maxDays,
              hasWeekendPhotoPair,
              hasBirthdayPhoto,
              photoMonths,
            };

            let newlyEarned = false;
            const badgesFor = (cardId: string) =>
              badgeCatalog[cardId].map(({ def, done }) => {
                let earnedAt = stored.earned[def.id]?.earnedAt ?? null;
                if (!earnedAt && done(stats)) {
                  earnedAt = todayKey;
                  stored.earned[def.id] = { earnedAt };
                  newlyEarned = true;
                }
                return { ...def, earnedAt };
              });

            const photoCard = {
              id: 'photo-days-week',
              icon: '📸',
              label: 'Photos this week',
              value: `${daysWithPhoto.size}/${DIGEST.LOOKBACK_DAYS}`,
              badges: badgesFor('photo-days-week'),
            };
            // Cats never evaluate walk badges at all — no stray earns if a
            // walk gets tagged onto a cat in a mixed-species outing. Photo
            // card leads for every species (2026-07-15) so it lands in the
            // same grid column whether a pet has 1 card or 3 — cats always
            // had it first by default; dogs used to bury it after walks/miles.
            const cards = isCatSpecies(pet.species)
              ? [photoCard]
              : [
                  photoCard,
                  { id: 'walks-week', icon: '🚶', label: 'Walks this week', value: String(weekWalks.length), badges: badgesFor('walks-week') },
                  { id: 'distance-week', icon: '🗺️', label: 'Miles this week', value: weekMiles.toFixed(1), badges: badgesFor('distance-week') },
                ];
            if (newlyEarned) await putJson(badgesKey, stored);
            return { petId, petName: pet.name, cards };
          }),
        );

        // Family leaderboard — who's winning the week (miles first, walk
        // count as the tiebreak), over the same rolling window as the cards.
        // Solo accounts get null and the UI hides the section entirely.
        // Pre-attribution walks (no `by`, logged before 2026-07-12) count
        // for nobody.
        let leaderboard: {
          label: string;
          me: string;
          members: { email: string; walks: number; miles: number }[];
        } | null = null;
        const household = await readHousehold(poolSub);
        if (household.members.length > 0) {
          const emails = [await actorEmail(poolSub), ...household.members.map((m) => m.email)];
          const rows = emails
            .map((email) => {
              const wk = allWalks.filter(
                (w) => w.by === email && w.startedAt.slice(0, 10) >= windowStart,
              );
              return {
                email,
                walks: wk.length,
                miles: toMiles(wk.reduce((sum, w) => sum + w.distanceMeters, 0)),
              };
            })
            .sort((a, b) => b.miles - a.miles || b.walks - a.walks);
          leaderboard = { label: 'This week', me: await actorEmail(sub), members: rows };
        }

        return json(200, {
          pets: pets.filter((p): p is NonNullable<typeof p> => p !== null),
          leaderboard,
        });
      }

      case 'POST /pets': {
        const pet = cleanPet(JSON.parse(event.body ?? '{}'));
        if (!pet.name) return json(400, { error: 'name required' });
        // A member's new pet is a family pet: it goes into the household pool
        // under the owner's prefix, governed by the owner's plan.
        const membership = await readMemberOf(sub);
        const poolSub = membership?.ownerSub ?? sub;
        const poolPrefix = `users/${poolSub}/pets/`;
        const [list, ent] = await Promise.all([
          s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: poolPrefix })),
          getEntitlements(poolSub),
        ]);
        const count = (list.Contents ?? []).filter((it) => it.Key!.endsWith('/pet.json')).length;
        if (count >= ent.maxPets) {
          return json(409, { error: `limit of ${ent.maxPets} pets reached` });
        }
        const id = randomUUID();
        // createdAt drives the active-pets ranking on downgrade; server-stamped
        // so it can't be forged into a better rank.
        const createdAt = new Date().toISOString();
        await putJson(`${poolPrefix}${id}/pet.json`, { ...pet, createdAt });
        return json(200, {
          pet: { id, ...pet, createdAt, ...(membership ? { household: true } : {}) },
        });
      }

      case 'PUT /pets/{petId}': {
        const pet = cleanPet(JSON.parse(event.body ?? '{}'));
        if (!pet.name) return json(400, { error: 'name required' });
        // Update only - creating here would sidestep the POST /pets limit.
        const existing = await readJson<Record<string, unknown>>(petKey);
        if (existing === null) return json(404, { error: 'not found' });
        // Passport/createdAt fields are managed server-side; preserve them across profile edits.
        await s3.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: petKey,
            Body: JSON.stringify({
              ...pet,
              passportToken: existing.passportToken,
              passportExpiry: existing.passportExpiry,
              createdAt: existing.createdAt,
            }),
            ContentType: 'application/json',
          }),
        );
        return json(200, { pet: { id: petId, ...pet } });
      }

      case 'DELETE /pets/{petId}': {
        // Removes the whole pet: pet.json, avatar, every doc under it — and
        // its passport token object, which lives at the bucket root and would
        // otherwise survive as a live-but-dead public link.
        const pet = await readJson<{ passportToken?: string }>(petKey);
        if (pet?.passportToken) {
          await s3.send(
            new DeleteObjectCommand({
              Bucket: BUCKET,
              Key: `passports/${pet.passportToken}.json`,
            }),
          );
        }
        await deletePrefix(petPrefix);
        return { statusCode: 204 };
      }

      case 'POST /pets/{petId}/avatar/upload-url': {
        const input = JSON.parse(event.body ?? '{}');
        const contentType = String(input.contentType ?? '');
        if (!AVATAR_TYPES.includes(contentType)) {
          return json(400, { error: 'avatar must be a JPEG, PNG, or WebP image' });
        }
        if ((await readJson(petKey)) === null) return json(404, { error: 'not found' });
        // Fixed key: a new photo overwrites the old one, so there's nothing to
        // clean up and it never counts against the doc limit.
        const { url, fields } = await createPresignedPost(s3, {
          Bucket: BUCKET,
          Key: avatarKey,
          Conditions: [
            ['content-length-range', 1, MAX_AVATAR_BYTES],
            ['eq', '$Content-Type', contentType],
          ],
          Fields: { 'Content-Type': contentType },
          Expires: UPLOADS.UPLOAD_URL_TTL_SECONDS,
        });
        return json(200, { url, fields });
      }

      // ---- photos (casual per-pet album — swipe-right camera / swipe-left
      // albums on the overview screen). Separate from both the single-slot
      // avatar above and the formal vaccine docs below: a growing collection
      // of candid photos, key shape users/{sub}/pets/{petId}/photos/{photoId}/
      // {filename}, same presigned-POST-direct-to-S3 pattern as docs. Limits
      // are a DAILY per-pet SAVE count (see bumpPhotoQuota), not a lifetime
      // total — deliberately never surfaced in the UI until it's hit. ----
      case 'GET /pets/{petId}/photos': {
        const list = await s3.send(
          new ListObjectsV2Command({ Bucket: BUCKET, Prefix: photosPrefix }),
        );
        const items = (list.Contents ?? []).sort(
          (a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0),
        );
        const photos = await Promise.all(
          items.map(async (it) => {
            const key = it.Key!;
            // key shape: users/{sub}/pets/{petId}/photos/{photoId}/{filename}
            const parts = key.split('/');
            const url = await getSignedUrl(
              s3,
              new GetObjectCommand({ Bucket: BUCKET, Key: key }),
              { expiresIn: UPLOADS.DOWNLOAD_URL_TTL_SECONDS },
            );
            return {
              id: parts[5],
              filename: parts.slice(6).join('/'),
              size: it.Size,
              uploadedAt: it.LastModified,
              url,
            };
          }),
        );
        return json(200, { photos });
      }

      case 'POST /pets/{petId}/photos/upload-url': {
        const input = JSON.parse(event.body ?? '{}');
        const filename = String(input.filename ?? 'photo.jpg')
          .replace(/[^\w.\- ]/g, '_')
          .slice(0, 200);
        const contentType = String(input.contentType ?? '');
        if (!PHOTO_TYPES.includes(contentType)) {
          return json(400, { error: 'photo must be a JPEG, PNG, or WebP image' });
        }
        const [pet, ent] = await Promise.all([
          readJson<{ name?: string }>(petKey),
          getEntitlements(dataSub),
        ]);
        if (pet === null) return json(404, { error: 'not found' });
        if (!(await petAcceptsWrites(petsPrefix, petId!, ent.maxPets))) {
          return json(403, { error: READ_ONLY_PET_ERROR });
        }
        // Bumped here (not at /confirm) — issuing the URL is our proxy for
        // "the user tapped Save," same best-effort-not-billing tradeoff as
        // bumpAiQuota. A shutter press that's later discarded never reaches
        // this route at all, so it never counts. Human-readable error string
        // (not a machine code) — same convention as the doc-count 409 above,
        // this is the ONLY place the cap is ever surfaced to the user.
        const cap = ent.plan === 'paid' ? PAID_MAX_PHOTOS_PER_DAY : MAX_PHOTOS_PER_DAY;
        const quota = await bumpPhotoQuota(petPrefix, cap);
        if (!quota.ok) {
          return json(409, {
            error: `You've reached today's photo limit for ${pet?.name ?? 'this pet'} — try again tomorrow${
              ent.plan === 'paid' ? '.' : ', or upgrade for more photos per day.'
            }`,
          });
        }

        const photoId = randomUUID();
        const key = `${photosPrefix}${photoId}/${filename}`;
        const { url, fields } = await createPresignedPost(s3, {
          Bucket: BUCKET,
          Key: key,
          Conditions: [
            ['content-length-range', 1, MAX_PHOTO_BYTES],
            ['eq', '$Content-Type', contentType],
          ],
          Fields: { 'Content-Type': contentType },
          Expires: UPLOADS.UPLOAD_URL_TTL_SECONDS,
        });
        return json(200, { url, fields, photoId });
      }

      // Called by the client after the direct-to-S3 upload succeeds (the API
      // Lambda never sees a presigned POST land otherwise). HEAD-checks the
      // object is actually there before pushing, so an aborted upload or a
      // closed app never triggers a false "new photo" notification to the
      // household. Broadcasts to every OTHER household member sharing this
      // pet — not the uploader.
      case 'POST /pets/{petId}/photos/{id}/confirm': {
        const id = event.pathParameters?.id;
        if (!id) return json(400, { error: 'id required' });
        const list = await s3.send(
          new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${photosPrefix}${id}/` }),
        );
        if ((list.Contents ?? []).length === 0) {
          return json(200, { ok: true, notified: false });
        }
        const pet = await readJson<{ name?: string }>(petKey);
        if (pet?.name) {
          const household = await readHousehold(dataSub);
          const notifySubs = [dataSub, ...household.members.map((m) => m.sub)].filter(
            (s) => s !== sub,
          );
          await Promise.all(
            notifySubs.map((notifySub) =>
              sendPushes(BUCKET, `users/${notifySub}/`, photoCopy.title, photoCopy.body(pet.name!), APP_URL),
            ),
          );
        }
        return json(200, { ok: true, notified: true });
      }

      case 'DELETE /pets/{petId}/photos/{id}': {
        const id = event.pathParameters?.id;
        if (!id) return json(400, { error: 'id required' });
        const list = await s3.send(
          new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${photosPrefix}${id}/` }),
        );
        await Promise.all(
          (list.Contents ?? []).map((it) =>
            s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: it.Key! })),
          ),
        );
        return { statusCode: 204 };
      }

      // ---- documents (per pet) ----
      case 'GET /pets/{petId}/docs': {
        const list = await s3.send(
          new ListObjectsV2Command({ Bucket: BUCKET, Prefix: docsPrefix }),
        );
        // Archived versions live under …/docs/{id}/_archived/… — exclude them
        // from the listing so only the current version of each record shows.
        const docs = await Promise.all(
          (list.Contents ?? []).filter((it) => !it.Key!.includes('/_archived/')).map(async (it) => {
            const key = it.Key!;
            // key shape: users/{sub}/pets/{petId}/docs/{docId}/{encodeMeta}/{filename}
            // Label lives in the key (not S3 metadata) so the browser upload carries
            // no x-amz-* headers and can't trip S3's "unsigned header" rejection.
            const parts = key.split('/');
            const meta = decodeMeta(parts[6]);
            // Short-lived GET URL so the browser opens the PDF straight from S3.
            const url = await getSignedUrl(
              s3,
              new GetObjectCommand({ Bucket: BUCKET, Key: key }),
              { expiresIn: UPLOADS.DOWNLOAD_URL_TTL_SECONDS },
            );
            return {
              id: parts[5],
              label: meta.label,
              expiry: meta.expiry,
              given: meta.given,
              remindersEnabled: meta.remindersEnabled !== false,
              filename: parts.slice(7).join('/'),
              size: it.Size,
              // Content identity (MD5 for our single-part uploads/copies) —
              // one AI-scanned certificate commits as N records backed by the
              // SAME bytes, and Present mode uses this to show the file once.
              etag: it.ETag,
              uploadedAt: it.LastModified,
              url,
            };
          }),
        );
        return json(200, { docs });
      }

      case 'POST /pets/{petId}/docs/upload-url': {
        const input = JSON.parse(event.body ?? '{}');
        const filename = String(input.filename ?? '')
          .replace(/[^\w.\- ]/g, '_')
          .slice(0, 200);
        const label = String(input.label ?? '').slice(0, 200);
        const expiry = cleanExpiry(input.expiry);
        const remindersEnabled = input.remindersEnabled !== false;
        const contentType = String(input.contentType ?? 'application/octet-stream');
        if (!filename) return json(400, { error: 'filename required' });
        if ((await readJson(petKey)) === null) return json(404, { error: 'not found' });

        // Enforce the per-pet limit before handing out an upload URL.
        // Count only current (non-archived) docs so archived versions don't
        // inflate the count and block uploads.
        const [list, ent] = await Promise.all([
          s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: docsPrefix })),
          getEntitlements(dataSub),
        ]);
        const currentDocs = (list.Contents ?? []).filter(
          (it) => !it.Key!.includes('/_archived/'),
        );
        if (currentDocs.length >= ent.maxDocs) {
          return json(409, { error: `limit of ${ent.maxDocs} documents reached` });
        }
        if (!(await petAcceptsWrites(petsPrefix, petId!, ent.maxPets))) {
          return json(403, { error: READ_ONLY_PET_ERROR });
        }

        const docId = randomUUID();
        // Label is encoded into the key (own path segment) rather than stored as
        // x-amz-meta-*. Fall back to the filename if no label was given (avoids an
        // empty key segment).
        const safeLabel = label || filename;
        const key = `${docsPrefix}${docId}/${encodeMeta({ label: safeLabel, expiry, remindersEnabled })}/${filename}`;

        // Presigned POST (not PUT): the signed policy carries conditions that S3
        // enforces itself. content-length-range rejects an oversized upload
        // server-side, so the browser's size check is no longer the only guard.
        // The client posts these `fields` (file LAST) as multipart/form-data.
        const { url, fields } = await createPresignedPost(s3, {
          Bucket: BUCKET,
          Key: key,
          Conditions: [
            ['content-length-range', 1, MAX_FILE_BYTES],
            ['eq', '$Content-Type', contentType],
          ],
          Fields: { 'Content-Type': contentType },
          Expires: UPLOADS.UPLOAD_URL_TTL_SECONDS,
        });
        return json(200, { url, fields, key });
      }

      // ---- AI extraction: temp upload -> analyze -> review (client) -> commit ----

      case 'POST /pets/{petId}/docs/analyze-upload-url': {
        const input = JSON.parse(event.body ?? '{}');
        const filename = String(input.filename ?? '')
          .replace(/[^\w.\- ]/g, '_')
          .slice(0, 200);
        const contentType = String(input.contentType ?? 'application/octet-stream');
        if (!filename) return json(400, { error: 'filename required' });
        if ((await readJson(petKey)) === null) return json(404, { error: 'not found' });

        // Same gates as a direct upload: a full or read-only pet shouldn't get
        // a temp file it can never commit.
        const [list, ent] = await Promise.all([
          s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: docsPrefix })),
          getEntitlements(dataSub),
        ]);
        const currentDocs = (list.Contents ?? []).filter((it) => !it.Key!.includes('/_archived/'));
        if (currentDocs.length >= ent.maxDocs) {
          return json(409, { error: `limit of ${ent.maxDocs} documents reached` });
        }
        if (!(await petAcceptsWrites(petsPrefix, petId!, ent.maxPets))) {
          return json(403, { error: READ_ONLY_PET_ERROR });
        }

        const uploadId = randomUUID();
        const tmpKey = `tmp/${sub}/${uploadId}/${filename}`;
        const { url, fields } = await createPresignedPost(s3, {
          Bucket: BUCKET,
          Key: tmpKey,
          Conditions: [
            ['content-length-range', 1, MAX_FILE_BYTES],
            ['eq', '$Content-Type', contentType],
          ],
          Fields: { 'Content-Type': contentType },
          Expires: UPLOADS.UPLOAD_URL_TTL_SECONDS,
        });
        return json(200, { url, fields, uploadId });
      }

      case 'POST /pets/{petId}/docs/analyze': {
        const input = JSON.parse(event.body ?? '{}');
        const uploadId = input.uploadId;
        if (!isUuid(uploadId)) return json(400, { error: 'uploadId required' });
        if ((await readJson(petKey)) === null) return json(404, { error: 'not found' });

        // uploadId is scoped under the caller's own tmp/{sub}/ prefix, so one
        // user can never analyze (or even probe for) another user's upload.
        const tmpPrefix = `tmp/${sub}/${uploadId}/`;
        const tmpList = await s3.send(
          new ListObjectsV2Command({ Bucket: BUCKET, Prefix: tmpPrefix }),
        );
        const tmpObj = tmpList.Contents?.[0];
        if (!tmpObj) return json(404, { error: 'upload not found' });
        if ((tmpObj.Size ?? 0) > MAX_AI_FILE_BYTES) {
          return json(413, { error: 'TOO_LARGE_FOR_AI' });
        }

        // Exact-duplicate check: a byte-identical re-upload of a file that
        // already backs a record skips the model call (and costs no scan).
        // Both the browser POST and the commit-time CopyObject are single-part,
        // so ETag stays the content MD5 and ETag+Size equality is exact.
        const dupList = await s3.send(
          new ListObjectsV2Command({ Bucket: BUCKET, Prefix: docsPrefix }),
        );
        const dupObj = (dupList.Contents ?? []).find(
          (it) =>
            !it.Key!.includes('/_archived/') &&
            it.ETag === tmpObj.ETag &&
            it.Size === tmpObj.Size,
        );
        if (dupObj) {
          const dupParts = dupObj.Key!.split('/');
          const dupMeta = decodeMeta(dupParts[6]);
          return json(200, {
            duplicate: { id: dupParts[5], label: dupMeta.label, expiry: dupMeta.expiry },
          });
        }

        const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: tmpObj.Key! }));
        const contentType = (obj.ContentType ?? '').toLowerCase().split(';')[0].trim();
        const isPdf = contentType === 'application/pdf';
        if (!isPdf && !AI_IMAGE_TYPES.includes(contentType)) {
          return json(415, { error: 'UNSUPPORTED_TYPE_FOR_AI' });
        }
        const data = Buffer.from(await obj.Body!.transformToByteArray()).toString('base64');

        // Household pets bill AI scans to the owner's plan and daily budget —
        // the family shares one scan allowance, like every other cap.
        const ent = await getEntitlements(dataSub);
        const cap = ent.plan === 'paid' ? PAID_MAX_AI_SCANS : MAX_AI_SCANS;
        // Bump after the cheap rejections but before the model call: failed
        // model calls still count, so a hostile client can't loop free scans.
        const quota = await bumpAiQuota(dataSub, cap);
        if (!quota.ok) return json(429, { error: 'AI_QUOTA_EXCEEDED' });

        let extraction: Extraction;
        try {
          const msg = await getClaude().messages.create({
            model: BEDROCK_MODEL_ID,
            max_tokens: 1500,
            output_config: { format: { type: 'json_schema', schema: EXTRACTION_SCHEMA } },
            messages: [
              {
                role: 'user',
                content: [
                  isPdf
                    ? { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data } }
                    : { type: 'image' as const, source: { type: 'base64' as const, media_type: contentType as 'image/jpeg', data } },
                  { type: 'text' as const, text: EXTRACTION_PROMPT },
                ],
              },
            ],
          });
          if (msg.stop_reason === 'refusal') return json(502, { error: 'AI_FAILED' });
          const text = msg.content.find((b) => b.type === 'text');
          extraction = cleanExtraction(JSON.parse(text && 'text' in text ? text.text : '{}'));
        } catch (e) {
          // Model access not enabled, throttled, timed out, unparseable — the
          // client falls back to manual entry; the upload itself is fine.
          console.error('bedrock analyze error', e);
          return json(502, { error: 'AI_FAILED' });
        }
        return json(200, { extraction, scansRemaining: quota.remaining });
      }

      case 'POST /pets/{petId}/docs/commit': {
        const input = JSON.parse(event.body ?? '{}');
        const uploadId = input.uploadId;
        if (!isUuid(uploadId)) return json(400, { error: 'uploadId required' });
        if (!Array.isArray(input.records) || input.records.length === 0) {
          return json(400, { error: 'at least one record required' });
        }

        // Validate every record before touching S3 — all-or-nothing.
        const records: { label: string; expiry?: string; given?: string; remindersEnabled: boolean }[] = [];
        for (const raw of input.records) {
          const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
          const label = String(r.label ?? '').trim().slice(0, 200);
          if (!label) return json(400, { error: 'record label required' });
          if (r.expiry !== undefined && r.expiry !== null && r.expiry !== '' && !isStrictDay(r.expiry)) {
            return json(400, { error: 'expiry must be a valid YYYY-MM-DD date' });
          }
          if (r.given !== undefined && r.given !== null && r.given !== '' && !isStrictDay(r.given)) {
            return json(400, { error: 'given must be a valid YYYY-MM-DD date' });
          }
          records.push({
            label,
            expiry: isStrictDay(r.expiry) ? r.expiry : undefined,
            given: isStrictDay(r.given) ? r.given : undefined,
            remindersEnabled: r.remindersEnabled !== false,
          });
        }

        const existingPet = await readJson<Record<string, unknown>>(petKey);
        if (existingPet === null) return json(404, { error: 'not found' });

        const tmpPrefix = `tmp/${sub}/${uploadId}/`;
        const [tmpList, docList, ent] = await Promise.all([
          s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: tmpPrefix })),
          s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: docsPrefix })),
          getEntitlements(dataSub),
        ]);
        const tmpKey = tmpList.Contents?.[0]?.Key;
        if (!tmpKey) return json(404, { error: 'upload not found' });
        const currentDocs = (docList.Contents ?? []).filter(
          (it) => !it.Key!.includes('/_archived/'),
        );
        if (currentDocs.length + records.length > ent.maxDocs) {
          return json(409, { error: `limit of ${ent.maxDocs} documents reached` });
        }
        if (!(await petAcceptsWrites(petsPrefix, petId!, ent.maxPets))) {
          return json(403, { error: READ_ONLY_PET_ERROR });
        }

        // One uploaded file can become several records (a cert listing three
        // vaccines): server-side copy per record, each with its own docId/meta.
        const filename = tmpKey.slice(tmpPrefix.length);
        const copySource = `${BUCKET}/${encodeURIComponent(tmpKey).replace(/%2F/g, '/')}`;
        const created = await Promise.all(
          records.map(async (rec) => {
            const docId = randomUUID();
            const newKey = `${docsPrefix}${docId}/${encodeMeta({
              label: rec.label,
              expiry: rec.expiry,
              given: rec.given,
              remindersEnabled: rec.remindersEnabled,
            })}/${filename}`;
            await s3.send(
              new CopyObjectCommand({ Bucket: BUCKET, Key: newKey, CopySource: copySource }),
            );
            return { id: docId, ...rec, filename };
          }),
        );
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: tmpKey }));

        // Optional profile enrichment from the extraction. Only a whitelist of
        // health fields, and only the keys the client explicitly sent — the UI
        // offers these solely for fields the profile doesn't already have.
        if (input.profile && typeof input.profile === 'object') {
          const p = input.profile as Record<string, unknown>;
          const patch: Record<string, unknown> = {};
          if (typeof p.breed === 'string') patch.breed = str(p.breed, 100);
          if (isStrictDay(p.dob)) patch.dob = p.dob;
          if (typeof p.weight === 'string') patch.weight = str(p.weight, 50);
          if (typeof p.vetName === 'string') patch.vetName = str(p.vetName, 150);
          if (typeof p.vetPhone === 'string') patch.vetPhone = str(p.vetPhone, 50);
          if (typeof p.microchip === 'string') patch.microchip = str(p.microchip, 50);
          if (Object.keys(patch).length > 0) {
            await putJson(petKey, { ...existingPet, ...patch });
          }
        }

        return json(200, { docs: created });
      }

      // Manual entry: create metadata-only records without requiring a file upload.
      // Writes a tiny placeholder S3 object so the key schema is consistent.
      case 'POST /pets/{petId}/docs/create-record': {
        const input = JSON.parse(event.body ?? '{}');
        if (!Array.isArray(input.records) || input.records.length === 0) {
          return json(400, { error: 'at least one record required' });
        }
        const records: { label: string; expiry?: string; given?: string; remindersEnabled: boolean }[] = [];
        for (const raw of input.records) {
          const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
          const label = String(r.label ?? '').trim().slice(0, 200);
          if (!label) return json(400, { error: 'record label required' });
          if (r.expiry !== undefined && r.expiry !== null && r.expiry !== '' && !isStrictDay(r.expiry)) {
            return json(400, { error: 'expiry must be a valid YYYY-MM-DD date' });
          }
          if (r.given !== undefined && r.given !== null && r.given !== '' && !isStrictDay(r.given)) {
            return json(400, { error: 'given must be a valid YYYY-MM-DD date' });
          }
          records.push({
            label,
            expiry: isStrictDay(r.expiry) ? r.expiry : undefined,
            given: isStrictDay(r.given) ? r.given : undefined,
            remindersEnabled: r.remindersEnabled !== false,
          });
        }

        const existingPet = await readJson<Record<string, unknown>>(petKey);
        if (existingPet === null) return json(404, { error: 'not found' });

        const [docList, ent] = await Promise.all([
          s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: docsPrefix })),
          getEntitlements(dataSub),
        ]);
        const currentDocs = (docList.Contents ?? []).filter(
          (it) => !it.Key!.includes('/_archived/'),
        );
        if (currentDocs.length + records.length > ent.maxDocs) {
          return json(409, { error: `limit of ${ent.maxDocs} documents reached` });
        }
        if (!(await petAcceptsWrites(petsPrefix, petId!, ent.maxPets))) {
          return json(403, { error: READ_ONLY_PET_ERROR });
        }

        const created = await Promise.all(
          records.map(async (rec) => {
            const docId = randomUUID();
            const newKey = `${docsPrefix}${docId}/${encodeMeta({
              label: rec.label,
              expiry: rec.expiry,
              given: rec.given,
              remindersEnabled: rec.remindersEnabled,
            })}/_manual`;
            await s3.send(
              new PutObjectCommand({ Bucket: BUCKET, Key: newKey, Body: '', ContentType: 'text/plain' }),
            );
            return { id: docId, ...rec, filename: '_manual' };
          }),
        );
        return json(200, { docs: created });
      }

      case 'PATCH /pets/{petId}/docs/{id}': {
        // Edit = change label and/or expiry, which live in the key -> S3 has no
        // rename, so copy the object to a new key and delete the old one. docId +
        // filename are preserved; only the metadata path segment changes.
        const id = event.pathParameters?.id;
        if (!id) return json(400, { error: 'id required' });
        const input = JSON.parse(event.body ?? '{}');
        const newLabel = String(input.label ?? '').slice(0, 200);
        if (!newLabel) return json(400, { error: 'label required' });
        const newExpiry = cleanExpiry(input.expiry);

        const prefix = `${docsPrefix}${id}/`;
        const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
        // Skip archived versions — rename applies only to the current file.
        const oldKey = list.Contents?.find((it) => !it.Key!.includes('/_archived/'))?.Key;
        if (!oldKey) return json(404, { error: 'not found' });

        const oldParts = oldKey.split('/');
        const filename = oldParts.slice(7).join('/');
        const oldMeta = decodeMeta(oldParts[6]);
        // Preserve existing remindersEnabled/given if not provided in request.
        const newRemindersEnabled = typeof input.remindersEnabled === 'boolean'
          ? input.remindersEnabled
          : oldMeta.remindersEnabled !== false;
        const newGiven =
          input.given === null || input.given === ''
            ? undefined // explicit clear
            : isStrictDay(input.given)
              ? input.given
              : oldMeta.given;
        const newKey = `${prefix}${encodeMeta({ label: newLabel, expiry: newExpiry, given: newGiven, remindersEnabled: newRemindersEnabled })}/${filename}`;
        if (newKey === oldKey) return json(200, { ok: true });

        // CopySource must be a URL-encoded bucket/key, but with '/' preserved as
        // path separators (encodeURIComponent would turn them into %2F).
        const copySource = `${BUCKET}/${encodeURIComponent(oldKey).replace(/%2F/g, '/')}`;
        await s3.send(new CopyObjectCommand({ Bucket: BUCKET, Key: newKey, CopySource: copySource }));
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: oldKey }));
        return json(200, { ok: true });
      }

      // (The old POST /docs/{id}/update-url route is gone — the Update-record
      // feature was removed in session 12. Listings still skip /_archived/
      // sub-keys because objects archived by that route may exist in S3.)

      case 'DELETE /pets/{petId}/docs/{id}': {
        const id = event.pathParameters?.id;
        if (!id) return json(400, { error: 'id required' });
        const prefix = `${docsPrefix}${id}/`;
        const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
        // Deletes everything under the prefix: current file + all archived versions.
        await Promise.all(
          (list.Contents ?? []).map((it) =>
            s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: it.Key! })),
          ),
        );
        return { statusCode: 204 };
      }

      // ---- medications (per pet) ----

      case 'GET /pets/{petId}/meds': {
        const stored = await readJson<{ meds: Med[] }>(`${petPrefix}meds.json`);
        return json(200, { meds: stored?.meds ?? [] });
      }

      case 'PUT /pets/{petId}/meds': {
        // Whole-list replace, like settings.json. Require the pet to exist so
        // meds can't be stashed under arbitrary petIds outside the pet limit.
        const [existingPet, ent] = await Promise.all([
          readJson(petKey),
          getEntitlements(dataSub),
        ]);
        if (existingPet === null) return json(404, { error: 'not found' });
        const input = JSON.parse(event.body ?? '{}');
        // ETag-guarded like daily.json: the daily-check med side-effect writes
        // this file too, so an unguarded replace could clobber a nextDue
        // advance that landed mid-request.
        for (let attempt = 0; ; attempt++) {
          const { value: stored, etag } = await readJsonTagged<{ meds: Med[] }>(
            `${petPrefix}meds.json`,
          );
          // Grandfather clause: whole-list replace means a user left over the cap
          // by a downgrade must still be able to edit/shrink the list — only
          // growing past what they already have is blocked.
          const effectiveMax = Math.max(ent.maxMeds, stored?.meds?.length ?? 0);
          const result = cleanMeds(input.meds, effectiveMax, stored?.meds ?? []);
          if ('error' in result) return json(400, { error: result.error });
          // Growing the list counts as a write; read-only (over-cap) pets can
          // still have meds edited, toggled, and removed — just not added.
          if (
            result.meds.length > (stored?.meds?.length ?? 0) &&
            !(await petAcceptsWrites(petsPrefix, petId!, ent.maxPets))
          ) {
            return json(403, { error: READ_ONLY_PET_ERROR });
          }
          if (await putJsonGuarded(`${petPrefix}meds.json`, result, etag)) {
            return json(200, result);
          }
          if (attempt >= 3) return json(409, { error: 'busy, try again' });
        }
      }

      // ---- daily care checklist (per pet) ----

      case 'GET /pets/{petId}/daily': {
        // Reads accept dates back over the plan's history window (the Daily
        // tab's swipe-back browsing); writes below stay on the tight
        // anti-backfill DATE_WINDOW_MS. Household pets follow the owner's plan.
        const date = event.queryStringParameters?.date;
        if (!isStrictDay(date)) {
          return json(400, { error: 'date required (YYYY-MM-DD)' });
        }
        const ageMs = Date.now() - Date.parse(`${date}T00:00:00Z`);
        if (-ageMs > DAILY.DATE_WINDOW_MS) {
          return json(400, { error: 'date required (YYYY-MM-DD, not in the future)' });
        }
        if (ageMs > DAILY.HISTORY_DAYS_FREE * 86_400_000 + DAILY.DATE_WINDOW_MS) {
          const ent = await getEntitlements(dataSub);
          if (ageMs > ent.dailyHistoryDays * 86_400_000 + DAILY.DATE_WINDOW_MS) {
            return json(403, { error: 'HISTORY_LIMIT' });
          }
        }
        const petInfo = await readJson<{ species?: string }>(petKey);
        if (petInfo === null) return json(404, { error: 'not found' });
        const [file, medsStored] = await Promise.all([
          readJson<DailyFile>(`${petPrefix}daily.json`),
          readJson<{ meds: Med[] }>(`${petPrefix}meds.json`),
        ]);
        let checks = file?.log?.[date] ?? {};
        let mood = file?.moods?.[date] ?? null;
        // Days older than the in-file retention live in the per-month archive.
        // Item definitions aren't archived: rows render with CURRENT item/med
        // names, so checks on since-deleted items are omitted (same drift the
        // live window already has).
        if (
          ageMs > (DAILY_LOG_RETENTION_DAYS - 1) * 86_400_000 &&
          Object.keys(checks).length === 0 &&
          mood === null
        ) {
          const arch = await readJson<{
            days?: Record<string, { checks?: Record<string, DailyCheck>; mood?: DailyMood }>;
          }>(`${petPrefix}daily-archive/${date.slice(0, 7)}.json`);
          checks = arch?.days?.[date]?.checks ?? {};
          mood = arch?.days?.[date]?.mood ?? null;
        }
        const items = [
          // Tombstoned/future items filter out per date — the archive path
          // works too, since removed items keep their names in daily.json.
          ...(file?.items ?? dailyPresetsFor(petInfo.species)).filter((i) =>
            itemVisibleOn(i, date),
          ),
          ...dailyMedItems(medsStored?.meds ?? [], date, checks),
        ];
        // Feeding-disuse hint: active feeding items with ZERO checks across
        // the whole live log, while everything else shows real use (other
        // checks on 3+ distinct days — a brand-new account never triggers).
        // The Daily tab renders a dismissible "drop meal tracking?" prompt.
        let feedingIdle = false;
        const feedingIds = new Set(
          items.filter((i) => !('med' in i) && isFeedingDailyItem(i.id, i.name)).map((i) => i.id),
        );
        if (feedingIds.size > 0) {
          let fedEver = false;
          let otherDays = 0;
          for (const dayChecks of Object.values(file?.log ?? {})) {
            let otherToday = false;
            for (const id of Object.keys(dayChecks)) {
              if (feedingIds.has(id)) fedEver = true;
              else otherToday = true;
            }
            if (otherToday) otherDays++;
          }
          feedingIdle = !fedEver && otherDays >= 3;
        }
        return json(200, { date, items, checks, mood, feedingIdle });
      }

      case 'POST /pets/{petId}/daily/mood': {
        const input = JSON.parse(event.body ?? '{}');
        const date = input.date;
        const value = input.value;
        if (!isDailyDate(date)) {
          return json(400, { error: 'date required (YYYY-MM-DD, near today)' });
        }
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5) {
          return json(400, { error: 'value must be 1-5' });
        }
        if ((await readJson(petKey)) === null) return json(404, { error: 'not found' });
        const who = await actorEmail(sub);
        for (let attempt = 0; ; attempt++) {
          const { value: stored, etag } = await readJsonTagged<DailyFile>(`${petPrefix}daily.json`);
          const file: DailyFile = stored ?? { items: null, log: {} };
          const moods = file.moods ?? {};
          const current = moods[date];
          // Same value again = agreement, keep the first press's attribution.
          // A different value overrides and re-attributes.
          if (!current || current.value !== value) {
            moods[date] = { value, by: who, at: new Date().toISOString() };
          }
          file.moods = moods;
          await pruneDailyToArchive(petPrefix, file, date);
          if (await putJsonGuarded(`${petPrefix}daily.json`, file, etag)) {
            return json(200, { date, mood: moods[date] });
          }
          if (attempt >= 3) return json(409, { error: 'busy, try again' });
        }
      }

      case 'POST /pets/{petId}/daily/check': {
        const input = JSON.parse(event.body ?? '{}');
        const date = input.date;
        const itemId = String(input.itemId ?? '');
        const checked = input.checked !== false;
        if (!isDailyDate(date)) {
          return json(400, { error: 'date required (YYYY-MM-DD, near today)' });
        }
        if (!itemId || itemId.length > 80) return json(400, { error: 'itemId required' });
        const checkPetInfo = await readJson<{ species?: string }>(petKey);
        if (checkPetInfo === null) return json(404, { error: 'not found' });

        // The med side-effect (mark-as-given / restore) is computed inside the
        // retry loop but WRITTEN only after the daily write lands, so a retry
        // can never apply it twice.
        const isMed = itemId.startsWith('med:');
        let medsStored: { meds: Med[] } | null = null;
        let med: Med | undefined;
        if (isMed) {
          medsStored = await readJson<{ meds: Med[] }>(`${petPrefix}meds.json`);
          med = medsStored?.meds.find((m) => m.id === itemId.slice(4));
          if (!med) return json(404, { error: 'medication not found' });
        }
        const who = await actorEmail(sub);

        // Several family phones write daily.json at once — read-modify-write
        // under an ETag guard, re-applying on conflict.
        let day: Record<string, DailyCheck> = {};
        let medUpdate: { lastGiven?: string; nextDue: string } | null = null;
        for (let attempt = 0; ; attempt++) {
          const { value, etag } = await readJsonTagged<DailyFile>(`${petPrefix}daily.json`);
          const file: DailyFile = value ?? { items: null, log: {} };
          const log = file.log ?? {};
          day = log[date] ?? {};
          medUpdate = null;

          if (isMed) {
            if (checked && !day[itemId]) {
              medUpdate = {
                lastGiven: date,
                nextDue: addToDay(
                  date,
                  med!.unit === 'month'
                    ? { months: med!.interval }
                    : { days: med!.interval * (med!.unit === 'week' ? 7 : 1) },
                ),
              };
              day[itemId] = {
                by: who,
                at: new Date().toISOString(),
                prev: { lastGiven: med!.lastGiven, nextDue: med!.nextDue },
              };
            } else if (!checked && day[itemId]) {
              const prev = day[itemId].prev;
              if (prev) medUpdate = prev;
              delete day[itemId];
            }
          } else {
            const items = file.items ?? dailyPresetsFor(checkPetInfo.species);
            // Tombstoned (or not-yet-added) items can't be checked for a day
            // they weren't on the list.
            const item = items.find((i) => i.id === itemId && itemVisibleOn(i, date));
            if (!item) return json(404, { error: 'item not found' });
            if (item.kind === 'counter') {
              // Counters tally repeatable events; `checked` maps to +1/-1.
              // Every increment is kept (who + when) for future reports.
              const entry = day[itemId];
              if (checked) {
                const events = entry?.events ?? [];
                if (events.length >= MAX_COUNTER_PER_DAY) {
                  return json(400, { error: 'daily counter limit reached' });
                }
                events.push({ by: who, at: new Date().toISOString() });
                const last = events[events.length - 1];
                day[itemId] = { by: last.by, at: last.at, count: events.length, events };
              } else if (entry?.events?.length) {
                entry.events.pop();
                if (entry.events.length === 0) {
                  delete day[itemId];
                } else {
                  const last = entry.events[entry.events.length - 1];
                  day[itemId] = {
                    by: last.by,
                    at: last.at,
                    count: entry.events.length,
                    events: entry.events,
                  };
                }
              }
            } else {
              // First checker wins — re-checking never steals attribution.
              if (checked && !day[itemId]) {
                day[itemId] = { by: who, at: new Date().toISOString() };
              } else if (!checked) {
                delete day[itemId];
              }
            }
          }

          log[date] = day;
          file.log = log;
          await pruneDailyToArchive(petPrefix, file, date);
          if (await putJsonGuarded(`${petPrefix}daily.json`, file, etag)) break;
          if (attempt >= 3) return json(409, { error: 'busy, try again' });
        }

        if (medUpdate && med) {
          // Apply the schedule change to a FRESH read under an ETag guard —
          // writing back the list read at request start could clobber another
          // phone's concurrent check-off (or a meds-screen edit). The daily
          // write already landed, so on exhausted retries we log and return
          // 200 rather than strand a checked-off row (unchecking restores the
          // schedule from `prev` either way).
          const medId = med.id;
          for (let attempt = 0; ; attempt++) {
            const { value: fresh, etag } = await readJsonTagged<{ meds: Med[] }>(
              `${petPrefix}meds.json`,
            );
            const target = fresh?.meds.find((m) => m.id === medId);
            if (!target) break; // med deleted mid-request — nothing to advance
            target.lastGiven = medUpdate.lastGiven;
            target.nextDue = medUpdate.nextDue;
            if (await putJsonGuarded(`${petPrefix}meds.json`, fresh, etag)) break;
            if (attempt >= 3) {
              console.error(`med schedule write lost after retries: ${petPrefix} ${medId}`);
              break;
            }
          }
        }
        return json(200, { date, checks: day });
      }

      case 'PUT /pets/{petId}/daily/items': {
        // Whole-list replace of the VISIBLE custom items (med rows derive from
        // meds.json and can't be edited here). Removals become tombstones, not
        // deletions: history must keep showing what the list looked like on
        // each past day, so a removed item stays in the array with removedOn
        // and only disappears from that day forward.
        const input = JSON.parse(event.body ?? '{}');
        if (!Array.isArray(input.items) || input.items.length > MAX_DAILY_ITEMS) {
          return json(400, { error: `items must be an array of at most ${MAX_DAILY_ITEMS}` });
        }
        // The client's local day stamps addedOn/removedOn (log dates are local
        // days too); older clients that send no date fall back to UTC today.
        const stamp = isDailyDate(input.date)
          ? input.date
          : new Date().toISOString().slice(0, 10);
        const seen = new Set<string>();
        const incoming: DailyItem[] = [];
        for (const raw of input.items) {
          const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
          const name = String(r.name ?? '').trim().slice(0, 60);
          if (!name) return json(400, { error: 'item name required' });
          // Keep stable ids (incl. preset-*) so the day's attribution survives
          // a rename; regenerate anything malformed or duplicated.
          const id =
            typeof r.id === 'string' && /^[\w-]{1,40}$/.test(r.id) && !seen.has(r.id)
              ? r.id
              : randomUUID();
          seen.add(id);
          incoming.push({ id, name, ...(r.kind === 'counter' ? { kind: 'counter' as const } : {}) });
        }
        const itemsPetInfo = await readJson<{ species?: string }>(petKey);
        if (itemsPetInfo === null) return json(404, { error: 'not found' });
        for (let attempt = 0; ; attempt++) {
          const { value: file, etag } = await readJsonTagged<DailyFile>(`${petPrefix}daily.json`);
          // First-ever edit materializes the presets so removing one of them
          // tombstones it instead of just not storing it.
          const base = file?.items ?? dailyPresetsFor(itemsPetInfo.species);
          const baseById = new Map(base.filter((s) => !s.removedOn).map((s) => [s.id, s]));
          const items: DailyItem[] = [
            // Visible list in the user's order: known ids keep their addedOn,
            // new ids are stamped with today.
            ...incoming.map((i) => {
              const prev = baseById.get(i.id);
              return prev ? { ...i, addedOn: prev.addedOn } : { ...i, addedOn: stamp };
            }),
            // History: prior tombstones ride along; anything visible that the
            // client dropped is removed as of today.
            ...base
              .filter((s) => s.removedOn || !seen.has(s.id))
              .map((s) => (s.removedOn ? s : { ...s, removedOn: stamp })),
          ];
          const next = { items, log: file?.log ?? {}, moods: file?.moods ?? {} };
          if (await putJsonGuarded(`${petPrefix}daily.json`, next, etag)) {
            return json(200, { items: items.filter((i) => itemVisibleOn(i, stamp)) });
          }
          if (attempt >= 3) return json(409, { error: 'busy, try again' });
        }
      }

      // ---- user settings ----

      case 'GET /settings': {
        const settings = await readJson<Record<string, unknown>>(`users/${sub}/settings.json`);
        return json(200, settings ?? {
          remindersEnabled: false,
          reminderDays: REMINDERS.DEFAULT_REMINDER_DAYS,
        });
      }

      case 'PUT /settings': {
        const input = JSON.parse(event.body ?? '{}');
        const validDays = REMINDERS.VALID_REMINDER_DAYS;
        // ETag-guarded: the reminder Lambda's legacy-token backfill and the
        // public /unsubscribe route write this file too — a conflict here
        // could regenerate the unsubToken (dead links in already-sent email).
        for (let attempt = 0; ; attempt++) {
          // unsubToken is server-managed: preserved from the stored file (never
          // trusted from the client) and minted here if absent, so every user
          // who saves settings gets a working unsubscribe link.
          const { value: existing, etag } = await readJsonTagged<Record<string, unknown>>(
            `users/${sub}/settings.json`,
          );
          const settings = {
            email: typeof input.email === 'string' ? input.email.slice(0, 254) : '',
            remindersEnabled: input.remindersEnabled === true,
            reminderDays: Array.isArray(input.reminderDays)
              ? (input.reminderDays as unknown[]).filter(
                  (d): d is number => typeof d === 'number' && validDays.includes(d),
                )
              : REMINDERS.DEFAULT_REMINDER_DAYS,
            marketingOptIn: input.marketingOptIn === true,
            emailOptOut: input.emailOptOut === true,
            // Sunday summary of the week's care/mood/weight. Default ON (it
            // only ever sends when reminders are enabled AND there was
            // activity), explicit false turns it off.
            weeklyDigest: input.weeklyDigest !== false,
            unsubToken:
              typeof existing?.unsubToken === 'string' ? existing.unsubToken : randomUUID(),
          };
          if (await putJsonGuarded(`users/${sub}/settings.json`, settings, etag)) {
            return json(200, settings);
          }
          if (attempt >= 3) return json(409, { error: 'busy, try again' });
        }
      }

      // ---- account deletion ----

      case 'DELETE /account': {
        // Hard delete, everything, in an order that keeps a mid-failure
        // retryable: Stripe + orphanable root objects first, then the user's
        // S3 prefix, then the Cognito user LAST (while it exists the user can
        // still re-auth and hit this route again).
        //
        // No equivalent cleanup exists for an Apple IAP subscription — unlike
        // Stripe, there's no server-side "cancel" call available to us; the
        // user must cancel it themselves via the App Store (standard for
        // every IAP app). Deleting the Cognito user here still revokes app
        // access immediately regardless.
        const plan = await readJson<{ stripeCustomerId?: string }>(`users/${sub}/plan.json`);
        if (plan?.stripeCustomerId) {
          try {
            const { stripe } = await getStripe();
            // Default list excludes already-canceled subscriptions.
            const subs = await stripe.subscriptions.list({ customer: plan.stripeCustomerId });
            for (const s of subs.data) {
              await stripe.subscriptions.cancel(s.id);
            }
            await s3.send(
              new DeleteObjectCommand({
                Bucket: BUCKET,
                Key: `billing/customers/${plan.stripeCustomerId}.json`,
              }),
            );
          } catch (e) {
            // Don't strand the user with an undeletable account; an orphaned
            // subscription is visible (and cancellable) in the Stripe dashboard.
            console.error(`account delete: Stripe cleanup failed for ${sub}`, e);
          }
        }

        // Passport tokens live at the bucket root keyed by token — collect them
        // from each pet.json before the prefix delete orphans them as live links.
        const petsList = await s3.send(
          new ListObjectsV2Command({ Bucket: BUCKET, Prefix: petsPrefix }),
        );
        const petJsonKeys = (petsList.Contents ?? [])
          .map((it) => it.Key!)
          .filter((k) => k.endsWith('/pet.json'));
        for (const key of petJsonKeys) {
          const pet = await readJson<{ passportToken?: string }>(key);
          if (pet?.passportToken) {
            await s3.send(
              new DeleteObjectCommand({
                Bucket: BUCKET,
                Key: `passports/${pet.passportToken}.json`,
              }),
            );
          }
        }

        // Family cleanup, both directions: members' back-pointers and pending
        // invite tokens die with an owner; a member's seat is freed with them.
        const household = await readHousehold(sub);
        for (const m of household.members) {
          await s3.send(
            new DeleteObjectCommand({ Bucket: BUCKET, Key: `users/${m.sub}/memberOf.json` }),
          );
        }
        for (const i of household.invites) {
          await s3.send(
            new DeleteObjectCommand({ Bucket: BUCKET, Key: `invites/${i.token}.json` }),
          );
        }
        const membership = await readMemberOf(sub);
        if (membership) {
          await updateHousehold(membership.ownerSub, (h) => {
            h.members = h.members.filter((m) => m.sub !== sub);
            return { result: true };
          });
        }

        // Roadmap votes are keyed by sub at the bucket root — remove them so
        // nothing user-linked outlives the account.
        try {
          const roadmapItems = await readRoadmapItems();
          for (const i of roadmapItems) {
            await s3.send(
              new DeleteObjectCommand({ Bucket: BUCKET, Key: `roadmap/votes/${i.id}/${sub}` }),
            );
          }
        } catch (e) {
          console.error('roadmap vote cleanup failed (non-fatal)', e);
        }

        await deletePrefix(`users/${sub}/`);

        await cognito.send(
          new AdminDeleteUserCommand({ UserPoolId: USER_POOL_ID, Username: sub }),
        );
        console.log(`account deleted: ${sub}`);
        return { statusCode: 204 };
      }

      // ---- billing ----

      case 'POST /billing/checkout': {
        const { stripe, config } = await getStripe();
        const input = JSON.parse(event.body ?? '{}');
        const price = input.interval === 'year' ? config.priceYearly : config.priceMonthly;
        if (!price) return json(503, { error: 'billing not configured' });
        // Reuse the Stripe customer on re-upgrade so their history stays whole.
        const plan = await readJson<{ stripeCustomerId?: string }>(`users/${sub}/plan.json`);
        const session = await stripe.checkout.sessions.create({
          mode: 'subscription',
          line_items: [{ price, quantity: 1 }],
          client_reference_id: sub,
          ...(plan?.stripeCustomerId ? { customer: plan.stripeCustomerId } : {}),
          allow_promotion_codes: true,
          success_url: `${APP_URL}/dashboard?billing=success`,
          cancel_url: `${APP_URL}/dashboard?billing=cancelled`,
        });
        return json(200, { url: session.url });
      }

      case 'POST /billing/portal': {
        const { stripe } = await getStripe();
        const plan = await readJson<{ stripeCustomerId?: string }>(`users/${sub}/plan.json`);
        if (!plan?.stripeCustomerId) return json(404, { error: 'no billing account' });
        const session = await stripe.billingPortal.sessions.create({
          customer: plan.stripeCustomerId,
          return_url: `${APP_URL}/dashboard`,
        });
        return json(200, { url: session.url });
      }

      // Called by the iOS app immediately after purchasePackage()/
      // restorePurchases() resolves, so the UI reflects the new entitlement
      // without waiting on the webhook. See syncRevenueCatEntitlement above.
      case 'POST /billing/revenuecat/sync': {
        await syncRevenueCatEntitlement(sub);
        return json(200, await getEntitlements(sub));
      }

      // ---- passport management ----

      case 'POST /pets/{petId}/passport': {
        const existing = await readJson<Record<string, unknown>>(petKey);
        if (!existing) return json(404, { error: 'not found' });
        const input = JSON.parse(event.body ?? '{}');
        const expiry = cleanExpiry(input.expiry);

        // Revoke the old token before issuing a new one.
        const oldToken = existing.passportToken as string | undefined;
        if (oldToken) {
          await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: `passports/${oldToken}.json` }));
        }

        const token = randomUUID();
        await s3.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: `passports/${token}.json`,
            Body: JSON.stringify({ userId: sub, petId, expiry }),
            ContentType: 'application/json',
          }),
        );
        await s3.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: petKey,
            Body: JSON.stringify({ ...existing, passportToken: token, passportExpiry: expiry }),
            ContentType: 'application/json',
          }),
        );
        return json(200, { token, url: `https://petshots.app/p/${token}`, expiresAt: expiry });
      }

      case 'DELETE /pets/{petId}/passport': {
        const existing = await readJson<Record<string, unknown>>(petKey);
        if (!existing) return json(404, { error: 'not found' });
        const token = existing.passportToken as string | undefined;
        if (!token) return json(404, { error: 'no active passport' });
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: `passports/${token}.json` }));
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { passportToken: _t, passportExpiry: _e, ...rest } = existing;
        await s3.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: petKey,
            Body: JSON.stringify(rest),
            ContentType: 'application/json',
          }),
        );
        return { statusCode: 204 };
      }

      // ---- web push subscriptions ----
      // One object per device at users/{sub}/push/{sha256(endpoint)}.json —
      // multi-device by construction, resubscribing the same browser just
      // overwrites. The reminder Lambda reads these when it sends email and
      // pushes the same headline; it deletes any the push service rejects.

      case 'POST /push/subscribe': {
        const input = JSON.parse(event.body ?? '{}');
        // Native iOS app: an APNs device token instead of a web subscription.
        // Tokens are hex; Apple says treat length as opaque, so allow a wide
        // range. The reminder Lambda only ever sends these to Apple's APNs
        // hosts, so no endpoint allowlisting applies.
        if (input.platform === 'ios' || input.platform === 'apns') {
          const token = typeof input.token === 'string' ? input.token.toLowerCase() : '';
          if (!/^[0-9a-f]{32,512}$/.test(token)) {
            return json(400, { error: 'invalid push token' });
          }
          const id = createHash('sha256').update(token).digest('hex').slice(0, 32);
          await putJson(`users/${sub}/push/${id}.json`, {
            platform: 'apns',
            token,
            createdAt: new Date().toISOString(),
          });
          return json(200, { ok: true });
        }
        const s = input.subscription;
        const endpoint = typeof s?.endpoint === 'string' ? s.endpoint : '';
        const p256dh = typeof s?.keys?.p256dh === 'string' ? s.keys.p256dh : '';
        const auth = typeof s?.keys?.auth === 'string' ? s.keys.auth : '';
        if (
          !endpoint.startsWith('https://') ||
          endpoint.length > 1024 ||
          !p256dh || p256dh.length > 256 ||
          !auth || auth.length > 256
        ) {
          return json(400, { error: 'invalid push subscription' });
        }
        // The reminder Lambda POSTs to this URL — restrict it to the push
        // services real browsers actually use, so a stored endpoint can never
        // aim our sender at an arbitrary host.
        let host = '';
        try {
          host = new URL(endpoint).hostname;
        } catch {
          return json(400, { error: 'invalid push subscription' });
        }
        const allowedHost =
          host === 'fcm.googleapis.com' ||
          host === 'updates.push.services.mozilla.com' ||
          host === 'web.push.apple.com' ||
          host.endsWith('.push.apple.com') ||
          host.endsWith('.notify.windows.com');
        if (!allowedHost) return json(400, { error: 'unsupported push service' });
        const id = createHash('sha256').update(endpoint).digest('hex').slice(0, 32);
        await putJson(`users/${sub}/push/${id}.json`, {
          endpoint,
          keys: { p256dh, auth },
          createdAt: new Date().toISOString(),
        });
        return json(200, { ok: true });
      }

      case 'POST /push/unsubscribe': {
        const input = JSON.parse(event.body ?? '{}');
        // Web devices identify by endpoint URL, native iOS by APNs token —
        // both were hashed the same way at subscribe time.
        const endpoint =
          typeof input.endpoint === 'string'
            ? input.endpoint
            : typeof input.token === 'string'
              ? input.token.toLowerCase()
              : '';
        if (!endpoint) return json(400, { error: 'endpoint required' });
        const id = createHash('sha256').update(endpoint).digest('hex').slice(0, 32);
        await s3.send(
          new DeleteObjectCommand({ Bucket: BUCKET, Key: `users/${sub}/push/${id}.json` }),
        );
        return { statusCode: 204 };
      }

      // ---- weight log (per pet) ----

      case 'GET /pets/{petId}/weights': {
        const stored = await readJson<{ entries: WeightEntry[] }>(`${petPrefix}weights.json`);
        return json(200, { entries: stored?.entries ?? [] });
      }

      case 'POST /pets/{petId}/weights': {
        const input = JSON.parse(event.body ?? '{}');
        const date = input.date;
        const unit = input.unit === 'kg' ? 'kg' : input.unit === 'lb' ? 'lb' : null;
        const weight =
          typeof input.weight === 'number' && input.weight > 0 && input.weight <= 2000
            ? Math.round(input.weight * 100) / 100
            : null;
        if (!isWeightDate(date)) return json(400, { error: 'date must be a real day, not in the future' });
        if (!unit) return json(400, { error: 'unit must be lb or kg' });
        if (weight === null) return json(400, { error: 'weight must be a positive number' });
        if ((await readJson(petKey)) === null) return json(404, { error: 'not found' });

        const entry: WeightEntry = {
          date,
          weight,
          unit,
          by: await actorEmail(sub),
          at: new Date().toISOString(),
        };
        let entries: WeightEntry[] = [];
        for (let attempt = 0; ; attempt++) {
          const { value, etag } = await readJsonTagged<{ entries: WeightEntry[] }>(
            `${petPrefix}weights.json`,
          );
          // One entry per date: same-date logs replace (typo correction).
          entries = [...(value?.entries ?? []).filter((e) => e.date !== date), entry]
            .sort((a, b) => a.date.localeCompare(b.date))
            .slice(-MAX_WEIGHT_ENTRIES);
          if (await putJsonGuarded(`${petPrefix}weights.json`, { entries }, etag)) break;
          if (attempt >= 3) return json(409, { error: 'busy, try again' });
        }

        // Keep the profile's display weight in sync with the newest entry.
        const latest = entries[entries.length - 1];
        const pet = await readJson<Record<string, unknown>>(petKey);
        if (pet && latest.date === date) {
          await putJson(petKey, { ...pet, weight: formatWeight(latest) });
        }
        return json(200, { entries });
      }

      case 'DELETE /pets/{petId}/weights/{date}': {
        const date = event.pathParameters?.date;
        if (!isStrictDay(date)) return json(400, { error: 'invalid date' });
        let entries: WeightEntry[] = [];
        let removed: WeightEntry | undefined;
        for (let attempt = 0; ; attempt++) {
          const { value, etag } = await readJsonTagged<{ entries: WeightEntry[] }>(
            `${petPrefix}weights.json`,
          );
          removed = (value?.entries ?? []).find((e) => e.date === date);
          if (!removed) return json(404, { error: 'not found' });
          entries = (value?.entries ?? []).filter((e) => e.date !== date);
          if (await putJsonGuarded(`${petPrefix}weights.json`, { entries }, etag)) break;
          if (attempt >= 3) return json(409, { error: 'busy, try again' });
        }
        // If the profile was showing the deleted entry, fall back to the
        // newest remaining one (a hand-typed profile weight is left alone).
        const pet = await readJson<Record<string, unknown>>(petKey);
        if (pet && pet.weight === formatWeight(removed)) {
          const latest = entries[entries.length - 1];
          await putJson(petKey, { ...pet, weight: latest ? formatWeight(latest) : undefined });
        }
        return json(200, { entries });
      }

      // ---- roadmap voting (authed) ----

      case 'GET /roadmap/votes': {
        // Which items has THIS user voted for (drives the active chip state).
        const items = await readRoadmapItems();
        const voted: string[] = [];
        await Promise.all(
          items.map(async (i) => {
            try {
              await s3.send(
                new HeadObjectCommand({ Bucket: BUCKET, Key: `roadmap/votes/${i.id}/${sub}` }),
              );
              voted.push(i.id);
            } catch {
              /* no vote */
            }
          }),
        );
        return json(200, { voted });
      }

      case 'POST /roadmap/vote': {
        const input = JSON.parse(event.body ?? '{}');
        const itemId = input.itemId;
        if (!isRoadmapId(itemId)) return json(400, { error: 'itemId required' });
        const items = await readRoadmapItems();
        if (!items.some((i) => i.id === itemId)) return json(404, { error: 'not found' });
        const voteKey = `roadmap/votes/${itemId}/${sub}`;
        let voted: boolean;
        try {
          await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: voteKey }));
          await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: voteKey }));
          voted = false;
        } catch {
          await s3.send(
            new PutObjectCommand({ Bucket: BUCKET, Key: voteKey, Body: '', ContentType: 'text/plain' }),
          );
          voted = true;
        }
        return json(200, { itemId, voted, votes: await countVotes(itemId) });
      }

      // ---- family / household ----

      case 'GET /household': {
        const membership = await readMemberOf(sub);
        if (membership) {
          return json(200, {
            role: 'member',
            ownerEmail: membership.ownerEmail,
            joinedAt: membership.joinedAt,
          });
        }
        const [raw, ent] = await Promise.all([readHousehold(sub), getEntitlements(sub)]);
        const { h, changed } = await pruneInvites(raw);
        if (changed) await putJson(`users/${sub}/household.json`, h);
        return json(200, {
          role: 'owner',
          members: h.members.map((m) => ({ sub: m.sub, email: m.email, joinedAt: m.joinedAt })),
          invites: h.invites.map((i) => ({
            token: i.token,
            url: `${APP_URL}/join/${i.token}`,
            expiresAt: i.expiresAt,
            sentTo: i.sentTo,
          })),
          maxMembers: ent.maxMembers,
        });
      }

      case 'POST /household/invites': {
        // Members can't build households of their own (no chains), so being
        // in one blocks inviting.
        if (await readMemberOf(sub)) {
          return json(409, { error: 'ALREADY_IN_FAMILY' });
        }
        // Optional: an email address to send the invite to directly.
        const input = JSON.parse(event.body ?? '{}');
        const sentTo =
          typeof input.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)
            ? input.email.slice(0, 254)
            : undefined;
        if (typeof input.email === 'string' && input.email.trim() !== '' && !sentTo) {
          return json(400, { error: 'invalid email address' });
        }
        // Prune expired invite token objects up front (their household entries
        // are filtered inside the guarded update below).
        const ent = await getEntitlements(sub);
        await pruneInvites(await readHousehold(sub));
        const token = randomUUID();
        const createdAt = new Date().toISOString();
        const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
        const ownerEmail = await getUserEmail(sub);
        const url = `${APP_URL}/join/${token}`;
        await putJson(`invites/${token}.json`, { ownerSub: sub, ownerEmail, createdAt, expiresAt, sentTo });
        const added = await updateHousehold(sub, (h) => {
          const now = Date.now();
          h.invites = h.invites.filter((i) => Date.parse(i.expiresAt) > now);
          // Pending invites count against the cap — an invite is a promised seat.
          if (h.members.length + h.invites.length >= ent.maxMembers) return null;
          h.invites.push({ token, createdAt, expiresAt, ...(sentTo ? { sentTo } : {}) });
          return { result: true };
        });
        if (added === null) {
          await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: `invites/${token}.json` }));
          return json(409, { error: 'MEMBER_LIMIT_REACHED', maxMembers: ent.maxMembers });
        }

        if (sentTo && !(await bumpInviteEmailQuota(sub))) {
          // Invite exists and works as a link; only the email is refused.
          return json(200, { token, url, expiresAt, sentTo, emailDelivered: false });
        }
        if (sentTo) {
          // Send AFTER the invite exists; a failed send leaves a working
          // link the owner can still share by hand.
          try {
            await ses.send(
              new SendEmailCommand({
                FromEmailAddress: FROM_EMAIL,
                Destination: { ToAddresses: [sentTo] },
                Content: {
                  Simple: {
                    Subject: {
                      Data: `${ownerEmail} invited you to their Petshots family 🐾`,
                      Charset: 'UTF-8',
                    },
                    Body: {
                      Text: {
                        Data: [
                          `Hi,`,
                          ``,
                          `${ownerEmail} uses Petshots to keep their pets' vaccine records,`,
                          `medications, and daily care in one place — and they'd like to share`,
                          `it with you.`,
                          ``,
                          `Accept the invite (a free account takes a minute):`,
                          url,
                          ``,
                          `This link expires in 7 days. If you weren't expecting this, you can`,
                          `ignore it — nothing is shared until you accept.`,
                          ``,
                          `— The Petshots team`,
                        ].join('\n'),
                        Charset: 'UTF-8',
                      },
                    },
                  },
                },
              }),
            );
          } catch (e) {
            console.error(`invite email to ${sentTo} failed`, e);
            return json(200, { token, url, expiresAt, sentTo, emailDelivered: false });
          }
        }
        return json(200, { token, url, expiresAt, sentTo, emailDelivered: sentTo ? true : undefined });
      }

      case 'DELETE /household/invites/{token}': {
        const token = event.pathParameters?.token;
        if (!isUuid(token)) return json(404, { error: 'not found' });
        const h = await readHousehold(sub);
        // Only the invite's owner can revoke it — it must be in THEIR list.
        if (!h.invites.some((i) => i.token === token)) return json(404, { error: 'not found' });
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: `invites/${token}.json` }));
        h.invites = h.invites.filter((i) => i.token !== token);
        await putJson(`users/${sub}/household.json`, h);
        return { statusCode: 204 };
      }

      case 'POST /household/join': {
        const input = JSON.parse(event.body ?? '{}');
        const token = typeof input.token === 'string' ? input.token : undefined;
        if (!isUuid(token)) return json(400, { error: 'token required' });
        const inv = await readJson<{ ownerSub: string; ownerEmail: string; expiresAt: string }>(
          `invites/${token}.json`,
        );
        const existing = await readMemberOf(sub);
        if (existing) {
          // Re-clicking an already-used link (its token object is deleted on
          // join) shouldn't error out — but a live invite to a DIFFERENT
          // family still conflicts.
          if (!inv || inv.ownerSub === existing.ownerSub) {
            return json(200, { ownerEmail: existing.ownerEmail });
          }
          return json(409, { error: 'ALREADY_IN_FAMILY' });
        }
        if (!inv || Date.parse(inv.expiresAt) <= Date.now()) {
          return json(404, { error: 'INVITE_NOT_FOUND' });
        }
        if (inv.ownerSub === sub) return json(409, { error: 'OWN_INVITE' });
        const ownFamily = await readHousehold(sub);
        if (ownFamily.members.length > 0) {
          return json(409, { error: 'HAS_OWN_FAMILY' });
        }
        const ownerEnt = await getEntitlements(inv.ownerSub);
        const email = await getUserEmail(sub);
        const joinedAt = new Date().toISOString();
        // memberOf first: if the household.json write fails, the pointer is
        // harmless (owner's file omits them; a retry heals it).
        await putJson(`users/${sub}/memberOf.json`, {
          ownerSub: inv.ownerSub,
          ownerEmail: inv.ownerEmail,
          joinedAt,
        });
        const joined = await updateHousehold(inv.ownerSub, (h) => {
          if (!h.members.some((m) => m.sub === sub)) {
            if (h.members.length >= ownerEnt.maxMembers) return null;
            h.members.push({ sub, email, joinedAt });
          }
          h.invites = h.invites.filter((i) => i.token !== token);
          return { result: true };
        });
        if (joined === null) {
          await s3.send(
            new DeleteObjectCommand({ Bucket: BUCKET, Key: `users/${sub}/memberOf.json` }),
          );
          return json(409, { error: 'MEMBER_LIMIT_REACHED' });
        }
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: `invites/${token}.json` }));
        return json(200, { ownerEmail: inv.ownerEmail });
      }

      case 'DELETE /household/members/{memberSub}': {
        const memberSub = event.pathParameters?.memberSub;
        if (!isUuid(memberSub)) return json(404, { error: 'not found' });
        const removed = await updateHousehold(sub, (h) => {
          if (!h.members.some((m) => m.sub === memberSub)) return null;
          h.members = h.members.filter((m) => m.sub !== memberSub);
          return { result: true };
        });
        if (removed === null) return json(404, { error: 'not found' });
        await s3.send(
          new DeleteObjectCommand({ Bucket: BUCKET, Key: `users/${memberSub}/memberOf.json` }),
        );
        return { statusCode: 204 };
      }

      case 'POST /household/leave': {
        const membership = await readMemberOf(sub);
        if (!membership) return json(404, { error: 'not in a family' });
        await updateHousehold(membership.ownerSub, (h) => {
          h.members = h.members.filter((m) => m.sub !== sub);
          return { result: true };
        });
        await s3.send(
          new DeleteObjectCommand({ Bucket: BUCKET, Key: `users/${sub}/memberOf.json` }),
        );
        return { statusCode: 204 };
      }

      default:
        return json(404, { error: 'not found' });
    }
  } catch (e) {
    // Billing routes before setup-stripe.mjs has run: the secret isn't there yet.
    if ((e as { name?: string }).name === 'ResourceNotFoundException') {
      return json(503, { error: 'billing not configured yet' });
    }
    console.error('handler error', e);
    return json(500, { error: 'internal error' });
  }
};
