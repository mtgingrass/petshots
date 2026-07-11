// Client for PetshotsApiStack's HTTP API. Every call attaches the Cognito access
// token as a Bearer header; the API Gateway authorizer verifies it before the
// Lambda runs. File bytes go browser->S3 directly via presigned URLs - they
// never pass through this API.
import { config } from './config';
import { getAccessToken } from './auth/cognito';
import { compressImage, normalizeForAnalysis } from './utils/compressImage';
import { DEFAULT_REMINDER_DAYS, FREE_PLAN_LIMITS } from './productConfig';

const COMPRESSIBLE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export interface Pet {
  id: string;
  name: string;
  species: string;
  avatarUrl?: string;
  createdAt?: string; // ISO; server-stamped, drives active-pets ranking
  // False when the account holds more pets than its plan allows and this pet
  // is outside the oldest-N set: still fully viewable, but no new docs/meds.
  active?: boolean;
  // True when this pet belongs to the family the caller is a member of (it
  // lives under the owner's account). Members can't delete it or manage its
  // passport — the server enforces this; the flag drives the UI.
  household?: boolean;
  passportToken?: string;
  passportExpiry?: string; // YYYY-MM-DD
  // optional health profile fields
  breed?: string;
  dob?: string;         // YYYY-MM-DD
  weight?: string;
  allergies?: string;
  behavior?: string;
  vetName?: string;
  vetPhone?: string;
  emergencyContact?: string;
  microchip?: string;
  fixed?: boolean;
  notes?: string;
}

export interface UserSettings {
  email: string;
  remindersEnabled: boolean;
  reminderDays: number[];
  marketingOptIn: boolean;
  emailOptOut: boolean; // master kill-switch: true = no Petshots email at all
  weeklyDigest: boolean; // Sunday summary; only sends alongside remindersEnabled
}

export const DEFAULT_SETTINGS: UserSettings = {
  email: '',
  remindersEnabled: true,
  reminderDays: [...DEFAULT_REMINDER_DAYS],
  marketingOptIn: true,
  emailOptOut: false,
  weeklyDigest: true,
};

export function getSettings(): Promise<UserSettings> {
  return request('GET', '/settings');
}

export function saveSettings(settings: UserSettings): Promise<UserSettings> {
  return request('PUT', '/settings', settings);
}

// Permanently deletes everything: S3 data, passports, Stripe subscription,
// and the Cognito user itself. The caller must sign the user out afterwards.
export function deleteAccount(): Promise<void> {
  return request('DELETE', '/account');
}

// Public (no login): called from the email unsubscribe link's landing page.
// sub + token come from the link's query params.
export async function unsubscribeAll(sub: string, token: string): Promise<void> {
  const res = await friendlyFetch(config.apiBaseUrl + '/unsubscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sub, token }),
  });
  if (!res.ok) throw new Error('This unsubscribe link is invalid or has expired.');
}

export interface PassportDoc {
  id: string;
  label: string;
  expiry?: string;
  given?: string; // YYYY-MM-DD, date administered
  filename: string;
  url: string;
}

// Public med view: name + schedule only (no ids or reminder settings).
export interface PassportMed {
  name: string;
  interval: number;
  unit: MedUnit;
  nextDue: string;
  lastGiven?: string;
}

export interface PassportData {
  pet: Omit<Pet, 'id' | 'passportToken' | 'passportExpiry'>;
  docs: PassportDoc[];
  meds?: PassportMed[]; // absent on responses from an older API
  expiresAt?: string;
}

export interface Doc {
  id: string;
  label: string;
  expiry?: string; // YYYY-MM-DD, the vaccine's expiration date (optional)
  given?: string; // YYYY-MM-DD, the date the shot was administered (optional)
  remindersEnabled: boolean; // per-record reminder opt-in; true by default
  filename: string;
  size: number;
  etag?: string; // S3 content identity — same file committed as N records shares it
  uploadedAt: string;
  url: string; // short-lived presigned GET URL
}

export type MedUnit = 'day' | 'week' | 'month';

export interface Med {
  id: string;
  name: string;
  interval: number; // "every {interval} {unit}s"
  unit: MedUnit;
  nextDue: string; // YYYY-MM-DD
  remindersEnabled: boolean;
  lastGiven?: string; // YYYY-MM-DD
  // "Stop tracking": stays on record, but banners, overview status, the
  // passport, and reminder emails all skip it.
  dismissed?: boolean;
  // Server-stamped on first save; sent back on PUT but never trusted there.
  createdAt?: string;
}

