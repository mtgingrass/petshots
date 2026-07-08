import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

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

// A med reminder fires on the due day, then weekly while it stays overdue —
// nagging without spamming daily. NaN days (bad date) never matches.
function medDueToday(days: number): boolean {
  return days === 0 || (days < 0 && (-days) % 7 === 0);
}

function formatDate(d: string): string {
  return new Date(`${d}T00:00:00`).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

interface DueDoc { petName: string; label: string; expiry: string; days: number }
interface DueMed { petName: string; name: string; nextDue: string; days: number }
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

function composeEmail(
  dueDocs: DueDoc[],
  dueMeds: DueMed[],
  birthdays: Birthday[] = [],
): { subject: string; body: string } {
  const total = dueDocs.length + dueMeds.length;

  let subject: string;
  if (total === 0 && birthdays.length > 0) {
    const b = birthdays[0];
    subject =
      birthdays.length > 1
        ? `🎂 ${birthdays.length} Petshots birthdays today!`
        : b.age >= 1
          ? `🎂 ${b.petName} turns ${b.age} today!`
          : `🎂 Happy birthday, ${b.petName}!`;
  } else if (total === 1 && dueMeds.length === 1) {
    const m = dueMeds[0];
    subject = m.days === 0
      ? `Reminder: ${m.petName}'s ${m.name} is due today`
      : `Reminder: ${m.petName}'s ${m.name} is overdue`;
  } else if (total === 1) {
    const d = dueDocs[0];
    subject = `Reminder: ${d.petName}'s ${d.label} expires in ${d.days} day${d.days !== 1 ? 's' : ''}`;
  } else if (dueMeds.length === 0) {
    subject = `Petshots: ${total} vaccine records expiring soon`;
  } else if (dueDocs.length === 0) {
    subject = `Petshots: ${total} medications due`;
  } else {
    subject = `Petshots: ${total} pet care reminders`;
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
  if (dueMeds.length > 0) {
    const bullets = dueMeds
      .map((m) => {
        const when = m.days === 0
          ? 'due today'
          : `${-m.days} day${m.days === -1 ? '' : 's'} overdue (was due ${formatDate(m.nextDue)})`;
        return `• ${m.petName}'s ${m.name} — ${when}`;
      })
      .join('\n');
    sections.push(`Medications due:\n${bullets}`);
  }
  if (dueDocs.length > 0) {
    const bullets = dueDocs
      .map((r) => {
        const when = r.days === 0 ? 'today' : r.days === 1 ? 'tomorrow' : `in ${r.days} days`;
        return `• ${r.petName}'s ${r.label} — expires ${formatDate(r.expiry)} (${when})`;
      })
      .join('\n');
    sections.push(`Vaccine records expiring:\n${bullets}`);
  }

  const body = [
    `Hi,`,
    ``,
    total === 0 ? `A little celebration from Petshots:` : `Here's your Petshots reminder:`,
    ``,
    sections.join('\n\n'),
    ``,
    dueMeds.length > 0
      ? `Mark meds as given and keep records up to date: ${APP_URL}/dashboard`
      : `Keep records up to date: ${APP_URL}/dashboard`,
    ``,
    `— The Petshots team`,
    ``,
    `Manage reminders in Settings or on each pet's Meds tab.`,
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
      const vaccineRemindersOn = settings.remindersEnabled === true;
      const reminderDays = settings.reminderDays?.length ? settings.reminderDays : [7, 30];

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
            if (reminderDays.includes(days)) {
              dueDocs.push({ petName: pet.name, label: meta.label, expiry: meta.expiry, days });
            }
          }
        }

        const stored = await readJson<{ meds: Med[] }>(`${userPrefix}pets/${petId}/meds.json`);
        for (const med of stored?.meds ?? []) {
          if (med.dismissed === true || med.remindersEnabled === false || !med.nextDue) continue;
          const days = daysUntil(med.nextDue);
          if (medDueToday(days)) {
            dueMeds.push({ petName: pet.name, name: med.name, nextDue: med.nextDue, days });
          }
        }
      }

      if (dueDocs.length === 0 && dueMeds.length === 0 && birthdays.length === 0) continue;

      const { subject, body } = composeEmail(dueDocs, dueMeds, birthdays);

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
