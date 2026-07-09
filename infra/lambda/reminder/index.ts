import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import webpush from 'web-push';
import { randomUUID, sign } from 'node:crypto';
import * as http2 from 'node:http2';
// All product-tunable numbers (cadences, windows, TTLs) live in one
// documented file — edit values there, not here.
import { REMINDERS, DIGEST, PUSH, EMAIL } from '../shared/config';

const s3 = new S3Client({
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
const ses = new SESv2Client({ region: 'us-east-1' });
const sm = new SecretsManagerClient({});
const BUCKET = process.env.UPLOADS_BUCKET!;
const VAPID_SECRET_NAME = process.env.VAPID_SECRET_NAME ?? 'petshots/vapid';

// ---- web push ----
// VAPID keys from Secrets Manager, loaded lazily and cached per container.
// Push mirrors the reminder email: same trigger, same headline, tap opens
// the dashboard. A device the push service rejects (404/410 = expired or
// revoked subscription) is deleted so we never keep knocking.
interface WebPushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
// Native iOS devices store an APNs device token instead of a web endpoint.
interface ApnsSub {
  platform: 'apns';
  token: string;
}
type PushSub = WebPushSub | ApnsSub;
let vapidReady: boolean | null = null;
async function ensureVapid(): Promise<boolean> {
  if (vapidReady !== null) return vapidReady;
  try {
    const res = await sm.send(new GetSecretValueCommand({ SecretId: VAPID_SECRET_NAME }));
    const cfg = JSON.parse(res.SecretString!) as {
      publicKey: string;
      privateKey: string;
      subject: string;
    };
    webpush.setVapidDetails(cfg.subject, cfg.publicKey, cfg.privateKey);
    vapidReady = true;
  } catch (e) {
    console.error('vapid secret unavailable — push disabled this run', e);
    vapidReady = false;
  }
  return vapidReady;
}

async function listPushSubs(userPrefix: string): Promise<{ key: string; sub: PushSub }[]> {
  const list = await s3.send(
    new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${userPrefix}push/` }),
  );
  const out: { key: string; sub: PushSub }[] = [];
  for (const it of list.Contents ?? []) {
    const raw = await readJson<WebPushSub & ApnsSub>(it.Key!);
    if (!raw) continue;
    if (raw.platform === 'apns' && typeof raw.token === 'string') {
      out.push({ key: it.Key!, sub: { platform: 'apns', token: raw.token } });
    } else if (raw.endpoint && raw.keys?.p256dh && raw.keys?.auth) {
      out.push({ key: it.Key!, sub: { endpoint: raw.endpoint, keys: raw.keys } });
    }
  }
  return out;
}

// ---- native iOS push (APNs, token-based auth) ----
// Config from Secrets Manager `petshots/apns`:
//   { teamId, keyId, privateKey (the .p8 PEM), bundleId, environment? }
// environment: 'sandbox' for dev builds from Xcode, omit/'production' for
// TestFlight + App Store. PLACEHOLDER until the Apple Developer account
// exists — a missing or incomplete secret just skips iOS pushes (logged
// once per run); email and web push are unaffected. Setup steps in IOS.md.
const APNS_SECRET_NAME = process.env.APNS_SECRET_NAME ?? 'petshots/apns';
interface ApnsConfig {
  teamId: string;
  keyId: string;
  privateKey: string;
  bundleId: string;
  environment?: string;
}
let apnsCfg: ApnsConfig | null | undefined;
async function ensureApns(): Promise<ApnsConfig | null> {
  if (apnsCfg !== undefined) return apnsCfg;
  try {
    const res = await sm.send(new GetSecretValueCommand({ SecretId: APNS_SECRET_NAME }));
    const cfg = JSON.parse(res.SecretString!) as ApnsConfig;
    const complete =
      !!cfg.teamId && !!cfg.keyId && !!cfg.bundleId &&
      typeof cfg.privateKey === 'string' && cfg.privateKey.includes('PRIVATE KEY');
    apnsCfg = complete ? cfg : null;
    if (!apnsCfg) console.log('apns secret incomplete/placeholder — iOS push skipped this run');
  } catch {
    apnsCfg = null;
    console.log('apns secret unavailable — iOS push skipped (expected until Apple Developer setup)');
  }
  return apnsCfg;
}

// Provider JWT (ES256), cached and reissued after 45 min — Apple wants
// tokens refreshed between 20 and 60 minutes.
let apnsJwtCache: { jwt: string; iat: number } | null = null;
function apnsJwt(cfg: ApnsConfig): string {
  const now = Math.floor(Date.now() / 1000);
  if (apnsJwtCache && now - apnsJwtCache.iat < 45 * 60) return apnsJwtCache.jwt;
  const b64u = (s: string) => Buffer.from(s).toString('base64url');
  const unsigned = `${b64u(JSON.stringify({ alg: 'ES256', kid: cfg.keyId }))}.${b64u(
    JSON.stringify({ iss: cfg.teamId, iat: now }),
  )}`;
  // JWT ES256 wants the raw r||s signature, not ASN.1 DER.
  const sig = sign('sha256', Buffer.from(unsigned), {
    key: cfg.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  apnsJwtCache = { jwt: `${unsigned}.${sig.toString('base64url')}`, iat: now };
  return apnsJwtCache.jwt;
}

// One HTTP/2 POST per device token. Volume is a handful of devices per daily
// run, so a connection per send is fine.
function apnsSend(
  cfg: ApnsConfig,
  deviceToken: string,
  payload: unknown,
): Promise<{ status: number; reason?: string }> {
  return new Promise((resolve, reject) => {
    const host =
      cfg.environment === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
    const client = http2.connect(`https://${host}`);
    client.on('error', reject);
    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      authorization: `bearer ${apnsJwt(cfg)}`,
      'apns-topic': cfg.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor(Date.now() / 1000) + PUSH.APNS_EXPIRY_SECONDS),
    });
    req.setTimeout(10_000, () => {
      client.close();
      reject(new Error('apns timeout'));
    });
    let status = 0;
    let body = '';
    req.on('response', (headers) => {
      status = Number(headers[':status'] ?? 0);
    });
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      client.close();
      let reason: string | undefined;
      try {
        reason = (JSON.parse(body) as { reason?: string }).reason;
      } catch {
        /* empty body on success */
      }
      resolve({ status, reason });
    });
    req.on('error', (e) => {
      client.close();
      reject(e);
    });
    req.end(JSON.stringify(payload));
  });
}

