// Client for PetshotsApiStack's HTTP API. Every call attaches the Cognito access
// token as a Bearer header; the API Gateway authorizer verifies it before the
// Lambda runs. File bytes go browser->S3 directly via presigned URLs - they
// never pass through this API.
import { config } from './config';
import { getAccessToken } from './auth/cognito';
import { compressImage, normalizeForAnalysis, compressPhoto } from './utils/compressImage';
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
  /** Memorial state: pet has passed away. Records/photos stay viewable;
   *  stories, reminders, digests, achievements, Daily, and walk pickers all
   *  skip the pet. NOTE: PUT /pets is a full replace — every updatePet call
   *  must pass these through or the flag silently clears. */
  memorial?: boolean;
  passedOn?: string; // YYYY-MM-DD, optional
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

// Permanently deletes everything stored by Petshots: S3 data, passports, and
// the Cognito user itself. App Store subscriptions are managed by Apple and
// must be cancelled separately. The caller must sign the user out afterwards.
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
  // "Archived": hidden from the main records list and skipped by status badges,
  // the passport, and reminders. Stays viewable in the Archived section.
  dismissed?: boolean;
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
  /** Server hint: feeding items are active but unused across the whole live
   *  window while other tracking IS used — the tab offers to drop them. */
  feedingIdle?: boolean;
  /** Other household members who could receive a manual nudge for today's list. */
  householdRecipients?: number;
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

export function nudgeDailyTask(
  petId: string,
  itemId: string,
): Promise<{ ok: true; notified: number; pushed: number }> {
  return request('POST', `/pets/${petId}/daily/nudge`, { itemId });
}

