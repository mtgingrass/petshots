import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { randomUUID } from 'node:crypto';
// All product-tunable numbers (cadences, windows, TTLs) live in one
// documented file — edit values there, not here.
import { REMINDERS, DIGEST, EMAIL, LIMITS_FREE, DAILY, WEIGHTS, SUMMARY } from '../shared/config';
// The actual sentences these emails/pushes say live separately from this
// file's "how it's built and sent" logic — see copy/reminder.ts's header.
import { reminderCopy, nudgeCopy, weightNudgeCopy, digestCopy, digestInsightCopy, monthlyReportCopy } from '../shared/copy';
// Window-stats math (archive-merging, tallies, the "we noticed" line) is
// shared with the api Lambda's GET /trends — see that file's header for why.
import { mergedDailyEntries, rangeStats, pickInsight, overallCompletionPct } from '../shared/dailyStats';
// The Summary tab's persistent weekly/monthly stories — generated here on
// crons (this Lambda has the 5-minute timeout and already walks users/),
// same pipeline as the api Lambda's daily story. See summaryStory.ts.
import {
  computeStoryWindow,
  pickWindowPhotos,
  fetchImageBlocks,
  generateWindowStory,
  generateMonthStory,
  buildChips,
  buildStatsForModel,
  addDays as storyAddDays,
} from '../shared/summaryStory';
import { escapeHtml, emailHtml, petCardHtml, petRowHtml, insightRowHtml, ctaButtonHtml, infoCardHtml } from '../shared/emailHtml';
// Web push (VAPID) + native iOS push (APNs) — shared with the api Lambda's
// real-time pushes (e.g. "new photo added"). See that file's header.
import { listPushSubs as listPushSubsShared, sendPushes as sendPushesShared } from '../shared/push';