async function sendPushes(
  userPrefix: string,
  title: string,
  body: string,
): Promise<number> {
  const subs = await listPushSubs(userPrefix);
  let sent = 0;
  for (const { key, sub } of subs) {
    // Native iOS device → APNs. Dead tokens (410 Unregistered, or 400
    // BadDeviceToken from an env mismatch/uninstall) are pruned like
    // expired web-push endpoints.
    if ('token' in sub) {
      const cfg = await ensureApns();
      if (!cfg) continue;
      try {
        const res = await apnsSend(cfg, sub.token, {
          aps: { alert: { title, body }, sound: 'default' },
          url: '/dashboard',
        });
        if (res.status === 200) {
          sent++;
        } else if (
          res.status === 410 ||
          (res.status === 400 && res.reason === 'BadDeviceToken')
        ) {
          await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
          console.log(`pruned dead APNs token ${key}`);
        } else {
          console.error(`apns push to ${key} failed: ${res.status} ${res.reason ?? ''}`);
        }
      } catch (e) {
        console.error(`apns push to ${key} failed`, e);
      }
      continue;
    }
    if (!(await ensureVapid())) continue;
    try {
      await webpush.sendNotification(
        sub as webpush.PushSubscription,
        JSON.stringify({ title, body, url: `${APP_URL}/dashboard` }),
        { TTL: PUSH.WEB_PUSH_TTL_SECONDS },
      );
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) {
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
        console.log(`pruned expired push subscription ${key}`);
      } else {
        console.error(`push to ${key} failed`, e);
      }
    }
  }
  return sent;
}
const FROM_EMAIL = process.env.FROM_EMAIL ?? EMAIL.FROM_EMAIL;
const APP_URL = process.env.APP_URL ?? EMAIL.APP_URL;

interface UserSettings {
  email?: string;
  remindersEnabled?: boolean;
  reminderDays?: number[];
  emailOptOut?: boolean; // master kill-switch: true = never email this user
  unsubToken?: string; // per-user secret for the no-login unsubscribe link
  weeklyDigest?: boolean; // Sunday summary; absent = on (requires remindersEnabled)
}