// Per-user limits, resolved server-side from the user's plan and returned by
// GET /pets. The defaults mirror the free tier and only cover the moment
// before the first listPets response (or an older API without limits).
export interface Limits {
  plan: 'free' | 'paid';
  // Apple is the App Store entitlement source. manual is an explicit
  // operator/tester override rather than a second purchase path.
  billingSource?: 'apple' | 'manual';
  billingSources?: ('apple' | 'manual')[];
  billingApple?: {
    status?: string;
    expiresAt?: string | null;
    productId?: string;
    environment?: string;
    updatedAt?: string;
  };
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

// ---- summary (bottom-bar "Summary" tab) ----
// Today's AI-written story of the household's last 7 days, plus the week's
// photos and light per-pet numbers. The server generates the story at most
// once per day per account pool and caches it, so repeat calls are fast;
// the FIRST call of the day runs the model (several seconds — show a
// writing state). story:null comes with a reason: NOT_ENOUGH_DATA (quiet
// week, nothing to tell yet) or AI_FAILED (model hiccup — retry later).
export interface SummaryPetChip {
  petId: string;
  name: string;
  carePct: number;
  moodAvg: number | null;
  walks: { count: number; miles: number; kcal: number | null } | null; // null for cats
  /** Feeding tallies — surfaced as a chip stat only, never in the story. */
  meals: { done: number; total: number } | null;
}
export interface SummaryPhoto {
  petId: string;
  id: string;
  filename: string;
  url: string;
}
export interface SummaryResponse {
  story: string | null;
  reason?: 'NOT_ENOUGH_DATA' | 'AI_FAILED';
  generatedAt?: string;
  rangeStart: string;
  rangeEnd: string;
  pets: SummaryPetChip[];
  insights?: { petId: string; petName: string; text: string }[];
  deadlines?: {
    petId: string;
    petName: string;
    kind: 'doc' | 'med';
    label: string;
    date: string;
    days: number;
    status: 'overdue' | 'today' | 'due-soon';
  }[];
  photos: SummaryPhoto[];
}
export function getSummary(): Promise<SummaryResponse> {
  return request('GET', '/summary');
}

// The persistent story archive: one story per completed week (written by a
// Monday cron), consolidated per month (1st-of-month cron). Grows into the
// "pet book". List returns previews; the entry call returns the full story
// with fresh presigned photos.
export interface SummaryArchiveItem {
  key: string; // weeks: the Monday YYYY-MM-DD · months: YYYY-MM
  rangeStart: string;
  rangeEnd: string;
  monthLabel?: string; // months only, e.g. "July 2026"
  preview: string;
}
export interface SummaryArchiveEntry {
  key: string;
  kind: 'weeks' | 'months';
  rangeStart: string;
  rangeEnd: string;
  monthLabel?: string;
  story: string;
  generatedAt: string;
  pets: SummaryPetChip[];
  photos: SummaryPhoto[];
}
export function getSummaryArchive(): Promise<{ weeks: SummaryArchiveItem[]; months: SummaryArchiveItem[] }> {
  return request('GET', '/summary/archive');
}
export function getSummaryEntry(kind: 'weeks' | 'months', key: string): Promise<SummaryArchiveEntry> {
  return request('GET', `/summary/archive/${kind}/${key}`);
}

// ---- walks (account-level — one walk can cover multiple pets) ----

export interface WalkRecord {
  id: string;
  petIds: string[];
  startedAt: string; // ISO timestamp
  endedAt: string; // ISO timestamp
  distanceMeters: number;
  by?: string; // actor email, server-stamped; absent on pre-attribution walks
  // Family-tagged walks: emails of household members tagged as "walked with
  // me". countsForPet:false means a matching twin walk was found (see
  // backend) and this is the shorter of the pair — still shows here, just
  // excluded from the pet's aggregate stats.
  withMembers?: string[];
  countsForPet?: boolean;
  mergedWithId?: string;
  // Dog energy estimates (≈kcal, latest weight × distance), computed by the
  // server per dog on the walk. Missing for cats / dogs with no weight log.
  kcalByPet?: Record<string, number>;
}

export function listWalks(): Promise<{ walks: WalkRecord[] }> {
  return request('GET', '/walks');
}

export function createWalk(
  petIds: string[],
  startedAt: string,
  endedAt: string,
  distanceMeters: number,
  withMembers?: string[],
): Promise<{ walk: WalkRecord; kcalByPet?: Record<string, number> }> {
  return request('POST', '/walks', { petIds, startedAt, endedAt, distanceMeters, withMembers });
}

export function deleteWalk(id: string): Promise<void> {
  return request('DELETE', `/walks/${id}`);
}

// ---- achievements (account-level, swipe-left from the overview screen) ----

export interface AchievementBadge {
  id: string;
  icon: string;
  name: string;
  description: string; // the goal, shown while locked
  congrats: string; // celebration line, shown once earned
  earnedAt: string | null; // local YYYY-MM-DD, null = still locked
}
export interface AchievementCard {
  id: string;
  icon: string;
  label: string;
  value: string;
  badges: AchievementBadge[];
}
export interface PetAchievements {
  petId: string;
  petName: string;
  cards: AchievementCard[];
}
// Family walk leaderboard — null for solo accounts (no household members).
// `me` = the caller's email so the UI can highlight their own row.
export interface WalkLeaderboard {
  label: string;
  me: string;
  members: { email: string; walks: number; miles: number }[];
}

export function getAchievements(): Promise<{ pets: PetAchievements[]; leaderboard: WalkLeaderboard | null }> {
  return request('GET', '/achievements');
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
      participants: string[]; // other members' emails — for the walk "who else was there" picker
    }
  | { role: 'member'; ownerEmail: string; joinedAt: string; participants: string[] };

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

// ---- photos (casual per-pet album — swipe-right camera / swipe-left
// albums on the overview screen) ----

export interface Photo {
  id: string;
  filename: string;
  size: number;
  uploadedAt: string;
  url: string; // short-lived presigned GET URL
}

export function listPhotos(petId: string): Promise<{ photos: Photo[] }> {
  return request('GET', `/pets/${petId}/photos`);
}

// Presign -> upload -> confirm in one call, so callers (the camera capture
// flow) don't need to know it's a two-request round trip. The confirm call
// is what triggers the household push — see infra/lambda/api/index.ts's
// POST /pets/{petId}/photos/{id}/confirm. A 409 here means the daily save
// limit was hit; its message is already the full toast text (see that
// route's comment — deliberately the only place the cap is ever mentioned).
export async function uploadPhoto(petId: string, file: File): Promise<void> {
  const toUpload = COMPRESSIBLE_TYPES.has(file.type) ? await compressPhoto(file) : file;
  const presign = await request<{ url: string; fields: Record<string, string>; photoId: string }>(
    'POST',
    `/pets/${petId}/photos/upload-url`,
    { filename: toUpload.name, contentType: toUpload.type },
  );
  await postToS3(presign, toUpload);
  await request('POST', `/pets/${petId}/photos/${presign.photoId}/confirm`);
}

export function deletePhoto(petId: string, id: string): Promise<void> {
  return request('DELETE', `/pets/${petId}/photos/${id}`);
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

// Archive (hide) or restore a record. A partial PATCH — the server preserves
// label/expiry/given and, when archiving, also silences the record's reminders.
export function setDocArchived(petId: string, id: string, dismissed: boolean): Promise<{ ok: true }> {
  return request('PATCH', `/pets/${petId}/docs/${id}`, { dismissed });
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

// Apple signs each StoreKit transaction. The API verifies those JWS values,
// ties appAccountToken to the signed-in Cognito sub, and returns fresh limits.
export function syncAppleTransactions(
  signedTransactions: string[],
  clearTesterPlan = true,
  preserveIfEmpty = false,
): Promise<Limits> {
  return request('POST', '/billing/apple/sync', {
    signedTransactions,
    clearTesterPlan,
    preserveIfEmpty,
  });
}

// Temporary owner-only preview of the real server-side free/paid behavior.
// The API verifies the Cognito sub; hiding the control in the UI is not the
// security boundary.
export function setBillingTestPlan(plan: 'free' | 'paid'): Promise<Limits> {
  return request('POST', '/billing/test-plan', { plan });
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
  // Existing doc ids to swap out (a fresh shot replacing the same expired
  // vaccine). The server deletes them only after the new records are written.
  replaceDocIds?: string[],
): Promise<{ docs: (CommitRecord & { id: string; filename: string })[] }> {
  return request('POST', `/pets/${petId}/docs/commit`, {
    uploadId,
    records,
    ...(profile && Object.keys(profile).length > 0 ? { profile } : {}),
    ...(replaceDocIds && replaceDocIds.length > 0 ? { replaceDocIds } : {}),
  });
}

export function createManualRecords(
  petId: string,
  records: CommitRecord[],
  replaceDocIds?: string[],
): Promise<{ docs: (CommitRecord & { id: string; filename: string })[] }> {
  return request('POST', `/pets/${petId}/docs/create-record`, {
    records,
    ...(replaceDocIds && replaceDocIds.length > 0 ? { replaceDocIds } : {}),
  });
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