// ---- web push ----

export function subscribePush(subscription: unknown): Promise<{ ok: true }> {
  return request('POST', '/push/subscribe', { subscription });
}

export function unsubscribePush(endpoint: string): Promise<void> {
  return request('POST', '/push/unsubscribe', { endpoint });
}

// Native iOS app: an APNs device token instead of a web push subscription.
export function subscribeApnsPush(token: string): Promise<{ ok: true }> {
  return request('POST', '/push/subscribe', { platform: 'ios', token });
}

export function unsubscribeApnsPush(token: string): Promise<void> {
  return request('POST', '/push/unsubscribe', { token });
}

// ---- public roadmap ----

export interface RoadmapItem {
  id: string;
  title: string;
  description?: string;
  status: 'planned' | 'in-progress' | 'complete';
  completedAt?: string; // YYYY-MM-DD, present on shipped items
  votes: number;
}

// Public: anyone can see the board.
export async function getRoadmap(): Promise<{ items: RoadmapItem[] }> {
  const res = await friendlyFetch(`${config.apiBaseUrl}/roadmap`);
  if (!res.ok) throw new Error('Could not load the roadmap.');
  return (await res.json()) as { items: RoadmapItem[] };
}

// Authed: the caller's own votes (for chip state) and the vote toggle.
export function getMyRoadmapVotes(): Promise<{ voted: string[] }> {
  return request('GET', '/roadmap/votes');
}

export function toggleRoadmapVote(
  itemId: string,
): Promise<{ itemId: string; voted: boolean; votes: number }> {
  return request('POST', '/roadmap/vote', { itemId });
}

// ---- weight log ----

export interface WeightEntry {
  date: string; // YYYY-MM-DD
  weight: number;
  unit: 'lb' | 'kg';
  by: string; // who logged it, server-stamped
  at: string;
}

export function listWeights(petId: string): Promise<{ entries: WeightEntry[] }> {
  return request('GET', `/pets/${petId}/weights`);
}

// Same-date logs replace (typo fix); the newest entry also becomes the
// profile's display weight server-side.
export function logWeight(
  petId: string,
  date: string,
  weight: number,
  unit: 'lb' | 'kg',
): Promise<{ entries: WeightEntry[] }> {
  return request('POST', `/pets/${petId}/weights`, { date, weight, unit });
}

export function deleteWeight(petId: string, date: string): Promise<{ entries: WeightEntry[] }> {
  return request('DELETE', `/pets/${petId}/weights/${date}`);
}

// ---- daily care checklist ----

export interface DailyItem {
  id: string; // med rows use "med:{medId}" and derive from the Meds tab
  name: string;
  med?: boolean;
  kind?: 'check' | 'counter'; // counters tally repeatable events (poops, walks)
}
export interface DailyCheckInfo {
  by: string; // email of whoever checked it, server-stamped (counters: last increment)
  at: string; // ISO timestamp
  count?: number; // counter rows only
}
export interface DailyMoodInfo {
  value: number; // 1 (rough) .. 5 (great)
  by: string;
  at: string;
}
export interface DailyState {
  date: string;
  items: DailyItem[];
  checks: Record<string, DailyCheckInfo>;
  mood: DailyMoodInfo | null;
}