const s3 = new S3Client({
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
const ses = new SESv2Client({ region: 'us-east-1' });
const BUCKET = process.env.UPLOADS_BUCKET!;

const FROM_EMAIL = process.env.FROM_EMAIL ?? EMAIL.FROM_EMAIL;
const APP_URL = process.env.APP_URL ?? EMAIL.APP_URL;
const listPushSubs = (userPrefix: string) => listPushSubsShared(BUCKET, userPrefix);
const sendPushes = (userPrefix: string, title: string, body: string) =>
  sendPushesShared(BUCKET, userPrefix, title, body, APP_URL);

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
  dismissed?: boolean; // "archived" — hidden from view and never reminded
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
  createdAt?: string; // ISO, server-stamped when the med first appeared (absent on legacy meds)
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

// ETag-guarded pair for the one file this Lambda WRITES (the legacy
// unsubToken backfill into settings.json) — same pattern as the api Lambda's
// readJsonTagged/putJsonGuarded, so the backfill can't clobber a Settings
// save landing at the same moment as the 9:00 cron.
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

function decodeMeta(seg: string | undefined): DocMeta {
  const raw = decodeURIComponent(seg ?? '');
  try {
    const m = JSON.parse(raw);
    if (m && typeof m === 'object') {
      return {
        label: String(m.label ?? ''),
        expiry: m.expiry ? String(m.expiry) : undefined,
        remindersEnabled: m.remindersEnabled !== false,
        dismissed: m.dismissed === true ? true : undefined,
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

// Plain YYYY-MM-DD day difference (later - earlier), used for weight
// staleness where both dates are already-known strings rather than "today."
function daysBetweenDates(earlier: string, later: string): number {
  return Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);
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
    return `• ${reminderCopy.docOverdue(d.petName, d.label, formatDate(d.expiry), -d.days)}`;
  }
  if (d.phase === 'today') return `• ${reminderCopy.docToday(d.petName, d.label)}`;
  const when = d.days === 1 ? 'tomorrow' : `in ${d.days} days`;
  return `• ${reminderCopy.docUpcoming(d.petName, d.label, formatDate(d.expiry), when)}`;
}

function medBullet(m: DueMed): string {
  if (m.phase === 'overdue') {
    return `• ${reminderCopy.medOverdue(m.petName, m.name, formatDate(m.nextDue), -m.days)}`;
  }
  if (m.phase === 'today') return `• ${reminderCopy.medToday(m.petName, m.name)}`;
  const when = m.days === 1 ? 'tomorrow' : `in ${m.days} days`;
  return `• ${reminderCopy.medUpcoming(m.petName, m.name, formatDate(m.nextDue), when)}`;
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

// HTML line-builders — pet names, doc labels, and med names are user input,
// so (unlike the plain-text bullets above) each dynamic value is escaped
// individually rather than reusing the pre-formatted text bullet.
function docLineHtml(d: DueDoc): string {
  const pet = escapeHtml(d.petName);
  const label = escapeHtml(d.label);
  if (d.phase === 'overdue') return reminderCopy.docOverdue(pet, label, formatDate(d.expiry), -d.days);
  if (d.phase === 'today') return reminderCopy.docToday(pet, label);
  const when = d.days === 1 ? 'tomorrow' : `in ${d.days} days`;
  return reminderCopy.docUpcoming(pet, label, formatDate(d.expiry), when);
}
function medLineHtml(m: DueMed): string {
  const pet = escapeHtml(m.petName);
  const name = escapeHtml(m.name);
  if (m.phase === 'overdue') return reminderCopy.medOverdue(pet, name, formatDate(m.nextDue), -m.days);
  if (m.phase === 'today') return reminderCopy.medToday(pet, name);
  const when = m.days === 1 ? 'tomorrow' : `in ${m.days} days`;
  return reminderCopy.medUpcoming(pet, name, formatDate(m.nextDue), when);
}
function urgencySectionHtml(title: string, docs: DueDoc[], meds: DueMed[], color: string): string | null {
  if (docs.length === 0 && meds.length === 0) return null;
  const items = [
    ...meds.map((m) => ({ days: m.days, text: medLineHtml(m) })),
    ...docs.map((d) => ({ days: d.days, text: docLineHtml(d) })),
  ].sort((a, b) => a.days - b.days);
  return infoCardHtml(`
    <div style="font-weight:800;color:${color};margin:0 0 10px;font-size:14px;">${escapeHtml(title)}</div>
    <ul style="margin:0;padding-left:18px;color:#4b463e;">${items.map((i) => `<li style="margin:0 0 7px;">${i.text}</li>`).join('')}</ul>
  `);
}

function composeEmail(
  dueDocs: DueDoc[],
  dueMeds: DueMed[],
  birthdays: Birthday[],
  unsubUrl: string,
  showUpgrade: boolean,
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
        ? reminderCopy.subjectBirthdayMulti(birthdays.length)
        : reminderCopy.subjectBirthdaySingle(b.petName, b.age);
  } else if (overdueCount === 1 && total === 1) {
    if (overdueDocs.length === 1) {
      const d = overdueDocs[0];
      subject = reminderCopy.subjectOverdueSingleDoc(d.petName, d.label, -d.days);
    } else {
      const m = overdueMeds[0];
      subject = reminderCopy.subjectOverdueSingleMed(m.petName, m.name, -m.days);
    }
  } else if (overdueCount > 0) {
    subject = reminderCopy.subjectOverdueMulti(overdueCount);
  } else if (todayCount === 1 && total === 1) {
    subject = todayDocs.length === 1
      ? reminderCopy.subjectTodaySingleDoc(todayDocs[0].petName, todayDocs[0].label)
      : reminderCopy.subjectTodaySingleMed(todayMeds[0].petName, todayMeds[0].name);
  } else if (todayCount > 0) {
    subject = reminderCopy.subjectTodayMulti(todayCount);
  } else if (upcomingCount === 1 && upcomingMeds.length === 1) {
    const m = upcomingMeds[0];
    subject = reminderCopy.subjectUpcomingSingleMed(m.petName, m.name, m.days);
  } else if (upcomingCount === 1) {
    const d = upcomingDocs[0];
    subject = reminderCopy.subjectUpcomingSingleDoc(d.petName, d.label, d.days);
  } else if (upcomingMeds.length === 0) {
    subject = reminderCopy.subjectUpcomingDocsOnly(upcomingCount);
  } else if (upcomingDocs.length === 0) {
    subject = reminderCopy.subjectUpcomingMedsOnly(upcomingCount);
  } else {
    subject = reminderCopy.subjectUpcomingMixed(upcomingCount);
  }

  const sections: string[] = [];
  if (birthdays.length > 0) {
    sections.push(birthdays.map((b) => reminderCopy.birthdayLine(b.petName, b.age)).join('\n'));
  }
  const overdueSection = urgencySection(reminderCopy.sectionTitles.overdue, overdueDocs, overdueMeds);
  if (overdueSection) sections.push(overdueSection);
  const todaySection = urgencySection(reminderCopy.sectionTitles.today, todayDocs, todayMeds);
  if (todaySection) sections.push(todaySection);
  const upcomingSection = urgencySection(reminderCopy.sectionTitles.upcoming, upcomingDocs, upcomingMeds);
  if (upcomingSection) sections.push(upcomingSection);

  const anyMeds = dueMeds.length > 0;
  const body = [
    reminderCopy.greeting,
    ``,
    total === 0 ? reminderCopy.introCelebrationOnly : reminderCopy.introWithItems,
    ``,
    sections.join('\n\n'),
    ``,
    anyMeds ? reminderCopy.ctaWithMeds(`${APP_URL}/dashboard`) : reminderCopy.ctaDocsOnly(`${APP_URL}/dashboard`),
    ...(showUpgrade ? [``, reminderCopy.upgradeLine(LIMITS_FREE.MAX_PETS, `${APP_URL}/settings`)] : []),
    ``,
    reminderCopy.signoff,
    reminderCopy.signoffName,
    ``,
    reminderCopy.manageReminders,
    reminderCopy.unsubscribeLine(unsubUrl),
  ].join('\n');

  return { subject, body };
}

// Same content as composeEmail's body, rendered as branded HTML with the
// same free-plan upgrade line. Subject/urgency-bucketing logic is shared —
// this only re-renders the body.
function composeEmailHtml(
  dueDocs: DueDoc[],
  dueMeds: DueMed[],
  birthdays: Birthday[],
  unsubUrl: string,
  showUpgrade: boolean,
): string {
  const overdueDocs = dueDocs.filter((d) => d.phase === 'overdue');
  const overdueMeds = dueMeds.filter((m) => m.phase === 'overdue');
  const todayDocs = dueDocs.filter((d) => d.phase === 'today');
  const todayMeds = dueMeds.filter((m) => m.phase === 'today');
  const upcomingDocs = dueDocs.filter((d) => d.phase === 'upcoming');
  const upcomingMeds = dueMeds.filter((m) => m.phase === 'upcoming');
  const total = dueDocs.length + dueMeds.length;

  const sections: string[] = [];
  if (birthdays.length > 0) {
    sections.push(infoCardHtml(
      `${birthdays
        .map((b) => `<div>${reminderCopy.birthdayLine(escapeHtml(b.petName), b.age)}</div>`)
        .join('')}`,
    ));
  }
  const overdueSection = urgencySectionHtml(reminderCopy.sectionTitles.overdue, overdueDocs, overdueMeds, '#d64545');
  if (overdueSection) sections.push(overdueSection);
  const todaySection = urgencySectionHtml(reminderCopy.sectionTitles.today, todayDocs, todayMeds, '#c98a1b');
  if (todaySection) sections.push(todaySection);
  const upcomingSection = urgencySectionHtml(reminderCopy.sectionTitles.upcoming, upcomingDocs, upcomingMeds, '#555577');
  if (upcomingSection) sections.push(upcomingSection);

  const introHtml = `<p style="margin:0 0 18px;color:#4b463e;">${escapeHtml(total === 0 ? reminderCopy.introCelebrationOnly : reminderCopy.introWithItems)}</p>`;
  const ctaHtml = ctaButtonHtml(`${APP_URL}/dashboard`, reminderCopy.ctaButtonLabel);
  const upgradeHtml = showUpgrade
    ? infoCardHtml(`<div style="font-size:13px;line-height:1.6;color:#5f584f;">${reminderCopy.upgradeLineHtml(LIMITS_FREE.MAX_PETS, `${APP_URL}/settings`)}</div>`)
    : '';

  const title = total === 0 && birthdays.length > 0 ? reminderCopy.emailTitleCelebration : reminderCopy.emailTitleReminder;
  const footerHtml = `${escapeHtml(reminderCopy.manageReminders)}<br/><a href="${APP_URL}" style="color:#31584c;">petshots.app</a> · <a href="${APP_URL}/dashboard" style="color:#31584c;">Open dashboard</a> · <a href="${APP_URL}/support" style="color:#31584c;">Support</a><br/><a href="${unsubUrl}" style="color:#8a8a9a;">Unsubscribe from all Petshots email</a>`;

  return emailHtml(title, introHtml + sections.join('') + ctaHtml + upgradeHtml, footerHtml);
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
  items: { id: string; name: string; kind?: string; addedOn?: string; removedOn?: string }[] | null;
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

// ---- feeding/walk nudge ----
// Two extra EventBridge hits a day (see api-stack.ts DAILY_NUDGE rules), same
// Lambda, distinguished by event.nudge. Push-only — a same-day nag is stale
// news by the time any digest/reminder email would next go out. Reuses the
// vaccine-reminder consent toggle rather than a new opt-in (same precedent
// as the birthday email). Mirrors the Daily tab's own preset/tombstone
// model (api/index.ts) rather than a new "due time" concept — there isn't
// one; a preset is either on today's active list and unchecked, or it isn't.
function itemActiveOn(
  items: DailyFileView['items'],
  presetId: string,
  date: string,
): boolean {
  if (items === null) return true; // never customized -> presets apply as-is
  const item = items.find((i) => i.id === presetId);
  if (!item) return false; // customized away, or this pet never had it
  return (!item.addedOn || item.addedOn <= date) && (!item.removedOn || date < item.removedOn);
}

async function runDailyNudge(which: 'breakfast' | 'evening', dryRun: boolean): Promise<unknown> {
  const todayKey = new Date().toISOString().slice(0, 10);
  const wouldPush: Array<{ sub: string; body: string }> = [];

  const topList = await s3.send(
    new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'users/', Delimiter: '/' }),
  );
  const userPrefixes = (topList.CommonPrefixes ?? []).map((p) => p.Prefix!);
  const ownerPrefixes = (
    await Promise.all(
      userPrefixes.map(async (userPrefix) => {
        const membership = await readJson<{ ownerSub?: string }>(`${userPrefix}memberOf.json`);
        return membership?.ownerSub ? null : userPrefix;
      }),
    )
  ).filter((p): p is string => !!p);
  console.log(`Daily nudge (${which})${dryRun ? ' (dry run)' : ''}: ${ownerPrefixes.length} pool(s) found`);

  for (const userPrefix of ownerPrefixes) {
    try {
      const petsList = await s3.send(
        new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${userPrefix}pets/` }),
      );
      const petIds = (petsList.Contents ?? [])
        .filter((it) => it.Key!.endsWith('/pet.json'))
        .map((it) => it.Key!.slice(`${userPrefix}pets/`.length).split('/')[0]);

      const missed: string[] = [];
      for (const petId of petIds) {
        const [pet, daily] = await Promise.all([
          readJson<{ name?: string; species?: string; memorial?: boolean }>(`${userPrefix}pets/${petId}/pet.json`),
          readJson<DailyFileView>(`${userPrefix}pets/${petId}/daily.json`),
        ]);
        if (!pet?.name || pet.memorial) continue; // memorial pets get no nudges
        const todaysLog = daily?.log?.[todayKey] ?? {};
        const presetIds =
          which === 'breakfast'
            ? ['preset-breakfast']
            : /dog/i.test(pet.species ?? '')
              ? ['preset-dinner', 'preset-walk']
              : ['preset-dinner'];
        for (const id of presetIds) {
          if (itemActiveOn(daily?.items ?? null, id, todayKey) && !todaysLog[id]) {
            missed.push(`${pet.name}'s ${digestPresetName(id, pet.species)}`);
          }
        }
      }
      if (missed.length === 0) continue;

      const title = nudgeCopy.title(which);
      const body = nudgeCopy.body(missed);
      const ownerSub = userPrefix.slice('users/'.length, -1);
      const household = await readJson<{ members?: { sub: string }[] }>(`${userPrefix}household.json`);
      const recipientSubs = [ownerSub, ...((household?.members ?? []).map((m) => m.sub))];

      for (const recipientSub of recipientSubs) {
        const recipientPrefix = `users/${recipientSub}/`;
        const settings = await readJson<UserSettings>(`${recipientPrefix}settings.json`);
        if (settings?.remindersEnabled !== true) continue;

        if (dryRun) {
          wouldPush.push({ sub: recipientSub, body });
          console.log(`[dry run] would nudge ${recipientSub}: ${body}`);
          continue;
        }
        const pushed = await sendPushes(recipientPrefix, title, body);
        console.log(`Sent ${which} nudge to ${recipientSub} (+${pushed} push): ${body}`);
      }
    } catch (e) {
      console.error(`Error processing nudge for ${userPrefix}:`, e);
      // Continue to next user rather than failing the whole run.
    }
  }
  return dryRun ? { dryRun: true, wouldPush } : undefined;
}

// ---- monthly report (paid-plan perk) ----
// Fires once a month (see api-stack.ts's MonthlyReportRule, DIGEST.
// MONTHLY_REPORT_* in config.ts) via { monthlyReport: true }. Same content
// as GET /trends's month rollup, in email form — care-consistency %, mood,
// per-item %, weight, the "we noticed" headline. Free-plan users are
// skipped entirely (not even a downgrade tease), mirroring the Trends tab's
// month: null split. Household/family pets aren't included yet — owner's
// own pets only (see TODO.md).
function addToDay(ymd: string, offset: { days?: number }): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (offset.days ?? 0));
  return d.toISOString().slice(0, 10);
}