interface DocMeta {
  label: string;
  expiry?: string;
  remindersEnabled?: boolean;
}

interface Med {
  id: string;
  name: string;
  interval: number;
  unit: 'day' | 'week' | 'month';
  nextDue: string;
  remindersEnabled: boolean;
  lastGiven?: string;
  dismissed?: boolean; // "stop tracking" — never considered due
}

async function readJson<T>(key: string): Promise<T | null> {
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return JSON.parse(await obj.Body!.transformToString()) as T;
  } catch (e) {
    if ((e as { name?: string }).name === 'NoSuchKey') return null;
    throw e;
  }
}

function decodeMeta(seg: string | undefined): DocMeta {
  const raw = decodeURIComponent(seg ?? '');
  try {
    const m = JSON.parse(raw);
    if (m && typeof m === 'object') {
      return {
        label: String(m.label ?? ''),
        expiry: m.expiry ? String(m.expiry) : undefined,
        remindersEnabled: m.remindersEnabled !== false,
      };
    }
  } catch { /* legacy plain-label key */ }
  return { label: raw, remindersEnabled: true };
}

function daysUntil(day: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(`${day}T00:00:00`);
  return Math.round((d.getTime() - today.getTime()) / 86_400_000);
}

type Phase = 'overdue' | 'today' | 'upcoming';

function phaseFor(days: number): Phase {
  if (days > 0) return 'upcoming';
  if (days === 0) return 'today';
  return 'overdue';
}

// Shared overdue cadence for both vaccines and meds: weekly nags at first,
// then taper to monthly so a long-neglected record doesn't nag forever.
// NaN days (bad date) never matches. Intervals live in shared/config.ts.
function overdueCadenceMatch(overdueDays: number): boolean {
  if (overdueDays <= 0) return false;
  if (overdueDays <= REMINDERS.OVERDUE_WEEKLY_WINDOW_DAYS) {
    return overdueDays % REMINDERS.OVERDUE_WEEKLY_INTERVAL_DAYS === 0;
  }
  return overdueDays % REMINDERS.OVERDUE_MONTHLY_INTERVAL_DAYS === 0;
}

// Vaccine trigger days = whatever the user picked in Settings, PLUS a forced
// "final countdown" (FINAL_COUNTDOWN_DAYS before) so the last-mile warning
// never depends on the user having picked those specific milestones, PLUS the
// expiry day itself. Once past expiry, hand off to the overdue cadence.
function docShouldRemind(days: number, userDays: readonly number[]): boolean {
  if (days > 0) return userDays.includes(days) || REMINDERS.FINAL_COUNTDOWN_DAYS.includes(days);
  if (days === 0) return true;
  return overdueCadenceMatch(-days);
}

// A med reminder fires on the due day, then on the overdue cadence, plus (for
// meds with a week-or-longer cadence) a single heads-up MED_HEADSUP_DAYS
// before — skipped for daily/short-cycle meds where "coming due" is
// meaningless.
function medShouldRemind(days: number, effectiveIntervalDays: number): boolean {
  if (days === 0) return true;
  if (days > 0) {
    return (
      days === REMINDERS.MED_HEADSUP_DAYS &&
      effectiveIntervalDays >= REMINDERS.MED_HEADSUP_MIN_INTERVAL_DAYS
    );
  }
  return overdueCadenceMatch(-days);
}

function effectiveMedIntervalDays(unit: Med['unit'], interval: number): number {
  if (unit === 'day') return interval;
  if (unit === 'week') return interval * 7;
  return interval * 30; // month, approximate — only used for the >=7-day gate
}

