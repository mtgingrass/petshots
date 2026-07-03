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
      return { label: String(m.label ?? ''), expiry: m.expiry ? String(m.expiry) : undefined };
    }
  } catch { /* legacy plain-label key */ }
  return { label: raw };
}

function daysUntil(expiry: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(`${expiry}T00:00:00`);
  return Math.round((d.getTime() - today.getTime()) / 86_400_000);
}

function formatDate(d: string): string {
  return new Date(`${d}T00:00:00`).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export const handler = async (): Promise<void> => {
  // Discover all user prefixes via delimiter listing (users/{sub}/)
  const topList = await s3.send(
    new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'users/', Delimiter: '/' }),
  );
  const userPrefixes = (topList.CommonPrefixes ?? []).map((p) => p.Prefix!);
  console.log(`Reminder run: ${userPrefixes.length} user(s) found`);

  for (const userPrefix of userPrefixes) {
    try {
      const settings = await readJson<UserSettings>(`${userPrefix}settings.json`);
      if (!settings?.remindersEnabled || !settings.email) continue;

      const reminderDays = settings.reminderDays?.length ? settings.reminderDays : [7, 30];

      const petsList = await s3.send(
        new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${userPrefix}pets/` }),
      );
      const petIds = (petsList.Contents ?? [])
        .filter((it) => it.Key!.endsWith('/pet.json'))
        .map((it) => it.Key!.slice(`${userPrefix}pets/`.length).split('/')[0]);

      const due: Array<{ petName: string; label: string; expiry: string; days: number }> = [];

      for (const petId of petIds) {
        const pet = await readJson<{ name: string }>(`${userPrefix}pets/${petId}/pet.json`);
        if (!pet?.name) continue;

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
          const days = daysUntil(meta.expiry);
          if (reminderDays.includes(days)) {
            due.push({ petName: pet.name, label: meta.label, expiry: meta.expiry, days });
          }
        }
      }

      if (due.length === 0) continue;

      const bullets = due
        .map((r) => {
          const when = r.days === 0 ? 'today' : r.days === 1 ? 'tomorrow' : `in ${r.days} days`;
          return `• ${r.petName}'s ${r.label} — expires ${formatDate(r.expiry)} (${when})`;
        })
        .join('\n');

      const subject =
        due.length === 1
          ? `Reminder: ${due[0].petName}'s ${due[0].label} expires in ${due[0].days} day${due[0].days !== 1 ? 's' : ''}`
          : `Petshots: ${due.length} vaccine records expiring soon`;

      const body = [
        `Hi,`,
        ``,
        `Here's your Petshots vaccine reminder:`,
        ``,
        bullets,
        ``,
        `Keep records up to date: ${APP_URL}/dashboard`,
        ``,
        `— The Petshots team`,
        ``,
        `To turn off reminders, go to Settings in your Petshots dashboard.`,
      ].join('\n');

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
      console.log(`Sent ${due.length} reminder(s) to ${settings.email}`);
    } catch (e) {
      console.error(`Error processing ${userPrefix}:`, e);
      // Continue to next user rather than failing the whole run.
    }
  }
};