// Returns both the plain-text lines and a pre-rendered HTML card from one
// stats pass — computing thisStats/lastStats twice (once per format) would
// double the S3 reads mergedDailyEntries does for no reason.
async function composeMonthlyReportForPet(
  petName: string,
  species: string | undefined,
  userPrefix: string,
  petId: string,
  todayKey: string,
): Promise<{ text: string[]; html: string } | null> {
  const petPrefix = `${userPrefix}pets/${petId}/`;
  const [daily, weightsStored] = await Promise.all([
    readJson<DailyFileView>(`${petPrefix}daily.json`),
    readJson<{ entries: WeightEntryView[] }>(`${petPrefix}weights.json`),
  ]);
  const weights = weightsStored?.entries ?? [];
  const monthDates = Array.from({ length: 30 }, (_, i) => addToDay(todayKey, { days: -(29 - i) }));
  const priorMonthDates = Array.from({ length: 30 }, (_, i) => addToDay(todayKey, { days: -(59 - i) }));

  const [thisEntries, lastEntries] = await Promise.all([
    mergedDailyEntries(BUCKET, petPrefix, daily, monthDates, todayKey, DAILY.LOG_RETENTION_DAYS, addToDay),
    mergedDailyEntries(BUCKET, petPrefix, daily, priorMonthDates, todayKey, DAILY.LOG_RETENTION_DAYS, addToDay),
  ]);
  const thisStats = rangeStats(thisEntries, monthDates, weights);
  const lastStats = rangeStats(lastEntries, priorMonthDates, weights);
  if (thisStats.activeDates.size === 0) return null; // nothing to report

  const knownPresets = /dog/i.test(species ?? '') ? ['preset-breakfast', 'preset-dinner', 'preset-walk'] : ['preset-breakfast', 'preset-dinner'];
  const itemIds = [...new Set([...knownPresets, ...thisStats.checkCountsByItemId.keys(), ...lastStats.checkCountsByItemId.keys()])];
  const itemLabel = (id: string) => digestPresetName(id, species) ?? id;

  const lines = [petName, `  ${monthlyReportCopy.careConsistency(overallCompletionPct(thisStats, itemIds))}`];
  const rows = [petRowHtml(escapeHtml(monthlyReportCopy.careConsistency(overallCompletionPct(thisStats, itemIds))))];
  if (thisStats.moodAvg !== null) {
    lines.push(`  ${monthlyReportCopy.mood(thisStats.moodAvg, lastStats.moodAvg)}`);
    rows.push(petRowHtml(escapeHtml(monthlyReportCopy.mood(thisStats.moodAvg, lastStats.moodAvg))));
  }
  for (const id of itemIds) {
    const pct = Math.round(((thisStats.checkCountsByItemId.get(id) ?? 0) / thisStats.totalDays) * 100);
    lines.push(`  ${itemLabel(id)}: ${pct}% of days`);
    rows.push(petRowHtml(`${escapeHtml(itemLabel(id))}: ${pct}% of days`));
  }
  if (thisStats.weightLatest) {
    const delta =
      thisStats.weightFirst && thisStats.weightFirst !== thisStats.weightLatest && thisStats.weightFirst.unit === thisStats.weightLatest.unit
        ? Math.round((thisStats.weightLatest.weight - thisStats.weightFirst.weight) * 100) / 100
        : null;
    lines.push(`  ${monthlyReportCopy.weight(thisStats.weightLatest.weight, thisStats.weightLatest.unit, delta)}`);
    rows.push(petRowHtml(escapeHtml(monthlyReportCopy.weight(thisStats.weightLatest.weight, thisStats.weightLatest.unit, delta))));
  }
  const headline = pickInsight(petName, thisStats, itemLabel);
  let insight = '';
  if (headline) {
    lines.push(`  ${headline}`);
    insight = insightRowHtml(escapeHtml(headline));
  }
  return { text: lines, html: petCardHtml(petName, rows.join('') + insight) };
}

