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
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
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
const cognito = new CognitoIdentityProviderClient({});
const ses = new SESv2Client({});
const FROM_EMAIL = process.env.FROM_EMAIL ?? 'no-reply@petshots.app';
const BUCKET = process.env.UPLOADS_BUCKET!;
const USER_POOL_ID = process.env.USER_POOL_ID ?? '';
const MAX_PETS = Number(process.env.MAX_PETS ?? '2');
const MAX_DOCS = Number(process.env.MAX_DOCS ?? '8');
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
  // "Stop tracking": the med stays on record but banners, overview status, the
  // public passport, and reminder email all skip it. Distinct from muting
  // reminders — a dismissed med is no longer considered due at all.
  dismissed?: boolean;
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
      dismissed: m.dismissed === true ? true : undefined,
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
}
type Entitlements = Limits & { plan: 'free' | 'paid' };
const PLAN_LIMITS: Record<Entitlements['plan'], Limits> = {
  free: {
    maxPets: MAX_PETS,
    maxDocs: MAX_DOCS,
    maxMeds: MAX_MEDS,
    maxMembers: Number(process.env.MAX_MEMBERS ?? '1'),
  },
  paid: {
    maxPets: Number(process.env.PAID_MAX_PETS ?? '10'),
    maxDocs: Number(process.env.PAID_MAX_DOCS ?? '999'),
    maxMeds: Number(process.env.PAID_MAX_MEDS ?? '20'),
    maxMembers: Number(process.env.PAID_MAX_MEMBERS ?? '5'),
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
    maxMembers: posInt(file?.limits?.maxMembers, base.maxMembers),
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
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
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
const MAX_INVITE_EMAILS_PER_DAY = Number(process.env.MAX_INVITE_EMAILS ?? '10');
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
// list): dogs get walks and poop tracking; cats get the litter box counter —
// output monitoring is a top early-warning health signal for indoor cats —
// and no walk; anything else starts with just meals.
function dailyPresetsFor(species: string | undefined): DailyItem[] {
  const meals: DailyItem[] = [
    { id: 'preset-breakfast', name: 'Breakfast' },
    { id: 'preset-dinner', name: 'Dinner' },
  ];
  if (/cat/i.test(species ?? '')) {
    return [...meals, { id: 'preset-poop', name: '💩 Litter box', kind: 'counter' }];
  }
  if (/dog/i.test(species ?? '')) {
    return [
      ...meals,
      { id: 'preset-walk', name: 'Walk' },
      { id: 'preset-poop', name: '💩 Poop', kind: 'counter' },
    ];
  }
  return meals;
}
const MAX_DAILY_ITEMS = 20;
const MAX_COUNTER_PER_DAY = 30;
const DAILY_LOG_RETENTION_DAYS = 14;

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

// Accept only a real calendar day within ±2 days of server time — enough for
// any timezone, too tight to backfill or forge history.
function isDailyDate(v: unknown): v is string {
  if (!isStrictDay(v)) return false;
  return Math.abs(Date.parse(`${v}T00:00:00Z`) - Date.now()) <= 2.5 * 86_400_000;
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
const MAX_WEIGHT_ENTRIES = 500;
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
const BEDROCK_MODEL_ID =
  process.env.BEDROCK_MODEL_ID ?? 'us.anthropic.claude-sonnet-4-6';
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
    .slice(0, 12)
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
  const settings = await readJson<Record<string, unknown>>(`users/${sub}/settings.json`);
  const stored = typeof settings?.unsubToken === 'string' ? settings.unsubToken : '';
  const given = Buffer.from(token);
  const expected = Buffer.from(stored);
  if (!stored || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return json(404, { error: 'not found' });
  }
  await putJson(`users/${sub}/settings.json`, { ...settings, emailOptOut: true });
  return json(200, { ok: true });
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
                    { expiresIn: 3600 },
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
        const [existingPet, ent, stored] = await Promise.all([
          readJson(petKey),
          getEntitlements(dataSub),
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

      // ---- daily care checklist (per pet) ----

      case 'GET /pets/{petId}/daily': {
        const date = event.queryStringParameters?.date;
        if (!isDailyDate(date)) {
          return json(400, { error: 'date required (YYYY-MM-DD, near today)' });
        }
        const petInfo = await readJson<{ species?: string }>(petKey);
        if (petInfo === null) return json(404, { error: 'not found' });
        const [file, medsStored] = await Promise.all([
          readJson<DailyFile>(`${petPrefix}daily.json`),
          readJson<{ meds: Med[] }>(`${petPrefix}meds.json`),
        ]);
        const checks = file?.log?.[date] ?? {};
        const items = [
          ...(file?.items ?? dailyPresetsFor(petInfo.species)),
          ...dailyMedItems(medsStored?.meds ?? [], date, checks),
        ];
        return json(200, { date, items, checks, mood: file?.moods?.[date] ?? null });
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
            const item = items.find((i) => i.id === itemId);
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

        if (medUpdate && medsStored && med) {
          med.lastGiven = medUpdate.lastGiven;
          med.nextDue = medUpdate.nextDue;
          await putJson(`${petPrefix}meds.json`, medsStored);
        }
        return json(200, { date, checks: day });
      }

      case 'PUT /pets/{petId}/daily/items': {
        // Whole-list replace of the CUSTOM items (med rows derive from meds.json
        // and can't be edited here). Same pattern as meds.
        const input = JSON.parse(event.body ?? '{}');
        if (!Array.isArray(input.items) || input.items.length > MAX_DAILY_ITEMS) {
          return json(400, { error: `items must be an array of at most ${MAX_DAILY_ITEMS}` });
        }
        const seen = new Set<string>();
        const items: DailyItem[] = [];
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
          items.push({ id, name, ...(r.kind === 'counter' ? { kind: 'counter' as const } : {}) });
        }
        if ((await readJson(petKey)) === null) return json(404, { error: 'not found' });
        for (let attempt = 0; ; attempt++) {
          const { value: file, etag } = await readJsonTagged<DailyFile>(`${petPrefix}daily.json`);
          const next = { items, log: file?.log ?? {}, moods: file?.moods ?? {} };
          if (await putJsonGuarded(`${petPrefix}daily.json`, next, etag)) {
            return json(200, { items });
          }
          if (attempt >= 3) return json(409, { error: 'busy, try again' });
        }
      }

      // ---- user settings ----

      case 'GET /settings': {
        const settings = await readJson<Record<string, unknown>>(`users/${sub}/settings.json`);
        return json(200, settings ?? { remindersEnabled: false, reminderDays: [7, 30] });
      }

      case 'PUT /settings': {
        const input = JSON.parse(event.body ?? '{}');
        const validDays = [1, 3, 7, 14, 30, 60];
        // unsubToken is server-managed: preserved from the stored file (never
        // trusted from the client) and minted here if absent, so every user
        // who saves settings gets a working unsubscribe link.
        const existing = await readJson<Record<string, unknown>>(`users/${sub}/settings.json`);
        const settings = {
          email: typeof input.email === 'string' ? input.email.slice(0, 254) : '',
          remindersEnabled: input.remindersEnabled === true,
          reminderDays: Array.isArray(input.reminderDays)
            ? (input.reminderDays as unknown[]).filter(
                (d): d is number => typeof d === 'number' && validDays.includes(d),
              )
            : [7, 30],
          marketingOptIn: input.marketingOptIn === true,
          emailOptOut: input.emailOptOut === true,
          // Sunday summary of the week's care/mood/weight. Default ON (it
          // only ever sends when reminders are enabled AND there was
          // activity), explicit false turns it off.
          weeklyDigest: input.weeklyDigest !== false,
          unsubToken:
            typeof existing?.unsubToken === 'string' ? existing.unsubToken : randomUUID(),
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

      // ---- account deletion ----

      case 'DELETE /account': {
        // Hard delete, everything, in an order that keeps a mid-failure
        // retryable: Stripe + orphanable root objects first, then the user's
        // S3 prefix, then the Cognito user LAST (while it exists the user can
        // still re-auth and hit this route again).
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
