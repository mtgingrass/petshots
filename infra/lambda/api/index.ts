import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

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
const BUCKET = process.env.UPLOADS_BUCKET!;
const MAX_PETS = Number(process.env.MAX_PETS ?? '2');
const MAX_DOCS = Number(process.env.MAX_DOCS ?? '4');
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES ?? String(10 * 1024 * 1024));
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

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
}
const MAX_MEDS = Number(process.env.MAX_MEDS ?? '4');
const MED_UNIT_MAX: Record<Med['unit'], number> = { day: 365, week: 52, month: 24 };

// Strict calendar date: correct shape AND a real day. Round-trip through Date
// components — V8 string parsing silently rolls Feb 30 over to Mar 2, so a
// NaN check alone is not enough.
function isStrictDay(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function cleanMeds(input: unknown, maxMeds: number): { meds: Med[] } | { error: string } {
  if (!Array.isArray(input)) return { error: 'meds must be an array' };
  if (input.length > maxMeds) return { error: `limit of ${maxMeds} medications per pet` };
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
}
type Entitlements = Limits & { plan: 'free' | 'paid' };
const PLAN_LIMITS: Record<Entitlements['plan'], Limits> = {
  free: { maxPets: MAX_PETS, maxDocs: MAX_DOCS, maxMeds: MAX_MEDS },
  paid: {
    maxPets: Number(process.env.PAID_MAX_PETS ?? '10'),
    maxDocs: Number(process.env.PAID_MAX_DOCS ?? '20'),
    maxMeds: Number(process.env.PAID_MAX_MEDS ?? '20'),
  },
};
const posInt = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : fallback;
async function getEntitlements(sub: string): Promise<Entitlements> {
  const file = await readJson<{ plan?: string; limits?: Partial<Limits> }>(
    `users/${sub}/plan.json`,
  );
  const plan = file?.plan === 'paid' ? 'paid' : 'free';
  const base = PLAN_LIMITS[plan];
  return {
    plan,
    maxPets: posInt(file?.limits?.maxPets, base.maxPets),
    maxDocs: posInt(file?.limits?.maxDocs, base.maxDocs),
    maxMeds: posInt(file?.limits?.maxMeds, base.maxMeds),
  };
}

// ---- AI document extraction (Bedrock / Claude Haiku) ----
// Uploads land in tmp/{sub}/{uploadId}/ first (a lifecycle rule expires the
// prefix after a day), get read by Claude, and only become doc records when the
// user confirms the extraction on the review screen (POST .../docs/commit).
// bedrock-runtime path with a cross-region inference profile id. (The newer
// Mantle endpoint rejected this account's model entitlement at ship time —
// revisit `AnthropicBedrockMantle` + 'anthropic.claude-haiku-4-5' later.)
const BEDROCK_MODEL_ID =
  process.env.BEDROCK_MODEL_ID ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const MAX_AI_SCANS = Number(process.env.MAX_AI_SCANS ?? '10');
const PAID_MAX_AI_SCANS = Number(process.env.PAID_MAX_AI_SCANS ?? '50');
// Bedrock InvokeModel caps the request body at 25 MB; base64 inflates 4/3, so
// anything over ~15 MB can't be analyzed and falls back to manual entry.
const MAX_AI_FILE_BYTES = 15 * 1024 * 1024;
const AI_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

let claudeClient: AnthropicBedrock | null = null;
function getClaude(): AnthropicBedrock {
  if (!claudeClient) {
    claudeClient = new AnthropicBedrock({
      awsRegion: process.env.AWS_REGION ?? 'us-east-1',
      // Finish (or fail) before API Gateway's ~30s integration cap so the
      // client always gets a real response it can fall back from.
      timeout: 23_000,
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
        required: ['name', 'dateGiven', 'expiry'],
        properties: { name: { type: 'string' }, dateGiven: nullableString, expiry: nullableString },
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
- All dates in YYYY-MM-DD. If a date is partial or unreadable, use null for it.
- NEVER infer or calculate an expiration date that is not written in the document (do not guess 1-year vs 3-year durations).
- Use null for anything not present or not legible.
- If this is not a pet health document at all, set isPetHealthDocument to false and return an empty vaccines list.`;

interface Extraction {
  isPetHealthDocument: boolean;
  pet: { name?: string; species?: string; breed?: string; birthday?: string; weight?: string; microchip?: string };
  vet: { name?: string; clinic?: string; phone?: string };
  vaccines: { name: string; dateGiven?: string; expiry?: string }[];
}

// Model output is never trusted: structured outputs constrain the shape, not
// the semantics — re-validate every date (real calendar day) and cap lengths.
function cleanExtraction(raw: unknown): Extraction {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const day = (v: unknown): string | undefined => (isStrictDay(v) ? v : undefined);
  const pet = (r.pet ?? {}) as Record<string, unknown>;
  const vet = (r.vet ?? {}) as Record<string, unknown>;
  const vaccines = (Array.isArray(r.vaccines) ? r.vaccines : [])
    .slice(0, 12)
    .map((v: Record<string, unknown>) => ({
      name: String(v?.name ?? '').trim().slice(0, 100),
      dateGiven: day(v?.dateGiven),
      expiry: day(v?.expiry),
    }))
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
const APP_URL = process.env.APP_URL ?? 'https://petshots.app';
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
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscription.id,
      });
      break;
    }
  }
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
      { expiresIn: 3600 },
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
        { expiresIn: 3600 },
      );
      return { id: parts[5], label: meta.label, expiry: meta.expiry, filename: parts.slice(7).join('/'), url };
    }),
  );
  docs.sort((a, b) => statusRank(a.expiry) - statusRank(b.expiry) || (a.expiry ?? '').localeCompare(b.expiry ?? ''));

  return json(200, {
    pet: {
      name: pet.name, species: pet.species, breed: pet.breed, dob: pet.dob,
      weight: pet.weight, allergies: pet.allergies, behavior: pet.behavior,
      vetName: pet.vetName, vetPhone: pet.vetPhone, emergencyContact: pet.emergencyContact,
      microchip: pet.microchip, fixed: pet.fixed, notes: pet.notes, avatarUrl,
    },
    docs,
    expiresAt: passportRecord.expiry,
  });
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  // Public routes handled before auth check.
  if (event.routeKey === 'GET /passport/{token}') {
    try { return await handlePublicPassport(event); }
    catch (e) { console.error('passport error', e); return json(500, { error: 'internal error' }); }
  }
  // Stripe calls this server-to-server; auth is the webhook signature, not a JWT.
  if (event.routeKey === 'POST /billing/webhook') {
    try { return await handleStripeWebhook(event); }
    catch (e) { console.error('webhook error', e); return json(500, { error: 'internal error' }); }
  }

  // The Cognito JWT authorizer already verified the token; we just read claims.
  // sub is the stable per-user id we scope every S3 key to - a user can never
  // name a key outside their own prefix, so authz is the prefix itself.
  const sub = event.requestContext.authorizer?.jwt?.claims?.sub as string | undefined;
  if (!sub) return json(401, { error: 'unauthorized' });

  const petsPrefix = `users/${sub}/pets/`;

  // Pet-scoped routes carry {petId}; validate the shape before it touches a key.
  const petId = event.pathParameters?.petId;
  if (event.routeKey.includes('{petId}') && !isUuid(petId)) {
    return json(400, { error: 'invalid pet id' });
  }
  const petPrefix = `${petsPrefix}${petId}/`;
  const petKey = `${petPrefix}pet.json`;
  const avatarKey = `${petPrefix}avatar`;
  const docsPrefix = `${petPrefix}docs/`;

  try {
    switch (event.routeKey) {
      // ---- pets (each a small JSON object under its own prefix, no DB) ----
      case 'GET /pets': {
        // One LIST covers everything under pets/: pet.json keys identify the
        // pets, an `avatar` key marks a photo. Doc keys in the result are ignored.
        const [list, entitlements] = await Promise.all([
          s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: petsPrefix })),
          getEntitlements(sub),
        ]);
        const keys = (list.Contents ?? []).map((it) => it.Key!);
        const ids = keys
          .filter((k) => k.endsWith('/pet.json'))
          .map((k) => k.slice(petsPrefix.length).split('/')[0]);
        const pets = await Promise.all(
          ids.map(async (id) => {
            const pet = await readJson<{ name: string; species: string }>(
              `${petsPrefix}${id}/pet.json`,
            );
            const hasAvatar = keys.includes(`${petsPrefix}${id}/avatar`);
            const avatarUrl = hasAvatar
              ? await getSignedUrl(
                  s3,
                  new GetObjectCommand({ Bucket: BUCKET, Key: `${petsPrefix}${id}/avatar` }),
                  { expiresIn: 3600 },
                )
              : undefined;
            return { id, ...pet, avatarUrl };
          }),
        );
        // Stable order so the switcher doesn't shuffle between loads.
        pets.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
        // Over-cap accounts: flag which pets still accept new docs/meds.
        const activeIds = rankActivePets(
          pets as { id: string; createdAt?: string }[],
          entitlements.maxPets,
        );
        const flagged = pets.map((p) => ({ ...p, active: activeIds.has(p.id) }));
        // The client reads its limits from here — never hardcode them in the UI.
        return json(200, { pets: flagged, limits: entitlements });
      }

      case 'POST /pets': {
        const pet = cleanPet(JSON.parse(event.body ?? '{}'));
        if (!pet.name) return json(400, { error: 'name required' });
        const [list, ent] = await Promise.all([
          s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: petsPrefix })),
          getEntitlements(sub),
        ]);
        const count = (list.Contents ?? []).filter((it) => it.Key!.endsWith('/pet.json')).length;
        if (count >= ent.maxPets) {
          return json(409, { error: `limit of ${ent.maxPets} pets reached` });
        }
        const id = randomUUID();
        // createdAt drives the active-pets ranking on downgrade; server-stamped
        // so it can't be forged into a better rank.
        const createdAt = new Date().toISOString();
        await putJson(`${petsPrefix}${id}/pet.json`, { ...pet, createdAt });
        return json(200, { pet: { id, ...pet, createdAt } });
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
        // Removes the whole pet: pet.json, avatar, and every doc under it.
        const list = await s3.send(
          new ListObjectsV2Command({ Bucket: BUCKET, Prefix: petPrefix }),
        );
        await Promise.all(
          (list.Contents ?? []).map((it) =>
            s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: it.Key! })),
          ),
        );
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
          Expires: 300,
        });
        return json(200, { url, fields });
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
              { expiresIn: 3600 },
            );
            return {
              id: parts[5],
              label: meta.label,
              expiry: meta.expiry,
              given: meta.given,
              remindersEnabled: meta.remindersEnabled !== false,
              filename: parts.slice(7).join('/'),
              size: it.Size,
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
          getEntitlements(sub),
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
          Expires: 300,
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
          getEntitlements(sub),
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
          Expires: 300,
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

        const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: tmpObj.Key! }));
        const contentType = (obj.ContentType ?? '').toLowerCase().split(';')[0].trim();
        const isPdf = contentType === 'application/pdf';
        if (!isPdf && !AI_IMAGE_TYPES.includes(contentType)) {
          return json(415, { error: 'UNSUPPORTED_TYPE_FOR_AI' });
        }
        const data = Buffer.from(await obj.Body!.transformToByteArray()).toString('base64');

        const ent = await getEntitlements(sub);
        const cap = ent.plan === 'paid' ? PAID_MAX_AI_SCANS : MAX_AI_SCANS;
        // Bump after the cheap rejections but before the model call: failed
        // model calls still count, so a hostile client can't loop free scans.
        const quota = await bumpAiQuota(sub, cap);
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
          getEntitlements(sub),
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

      case 'POST /pets/{petId}/docs/{id}/update-url': {
        // "Update" = renew the cert. Archives the current file under a versioned
        // sub-key so the history is preserved, then returns a presigned POST for
        // the new upload. The docId stays the same, preserving the record's slot
        // in the list.
        const id = event.pathParameters?.id;
        if (!id) return json(400, { error: 'id required' });
        const input = JSON.parse(event.body ?? '{}');
        const filename = String(input.filename ?? '')
          .replace(/[^\w.\- ]/g, '_')
          .slice(0, 200);
        const label = String(input.label ?? '').slice(0, 200);
        const expiry = cleanExpiry(input.expiry);
        const contentType = String(input.contentType ?? 'application/octet-stream');
        if (!filename) return json(400, { error: 'filename required' });
        if ((await readJson(petKey)) === null) return json(404, { error: 'not found' });

        const prefix = `${docsPrefix}${id}/`;
        const existing = await s3.send(
          new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }),
        );
        const currentKey = existing.Contents?.find(
          (it) => !it.Key!.includes('/_archived/'),
        )?.Key;
        if (!currentKey) return json(404, { error: 'document not found' });

        // Copy current -> _archived/{timestamp}/… before presigning the new slot.
        // The old file is preserved even if the upload never completes.
        const archiveKey = `${prefix}_archived/${Date.now()}/${currentKey.slice(prefix.length)}`;
        const copySource = `${BUCKET}/${encodeURIComponent(currentKey).replace(/%2F/g, '/')}`;
        await s3.send(
          new CopyObjectCommand({ Bucket: BUCKET, Key: archiveKey, CopySource: copySource }),
        );
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: currentKey }));

        const safeLabel = label || filename;
        const newKey = `${prefix}${encodeMeta({ label: safeLabel, expiry })}/${filename}`;
        const { url, fields } = await createPresignedPost(s3, {
          Bucket: BUCKET,
          Key: newKey,
          Conditions: [
            ['content-length-range', 1, MAX_FILE_BYTES],
            ['eq', '$Content-Type', contentType],
          ],
          Fields: { 'Content-Type': contentType },
          Expires: 300,
        });
        return json(200, { url, fields, key: newKey });
      }

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
        const [existingPet, ent, stored] = await Promise.all([
          readJson(petKey),
          getEntitlements(sub),
          readJson<{ meds: Med[] }>(`${petPrefix}meds.json`),
        ]);
        if (existingPet === null) return json(404, { error: 'not found' });
        const input = JSON.parse(event.body ?? '{}');
        // Grandfather clause: whole-list replace means a user left over the cap
        // by a downgrade must still be able to edit/shrink the list — only
        // growing past what they already have is blocked.
        const effectiveMax = Math.max(ent.maxMeds, stored?.meds?.length ?? 0);
        const result = cleanMeds(input.meds, effectiveMax);
        if ('error' in result) return json(400, { error: result.error });
        // Growing the list counts as a write; read-only (over-cap) pets can
        // still have meds edited, toggled, and removed — just not added.
        if (
          result.meds.length > (stored?.meds?.length ?? 0) &&
          !(await petAcceptsWrites(petsPrefix, petId!, ent.maxPets))
        ) {
          return json(403, { error: READ_ONLY_PET_ERROR });
        }
        await s3.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: `${petPrefix}meds.json`,
            Body: JSON.stringify(result),
            ContentType: 'application/json',
          }),
        );
        return json(200, result);
      }

      // ---- user settings ----

      case 'GET /settings': {
        const settings = await readJson<Record<string, unknown>>(`users/${sub}/settings.json`);
        return json(200, settings ?? { remindersEnabled: false, reminderDays: [7, 30] });
      }

      case 'PUT /settings': {
        const input = JSON.parse(event.body ?? '{}');
        const validDays = [1, 3, 7, 14, 30, 60];
        const settings = {
          email: typeof input.email === 'string' ? input.email.slice(0, 254) : '',
          remindersEnabled: input.remindersEnabled === true,
          reminderDays: Array.isArray(input.reminderDays)
            ? (input.reminderDays as unknown[]).filter(
                (d): d is number => typeof d === 'number' && validDays.includes(d),
              )
            : [7, 30],
          marketingOptIn: input.marketingOptIn === true,
        };
        await s3.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: `users/${sub}/settings.json`,
            Body: JSON.stringify(settings),
            ContentType: 'application/json',
          }),
        );
        return json(200, settings);
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