function formatDate(d: string): string {
  return new Date(`${d}T00:00:00`).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

interface DueDoc { petName: string; label: string; expiry: string; days: number; phase: Phase }
interface DueMed { petName: string; name: string; nextDue: string; days: number; phase: Phase }
interface Birthday { petName: string; age: number }

// True when today (Lambda runs in UTC) is the pet's birthday. Feb-29 birthdays
// are celebrated on Feb 28 in non-leap years rather than skipped.
function isBirthdayToday(dob: string, today: Date): boolean {
  const m = dob.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const [, , mm, dd] = m;
  const tm = String(today.getMonth() + 1).padStart(2, '0');
  const td = String(today.getDate()).padStart(2, '0');
  if (mm === tm && dd === td) return true;
  if (mm === '02' && dd === '29' && tm === '02' && td === '28') {
    const y = today.getFullYear();
    const isLeap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    return !isLeap;
  }
  return false;
}

function docBullet(d: DueDoc): string {
  if (d.phase === 'overdue') {
    const od = -d.days;
    return `• ${d.petName}'s ${d.label} — expired ${formatDate(d.expiry)} (${od} day${od === 1 ? '' : 's'} overdue)`;
  }
  if (d.phase === 'today') {
    return `• ${d.petName}'s ${d.label} — expires today`;
  }
  const when = d.days === 1 ? 'tomorrow' : `in ${d.days} days`;
  return `• ${d.petName}'s ${d.label} — expires ${formatDate(d.expiry)} (${when})`;
}

function medBullet(m: DueMed): string {
  if (m.phase === 'overdue') {
    const od = -m.days;
    return `• ${m.petName}'s ${m.name} — ${od} day${od === 1 ? '' : 's'} overdue (was due ${formatDate(m.nextDue)})`;
  }
  if (m.phase === 'today') {
    return `• ${m.petName}'s ${m.name} — due today`;
  }
  const when = m.days === 1 ? 'tomorrow' : `in ${m.days} days`;
  return `• ${m.petName}'s ${m.name} — due ${formatDate(m.nextDue)} (${when})`;
}

// Combines docs + meds for one urgency tier into a single bulleted block,
// most-urgent-first (most overdue, or soonest-upcoming).
function urgencySection(title: string, docs: DueDoc[], meds: DueMed[]): string | null {
  if (docs.length === 0 && meds.length === 0) return null;
  const items = [
    ...meds.map((m) => ({ days: m.days, text: medBullet(m) })),
    ...docs.map((d) => ({ days: d.days, text: docBullet(d) })),
  ].sort((a, b) => a.days - b.days);
  return `${title}:\n${items.map((i) => i.text).join('\n')}`;
}

function composeEmail(
  dueDocs: DueDoc[],
  dueMeds: DueMed[],
  birthdays: Birthday[],
  unsubUrl: string,
): { subject: string; body: string } {
  const overdueDocs = dueDocs.filter((d) => d.phase === 'overdue');
  const overdueMeds = dueMeds.filter((m) => m.phase === 'overdue');
  const todayDocs = dueDocs.filter((d) => d.phase === 'today');
  const todayMeds = dueMeds.filter((m) => m.phase === 'today');
  const upcomingDocs = dueDocs.filter((d) => d.phase === 'upcoming');
  const upcomingMeds = dueMeds.filter((m) => m.phase === 'upcoming');

  const overdueCount = overdueDocs.length + overdueMeds.length;
  const todayCount = todayDocs.length + todayMeds.length;
  const upcomingCount = upcomingDocs.length + upcomingMeds.length;
  const total = overdueCount + todayCount + upcomingCount;

  let subject: string;
  if (total === 0 && birthdays.length > 0) {
    const b = birthdays[0];
    subject =
      birthdays.length > 1
        ? `🎂 ${birthdays.length} Petshots birthdays today!`
        : b.age >= 1
          ? `🎂 ${b.petName} turns ${b.age} today!`
          : `🎂 Happy birthday, ${b.petName}!`;
  } else if (overdueCount === 1 && total === 1) {
    if (overdueDocs.length === 1) {
      const d = overdueDocs[0];
      const od = -d.days;
      subject = `⚠️ ${d.petName}'s ${d.label} is ${od} day${od === 1 ? '' : 's'} overdue`;
    } else {
      const m = overdueMeds[0];
      const od = -m.days;
      subject = `⚠️ ${m.petName}'s ${m.name} is ${od} day${od === 1 ? '' : 's'} overdue`;
    }
  } else if (overdueCount > 0) {
    subject = `⚠️ Petshots: ${overdueCount} overdue reminder${overdueCount !== 1 ? 's' : ''}`;
  } else if (todayCount === 1 && total === 1) {
    subject = todayDocs.length === 1
      ? `Reminder: ${todayDocs[0].petName}'s ${todayDocs[0].label} expires today`
      : `Reminder: ${todayMeds[0].petName}'s ${todayMeds[0].name} is due today`;
  } else if (todayCount > 0) {
    subject = `Petshots: ${todayCount} reminder${todayCount !== 1 ? 's' : ''} due today`;
  } else if (upcomingCount === 1 && upcomingMeds.length === 1) {
    const m = upcomingMeds[0];
    subject = `Reminder: ${m.petName}'s ${m.name} is due in ${m.days} day${m.days !== 1 ? 's' : ''}`;
  } else if (upcomingCount === 1) {
    const d = upcomingDocs[0];
    subject = `Reminder: ${d.petName}'s ${d.label} expires in ${d.days} day${d.days !== 1 ? 's' : ''}`;
  } else if (upcomingMeds.length === 0) {
    subject = `Petshots: ${upcomingCount} vaccine records expiring soon`;
  } else if (upcomingDocs.length === 0) {
    subject = `Petshots: ${upcomingCount} medications due soon`;
  } else {
    subject = `Petshots: ${upcomingCount} pet care reminders`;
  }

  const sections: string[] = [];
  if (birthdays.length > 0) {
    sections.push(
      birthdays
        .map((b) =>
          b.age >= 1
            ? `🎂 ${b.petName} turns ${b.age} today — happy birthday!`
            : `🎂 It's ${b.petName}'s birthday today — happy birthday!`,
        )
        .join('\n'),
    );
  }
  const overdueSection = urgencySection('⚠️ Overdue', overdueDocs, overdueMeds);
  if (overdueSection) sections.push(overdueSection);
  const todaySection = urgencySection('📅 Due today', todayDocs, todayMeds);
  if (todaySection) sections.push(todaySection);
  const upcomingSection = urgencySection('Coming up', upcomingDocs, upcomingMeds);
  if (upcomingSection) sections.push(upcomingSection);

  const anyMeds = dueMeds.length > 0;
  const body = [
    `Hi,`,
    ``,
    total === 0 ? `A little celebration from Petshots:` : `Here's your Petshots reminder:`,
    ``,
    sections.join('\n\n'),
    ``,
    anyMeds
      ? `Mark meds as given and keep records up to date: ${APP_URL}/dashboard`
      : `Keep records up to date: ${APP_URL}/dashboard`,
    ``,
    `— The Petshots team`,
    ``,
    `Manage reminders in Settings or on each pet's Meds tab.`,
    `Unsubscribe from all Petshots email: ${unsubUrl}`,
  ].join('\n');

  return { subject, body };
}

// ---- weekly digest ----
// Sunday summary per user: last 7 days of the daily checklist (feedings,
// walks, counters, meds given, moods, who did what) + weight changes. Only
// sends when there was actual activity — silence beats an empty email.

interface DailyCheckEntry {
  by: string;
  at: string;
  count?: number;
  events?: { by: string; at: string }[];
}
interface DailyFileView {
  items: { id: string; name: string; kind?: string }[] | null;
  log?: Record<string, Record<string, DailyCheckEntry>>;
  moods?: Record<string, { value: number; by: string; at: string }>;
}
interface WeightEntryView {
  date: string;
  weight: number;
  unit: string;
}

const MOOD_EMOJI: Record<number, string> = { 1: '😢', 2: '😕', 3: '😐', 4: '🙂', 5: '😄' };
const MOOD_LABEL: Record<number, string> = { 1: 'rough', 2: 'off', 3: 'okay', 4: 'good', 5: 'great' };
// Preset names for uncustomized lists; preset-poop is species-dependent
// (dogs poop, cats have a litter box) — resolved by the caller.
function digestPresetName(itemId: string, species: string | undefined): string | undefined {
  if (itemId === 'preset-breakfast') return 'Breakfast';
  if (itemId === 'preset-dinner') return 'Dinner';
  if (itemId === 'preset-walk') return 'Walk';
  if (itemId === 'preset-poop') return /cat/i.test(species ?? '') ? '💩 Litter box' : '💩 Poop';
  return undefined;
}

// The digest's date window (DIGEST.LOOKBACK_DAYS long, ending today),
// oldest first.
function digestWindowDates(today: Date): string[] {
  const out: string[] = [];
  for (let i = DIGEST.LOOKBACK_DAYS - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86_400_000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// One pet's paragraph of the digest, or null if the week held nothing.
function digestPetSection(
  petName: string,
  species: string | undefined,
  daily: DailyFileView | null,
  weights: WeightEntryView[],
  dates: string[],
): string | null {
  const lines: string[] = [];
  const window = new Set(dates);

  // Mood strip, oldest → newest.
  const moods = dates
    .map((d) => daily?.moods?.[d]?.value)
    .filter((v): v is number => typeof v === 'number');
  if (moods.length > 0) {
    const avg = Math.round(moods.reduce((a, b) => a + b, 0) / moods.length);
    lines.push(
      `Mood: ${moods.map((v) => MOOD_EMOJI[v] ?? '·').join(' ')} (mostly ${MOOD_LABEL[avg] ?? 'okay'})`,
    );
  }

  // Checklist totals by item name; counters report their tallies.
  const itemNames = new Map<string, string>(
    (daily?.items ?? []).map((i) => [i.id, i.name]),
  );
  const checkCounts = new Map<string, number>();
  const byPerson = new Map<string, number>();
  let medsGiven = 0;
  for (const d of dates) {
    const day = daily?.log?.[d];
    if (!day) continue;
    for (const [itemId, entry] of Object.entries(day)) {
      const n = entry.count ?? 1;
      if (itemId.startsWith('med:')) medsGiven += 1;
      else {
        const name = itemNames.get(itemId) ?? digestPresetName(itemId, species) ?? 'Other';
        checkCounts.set(name, (checkCounts.get(name) ?? 0) + n);
      }
      for (const ev of entry.events ?? [{ by: entry.by }]) {
        const who = (ev.by ?? '').split('@')[0];
        if (who) byPerson.set(who, (byPerson.get(who) ?? 0) + 1);
      }
    }
  }
  if (checkCounts.size > 0) {
    lines.push(
      [...checkCounts.entries()].map(([name, n]) => `${name} ×${n}`).join(' · '),
    );
  }
  if (medsGiven > 0) {
    lines.push(`Meds given: ${medsGiven}`);
  }

  // Weight: newest in-window entry, plus the change across the window.
  const inWindow = weights.filter((w) => window.has(w.date));
  if (inWindow.length > 0) {
    const latest = inWindow[inWindow.length - 1];
    const before = [...weights].reverse().find((w) => w.date < dates[0]);
    const base = inWindow.length > 1 ? inWindow[0] : before;
    let deltaText = '';
    if (base && base.unit === latest.unit && base.weight !== latest.weight) {
      const d = Math.round((latest.weight - base.weight) * 100) / 100;
      deltaText = ` (${d > 0 ? '▲' : '▼'} ${Math.abs(d)} ${latest.unit})`;
    }
    lines.push(`Weight: ${latest.weight} ${latest.unit}${deltaText}`);
  }

  if (lines.length === 0) return null;
  if (byPerson.size > 1) {
    lines.push(
      `Checked off by: ${[...byPerson.entries()].map(([who, n]) => `${who} ${n}`).join(' · ')}`,
    );
  }
  return `${petName}\n${lines.map((l) => `  ${l}`).join('\n')}`;
}

// EventBridge invokes with its scheduled-event payload (no dryRun field).
// Passing { dryRun: true } via a manual invoke returns the would-send emails
// instead of sending them — the smoke test's window into this logic.
// { forceDigest: true } composes the weekly digest regardless of weekday.
// { ignoreNewUploads: true } disables the first-scan already-overdue nag so
// the smoke test can assert pure cadence behavior on freshly-seeded docs.
export const handler = async (event?: {
  dryRun?: boolean;
  forceDigest?: boolean;
  ignoreNewUploads?: boolean;
}): Promise<unknown> => {
  const dryRun = event?.dryRun === true;
  const ignoreNewUploads = event?.ignoreNewUploads === true;
  const digestDay = event?.forceDigest === true || new Date().getUTCDay() === DIGEST.DAY_UTC;
  const wouldSend: Array<{ email: string; subject: string; body: string }> = [];
  const wouldPush: Array<{ email: string; subject: string; devices: number }> = [];

  // Discover all user prefixes via delimiter listing (users/{sub}/)
  const topList = await s3.send(
    new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'users/', Delimiter: '/' }),
  );
  const userPrefixes = (topList.CommonPrefixes ?? []).map((p) => p.Prefix!);
  console.log(`Reminder run${dryRun ? ' (dry run)' : ''}: ${userPrefixes.length} user(s) found`);

  for (const userPrefix of userPrefixes) {
    try {
      const settings = await readJson<UserSettings>(`${userPrefix}settings.json`);
      // No email address on file -> nothing can be sent for this user. Vaccine
      // reminders additionally require the global settings toggle; med
      // reminders are governed by each med's own toggle.
      if (!settings?.email) continue;
      // Master kill-switch (the email unsubscribe link / Settings "pause all
      // email" toggle) — skip before any scanning.
      if (settings.emailOptOut === true) continue;
      const vaccineRemindersOn = settings.remindersEnabled === true;
      const reminderDays = settings.reminderDays?.length
        ? settings.reminderDays
        : REMINDERS.DEFAULT_REMINDER_DAYS;

      // Every email must carry a working unsubscribe link. Accounts that
      // predate unsubTokens get one minted and persisted here.
      if (!settings.unsubToken) {
        settings.unsubToken = randomUUID();
        await s3.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: `${userPrefix}settings.json`,
            Body: JSON.stringify(settings),
            ContentType: 'application/json',
          }),
        );
      }
      const userSub = userPrefix.slice('users/'.length).replace(/\/$/, '');
      const unsubUrl = `${APP_URL}/unsubscribe?u=${userSub}&t=${settings.unsubToken}`;

      // Pets this user should hear about: their own, plus the household's if
      // they're a family member (users/{sub}/memberOf.json points at the
      // owner whose prefix holds the shared pets). Each recipient's own
      // settings/milestones still govern their email.
      const petSources: { base: string; petId: string }[] = [];
      const collectPets = async (base: string) => {
        const petsList = await s3.send(
          new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${base}pets/` }),
        );
        for (const it of petsList.Contents ?? []) {
          if (it.Key!.endsWith('/pet.json')) {
            petSources.push({ base, petId: it.Key!.slice(`${base}pets/`.length).split('/')[0] });
          }
        }
      };
      await collectPets(userPrefix);
      const membership = await readJson<{ ownerSub?: string }>(`${userPrefix}memberOf.json`);
      if (membership?.ownerSub) await collectPets(`users/${membership.ownerSub}/`);

      const dueDocs: DueDoc[] = [];
      const dueMeds: DueMed[] = [];
      const birthdays: Birthday[] = [];
      const today = new Date();

      for (const { base, petId } of petSources) {
        const pet = await readJson<{ name: string; dob?: string }>(
          `${base}pets/${petId}/pet.json`,
        );
        if (!pet?.name) continue;

        // Birthday email rides the same consent signal as vaccine reminders —
        // no reminder opt-in, no unsolicited mail.
        if (vaccineRemindersOn && pet.dob && isBirthdayToday(pet.dob, today)) {
          birthdays.push({ petName: pet.name, age: today.getFullYear() - Number(pet.dob.slice(0, 4)) });
        }

        if (vaccineRemindersOn) {
          const docsList = await s3.send(
            new ListObjectsV2Command({
              Bucket: BUCKET,
              Prefix: `${base}pets/${petId}/docs/`,
            }),
          );
          for (const it of (docsList.Contents ?? []).filter((x) => !x.Key!.includes('/_archived/'))) {
            const parts = it.Key!.split('/');
            const meta = decodeMeta(parts[6]);
            if (!meta.expiry) continue;
            if (meta.remindersEnabled === false) continue;
            const days = daysUntil(meta.expiry);
            // A record uploaded ALREADY overdue may sit between taper ticks
            // (e.g. 61 days overdue waits ~29 more for day 90) and would get
            // no email for weeks. The first scan after the object appears
            // fires a one-time nag: object age < 24h is true on exactly one
            // daily run. Edits count too (PATCH rewrites the key, refreshing
            // LastModified) — one extra nag after touching an overdue record.
            const firstScanOverdue =
              !ignoreNewUploads &&
              days < 0 &&
              it.LastModified !== undefined &&
              Date.now() - it.LastModified.getTime() < REMINDERS.FIRST_SCAN_OVERDUE_WINDOW_MS;
            if (docShouldRemind(days, reminderDays) || firstScanOverdue) {
              dueDocs.push({ petName: pet.name, label: meta.label, expiry: meta.expiry, days, phase: phaseFor(days) });
            }
          }
        }

        const stored = await readJson<{ meds: Med[] }>(`${base}pets/${petId}/meds.json`);
        for (const med of stored?.meds ?? []) {
          if (med.dismissed === true || med.remindersEnabled === false || !med.nextDue) continue;
          const days = daysUntil(med.nextDue);
          const effInterval = effectiveMedIntervalDays(med.unit, med.interval);
          if (medShouldRemind(days, effInterval)) {
            dueMeds.push({ petName: pet.name, name: med.name, nextDue: med.nextDue, days, phase: phaseFor(days) });
          }
        }
      }

      // Weekly digest (Sundays) — a separate email from the reminder, sent
      // only to reminder-consented users who haven't turned the digest off,
      // and only when the week actually held activity.
      if (digestDay && vaccineRemindersOn && settings.weeklyDigest !== false) {
        const dates = digestWindowDates(today);
        const sections: string[] = [];
        const petNames: string[] = [];
        for (const { base, petId } of petSources) {
          const pet = await readJson<{ name?: string; species?: string }>(
            `${base}pets/${petId}/pet.json`,
          );
          if (!pet?.name) continue;
          const [daily, weightsStored] = await Promise.all([
            readJson<DailyFileView>(`${base}pets/${petId}/daily.json`),
            readJson<{ entries: WeightEntryView[] }>(`${base}pets/${petId}/weights.json`),
          ]);
          const section = digestPetSection(pet.name, pet.species, daily, weightsStored?.entries ?? [], dates);
          if (section) {
            sections.push(section);
            petNames.push(pet.name);
          }
        }
        if (sections.length > 0) {
          const subject =
            petNames.length === 1
              ? `🐾 ${petNames[0]}'s week at a glance`
              : `🐾 Your pets' week at a glance`;
          const body = [
            `Hi,`,
            ``,
            `Here's how the last 7 days went:`,
            ``,
            sections.join('\n\n'),
            ``,
            `Keep it up: ${APP_URL}/dashboard`,
            ``,
            `— The Petshots team`,
            ``,
            `Turn the weekly digest off in Settings.`,
            `Unsubscribe from all Petshots email: ${unsubUrl}`,
          ].join('\n');
          if (dryRun) {
            wouldSend.push({ email: settings.email, subject, body });
            console.log(`[dry run] would send digest to ${settings.email}: ${subject}`);
          } else {
            await ses.send(
              new SendEmailCommand({
                FromEmailAddress: FROM_EMAIL,
                Destination: { ToAddresses: [settings.email] },
                Content: {
                  Simple: {
                    Subject: { Data: subject, Charset: 'UTF-8' },
                    Body: { Text: { Data: body, Charset: 'UTF-8' } },
                  },
                },
              }),
            );
            console.log(`Sent weekly digest to ${settings.email}`);
          }
        }
      }

      if (dueDocs.length === 0 && dueMeds.length === 0 && birthdays.length === 0) continue;

      const { subject, body } = composeEmail(dueDocs, dueMeds, birthdays, unsubUrl);
      // Push body: the email's first couple of bullets, no boilerplate.
      const pushBody =
        body.split('\n').filter((l) => l.startsWith('•')).slice(0, 2).join('\n') ||
        'Tap to review in Petshots.';

      if (dryRun) {
        wouldSend.push({ email: settings.email, subject, body });
        const devices = (await listPushSubs(userPrefix)).length;
        if (devices > 0) wouldPush.push({ email: settings.email, subject, devices });
        console.log(`[dry run] would send to ${settings.email}: ${subject} (+${devices} push)`);
        continue;
      }

      await ses.send(
        new SendEmailCommand({
          FromEmailAddress: FROM_EMAIL,
          Destination: { ToAddresses: [settings.email] },
          Content: {
            Simple: {
              Subject: { Data: subject, Charset: 'UTF-8' },
              Body: { Text: { Data: body, Charset: 'UTF-8' } },
            },
          },
        }),
      );
      const pushed = await sendPushes(userPrefix, subject, pushBody);
      console.log(
        `Sent ${dueDocs.length + dueMeds.length} reminder(s) + ${birthdays.length} birthday(s) to ${settings.email} (+${pushed} push)`,
      );
    } catch (e) {
      console.error(`Error processing ${userPrefix}:`, e);
      // Continue to next user rather than failing the whole run.
    }
  }

  return dryRun ? { dryRun: true, wouldSend, wouldPush } : undefined;
};
