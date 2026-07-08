import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { randomUUID } from 'node:crypto';

const s3 = new S3Client({
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
const ses = new SESv2Client({ region: 'us-east-1' });
const BUCKET = process.env.UPLOADS_BUCKET!;
const FROM_EMAIL = process.env.FROM_EMAIL ?? 'no-reply@petshots.app';
const APP_URL = process.env.APP_URL ?? 'https://petshots.app';

interface UserSettings {
  email?: string;
  remindersEnabled?: boolean;
  reminderDays?: number[];
  emailOptOut?: boolean; // master kill-switch: true = never email this user
  unsubToken?: string; // per-user secret for the no-login unsubscribe link
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

// Shared overdue cadence for both vaccines and meds: weekly nags for the
// first month, then taper to monthly so a long-neglected record doesn't nag
// forever. NaN days (bad date) never matches.
function overdueCadenceMatch(overdueDays: number): boolean {
  if (overdueDays <= 0) return false;
  if (overdueDays <= 30) return overdueDays % 7 === 0;
  return overdueDays % 30 === 0;
}

// Vaccine trigger days = whatever the user picked in Settings, PLUS a forced
// "final countdown" (3 days and 1 day before) so the last-mile warning never
// depends on the user having picked those specific milestones, PLUS the
// expiry day itself. Once past expiry, hand off to the overdue cadence.
function docShouldRemind(days: number, userDays: number[]): boolean {
  if (days > 0) return userDays.includes(days) || days === 3 || days === 1;
  if (days === 0) return true;
  return overdueCadenceMatch(-days);
}

// A med reminder fires on the due day, then on the overdue cadence, plus (for
// meds with a week-or-longer cadence) a single "due in 3 days" heads-up —
// skipped for daily/short-cycle meds where "coming due" is meaningless.
function medShouldRemind(days: number, effectiveIntervalDays: number): boolean {
  if (days === 0) return true;
  if (days > 0) return days === 3 && effectiveIntervalDays >= 7;
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

// EventBridge invokes with its scheduled-event payload (no dryRun field).
// Passing { dryRun: true } via a manual invoke returns the would-send emails
// instead of sending them — the smoke test's window into this logic.
export const handler = async (event?: { dryRun?: boolean }): Promise<unknown> => {
  const dryRun = event?.dryRun === true;
  const wouldSend: Array<{ email: string; subject: string; body: string }> = [];

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
      const reminderDays = settings.reminderDays?.length ? settings.reminderDays : [7, 30];

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

      const petsList = await s3.send(
        new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${userPrefix}pets/` }),
      );
      const petIds = (petsList.Contents ?? [])
        .filter((it) => it.Key!.endsWith('/pet.json'))
        .map((it) => it.Key!.slice(`${userPrefix}pets/`.length).split('/')[0]);

      const dueDocs: DueDoc[] = [];
      const dueMeds: DueMed[] = [];
      const birthdays: Birthday[] = [];
      const today = new Date();

      for (const petId of petIds) {
        const pet = await readJson<{ name: string; dob?: string }>(
          `${userPrefix}pets/${petId}/pet.json`,
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
              Prefix: `${userPrefix}pets/${petId}/docs/`,
            }),
          );
          for (const it of (docsList.Contents ?? []).filter((x) => !x.Key!.includes('/_archived/'))) {
            const parts = it.Key!.split('/');
            const meta = decodeMeta(parts[6]);
            if (!meta.expiry) continue;
            if (meta.remindersEnabled === false) continue;
            const days = daysUntil(meta.expiry);
            if (docShouldRemind(days, reminderDays)) {
              dueDocs.push({ petName: pet.name, label: meta.label, expiry: meta.expiry, days, phase: phaseFor(days) });
            }
          }
        }

        const stored = await readJson<{ meds: Med[] }>(`${userPrefix}pets/${petId}/meds.json`);
        for (const med of stored?.meds ?? []) {
          if (med.dismissed === true || med.remindersEnabled === false || !med.nextDue) continue;
          const days = daysUntil(med.nextDue);
          const effInterval = effectiveMedIntervalDays(med.unit, med.interval);
          if (medShouldRemind(days, effInterval)) {
            dueMeds.push({ petName: pet.name, name: med.name, nextDue: med.nextDue, days, phase: phaseFor(days) });
          }
        }
      }

      if (dueDocs.length === 0 && dueMeds.length === 0 && birthdays.length === 0) continue;

      const { subject, body } = composeEmail(dueDocs, dueMeds, birthdays, unsubUrl);

      if (dryRun) {
        wouldSend.push({ email: settings.email, subject, body });
        console.log(`[dry run] would send to ${settings.email}: ${subject}`);
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
      console.log(
        `Sent ${dueDocs.length + dueMeds.length} reminder(s) + ${birthdays.length} birthday(s) to ${settings.email}`,
      );
    } catch (e) {
      console.error(`Error processing ${userPrefix}:`, e);
      // Continue to next user rather than failing the whole run.
    }
  }

  return dryRun ? { dryRun: true, wouldSend } : undefined;
};