// The list is a LOCAL day (dinner at 8pm ET must not roll into tomorrow's UTC list).
export function localToday(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function getDaily(petId: string, date: string): Promise<DailyState> {
  return request('GET', `/pets/${petId}/daily?date=${date}`);
}

// Checking a med row also marks it as given (and unchecking restores it).
export function checkDaily(
  petId: string,
  date: string,
  itemId: string,
  checked: boolean,
): Promise<{ date: string; checks: Record<string, DailyCheckInfo> }> {
  return request('POST', `/pets/${petId}/daily/check`, { date, itemId, checked });
}

// First press wins the attribution; a different value overrides it.
export function setDailyMood(
  petId: string,
  date: string,
  value: number,
): Promise<{ date: string; mood: DailyMoodInfo }> {
  return request('POST', `/pets/${petId}/daily/mood`, { date, value });
}

export function saveDailyItems(
  petId: string,
  items: { id?: string; name: string; kind?: 'check' | 'counter' }[],
  // The client's local day — stamps removed items' removedOn (history keeps
  // showing them for days before this) and new items' addedOn.
  date?: string,
): Promise<{ items: DailyItem[] }> {
  return request('PUT', `/pets/${petId}/daily/items`, { items, date });
}

// Per-user limits, resolved server-side from the user's plan and returned by
// GET /pets. The defaults mirror the free tier and only cover the moment
// before the first listPets response (or an older API without limits).
export interface Limits {
  plan: 'free' | 'paid';
  maxPets: number;
  maxDocs: number;
  maxMeds: number;
  maxMembers?: number; // family members besides the owner (absent on older API)
  dailyHistoryDays?: number; // Daily-tab browse depth (absent on older API)
}

// Pre-fetch placeholder only — the server sends the real limits with GET /pets.
// dailyHistoryDays MUST MATCH DAILY.HISTORY_DAYS_FREE in
// infra/lambda/shared/config.ts (the free window).
export const DEFAULT_LIMITS: Limits = { plan: 'free', dailyHistoryDays: 14, ...FREE_PLAN_LIMITS };

// Family summary riding on GET /pets: enough for badges without an extra call.
export interface FamilyInfo {
  role: 'owner' | 'member';
  ownerEmail?: string; // member view
  memberCount?: number; // owner view
}

// fetch() rejects with a browser-internal message ("Failed to fetch") when the
// network is down or CORS blocks the call — translate it for humans.
async function friendlyFetch(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    throw new Error("Can't reach the server. Check your connection and try again.");
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new Error('Your session has expired. Please log in again.');

  const res = await friendlyFetch(config.apiBaseUrl + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return undefined as T;
  const data = res.headers.get('content-type')?.includes('json')
    ? await res.json()
    : null;
  if (!res.ok) {
    throw new Error(data?.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

// Presigned POST helper: every signed field first, then the file LAST - S3
// ignores form fields that appear after the file part. Don't set Content-Type;
// the browser adds the multipart boundary itself. S3 enforces the policy's
// size limit (content-length-range) server-side.
async function postToS3(presign: { url: string; fields: Record<string, string> }, file: File) {
  const form = new FormData();
  for (const [k, v] of Object.entries(presign.fields)) form.append(k, v);
  form.append('file', file);
  const res = await friendlyFetch(presign.url, { method: 'POST', body: form });
  // S3 returns 204 on success; a 403 here usually means the file exceeded the
  // policy's size limit.
  if (!res.ok) throw new Error(`Upload to storage failed (${res.status})`);
}

// ---- pets ----

export function listPets(): Promise<{ pets: Pet[]; limits?: Limits; family?: FamilyInfo }> {
  return request('GET', '/pets');
}

// ---- trends (bottom-bar "Trends" tab) ----
// Week is available on every plan; month is a paid perk (server omits it —
// `null` — for free accounts), same free/paid split as Limits.dailyHistoryDays.
export interface TrendsChecklistItem {
  id: string;
  label: string;
  count: number;
  total: number;
}
// One entry per date in the window, oldest first — value is null on days
// with nothing logged (a gap, not a zero). Sparklines render these directly.
export interface TrendsSeriesPoint {
  date: string;
  value: number | null;
}
export interface TrendsChecklistDots {
  id: string;
  label: string;
  days: boolean[]; // one per date in the window, oldest first
}
export interface TrendsWeek {
  moodAvg: number | null;
  checklist: TrendsChecklistItem[];
  medsGiven: number;
  weight: { value: number; unit: string; deltaWeek: number | null } | null;
  insight: string | null;
  moodSeries: TrendsSeriesPoint[];
  weightSeries: TrendsSeriesPoint[];
  weightUnit: string | null;
  checklistSeries: TrendsChecklistDots[];
}
export interface TrendsMonthChecklistItem {
  id: string;
  label: string;
  pctThis: number;
  pctLast: number;
}
export interface TrendsMonth {
  headline: string | null;
  moodAvg: number | null;
  moodAvgLastMonth: number | null;
  medsGiven: number;
  medsGivenLastMonth: number;
  checklist: TrendsMonthChecklistItem[];
  moodSeries: TrendsSeriesPoint[];
  weightSeries: TrendsSeriesPoint[];
  weightUnit: string | null;
  checklistSeries: TrendsChecklistDots[];
}
export interface TrendsPet {
  petId: string;
  name: string;
  week: TrendsWeek;
  month: TrendsMonth | null;
}
export function getTrends(): Promise<{ plan: 'free' | 'paid'; pets: TrendsPet[] }> {
  return request('GET', '/trends');
}

// "Email me this report" — week is available on every plan; month 403s on
// a free account (the button that calls this is hidden for free users to
// begin with, but the server enforces it regardless).
export function sendTrendsReport(period: 'week' | 'month'): Promise<{ ok: true; sent: boolean; reason?: string }> {
  return request('POST', '/trends/send', { period });
}

// ---- family / household ----

export interface HouseholdMemberView {
  sub: string;
  email: string;
  joinedAt: string;
}
export interface HouseholdInviteView {
  token: string;
  url: string;
  expiresAt: string;
  sentTo?: string; // present when the invite was emailed
}
export type Household =
  | {
      role: 'owner';
      members: HouseholdMemberView[];
      invites: HouseholdInviteView[];
      maxMembers: number;
    }
  | { role: 'member'; ownerEmail: string; joinedAt: string };

export function getHousehold(): Promise<Household> {
  return request('GET', '/household');
}

// With an email, Petshots sends the invite directly; without one you get a
// link to share yourself. emailDelivered:false = invite created but the
// send failed — share the link by hand.
export function createInvite(
  email?: string,
): Promise<{ token: string; url: string; expiresAt: string; sentTo?: string; emailDelivered?: boolean }> {
  return request('POST', '/household/invites', email ? { email } : {});
}

export function revokeInvite(token: string): Promise<void> {
  return request('DELETE', `/household/invites/${token}`);
}

export function joinHousehold(token: string): Promise<{ ownerEmail: string }> {
  return request('POST', '/household/join', { token });
}

export function removeMember(memberSub: string): Promise<void> {
  return request('DELETE', `/household/members/${memberSub}`);
}

export function leaveHousehold(): Promise<void> {
  return request('POST', '/household/leave');
}

// Public (no login): the /join page's invite preview.
export async function getInviteInfo(
  token: string,
): Promise<{ ownerEmail?: string; expiresAt: string }> {
  const res = await friendlyFetch(`${config.apiBaseUrl}/household/invites/${token}`);
  if (!res.ok) throw new Error('This invite link is invalid or has expired.');
  return (await res.json()) as { ownerEmail?: string; expiresAt: string };
}

export function createPet(name: string, species: string): Promise<{ pet: Pet }> {
  return request('POST', '/pets', { name, species });
}

export function updatePet(id: string, fields: Omit<Pet, 'id' | 'avatarUrl'>): Promise<{ pet: Pet }> {
  return request('PUT', `/pets/${id}`, fields);
}

export function deletePet(id: string): Promise<void> {
  return request('DELETE', `/pets/${id}`);
}

export async function uploadAvatar(petId: string, file: File): Promise<void> {
  const toUpload = COMPRESSIBLE_TYPES.has(file.type) ? await compressImage(file) : file;
  const presign = await request<{ url: string; fields: Record<string, string> }>(
    'POST',
    `/pets/${petId}/avatar/upload-url`,
    { contentType: toUpload.type },
  );
  await postToS3(presign, toUpload);
}

// ---- documents (per pet) ----

export function listDocs(petId: string): Promise<{ docs: Doc[] }> {
  return request('GET', `/pets/${petId}/docs`);
}

export function updateDoc(
  petId: string,
  id: string,
  label: string,
  expiry?: string,
  remindersEnabled?: boolean,
  given?: string,
): Promise<{ ok: true }> {
  return request('PATCH', `/pets/${petId}/docs/${id}`, {
    label,
    expiry: expiry || undefined,
    // '' = explicit clear; the server preserves the stored value when absent.
    given,
    remindersEnabled: remindersEnabled !== false,
  });
}

export function deleteDoc(petId: string, id: string): Promise<void> {
  return request('DELETE', `/pets/${petId}/docs/${id}`);
}

// ---- medications (per pet) ----

export function listMeds(petId: string): Promise<{ meds: Med[] }> {
  return request('GET', `/pets/${petId}/meds`);
}

// Whole-list replace; the server validates every entry and echoes the stored list.
export function saveMeds(petId: string, meds: Med[]): Promise<{ meds: Med[] }> {
  return request('PUT', `/pets/${petId}/meds`, { meds });
}

// ---- passport ----

export function createPassport(
  petId: string,
  expiry?: string,
): Promise<{ token: string; url: string; expiresAt?: string }> {
  return request('POST', `/pets/${petId}/passport`, { expiry: expiry || undefined });
}

export function revokePassport(petId: string): Promise<void> {
  return request('DELETE', `/pets/${petId}/passport`);
}

// ---- billing ----

// Both return a Stripe-hosted URL to redirect the browser to.
export function createCheckout(interval: 'month' | 'year'): Promise<{ url: string }> {
  return request('POST', '/billing/checkout', { interval });
}

export function createBillingPortal(): Promise<{ url: string }> {
  return request('POST', '/billing/portal');
}

export async function fetchPassport(token: string): Promise<PassportData> {
  const res = await friendlyFetch(config.apiBaseUrl + `/passport/${token}`);
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error ?? `Failed to load passport (${res.status})`);
  }
  return res.json() as Promise<PassportData>;
}

// ---- AI document extraction ----
// Flow: upload the file to a temp slot, ask Claude to read it, show the user a
// pre-filled review screen, then commit — one upload can become several records.

export interface ExtractedVaccine {
  name: string;
  dateGiven?: string; // YYYY-MM-DD
  expiry?: string; // YYYY-MM-DD, only when a date is printed on the document
  validityText?: string; // duration as printed, e.g. "1 year", "(3 Months)"
  suggestedExpiry?: string; // dateGiven + validityText, computed server-side
}

export interface Extraction {
  isPetHealthDocument: boolean;
  pet: {
    name?: string;
    species?: string;
    breed?: string;
    birthday?: string;
    weight?: string;
    microchip?: string;
  };
  vet: { name?: string; clinic?: string; phone?: string };
  vaccines: ExtractedVaccine[];
}

export interface CommitRecord {
  label: string;
  expiry?: string;
  given?: string;
  remindersEnabled: boolean;
}

// Fields the commit route will merge into the pet profile (whitelisted server-side).
export interface ProfilePatch {
  breed?: string;
  dob?: string;
  weight?: string;
  vetName?: string;
  vetPhone?: string;
  microchip?: string;
}

// Uploads to the temp slot and returns the uploadId to analyze/commit with.
export async function uploadForAnalysis(petId: string, file: File): Promise<string> {
  // Normalize image orientation before upload. The canvas round-trip applies
  // EXIF orientation so upside-down/rotated phone photos arrive at the model
  // right-side up. PDFs and non-image types are passed through unchanged.
  const toUpload = COMPRESSIBLE_TYPES.has(file.type) ? await normalizeForAnalysis(file) : file;
  const presign = await request<{
    url: string;
    fields: Record<string, string>;
    uploadId: string;
  }>('POST', `/pets/${petId}/docs/analyze-upload-url`, {
    filename: toUpload.name,
    contentType: toUpload.type || 'application/octet-stream',
  });
  await postToS3(presign, toUpload);
  return presign.uploadId;
}

// A byte-identical re-upload of a file already backing a record comes back as
// { duplicate } instead of an extraction — no model call, no scan consumed.
export interface DuplicateInfo {
  id: string;
  label: string;
  expiry?: string;
}

// Server errors surface as Error(message) with machine-readable messages:
// AI_QUOTA_EXCEEDED, TOO_LARGE_FOR_AI, UNSUPPORTED_TYPE_FOR_AI, AI_FAILED.
export function analyzeUpload(
  petId: string,
  uploadId: string,
): Promise<{ extraction?: Extraction; scansRemaining?: number; duplicate?: DuplicateInfo }> {
  return request('POST', `/pets/${petId}/docs/analyze`, { uploadId });
}

export function commitUpload(
  petId: string,
  uploadId: string,
  records: CommitRecord[],
  profile?: ProfilePatch,
): Promise<{ docs: (CommitRecord & { id: string; filename: string })[] }> {
  return request('POST', `/pets/${petId}/docs/commit`, {
    uploadId,
    records,
    ...(profile && Object.keys(profile).length > 0 ? { profile } : {}),
  });
}

export function createManualRecords(
  petId: string,
  records: CommitRecord[],
): Promise<{ docs: (CommitRecord & { id: string; filename: string })[] }> {
  return request('POST', `/pets/${petId}/docs/create-record`, { records });
}

export async function uploadDoc(
  petId: string,
  file: File,
  label: string,
  expiry?: string,
  remindersEnabled?: boolean,
): Promise<void> {
  const presign = await request<{
    url: string;
    fields: Record<string, string>;
    key: string;
  }>('POST', `/pets/${petId}/docs/upload-url`, {
    filename: file.name,
    label,
    expiry: expiry || undefined,
    remindersEnabled: remindersEnabled !== false,
    contentType: file.type || 'application/octet-stream',
  });
  await postToS3(presign, file);
}