async function runMonthlyReport(dryRun: boolean): Promise<unknown> {
  const todayKey = new Date().toISOString().slice(0, 10);
  const wouldSend: Array<{ email: string; subject: string; body: string }> = [];

  const topList = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'users/', Delimiter: '/' }));
  const userPrefixes = (topList.CommonPrefixes ?? []).map((p) => p.Prefix!);
  console.log(`Monthly report run${dryRun ? ' (dry run)' : ''}: ${userPrefixes.length} user(s) found`);

  for (const userPrefix of userPrefixes) {
    try {
      const [settings, planFile] = await Promise.all([
        readJson<UserSettings>(`${userPrefix}settings.json`),
        readJson<{ plan?: string }>(`${userPrefix}plan.json`),
      ]);
      if (!settings?.email || settings.emailOptOut === true || settings.remindersEnabled !== true) continue;
      if (!settings.unsubToken) continue; // needs a working unsubscribe link; main run backfills it
      if (planFile?.plan !== 'paid') continue; // free plan: skip entirely, mirrors GET /trends's month: null

      const petsList = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${userPrefix}pets/` }));
      const petIds = (petsList.Contents ?? [])
        .filter((it) => it.Key!.endsWith('/pet.json'))
        .map((it) => it.Key!.slice(`${userPrefix}pets/`.length).split('/')[0]);

      const sections: string[] = [];
      const sectionsHtml: string[] = [];
      const petNames: string[] = [];
      for (const petId of petIds) {
        const pet = await readJson<{ name?: string; species?: string; memorial?: boolean }>(`${userPrefix}pets/${petId}/pet.json`);
        if (!pet?.name || pet.memorial) continue; // no monthly report section for memorial pets
        const report = await composeMonthlyReportForPet(pet.name, pet.species, userPrefix, petId, todayKey);
        if (report) {
          sections.push(report.text.join('\n'));
          sectionsHtml.push(report.html);
          petNames.push(pet.name);
        }
      }
      if (sections.length === 0) continue;

      const subject = petNames.length === 1 ? monthlyReportCopy.subjectSingle(petNames[0]) : monthlyReportCopy.subjectMulti;
      const userSub = userPrefix.slice('users/'.length).replace(/\/$/, '');
      const unsubUrl = `${APP_URL}/unsubscribe?u=${userSub}&t=${settings.unsubToken}`;
      const body = [
        monthlyReportCopy.greeting,
        ``,
        monthlyReportCopy.intro,
        ``,
        sections.join('\n\n'),
        ``,
        monthlyReportCopy.cta(`${APP_URL}/dashboard`),
        ``,
        monthlyReportCopy.signoff,
        monthlyReportCopy.signoffName,
        ``,
        monthlyReportCopy.unsubscribeLine(unsubUrl),
      ].join('\n');
      const footerHtml = `<a href="${APP_URL}" style="color:#31584c;">petshots.app</a> · <a href="${APP_URL}/dashboard" style="color:#31584c;">Open dashboard</a><br/><a href="${unsubUrl}" style="color:#8a8a9a;">Unsubscribe from all Petshots email</a>`;
      const html = emailHtml(
        monthlyReportCopy.intro,
        `<p style="margin:0 0 18px;color:#4b463e;">${escapeHtml(monthlyReportCopy.intro)}</p>` +
          sectionsHtml.join('') +
          ctaButtonHtml(`${APP_URL}/dashboard`, monthlyReportCopy.ctaButtonLabel),
        footerHtml,
      );

      if (dryRun) {
        wouldSend.push({ email: settings.email, subject, body });
        console.log(`[dry run] would send monthly report to ${settings.email}: ${subject}`);
        continue;
      }
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
      console.log(`Sent monthly report to ${settings.email}`);
    } catch (e) {
      console.error(`Error processing monthly report for ${userPrefix}:`, e);
    }
  }
  return dryRun ? { dryRun: true, wouldSend } : undefined;
}

// ---- persistent stories ({weeklyStories}/{monthlyStories} crons) ----
// The Summary tab's permanent record: one story per completed Mon-Sun week
// (Monday cron), consolidated into one story per month (1st-of-month cron).
// All plans; pools with nothing to tell are skipped silently. Pipeline
// lives in shared/summaryStory.ts (same code path as GET /summary's daily
// story — tone guardrails and the no-feeding rule apply everywhere).

async function putJsonPlain(key: string, body: unknown): Promise<void> {
  await s3.send(
    new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: JSON.stringify(body), ContentType: 'application/json' }),
  );
}

/** Monday of the most recently COMPLETED Mon-Sun week (yesterday's week if
 *  today is Monday). weekOf overrides for manual backfills. */
function lastCompletedWeekMonday(weekOf?: string): string {
  if (weekOf) return weekOf;
  const today = new Date().toISOString().slice(0, 10);
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // 0 = Monday
  return storyAddDays(today, -dow - 7);
}

async function runWeeklyStories(dryRun: boolean, weekOf?: string): Promise<unknown> {
  const monday = lastCompletedWeekMonday(weekOf);
  const dates = Array.from({ length: 7 }, (_, i) => storyAddDays(monday, i));
  const rangeStart = dates[0];
  const rangeEnd = dates[6];
  const topList = await s3.send(
    new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'users/', Delimiter: '/' }),
  );
  const userPrefixes = (topList.CommonPrefixes ?? []).map((p) => p.Prefix!);
  console.log(`Weekly stories (${rangeStart}..${rangeEnd})${dryRun ? ' (dry run)' : ''}: ${userPrefixes.length} user prefix(es)`);
  const results: Array<{ pool: string; status: string }> = [];

  for (const userPrefix of userPrefixes) {
    const poolSub = userPrefix.slice('users/'.length, -1);
    try {
      const weekKey = `users/${poolSub}/summary/weeks/${monday}.json`;
      if (await readJson(weekKey)) {
        results.push({ pool: poolSub, status: 'exists' });
        continue;
      }
      // Members have no pets/ under their own prefix — computeStoryWindow
      // returns zero pets and the activity gate skips them (the owner's
      // pool writes the household's one story).
      const { pets, activeDays } = await computeStoryWindow(BUCKET, poolSub, dates);
      const photoRefs = await pickWindowPhotos(BUCKET, poolSub, pets.map((p) => p.petId), rangeStart, rangeEnd);
      if (pets.length === 0 || (activeDays < SUMMARY.MIN_ACTIVE_DAYS && photoRefs.length === 0)) {
        results.push({ pool: poolSub, status: 'quiet-skip' });
        continue;
      }
      if (dryRun) {
        results.push({ pool: poolSub, status: `would-generate (${pets.length} pets, ${photoRefs.length} photos)` });
        continue;
      }
      const imageBlocks = await fetchImageBlocks(BUCKET, photoRefs);
      const story = await generateWindowStory({
        petNames: pets.map((p) => p.name),
        days: 7,
        statsForModel: buildStatsForModel(pets),
        imageBlocks,
        windowNote: `This covers the completed week of ${rangeStart} to ${rangeEnd}.`,
      });
      await putJsonPlain(weekKey, {
        rangeStart,
        rangeEnd,
        story,
        photoRefs: photoRefs.map(({ petId, id, filename }) => ({ petId, id, filename })),
        pets: buildChips(pets),
        generatedAt: new Date().toISOString(),
      });
      results.push({ pool: poolSub, status: 'generated' });
    } catch (e) {
      // One pool's failure never blocks the rest; the missing week is
      // retried by the next Monday run (or a manual weekOf backfill).
      console.error(`weekly story failed for ${poolSub}`, e);
      results.push({ pool: poolSub, status: 'error' });
    }
  }
  console.log('Weekly stories done:', JSON.stringify(results));
  return { week: monday, results };
}

async function runMonthlyStories(dryRun: boolean, monthArg?: string): Promise<unknown> {
  // Default: the month that just ended (cron fires on the 1st).
  const month =
    monthArg ??
    (() => {
      const d = new Date();
      d.setUTCDate(0); // last day of previous month
      return d.toISOString().slice(0, 7);
    })();
  const topList = await s3.send(
    new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'users/', Delimiter: '/' }),
  );
  const userPrefixes = (topList.CommonPrefixes ?? []).map((p) => p.Prefix!);
  console.log(`Monthly stories (${month})${dryRun ? ' (dry run)' : ''}: ${userPrefixes.length} user prefix(es)`);
  const results: Array<{ pool: string; status: string }> = [];

  for (const userPrefix of userPrefixes) {
    const poolSub = userPrefix.slice('users/'.length, -1);
    try {
      const monthKey = `users/${poolSub}/summary/months/${month}.json`;
      if (await readJson(monthKey)) {
        results.push({ pool: poolSub, status: 'exists' });
        continue;
      }
      // A week belongs to the month its Monday falls in — simple rule,
      // straddling weeks land in one month only.
      const weeksList = await s3.send(
        new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `users/${poolSub}/summary/weeks/${month}-` }),
      );
      const weekKeys = (weeksList.Contents ?? []).map((it) => it.Key!).sort();
      if (weekKeys.length === 0) {
        results.push({ pool: poolSub, status: 'no-weeks' });
        continue;
      }
      interface StoredWeek {
        rangeStart: string;
        rangeEnd: string;
        story: string;
        photoRefs: { petId: string; id: string; filename: string }[];
        pets: { petId: string; name: string }[];
      }
      const weeks = (await Promise.all(weekKeys.map((k) => readJson<StoredWeek>(k)))).filter(
        (w): w is StoredWeek => w !== null,
      );
      if (dryRun) {
        results.push({ pool: poolSub, status: `would-consolidate (${weeks.length} weeks)` });
        continue;
      }
      const petNames = [...new Set(weeks.flatMap((w) => w.pets.map((p) => p.name)))];
      const monthLabel = new Date(`${month}-01T00:00:00Z`).toLocaleString('en-US', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      });
      const story = await generateMonthStory({ petNames, monthLabel, weeklyStories: weeks });
      await putJsonPlain(monthKey, {
        month,
        monthLabel,
        rangeStart: weeks[0].rangeStart,
        rangeEnd: weeks[weeks.length - 1].rangeEnd,
        story,
        // The month keeps a filmstrip too — the weeks' photos, capped.
        photoRefs: weeks.flatMap((w) => w.photoRefs).slice(0, 6),
        pets: weeks[weeks.length - 1].pets,
        weeksUsed: weekKeys.map((k) => k.split('/').pop()!.replace('.json', '')),
        generatedAt: new Date().toISOString(),
      });
      results.push({ pool: poolSub, status: 'generated' });
    } catch (e) {
      console.error(`monthly story failed for ${poolSub}`, e);
      results.push({ pool: poolSub, status: 'error' });
    }
  }
  console.log('Monthly stories done:', JSON.stringify(results));
  return { month, results };
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
  const moodAvgRaw = moods.length > 0 ? moods.reduce((a, b) => a + b, 0) / moods.length : null;
  if (moods.length > 0) {
    const avg = Math.round(moodAvgRaw!);
    lines.push(
      `Mood: ${moods.map((v) => MOOD_EMOJI[v] ?? '·').join(' ')} (mostly ${MOOD_LABEL[avg] ?? 'okay'})`,
    );
  }

  // Checklist totals — tracked by BOTH display name (the tally line below)
  // and raw itemId (to pick the right "we noticed" phrasing further down).
  const itemNames = new Map<string, string>(
    (daily?.items ?? []).map((i) => [i.id, i.name]),
  );
  const checkCounts = new Map<string, number>();
  const checkCountsByItemId = new Map<string, number>();
  const byPerson = new Map<string, number>();
  const activeDates = new Set<string>();
  let medsGiven = 0;
  for (const d of dates) {
    const day = daily?.log?.[d];
    if (daily?.moods?.[d]) activeDates.add(d);
    if (!day) continue;
    activeDates.add(d);
    for (const [itemId, entry] of Object.entries(day)) {
      const n = entry.count ?? 1;
      if (itemId.startsWith('med:')) medsGiven += 1;
      else {
        const name = itemNames.get(itemId) ?? digestPresetName(itemId, species) ?? 'Other';
        checkCounts.set(name, (checkCounts.get(name) ?? 0) + n);
        checkCountsByItemId.set(itemId, (checkCountsByItemId.get(itemId) ?? 0) + n);
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

  // At most one short "we noticed" line — mood takes priority over a low
  // checklist rate (see DIGEST.MOOD_DIP_THRESHOLD / LOW_COMPLETION_MISSED_DAYS
  // / MIN_ACTIVE_DAYS_FOR_INSIGHT in shared/config.ts for the thresholds,
  // copy/digest.ts for the wording). The low-completion check additionally
  // requires a SMALL ABSOLUTE floor of tracked days — otherwise a pet added
  // mid-week (or a brand-new signup's first day) would get told "you only
  // logged breakfast 1 of the last 7 days," a false signal, not a missed day.
  const trackedEnoughDays = activeDates.size >= DIGEST.MIN_ACTIVE_DAYS_FOR_INSIGHT;
  if (moodAvgRaw !== null && moodAvgRaw < DIGEST.MOOD_DIP_THRESHOLD) {
    lines.push(digestInsightCopy.moodDip(petName));
  } else if (trackedEnoughDays) {
    const lowItem = [...checkCountsByItemId.entries()]
      .filter(([, n]) => n <= dates.length - DIGEST.LOW_COMPLETION_MISSED_DAYS)
      .sort((a, b) => a[1] - b[1])[0];
    if (lowItem) {
      const [itemId, n] = lowItem;
      if (itemId === 'preset-breakfast') lines.push(digestInsightCopy.lowBreakfast(petName, n, dates.length));
      else if (itemId === 'preset-dinner') lines.push(digestInsightCopy.lowDinner(petName, n, dates.length));
      else if (itemId === 'preset-walk') lines.push(digestInsightCopy.lowWalk(petName, n, dates.length));
      else lines.push(digestInsightCopy.lowGeneric(petName, itemNames.get(itemId) ?? 'that', n, dates.length));
    }
  }

  // Weight: newest in-window entry, plus the change across the window. If
  // nothing fell in-window but there's history, the latest entry might just
  // be stale (see WEIGHTS.STALE_NUDGE_DAYS) — nudge instead of staying silent.
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
  } else if (weights.length > 0) {
    const latestOverall = weights.reduce((a, b) => (a.date > b.date ? a : b));
    const staleDays = daysBetweenDates(latestOverall.date, dates[dates.length - 1]);
    if (staleDays >= WEIGHTS.STALE_NUDGE_DAYS) {
      lines.push(digestInsightCopy.weightStale(petName, staleDays));
    }
  }

  if (lines.length === 0) return null;
  if (byPerson.size > 1) {
    lines.push(
      `Checked off by: ${[...byPerson.entries()].map(([who, n]) => `${who} ${n}`).join(' · ')}`,
    );
  }
  return `${petName}\n${lines.map((l) => `  ${l}`).join('\n')}`;
}

// HTML twin of digestPetSection — same data, rendered as a pet card with the
// "we noticed" line called out in its own highlighted row instead of just
// another list item. Kept as a genuinely separate render pass (like
// composeEmailHtml/composeEmail above) rather than reusing digestPetSection's
// plain-text lines, since the insight line needs different markup than the
// rest.
function digestPetSectionHtml(
  petName: string,
  species: string | undefined,
  daily: DailyFileView | null,
  weights: WeightEntryView[],
  dates: string[],
): string | null {
  const rows: string[] = [];
  let insight: string | null = null;
  const window = new Set(dates);

  const moods = dates
    .map((d) => daily?.moods?.[d]?.value)
    .filter((v): v is number => typeof v === 'number');
  const moodAvgRaw = moods.length > 0 ? moods.reduce((a, b) => a + b, 0) / moods.length : null;
  if (moods.length > 0) {
    const avg = Math.round(moodAvgRaw!);
    rows.push(
      petRowHtml(
        `Mood: ${moods.map((v) => MOOD_EMOJI[v] ?? '·').join(' ')} (mostly ${MOOD_LABEL[avg] ?? 'okay'})`,
      ),
    );
  }

  const itemNames = new Map<string, string>((daily?.items ?? []).map((i) => [i.id, i.name]));
  const checkCounts = new Map<string, number>();
  const checkCountsByItemId = new Map<string, number>();
  const byPerson = new Map<string, number>();
  const activeDates = new Set<string>();
  let medsGiven = 0;
  for (const d of dates) {
    const day = daily?.log?.[d];
    if (daily?.moods?.[d]) activeDates.add(d);
    if (!day) continue;
    activeDates.add(d);
    for (const [itemId, entry] of Object.entries(day)) {
      const n = entry.count ?? 1;
      if (itemId.startsWith('med:')) medsGiven += 1;
      else {
        const name = itemNames.get(itemId) ?? digestPresetName(itemId, species) ?? 'Other';
        checkCounts.set(name, (checkCounts.get(name) ?? 0) + n);
        checkCountsByItemId.set(itemId, (checkCountsByItemId.get(itemId) ?? 0) + n);
      }
      for (const ev of entry.events ?? [{ by: entry.by }]) {
        const who = (ev.by ?? '').split('@')[0];
        if (who) byPerson.set(who, (byPerson.get(who) ?? 0) + 1);
      }
    }
  }
  if (checkCounts.size > 0) {
    rows.push(
      petRowHtml(
        escapeHtml([...checkCounts.entries()].map(([name, n]) => `${name} ×${n}`).join(' · ')),
      ),
    );
  }
  if (medsGiven > 0) rows.push(petRowHtml(`Meds given: ${medsGiven}`));

  const trackedEnoughDays = activeDates.size >= DIGEST.MIN_ACTIVE_DAYS_FOR_INSIGHT;
  if (moodAvgRaw !== null && moodAvgRaw < DIGEST.MOOD_DIP_THRESHOLD) {
    insight = digestInsightCopy.moodDip(petName);
  } else if (trackedEnoughDays) {
    const lowItem = [...checkCountsByItemId.entries()]
      .filter(([, n]) => n <= dates.length - DIGEST.LOW_COMPLETION_MISSED_DAYS)
      .sort((a, b) => a[1] - b[1])[0];
    if (lowItem) {
      const [itemId, n] = lowItem;
      if (itemId === 'preset-breakfast') insight = digestInsightCopy.lowBreakfast(petName, n, dates.length);
      else if (itemId === 'preset-dinner') insight = digestInsightCopy.lowDinner(petName, n, dates.length);
      else if (itemId === 'preset-walk') insight = digestInsightCopy.lowWalk(petName, n, dates.length);
      else insight = digestInsightCopy.lowGeneric(petName, itemNames.get(itemId) ?? 'that', n, dates.length);
    }
  }

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
    rows.push(petRowHtml(`Weight: ${latest.weight} ${latest.unit}${deltaText}`));
  } else if (weights.length > 0) {
    const latestOverall = weights.reduce((a, b) => (a.date > b.date ? a : b));
    const staleDays = daysBetweenDates(latestOverall.date, dates[dates.length - 1]);
    if (staleDays >= WEIGHTS.STALE_NUDGE_DAYS) {
      rows.push(petRowHtml(escapeHtml(digestInsightCopy.weightStale(petName, staleDays))));
    }
  }

  if (rows.length === 0 && !insight) return null;
  if (byPerson.size > 1) {
    rows.push(
      petRowHtml(
        escapeHtml(`Checked off by: ${[...byPerson.entries()].map(([who, n]) => `${who} ${n}`).join(' · ')}`),
      ),
    );
  }
  return petCardHtml(petName, rows.join('') + (insight ? insightRowHtml(escapeHtml(insight)) : ''));
}

// EventBridge invokes with its scheduled-event payload (no dryRun field).
// Passing { dryRun: true } via a manual invoke returns the would-send emails
// instead of sending them — the smoke test's window into this logic.
// { forceDigest: true } composes the weekly digest regardless of weekday.
// { ignoreNewUploads: true } disables the first-scan already-overdue nag so
// the smoke test can assert pure cadence behavior on freshly-seeded docs.
// { nudge: 'breakfast' | 'evening' } is a separate, later-in-day EventBridge
// rule (see api-stack.ts) that runs ONLY the feeding/walk nudge below and
// skips the vaccine/med/digest scan entirely. { monthlyReport: true } is
// similarly a separate once-a-month EventBridge rule that runs ONLY the
// paid-plan monthly report.
export const handler = async (event?: {
  dryRun?: boolean;
  forceDigest?: boolean;
  ignoreNewUploads?: boolean;
  nudge?: 'breakfast' | 'evening';
  monthlyReport?: boolean;
  weeklyStories?: boolean;
  monthlyStories?: boolean;
  /** Manual backfill overrides: weekOf = that week's Monday (YYYY-MM-DD),
   *  month = YYYY-MM. */
  weekOf?: string;
  month?: string;
}): Promise<unknown> => {
  const dryRun = event?.dryRun === true;
  if (event?.nudge) return runDailyNudge(event.nudge, dryRun);
  if (event?.monthlyReport) return runMonthlyReport(dryRun);
  if (event?.weeklyStories) return runWeeklyStories(dryRun, event.weekOf);
  if (event?.monthlyStories) return runMonthlyStories(dryRun, event.month);
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
      // predate unsubTokens get one minted and persisted here — under an
      // ETag guard, so a Settings save landing at the same moment as the
      // cron neither loses its keys nor ends up with a different token than
      // the one going into this email.
      if (!settings.unsubToken) {
        for (let attempt = 0; attempt < 4; attempt++) {
          const { value: fresh, etag } = await readJsonTagged<UserSettings>(
            `${userPrefix}settings.json`,
          );
          if (fresh?.unsubToken) {
            // Someone else (PUT /settings) minted one first — use theirs.
            settings.unsubToken = fresh.unsubToken;
            break;
          }
          const minted = { ...(fresh ?? settings), unsubToken: randomUUID() };
          if (await putJsonGuarded(`${userPrefix}settings.json`, minted, etag)) {
            settings.unsubToken = minted.unsubToken;
            break;
          }
        }
        // Never send email whose unsubscribe link isn't persisted.
        if (!settings.unsubToken) continue;
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
      const weightNudges: { petName: string; days: number }[] = [];
      const today = new Date();

      for (const { base, petId } of petSources) {
        const pet = await readJson<{ name: string; dob?: string; memorial?: boolean }>(
          `${base}pets/${petId}/pet.json`,
        );
        if (!pet?.name) continue;
        // Memorial pets: no birthday emails (the worst possible send), no
        // vaccine-expiry or med reminders. Records stay browsable in-app.
        if (pet.memorial) continue;

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
            if (meta.dismissed === true) continue; // archived — owner opted out
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
          // Med equivalent of the doc-side first-scan rule: a med ADDED
          // already-overdue would otherwise wait for the next taper tick
          // (up to ~30 days) before its first email. createdAt is stamped
          // per med by the PUT validator (meds.json's own LastModified is
          // useless — any edit refreshes it); legacy meds without a stamp
          // never spuriously nag. Age < window is true on exactly one run.
          const firstScanOverdue =
            !ignoreNewUploads &&
            days < 0 &&
            typeof med.createdAt === 'string' &&
            Date.now() - Date.parse(med.createdAt) < REMINDERS.FIRST_SCAN_OVERDUE_WINDOW_MS;
          if (medShouldRemind(days, effInterval) || firstScanOverdue) {
            dueMeds.push({ petName: pet.name, name: med.name, nextDue: med.nextDue, days, phase: phaseFor(days) });
          }
        }

        // Weight staleness push — rides the same consent toggle as the
        // birthday email (no separate opt-in). Flat modulo cadence (see
        // WEIGHTS.STALE_NUDGE_DAYS) instead of a one-time nag so a
        // long-neglected pet keeps getting nudged, same idea as the vaccine/
        // med overdue taper.
        if (vaccineRemindersOn) {
          const weightsStored = await readJson<{ entries: WeightEntryView[] }>(
            `${base}pets/${petId}/weights.json`,
          );
          const entries = weightsStored?.entries ?? [];
          if (entries.length > 0) {
            const latest = entries.reduce((a, b) => (a.date > b.date ? a : b));
            const staleDays = -daysUntil(latest.date);
            if (staleDays >= WEIGHTS.STALE_NUDGE_DAYS && staleDays % WEIGHTS.STALE_NUDGE_DAYS === 0) {
              weightNudges.push({ petName: pet.name, days: staleDays });
            }
          }
        }
      }

      // Weekly digest (Sundays) — a separate email from the reminder, sent
      // only to reminder-consented users who haven't turned the digest off,
      // and only when the week actually held activity.
      if (digestDay && vaccineRemindersOn && settings.weeklyDigest !== false) {
        const dates = digestWindowDates(today);
        const sections: string[] = [];
        const sectionsHtml: string[] = [];
        const petNames: string[] = [];
        for (const { base, petId } of petSources) {
          const pet = await readJson<{ name?: string; species?: string; memorial?: boolean }>(
            `${base}pets/${petId}/pet.json`,
          );
          if (!pet?.name || pet.memorial) continue; // no digest section for memorial pets
          const [daily, weightsStored] = await Promise.all([
            readJson<DailyFileView>(`${base}pets/${petId}/daily.json`),
            readJson<{ entries: WeightEntryView[] }>(`${base}pets/${petId}/weights.json`),
          ]);
          const section = digestPetSection(pet.name, pet.species, daily, weightsStored?.entries ?? [], dates);
          if (section) {
            sections.push(section);
            sectionsHtml.push(
              digestPetSectionHtml(pet.name, pet.species, daily, weightsStored?.entries ?? [], dates) ?? '',
            );
            petNames.push(pet.name);
          }
        }
        if (sections.length > 0) {
          const subject =
            petNames.length === 1 ? digestCopy.subjectSingle(petNames[0]) : digestCopy.subjectMulti;
          const body = [
            digestCopy.greeting,
            ``,
            digestCopy.intro,
            ``,
            sections.join('\n\n'),
            ``,
            digestCopy.cta(`${APP_URL}/dashboard`),
            ``,
            digestCopy.signoff,
            digestCopy.signoffName,
            ``,
            digestCopy.toggleOff,
            digestCopy.unsubscribeLine(unsubUrl),
          ].join('\n');
          const footerHtml = `${escapeHtml(digestCopy.toggleOff)}<br/><a href="${APP_URL}" style="color:#31584c;">petshots.app</a> · <a href="${APP_URL}/dashboard" style="color:#31584c;">Open dashboard</a><br/><a href="${unsubUrl}" style="color:#8a8a9a;">Unsubscribe from all Petshots email</a>`;
          const html = emailHtml(
            digestCopy.intro,
            `<p style="margin:0 0 18px;color:#4b463e;">${escapeHtml(digestCopy.intro)}</p>` +
              sectionsHtml.join('') +
              ctaButtonHtml(`${APP_URL}/dashboard`, digestCopy.ctaButtonLabel),
            footerHtml,
          );
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
                    Body: {
                      Text: { Data: body, Charset: 'UTF-8' },
                      Html: { Data: html, Charset: 'UTF-8' },
                    },
                  },
                },
              }),
            );
            console.log(`Sent weekly digest to ${settings.email}`);
          }
        }
      }

      // Weight staleness push — independent of the due-item email below (and
      // the `continue` right after this), since a pet can be weight-stale
      // with nothing else due.
      if (weightNudges.length > 0) {
        const title = weightNudgeCopy.title;
        const nudgeBody = weightNudgeCopy.body(weightNudges.map((w) => w.petName));
        if (dryRun) {
          const devices = (await listPushSubs(userPrefix)).length;
          if (devices > 0) wouldPush.push({ email: settings.email, subject: title, devices });
          console.log(`[dry run] would send weight nudge to ${settings.email}: ${nudgeBody}`);
        } else {
          const pushed = await sendPushes(userPrefix, title, nudgeBody);
          console.log(`Sent weight nudge to ${settings.email} (+${pushed} push): ${nudgeBody}`);
        }
      }

      if (dueDocs.length === 0 && dueMeds.length === 0 && birthdays.length === 0) continue;

      // Free-plan users get a short upgrade line in the reminder email itself
      // (no separate opt-in — same low-key treatment as the in-app CTAs).
      const planFile = await readJson<{ plan?: string }>(`${userPrefix}plan.json`);
      const showUpgrade = planFile?.plan !== 'paid';

      const { subject, body } = composeEmail(dueDocs, dueMeds, birthdays, unsubUrl, showUpgrade);
      const html = composeEmailHtml(dueDocs, dueMeds, birthdays, unsubUrl, showUpgrade);
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
              Body: {
                Text: { Data: body, Charset: 'UTF-8' },
                Html: { Data: html, Charset: 'UTF-8' },
              },
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
