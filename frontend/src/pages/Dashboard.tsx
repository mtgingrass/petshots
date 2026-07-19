import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import { useAuth } from '../auth/AuthContext';
import { changePassword, verifyPassword } from '../auth/cognito';
import {
  listPets,
  createPet,
  updatePet,
  deletePet,
  uploadAvatar,
  listPhotos,
  uploadPhoto,
  deletePhoto,
  createWalk,
  listWalks,
  deleteWalk,
  getAchievements,
  listDocs,
  updateDoc,
  deleteDoc,
  setDocArchived,
  uploadForAnalysis,
  analyzeUpload,
  commitUpload,
  createManualRecords,
  listMeds,
  saveMeds,
  createPassport,
  revokePassport,
  syncAppleTransactions,
  setBillingTestPlan,
  getSettings,
  saveSettings,
  deleteAccount,
  getHousehold,
  createInvite,
  revokeInvite,
  removeMember,
  leaveHousehold,
  getDaily,
  checkDaily,
  setDailyMood,
  saveDailyItems,
  nudgeDailyTask,
  localToday,
  listWeights,
  logWeight,
  deleteWeight,
  getSummary,
  getSummaryArchive,
  getSummaryEntry,
  DEFAULT_LIMITS,
  DEFAULT_SETTINGS,
  type Limits,
  type Pet,
  type Doc,
  type Med,
  type MedUnit,
  type UserSettings,
  type Household,
  type DailyState,
  type DailyItem,
  type WeightEntry,
  type Extraction,
  type CommitRecord,
  type ProfilePatch,
  type DuplicateInfo,
  type SummaryResponse,
  type SummaryArchiveItem,
  type SummaryArchiveEntry,
  type Photo,
  type PetAchievements,
  type WalkLeaderboard,
  type WalkRecord,
} from '../api';
import { applyTheme, getSavedTheme, type Theme } from '../utils/theme';
import { readDoorCache, updateDoorCache } from '../doorCache';
import { getPushState, enablePush, disablePush, iosNeedsInstall, type PushState } from '../push';
import { OnboardingTour, TOUR_DONE_KEY } from '../components/OnboardingTour';
import { useSwipeStep } from '../components/TrendsCharts';
import {
  isNative,
  hapticTap,
  hapticSuccess,
  hapticWarning,
  saveWalkToAppleHealth,
  getAppVersion,
  getPaidOfferingPackages,
  purchaseStoreKitProduct,
  restoreStoreKitPurchases,
  getCurrentStoreKitEntitlements,
  requestAlwaysLocation,
  backgroundWalkStart,
  backgroundWalkPause,
  backgroundWalkResume,
  backgroundWalkEnd,
  backgroundWalkSnapshot,
  type StoreKitProduct,
  type PaidOfferingPackages,
} from '../native';
import { Geolocation } from '@capacitor/geolocation';
import {
  computeNotices,
  isDismissed,
  dismissNotice,
  noticeTab,
  MAX_NOTICES,
  type Notice,
} from '../utils/notices';
import {
  UPLOADS,
  DASHBOARD as DASHBOARD_CONFIG,
  ACHIEVEMENTS as ACHIEVEMENTS_CONFIG,
  APPLE_IAP,
  APP_STORE_URL,
  PAID_PLAN_LIMITS,
  REMINDER_DAY_OPTIONS,
  VACCINE_CADENCES,
} from '../productConfig';
import { SiteFooter } from '../components/SiteFooter';
import { TabBar, type MainTab } from '../components/TabBar';

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
const ALLOWED_EXTS = ['pdf', ...IMAGE_EXTS];
const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Product-tunable values live in productConfig.ts — edit them there.
const MAX_FILE_BYTES = UPLOADS.MAX_FILE_BYTES;
const DUE_SOON_DAYS = DASHBOARD_CONFIG.DUE_SOON_DAYS;
// Pure UI tuning (not backend-enforced, so it lives here rather than
// productConfig.ts) — how many photos show per pet on the Albums overview
// before "See all" is needed. 6 makes a clean 2x3/3x2 grid.
const ALBUM_PREVIEW_COUNT = 6;

type Status = 'overdue' | 'due-soon' | 'current' | 'none';

function extOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Parse a 'YYYY-MM-DD' as local midnight (not UTC) so day math is timezone-safe.
function parseDay(d: string): Date {
  return new Date(`${d}T00:00:00`);
}

function formatDate(day: string): string {
  return parseDay(day).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function daysUntil(expiry: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((parseDay(expiry).getTime() - today.getTime()) / 86_400_000);
}

function toYMD(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function todayYMD(): string {
  return toYMD(new Date());
}

// Advance a med's due date by its cadence. Month math is calendar-correct:
// the next dose lands on the same day-of-month, clamped to month end
// (Jan 31 + 1 month = Feb 28), never the +30d drift of day arithmetic.
function addInterval(from: string, interval: number, unit: MedUnit): string {
  const d = parseDay(from);
  if (unit === 'day' || unit === 'week') {
    d.setDate(d.getDate() + interval * (unit === 'week' ? 7 : 1));
    return toYMD(d);
  }
  const dayOfMonth = d.getDate();
  const r = new Date(d.getFullYear(), d.getMonth() + interval, 1);
  const lastDay = new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate();
  r.setDate(Math.min(dayOfMonth, lastDay));
  return toYMD(r);
}

function statusOf(expiry?: string): Status {
  if (!expiry) return 'none';
  const days = daysUntil(expiry);
  if (days < 0) return 'overdue';
  if (days <= DUE_SOON_DAYS) return 'due-soon';
  return 'current';
}

// Most urgent first: the record you need to act on (or produce at the door)
// should never be below the fold.
const STATUS_RANK: Record<Status, number> = { overdue: 0, 'due-soon': 1, current: 2, none: 3 };
function sortDocs(docs: Doc[]): Doc[] {
  return [...docs].sort((a, b) => {
    const rank = STATUS_RANK[statusOf(a.expiry)] - STATUS_RANK[statusOf(b.expiry)];
    if (rank !== 0) return rank;
    if (a.expiry && b.expiry && a.expiry !== b.expiry) return a.expiry < b.expiry ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
}

function speciesEmoji(species: string): string {
  if (species === 'dog') return '🐶';
  if (species === 'cat') return '🐱';
  return '🐾';
}

// Meds a pet is actively tracking (dismissed = kept on record, never "due").
function trackedMeds(meds: Med[] | undefined): Med[] {
  return (meds ?? []).filter((m) => m.dismissed !== true);
}

// Records still in play: archived (dismissed) records stay stored but drop out
// of status badges, banners, and the overview ring — the owner said they don't
// care about them.
function trackedDocs(docs: Doc[] | undefined): Doc[] {
  return (docs ?? []).filter((d) => !d.dismissed);
}

// Worst-case status across a pet's docs AND meds — drives the overview pin ring.
function petOverallStatus(allDocs: Doc[], meds?: Med[]): Status {
  let worst = trackedDocs(allDocs).reduce<Status>((w, doc) => {
    const s = statusOf(doc.expiry);
    return STATUS_RANK[s] < STATUS_RANK[w] ? s : w;
  }, 'none');
  for (const med of trackedMeds(meds)) {
    const s = medStatus(med).status;
    if (STATUS_RANK[s] < STATUS_RANK[worst]) worst = s;
  }
  return worst;
}

// Compact status that fits under a pet pin without truncating.
function petPinStatus(allDocs: Doc[], meds?: Med[]): string {
  const docs = trackedDocs(allDocs);
  const tracked = trackedMeds(meds);
  if (docs.length === 0 && tracked.length === 0) return 'No records yet';
  const overdue =
    docs.filter((d) => statusOf(d.expiry) === 'overdue').length +
    tracked.filter((m) => medStatus(m).status === 'overdue').length;
  if (overdue > 0) return `${overdue} overdue`;
  const dueSoon =
    docs.filter((d) => statusOf(d.expiry) === 'due-soon').length +
    tracked.filter((m) => medStatus(m).status === 'due-soon').length;
  if (dueSoon > 0) return `${dueSoon} due soon`;
  return 'All current';
}

// Match common vaccine labels to a plain-English blurb. Returns null for unknowns.
function vaccineBlurb(label: string): string | null {
  const l = label.toLowerCase();
  if (/rabies/.test(l))
    return 'Required at nearly every boarding facility, dog park, daycare, and groomer. A current rabies certificate is the most-requested document at check-in.';
  if (/\bdhpp\b|da2pp|distemper|parvovirus|parvo/.test(l))
    return 'Core vaccine protecting against distemper, adenovirus, parvovirus, and parainfluenza. Usually renewed every 1–3 years after the initial series.';
  if (/bordetella|kennel.?cough/.test(l))
    return 'Required at most boarding facilities and dog parks. Protects against kennel cough, a highly contagious respiratory infection.';
  if (/lepto/.test(l))
    return 'Protects against leptospirosis, a bacterial infection spread through contaminated water, soil, and wildlife.';
  if (/lyme/.test(l))
    return 'Tick-borne disease prevention, especially important in wooded or grassy areas.';
  if (/influenza|canine.?flu/.test(l))
    return 'Required at some boarding and daycare facilities. Protects against canine influenza strains H3N2 and H3N8.';
  if (/felv|feline.?leukemia/.test(l))
    return 'Recommended for cats with outdoor access or contact with other cats. Protects against feline leukemia virus.';
  if (/fvrcp|rhinotracheitis|calici/.test(l))
    return 'Core feline vaccine protecting against feline herpesvirus, calicivirus, and panleukopenia. Usually renewed every 1–3 years.';
  return null;
}

// "year" / "3 years" / "6 months" — a single interval in words.
function humanEvery(months: number): string {
  if (months % 12 === 0) {
    const y = months / 12;
    return y === 1 ? 'year' : `${y} years`;
  }
  return months === 1 ? 'month' : `${months} months`;
}

// Turn a vaccine's cadence options into a phrase like "about every year" or
// "every 1–3 years". Ranges collapse to a shared unit (years when both are
// whole years, otherwise months).
function cadencePhrase(options: { months: number }[]): string {
  const ms = [...new Set(options.map((o) => o.months))].sort((a, b) => a - b);
  const lo = ms[0];
  const hi = ms[ms.length - 1];
  if (lo === hi) return `about every ${humanEvery(lo)}`;
  if (lo % 12 === 0 && hi % 12 === 0) return `every ${lo / 12}–${hi / 12} years`;
  return `every ${lo}–${hi} months`;
}

// Informational "typical schedule" line for a recognized vaccine, e.g. "Most
// dogs get this about every year." NOT medical advice — the Record Details
// screen always pairs it with a "check with your vet" disclaimer. Returns null
// for labels we don't recognize (nothing to say, so nothing shows).
function vaccineCadenceNote(label: string, species?: string): string | null {
  const c = VACCINE_CADENCES.find((v) => v.match.test(label));
  if (!c) return null;
  const who = species === 'cat' ? 'cats' : species === 'dog' ? 'dogs' : 'pets';
  return `Most ${who} get this ${cadencePhrase(c.options)}.`;
}

// ---- navigation state ----

// ---- daily history dates ----
// Pre-fetch fallback for how far back the Daily tab can browse; the real
// depth is plan-gated and arrives with GET /pets limits (dailyHistoryDays).
// MUST MATCH DAILY.HISTORY_DAYS_FREE in infra/lambda/shared/config.ts.
const DAILY_HISTORY_FALLBACK_DAYS = 14;

// Day arithmetic on local-calendar YYYY-MM-DD strings (same convention as
// localToday(): the list is a LOCAL day).
function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  const p = (v: number) => String(v).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

// "Today, July 9" / "Yesterday, July 8" / "Monday, July 7"
function dailyDateLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const monthDay = dt.toLocaleDateString([], { month: 'long', day: 'numeric' });
  const today = localToday();
  if (day === today) return `Today, ${monthDay}`;
  if (day === addDays(today, -1)) return `Yesterday, ${monthDay}`;
  return `${dt.toLocaleDateString([], { weekday: 'long' })}, ${monthDay}`;
}

function initialsFromEmail(email: string): string {
  const parts = email.split('@')[0].split(/[._+-]+/).filter(Boolean);
  const init =
    parts.length >= 2 ? parts[0][0] + parts[1][0] : (parts[0] ?? '?').slice(0, 2);
  return init.toUpperCase();
}

// Passport is NOT a pet-detail segment — it's a bottom-bar tab listing every
// pet's passport (DashView 'passports'). Profile isn't a segment either: the
// pet's identity gets its own pushed screen, opened by tapping the hero name.
type PetTab = 'records' | 'daily' | 'meds';

type SettingsSection = 'account' | 'notifications' | 'family';

type DashView =
  | { type: 'overview' }
  | { type: 'detail'; petId: string; tab?: PetTab }
  // The pet's identity screen (health profile + weight log + name/photo edit),
  // pushed from the detail hero. Everything editable — including delete —
  // lives in its Edit Profile sheet; there is no separate edit-pet screen.
  | { type: 'profile'; petId: string }
  | { type: 'passports' }
  // The Summary tab — today's AI-written story of the pool's last 7 days,
  // with the week's photos (GET /summary, cached server-side once per day).
  | { type: 'summary' }
  // A saved weekly/monthly story from the archive, pushed from Summary.
  | { type: 'summary-entry'; kind: 'weeks' | 'months'; entryKey: string }
  | { type: 'add-pet' }
  | { type: 'change-password' }
  // Settings is split into three focused screens, all reached from the
  // header avatar menu.
  | { type: 'settings'; section: SettingsSection }
  // Combined every-pet daily view — the bottom tab bar's "Daily" tab.
  | { type: 'daily' }
  // Casual per-pet photo album — reached by swipe-right on the overview
  // screen (see useSwipeStep wiring near the overview render). Shows a
  // capped preview grid per pet (ALBUM_PREVIEW_COUNT); "See all" pushes to
  // the 'album' screen below for that one pet's full, day-grouped grid.
  | { type: 'albums' }
  | { type: 'album'; petId: string }
  // Live rolling stat cards per pet (walks, distance, photos, care streak) —
  // reached by swipe-left on the overview screen, the gesture freed up
  // when swipe-to-camera was dropped. Tapping a card pushes to its 'badges'
  // ladder (earned vs still-to-earn), same push-a-level pattern as
  // albums -> album.
  | { type: 'achievements' }
  | { type: 'badges'; petId: string; cardId: string }
  // Full walk log (all pool walks, any age) with per-walk delete — the
  // escape hatch for accidentally logged / left-running-in-the-car walks.
  | { type: 'walk-history' };

type EditView =
  | { type: 'list' }
  | { type: 'doc'; doc: Doc; petId: string }
  | { type: 'edit'; doc: Doc; petId: string }
  | { type: 'edit-profile' }
  // Post-upload review: the file sits in a temp slot until the user confirms
  // what Claude read (extraction=null -> AI unavailable, plain manual entry).
  | {
      type: 'review-extraction';
      petId: string;
      uploadId: string | null; // null for manual entry (no file)
      fileName: string;
      extraction: Extraction | null;
      aiNote?: string;
      duplicateOf?: DuplicateInfo; // byte-identical to this existing record
    };

// ---- main component ----

export function Dashboard() {
  const { email, sub, logout } = useAuth();
  const navigate = useNavigate();

  const [theme, setTheme] = useState<Theme>(getSavedTheme);

  const [pets, setPets] = useState<Pet[] | null>(null); // null = still loading
  const [limits, setLimits] = useState<Limits>(DEFAULT_LIMITS);
  // The API returns over-limit pets with active:false so no data is deleted on
  // downgrade. They stay out of every picker/cache until paid access returns.
  const [lockedPetCount, setLockedPetCount] = useState(0);
  // The app opens on the pets overview (the pinned circles) everywhere;
  // the every-day surface is one tap away (Daily tab, or a pet's Daily —
  // its landing segment).
  const [dashView, setDashView] = useState<DashView>({ type: 'overview' });
  // Pet-detail's active segment, reported up so the header can show the
  // date picker only while a pet's Daily tab is up (future: reports too).
  const [petTab, setPetTab] = useState<PetTab>('daily');
  const [dailyDate, setDailyDate] = useState<string>(localToday);
  const handlePetTabChange = useCallback((t: PetTab) => {
    setPetTab(t);
    // Every fresh entry to a pet's Daily starts on today.
    if (t === 'daily') setDailyDate(localToday());
  }, []);
  const [allDocs, setAllDocs] = useState<Record<string, Doc[]>>({});
  const [allMeds, setAllMeds] = useState<Record<string, Med[]>>({});
  const [allDocsLoading, setAllDocsLoading] = useState(false);
  const [editView, setEditView] = useState<EditView>({ type: 'list' });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Which pet's records are fullscreen "at the door" — opened by
  // long-pressing a pet's circle on the overview.
  const [presentingPetId, setPresentingPetId] = useState<string | null>(null);
  // One-time discoverability tip for that gesture (touch devices only, gone
  // once dismissed or once the user actually long-presses).
  const [showPresentHint, setShowPresentHint] = useState(
    () =>
      window.matchMedia('(pointer: coarse)').matches &&
      !localStorage.getItem('petshots.presentHint'),
  );
  function dismissPresentHint() {
    localStorage.setItem('petshots.presentHint', '1');
    setShowPresentHint(false);
  }
  // Swipe-right-to-camera / swipe-left-to-albums (overview screen), and
  // swipe-right-back (albums screen) — see useSwipeStep call near the
  // bottom of this component for why a single always-mounted hook guarded
  // by dashView.type is used instead of one per screen.
  const cameraInputRef = useRef<HTMLInputElement>(null);
  // A second, separate hidden input with NO capture attribute (2026-07-14) —
  // the camera input above deliberately forces the native camera directly
  // (zero-tap) and stays untouched; this one lets the OS show its normal
  // photo chooser (library/browse, camera too) so an EXISTING photo can be
  // attached instead of only a freshly taken one. Same downstream flow
  // (capturedPhoto -> PhotoConfirmScreen) either way — one File is one File.
  const libraryInputRef = useRef<HTMLInputElement>(null);
  const [capturedPhoto, setCapturedPhoto] = useState<File | null>(null);
  const [savingPhoto, setSavingPhoto] = useState(false);
  const [showPhotoHint, setShowPhotoHint] = useState(
    () =>
      window.matchMedia('(pointer: coarse)').matches &&
      !localStorage.getItem('petshots.photoHint'),
  );
  function dismissPhotoHint() {
    localStorage.setItem('petshots.photoHint', '1');
    setShowPhotoHint(false);
  }
  function openCamera() {
    // .click() FIRST, synchronously, before any other work — iOS Safari's
    // "user activation" grant for opening the native camera (as opposed to
    // a plain file picker) is easy to lose if anything else runs first,
    // especially when this is called from a touchend handler rather than a
    // direct click on the triggering element (see useSwipeStep call below).
    cameraInputRef.current?.click();
    dismissPhotoHint();
  }
  function handleCameraChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // lets the same shot be retaken/reselected later
    if (file) { setCapturedPhoto(file); setPhotoLimitError(null); }
  }
  function openLibrary() {
    libraryInputRef.current?.click();
    dismissPhotoHint();
  }
  function handleLibraryChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // lets the same photo be reselected later
    if (file) { setCapturedPhoto(file); setPhotoLimitError(null); }
  }
  // Set only for the daily-photo-quota error, so the confirm screen stays up
  // with an upgrade CTA instead of silently discarding the photo the user
  // just took (the generic error path below still does that).
  const [photoLimitError, setPhotoLimitError] = useState<string | null>(null);
  async function handleSavePhoto(petId: string) {
    if (!capturedPhoto) return;
    const file = capturedPhoto;
    setSavingPhoto(true);
    try {
      await uploadPhoto(petId, file);
      const savedTo = pets?.find((p) => p.id === petId);
      showNotice(`Saved to ${savedTo?.name ?? "pet"}'s album.`);
      hapticSuccess();
      setCapturedPhoto(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not save the photo';
      if (msg.includes("today's photo limit") && limits.plan !== 'paid') {
        setPhotoLimitError(msg);
      } else {
        setError(msg);
        setCapturedPhoto(null);
      }
    } finally {
      setSavingPhoto(false);
    }
  }
  // Walk tracking lives in useWalkTracker (called unconditionally below, so
  // it survives regardless of screen visibility — see that hook's header
  // comment for why). walkScreenOpen controls ONLY whether the full-screen
  // WalkScreen UI is showing; a walk can be in progress (walk.phase !==
  // 'idle') while this is false — that's the minimized state, and
  // WalkMiniBar (rendered near the tab bar below) is what tells the user
  // it's still tracking (2026-07-15, Mark: couldn't take a photo mid-walk).
  const [walkScreenOpen, setWalkScreenOpen] = useState(false);
  const livingPets = pets ? pets.filter((p) => !p.memorial) : [];
  async function handleWalkSaved(msg: string) {
    setWalkScreenOpen(false);
    showNotice(msg);
    hapticSuccess();
  }
  const walk = useWalkTracker(livingPets, handleWalkSaved, setError);
  // Last GET /achievements result, kept so BadgeScreen (a drill-down of the
  // achievements screen) doesn't re-run the most S3-expensive endpoint just
  // to show a card it was tapped from. Refreshed every time the achievements
  // screen mounts.
  const [achievementsCache, setAchievementsCache] = useState<PetAchievements[] | null>(null);
  // First-run tour (once per device, phones + native): four cards ending in
  // the push-notification ask — the system dialog only fires once on iOS, so
  // the tour makes the case before spending it. navigator.webdriver skips it
  // for every Playwright suite (fresh profiles would otherwise hit the
  // overlay); a script that wants to SEE the tour launches chromium with
  // --disable-blink-features=AutomationControlled.
  const [showTour, setShowTour] = useState(
    () =>
      !navigator.webdriver &&
      (isNative || window.matchMedia('(max-width: 767px)').matches) &&
      !localStorage.getItem(TOUR_DONE_KEY),
  );
  const showNotice = useCallback((msg: string) => {
    setNotice(msg);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3000);
  }, []);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  // ---- bottom tab bar (mobile + native; desktop keeps the ProfileMenu) ----
  // Which tab owns the current view. The pets tab is a whole stack
  // (overview → detail → edit screens); daily and settings are single screens.
  const activeTab: MainTab =
    dashView.type === 'settings' || dashView.type === 'change-password'
      ? 'settings'
      : dashView.type === 'daily'
        ? 'daily'
        : dashView.type === 'summary' || dashView.type === 'summary-entry'
          ? 'summary'
          : dashView.type === 'passports'
            ? 'passports'
            : 'pets';

  // Remember where the pets stack was so switching Daily → Pets restores the
  // pet you were looking at (per-tab stacks, like a real iOS tab bar).
  const lastPetsViewRef = useRef<DashView>({ type: 'overview' });
  if (activeTab === 'pets') lastPetsViewRef.current = dashView;

  // Where Settings should return to — it's reached from the avatar menu now,
  // so remember which tab root the user came from.
  const settingsReturnRef = useRef<DashView>({ type: 'overview' });
  function openSettings(section: SettingsSection) {
    settingsReturnRef.current =
      activeTab === 'daily'
        ? { type: 'daily' }
        : activeTab === 'summary'
          ? { type: 'summary' }
          : activeTab === 'passports'
            ? { type: 'passports' }
            : { type: 'overview' };
    setDashView({ type: 'settings', section });
  }

  function handleTabSelect(tab: MainTab) {
    // Walk is an action, not a view: the tracking overlay opens over
    // whatever screen is up, and the active-tab highlight stays put. If a
    // walk already exists (ready/active/paused/summary — e.g. minimized),
    // this just reopens it — no restart, no repeat permission prompt.
    if (tab === 'walk') {
      if (walk.phase === 'idle') {
        if (livingPets.length === 0) return;
        setWalkScreenOpen(true);
        void walk.beginWalk().then((ok) => { if (!ok) setWalkScreenOpen(false); });
      } else {
        setWalkScreenOpen(true);
      }
      return;
    }
    if (tab === activeTab) {
      // iOS convention: re-tapping the active tab pops its stack to the root.
      if (tab === 'pets' && dashView.type !== 'overview') backToOverview();
      return;
    }
    if (tab === 'pets') setDashView(lastPetsViewRef.current);
    else if (tab === 'daily') setDashView({ type: 'daily' });
    else if (tab === 'summary') setDashView({ type: 'summary' });
    else if (tab === 'passports') setDashView({ type: 'passports' });
    else setDashView({ type: 'settings', section: 'account' });
  }

  // ---- screen transition direction (iOS push/pop) ----
  // Depth 0 = tab roots, 1 = pushed screens, 2 = nested. Sheet-presented
  // screens animate themselves (.screen-view--sheet slides up), so the
  // horizontal push is suppressed for them. The dir lives in a ref keyed by
  // the view so mid-animation re-renders can't cancel it.
  const isSheetView =
    dashView.type === 'add-pet' ||
    dashView.type === 'change-password' ||
    (dashView.type === 'detail' && (editView.type === 'edit' || editView.type === 'review-extraction')) ||
    (dashView.type === 'profile' && editView.type === 'edit-profile');
  const viewDepth =
    dashView.type === 'overview' ||
    dashView.type === 'daily' ||
    dashView.type === 'passports' ||
    dashView.type === 'settings'
      ? 0
      : dashView.type === 'profile' && editView.type === 'edit-profile'
        ? 3
        : dashView.type === 'change-password' ||
            dashView.type === 'profile' ||
            dashView.type === 'summary-entry' ||
            (dashView.type === 'detail' && editView.type !== 'list')
          ? 2
          : 1;
  const viewKey =
    pets === null
      ? 'loading'
      : dashView.type === 'detail'
        ? `detail:${dashView.petId}:${editView.type}`
        : dashView.type === 'profile'
          ? `profile:${dashView.petId}:${editView.type}`
          : dashView.type;
  const animRef = useRef<{ key: string; dir: 'push' | 'pop' | 'none'; depth: number }>({
    key: viewKey,
    dir: 'none',
    depth: viewDepth,
  });
  if (animRef.current.key !== viewKey) {
    animRef.current = {
      key: viewKey,
      dir:
        isSheetView || viewDepth === animRef.current.depth
          ? 'none'
          : viewDepth > animRef.current.depth
            ? 'push'
            : 'pop',
      depth: viewDepth,
    };
  }

  // Pet currently being viewed in detail/profile screens.
  const detailPet =
    dashView.type === 'detail' || dashView.type === 'profile'
      ? (pets?.find((p) => p.id === dashView.petId) ?? null)
      : null;

  // Docs for the active detail pet, always sorted.
  const detailDocs = detailPet ? (allDocs[detailPet.id] ?? []) : [];

  const presentingPet = presentingPetId
    ? (pets?.find((p) => p.id === presentingPetId) ?? null)
    : null;
  const presentingDocs = presentingPet ? (allDocs[presentingPet.id] ?? []) : [];

  const albumPet =
    dashView.type === 'album' ? (pets?.find((p) => p.id === dashView.petId) ?? null) : null;

  const loadPets = useCallback(async () => {
    setError(null);
    try {
      if (isNative && sub) {
        try {
          const current = await getCurrentStoreKitEntitlements();
          // A temporarily empty local sequence (for example while offline)
          // must not erase still-unexpired server state. Explicit Restore may
          // clear missing state; this background refresh may not.
          await syncAppleTransactions(current, false, true);
        } catch (error) {
          // Records must still load if StoreKit is temporarily unavailable.
          console.error('[StoreKit] entitlement refresh failed', error);
        }
      }
      const res = await listPets();
      const accessiblePets = res.pets.filter((pet) => pet.active !== false);
      setLockedPetCount(res.pets.length - accessiblePets.length);
      setPets(accessiblePets);
      setLimits(res.limits ?? DEFAULT_LIMITS);
      return accessiblePets;
    } catch (err) {
      // Offline with saved records = the door moment. Skip the dead dashboard
      // and go straight to the offline copy.
      if (!navigator.onLine && readDoorCache()) {
        navigate('/door', { replace: true });
        return [];
      }
      setPets([]);
      setLockedPetCount(0);
      setError(err instanceof Error ? err.message : 'Failed to load your pets');
      return [];
    }
  }, [navigate, sub]);

  const loadAllDocs = useCallback(async (petList: Pet[]) => {
    if (petList.length === 0) {
      setAllDocs({});
      setAllMeds({});
      return;
    }
    setAllDocsLoading(true);
    try {
      // Meds ride along so the overview pins/notices can reflect med status too.
      const [docPairs, medPairs] = await Promise.all([
        Promise.all(
          petList.map((p) => listDocs(p.id).then((r) => [p.id, sortDocs(r.docs)] as const)),
        ),
        Promise.all(
          petList.map((p) => listMeds(p.id).then((r) => [p.id, r.meds] as const).catch(() => [p.id, []] as const)),
        ),
      ]);
      setAllDocs(Object.fromEntries(docPairs));
      setAllMeds(Object.fromEntries(medPairs));
      // Refresh the offline door-mode copy in the background.
      void updateDoorCache(petList, Object.fromEntries(docPairs));
    } catch {
      // non-fatal — overview cards show without status
    } finally {
      setAllDocsLoading(false);
    }
  }, []);

  // Refresh just one pet's docs (after upload/delete/rename in detail view).
  const loadPetDocs = useCallback(async (petId: string) => {
    try {
      const res = await listDocs(petId);
      setAllDocs((prev) => ({ ...prev, [petId]: sortDocs(res.docs) }));
    } catch {
      // non-fatal
    }
  }, []);

  useEffect(() => {
    void loadPets();
  }, [loadPets]);

  // A family invite followed through signup/login lands here — bounce back to
  // the join page to finish accepting. One-shot: clear the key first so
  // declining ("Not now") can't loop back.
  useEffect(() => {
    const inviteToken = localStorage.getItem('petshots.pendingInvite');
    if (!inviteToken) return;
    localStorage.removeItem('petshots.pendingInvite');
    navigate(`/join/${inviteToken}`);
  }, [navigate]);

  // Flush marketing opt-in captured at signup (stored before the user was logged in).
  useEffect(() => {
    const pending = localStorage.getItem('petshots.pendingMarketingOptIn');
    if (pending === null || !email) return;
    localStorage.removeItem('petshots.pendingMarketingOptIn');
    const marketingOptIn = pending === 'true';
    void getSettings()
      .catch(() => ({ ...DEFAULT_SETTINGS, email: email ?? '' }))
      .then((s) => saveSettings({ ...s, email: email ?? s.email, marketingOptIn }))
      .catch(() => {}); // non-fatal
  }, [email]);

  // When the pets list changes (initial load, add, delete), reload all docs.
  useEffect(() => {
    if (pets !== null) void loadAllDocs(pets);
  }, [pets, loadAllDocs]);

  useEffect(() => {
    document.title = detailPet ? `${detailPet.name} · Petshots` : 'Petshots';
  }, [detailPet]);

  function handleLogout() {
    logout();
    navigate('/', { replace: true });
  }

  // Header share button: native share sheet where available, clipboard fallback.
  async function handleShareApp() {
    hapticTap();
    const data = {
      title: 'Petshots',
      text: 'Pet vaccine records, ready at the door.',
      url: 'https://petshots.app',
    };
    if (navigator.share) {
      try {
        await navigator.share(data);
      } catch {
        // user cancelled the sheet — nothing to do
      }
    } else {
      try {
        await navigator.clipboard.writeText(data.url);
        showNotice('Link copied');
      } catch {
        showNotice('Share petshots.app with a friend');
      }
    }
  }

  function backToOverview() {
    setDashView({ type: 'overview' });
    setEditView({ type: 'list' });
  }

  // Always mounted (not conditionally called) so the hook order never
  // changes — dashView.type is checked INSIDE the callback instead. That's
  // the single active listener for this gesture: it no-ops on every screen
  // except overview/albums/achievements, so it never conflicts with Daily's
  // own swipe listener or the Trends tabs' useSwipeStep calls (each of those
  // is its own mounted-only-when-active component, this is the app-shell-
  // level one). 'back' = swipe right, 'forward' = swipe left (useSwipeStep's
  // own convention). Right -> albums; left -> achievements (the gesture
  // freed up when swipe-to-camera was dropped, 2026-07-13). Each screen's
  // OPPOSITE swipe direction goes back to overview.
  useSwipeStep((dir) => {
    if (dashView.type === 'overview') {
      if (dir === 'back') setDashView({ type: 'albums' });
      else setDashView({ type: 'achievements' });
    } else if (dashView.type === 'albums' && dir === 'forward') {
      backToOverview();
    } else if (dashView.type === 'achievements' && dir === 'back') {
      backToOverview();
    } else if (dashView.type === 'badges' && dir === 'back') {
      setDashView({ type: 'achievements' });
    } else if (dashView.type === 'walk-history' && dir === 'back') {
      setDashView({ type: 'achievements' });
    }
  });

  // Deliberate destruction only: the caller (Edit Profile's danger zone) has
  // already made the user TYPE the pet's name, so this deletes immediately —
  // the old optimistic-remove + 10s undo toast was too easy to trip and too
  // easy to miss.
  async function handleDeletePet(petId: string) {
    const pet = pets?.find((p) => p.id === petId);
    if (!pet) return;
    hapticWarning();
    try {
      await deletePet(petId);
      await loadPets(); // may promote a safely stored over-limit pet
      setAllDocs((prev) => { const n = { ...prev }; delete n[petId]; return n; });
      setAllMeds((prev) => { const n = { ...prev }; delete n[petId]; return n; });
      backToOverview();
      showNotice(`${pet.name} deleted`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the pet');
    }
  }

  return (
    <>
      <main className="page page--tabbed">
        <header className="dashboard-header">
          {/* The wordmark is desktop-only in the dashboard (mobile screens
              carry their own large titles — the header stays lean, Bevel-style);
              screens pushed within the pets stack show a back button on desktop. */}
          {dashView.type === 'overview' ||
          dashView.type === 'daily' ||
          dashView.type === 'summary' ||
          dashView.type === 'settings' ||
          dashView.type === 'change-password' ? (
            <Link className="wordmark dashboard-header__wordmark-desktop" to="/">🐾 Petshots</Link>
          ) : (
            <>
              <Link className="wordmark dashboard-header__wordmark-desktop" to="/">🐾 Petshots</Link>
              <button className="btn btn--link dashboard-header__back" onClick={backToOverview}>
                ‹ Pets
              </button>
            </>
          )}
          {/* Date picker rides the header while a pet's Daily tab is up. */}
          {dashView.type === 'detail' && editView.type === 'list' && petTab === 'daily' && (
            <DateNav
              date={dailyDate}
              historyDays={limits.dailyHistoryDays ?? DAILY_HISTORY_FALLBACK_DAYS}
              onChange={setDailyDate}
            />
          )}
          <div className="dashboard-header__right">
            <button
              className="btn btn--icon theme-btn"
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
              onClick={() => {
                hapticTap();
                const next: Theme = theme === 'dark' ? 'light' : 'dark';
                applyTheme(next);
                setTheme(next);
              }}
            >
              {theme === 'dark' ? '☀️' : '🌙'}
            </button>
            <div className="hdr-pill">
              <button
                type="button"
                className="share-btn"
                aria-label="Share Petshots"
                onClick={() => void handleShareApp()}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 3v12" />
                  <path d="M8 6.5 12 3l4 3.5" />
                  <path d="M6 10H5.5A1.5 1.5 0 0 0 4 11.5v8A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 18.5 10H18" />
                </svg>
              </button>
              <AccountMenu
                email={email ?? ''}
                onOpenSection={openSettings}
                onOpenPassports={() => setDashView({ type: 'passports' })}
                onLogout={handleLogout}
              />
            </div>
          </div>
        </header>

        {/* Rendered here (right after the header, inside <main>) rather than
            as a sibling after </main> so desktop's normal document flow puts
            it between the header and the page content — mobile/native are
            unaffected since their .tabbar is position:fixed (DOM position
            doesn't matter once an element is taken out of flow). */}
        {pets !== null && <TabBar active={activeTab} onSelect={handleTabSelect} />}

        {/* Hidden — swipe-right (or the camera icon button) triggers .click()
            on this. capture="environment" opens the native camera directly
            (mobile web and the Capacitor iOS shell both honor it) instead of
            a gallery/file picker. */}
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={handleCameraChange}
          style={{ display: 'none' }}
        />

        {/* Hidden — the 📎 "Attach a photo" icon button triggers this one.
            NO capture attribute, so the OS shows its normal photo chooser
            (library/browse) instead of forcing the camera. */}
        <input
          ref={libraryInputRef}
          type="file"
          accept="image/*"
          onChange={handleLibraryChange}
          style={{ display: 'none' }}
        />

        {notice && <p className="notice" role="status">{notice}</p>}
        {error && (
          <p className="error" role="alert" onClick={() => setError(null)} title="Dismiss">
            {error}
          </p>
        )}

        {/* Keyed wrapper: remounting on view change re-triggers the CSS
            push/pop animation (see .view-anim in index.css). */}
        <div className="view-anim" data-nav={animRef.current.dir} key={viewKey}>
        {pets === null ? (
          <DashboardSkeleton />
        ) : dashView.type === 'add-pet' ? (
          <div className="screen-view screen-view--sheet">
            <nav className="screen-nav">
              <button
                className="screen-nav__back btn btn--link"
                type="button"
                onClick={backToOverview}
              >
                ‹ Pets
              </button>
              <span className="screen-nav__title">New Pet</span>
            </nav>
            <div className="screen-view__body">
              <PetForm
                submitLabel="Add pet"
                onDone={async (pet) => {
                  await loadPets();
                  setDashView(pet ? { type: 'detail', petId: pet.id } : { type: 'overview' });
                }}
                onCancel={backToOverview}
                onError={setError}
                onNotice={showNotice}
              />
            </div>
          </div>
        ) : dashView.type === 'settings' ? (
          <SettingsScreen
            section={dashView.section}
            email={email ?? ''}
            sub={sub ?? ''}
            limits={limits}
            theme={theme}
            onThemeChange={(t) => { applyTheme(t); setTheme(t); }}
            onDone={() => setDashView(settingsReturnRef.current)}
            onChangePassword={() => setDashView({ type: 'change-password' })}
            onLogout={handleLogout}
            onError={setError}
            onNotice={showNotice}
            onLimitsChange={(next) => {
              setLimits(next);
              void loadPets();
            }}
            onUpgrade={() => setDashView({ type: 'settings', section: 'account' })}
            onAccountDeleted={() => { logout(); navigate('/'); }}
          />
        ) : dashView.type === 'change-password' ? (
          <ChangePasswordScreen
            onDone={() => { setDashView({ type: 'settings', section: 'account' }); showNotice('Password changed'); }}
            onCancel={() => setDashView({ type: 'settings', section: 'account' })}
            onError={setError}
          />
        ) : dashView.type === 'daily' ? (
          <DailyAllScreen
            pets={pets.filter((p) => !p.memorial)}
            onError={setError}
            onNotice={showNotice}
            onOpenPet={(petId) => setDashView({ type: 'detail', petId, tab: 'daily' })}
            onMedsChanged={(petId, meds) =>
              setAllMeds((prev) => ({ ...prev, [petId]: meds }))
            }
            onAddPet={() => setDashView({ type: 'add-pet' })}
          />
        ) : dashView.type === 'summary' ? (
          <SummaryScreen
            pets={pets}
            onAddPet={() => setDashView({ type: 'add-pet' })}
            onOpenEntry={(kind, entryKey) => setDashView({ type: 'summary-entry', kind, entryKey })}
          />
        ) : dashView.type === 'summary-entry' ? (
          <SummaryArchiveEntryScreen
            kind={dashView.kind}
            entryKey={dashView.entryKey}
            onBack={() => setDashView({ type: 'summary' })}
          />
        ) : dashView.type === 'passports' ? (
          <PassportsAllScreen
            pets={pets}
            onPassportChanged={() => void loadPets()}
            onNotice={showNotice}
            onError={setError}
            onAddPet={() => setDashView({ type: 'add-pet' })}
          />
        ) : dashView.type === 'albums' ? (
          <AlbumsAllScreen
            pets={pets}
            onError={setError}
            onNotice={showNotice}
            onAddPet={() => setDashView({ type: 'add-pet' })}
            onOpenPet={(petId) => setDashView({ type: 'album', petId })}
          />
        ) : dashView.type === 'album' && albumPet ? (
          <PetAlbumScreen
            pet={albumPet}
            onError={setError}
            onNotice={showNotice}
          />
        ) : dashView.type === 'achievements' ? (
          <AchievementsAllScreen
            accessiblePetIds={pets.map((pet) => pet.id)}
            onError={setError}
            onLoaded={setAchievementsCache}
            onOpenBadges={(petId, cardId) => setDashView({ type: 'badges', petId, cardId })}
          />
        ) : dashView.type === 'badges' ? (
          <BadgeScreen
            petId={dashView.petId}
            cardId={dashView.cardId}
            preloaded={achievementsCache}
            onBack={() => setDashView({ type: 'achievements' })}
            onError={setError}
          />
        ) : dashView.type === 'walk-history' ? (
          <WalkHistoryScreen
            pets={pets ?? []}
            onBack={() => setDashView({ type: 'achievements' })}
            onError={setError}
            onNotice={showNotice}
          />
        ) : dashView.type === 'profile' && detailPet ? (
          editView.type === 'edit-profile' ? (
            <ProfileEditScreen
              pet={detailPet}
              onDone={async () => { setEditView({ type: 'list' }); await loadPets(); }}
              onCancel={() => setEditView({ type: 'list' })}
              onDeletePet={(petId) => { setEditView({ type: 'list' }); void handleDeletePet(petId); }}
              onError={setError}
              onNotice={showNotice}
            />
          ) : (
            <PetProfileScreen
              pet={detailPet}
              onBack={() => setDashView({ type: 'detail', petId: detailPet.id, tab: petTab })}
              onEditProfile={() => setEditView({ type: 'edit-profile' })}
              onPetChanged={() => void loadPets()}
              onError={setError}
            />
          )
        ) : dashView.type === 'detail' && detailPet ? (
          editView.type === 'edit' ? (
            <EditDocScreen
              petId={editView.petId}
              doc={editView.doc}
              onDone={async () => {
                setEditView({ type: 'list' });
                await loadPetDocs(editView.petId);
              }}
              onCancel={() => setEditView({ type: 'list' })}
              onError={setError}
              onNotice={showNotice}
            />
          ) : editView.type === 'doc' ? (
            <DocDetailScreen
              doc={editView.doc}
              species={detailPet?.species}
              onBack={() => setEditView({ type: 'list' })}
              onEdit={() => setEditView({ type: 'edit', doc: editView.doc, petId: editView.petId })}
            />
          ) : editView.type === 'review-extraction' ? (
            <ReviewExtractionScreen
              pet={detailPet}
              docs={detailDocs}
              maxDocs={limits.maxDocs}
              uploadId={editView.uploadId}
              fileName={editView.fileName}
              extraction={editView.extraction}
              aiNote={editView.aiNote}
              duplicateOf={editView.duplicateOf}
              onDone={async (message, profileApplied) => {
                setEditView({ type: 'list' });
                await loadPetDocs(detailPet.id);
                if (profileApplied) await loadPets();
                showNotice(message);
              }}
              onCancel={() => setEditView({ type: 'list' })}
              onError={setError}
              onUpgrade={
                limits.plan === 'paid'
                  ? undefined
                  : () => setDashView({ type: 'settings', section: 'account' })
              }
            />
          ) : (
            <PetDetailScreen
              pet={detailPet}
              initialTab={dashView.tab}
              onTabChange={handlePetTabChange}
              dailyDate={dailyDate}
              onDailyDateChange={setDailyDate}
              docs={detailDocs}
              meds={allMeds[detailPet.id]}
              onMedsChanged={(meds) =>
                setAllMeds((prev) => ({ ...prev, [detailPet.id]: meds }))
              }
              limits={limits}
              onOpenProfile={() => setDashView({ type: 'profile', petId: detailPet.id })}
              onViewDoc={(doc) => setEditView({ type: 'doc', doc, petId: detailPet.id })}
              onEditDoc={(doc) => setEditView({ type: 'edit', doc, petId: detailPet.id })}
              onReviewExtraction={(uploadId, fileName, extraction, aiNote, duplicateOf) =>
                setEditView({
                  type: 'review-extraction',
                  petId: detailPet.id,
                  uploadId,
                  fileName,
                  extraction,
                  aiNote,
                  duplicateOf,
                })
              }
              onDocsChanged={() => loadPetDocs(detailPet.id)}
              onUpgrade={() => setDashView({ type: 'settings', section: 'account' })}
              onError={setError}
              onNotice={showNotice}
            />
          )
        ) : pets.length === 0 ? (
          <div className="empty-overview">
            <span className="empty-state__icon" aria-hidden="true">🐾</span>
            <p>Who are we keeping records for? Add your first pet to get started.</p>
            <button
              className="btn btn--primary"
              onClick={() => setDashView({ type: 'add-pet' })}
            >
              Add your first pet
            </button>
          </div>
        ) : (
          <>
            <NoticeStrip
              pets={pets}
              allDocs={allDocs}
              allMeds={allMeds}
              onNavigateToPet={(petId, tab) =>
                // Birthday/dob notices point at the pet's identity — its own
                // pushed screen now, not a detail segment.
                setDashView(
                  tab === 'profile'
                    ? { type: 'profile', petId }
                    : { type: 'detail', petId, tab },
                )
              }
            />
            <div className="pets-header-row">
              <h1 className="large-title">Pets</h1>
              {/* Swipe is touch-only (no desktop affordance) — these mirror
                  it for mouse/desktop. */}
              <div className="pets-header-row__actions">
                <button
                  type="button"
                  className="pets-header-row__icon-btn"
                  onClick={openCamera}
                  aria-label="Take a photo"
                  title="Take a photo"
                >
                  📷
                </button>
                <button
                  type="button"
                  className="pets-header-row__icon-btn"
                  onClick={openLibrary}
                  aria-label="Attach a photo"
                  title="Attach a photo"
                >
                  📎
                </button>
                <button
                  type="button"
                  className="pets-header-row__icon-btn"
                  onClick={() => setDashView({ type: 'albums' })}
                  aria-label="View albums"
                  title="View albums"
                >
                  🖼️
                </button>
                {/* Walk moved to the bottom tab bar (2026-07-13). */}
                <button
                  type="button"
                  className="pets-header-row__icon-btn"
                  onClick={() => setDashView({ type: 'achievements' })}
                  aria-label="View achievements"
                  title="View achievements"
                >
                  🏆
                </button>
              </div>
            </div>
            {showPhotoHint && (
              <p className="daily-swipe-hint" role="status">
                <span>Swipe right for albums, swipe left for achievements.</span>
                <button
                  type="button"
                  className="daily-swipe-hint__close"
                  aria-label="Dismiss tip"
                  onClick={dismissPhotoHint}
                >
                  ✕
                </button>
              </p>
            )}
            {showPresentHint &&
              pets.some((p) => (allDocs[p.id]?.length ?? 0) > 0) && (
                <p className="daily-swipe-hint" role="status">
                  <span>
                    Tip: press and hold a pet's photo to show their records at
                    the door.
                  </span>
                  <button
                    type="button"
                    className="daily-swipe-hint__close"
                    aria-label="Dismiss tip"
                    onClick={dismissPresentHint}
                  >
                    ✕
                  </button>
                </p>
              )}
            <div className="pet-pins">
              {pets.map((pet) => (
                <PetPin
                  key={pet.id}
                  pet={pet}
                  docs={allDocs[pet.id]}
                  meds={allMeds[pet.id]}
                  docsLoading={allDocsLoading}
                  onSelect={() => setDashView({ type: 'detail', petId: pet.id })}
                  onPresent={
                    (allDocs[pet.id]?.length ?? 0) > 0
                      ? () => {
                          dismissPresentHint(); // they found the gesture
                          setPresentingPetId(pet.id);
                        }
                      : null
                  }
                />
              ))}
              {pets.length < limits.maxPets && (
                <button
                  className="pet-pin pet-pin--add"
                  onClick={() => setDashView({ type: 'add-pet' })}
                >
                  <span className="pet-pin__add-circle" aria-hidden="true">+</span>
                  <span className="pet-pin__name">Add pet</span>
                </button>
              )}
            </div>
            {lockedPetCount > 0 ? (
              <p className="pet-pins__limit">
                {lockedPetCount === 1 ? 'One additional pet is' : `${lockedPetCount} additional pets are`}{' '}
                safely stored and locked on the free plan.{' '}
                <button
                  className="btn btn--link"
                  onClick={() => setDashView({ type: 'settings', section: 'account' })}
                >
                  Upgrade to unlock →
                </button>
              </p>
            ) : pets.length === limits.maxPets ? (
              <p className="pet-pins__limit">
                You're at the {limits.maxPets}-pet limit.{' '}
                {limits.plan === 'free' ? (
                  <button
                    className="btn btn--link"
                    onClick={() => setDashView({ type: 'settings', section: 'account' })}
                  >
                    Upgrade for more →
                  </button>
                ) : (
                  'Remove a pet to add another.'
                )}
              </p>
            ) : null}
            <OnboardingChecklist
              pets={pets}
              allDocs={allDocs}
              onAddPet={() => setDashView({ type: 'add-pet' })}
              onScanRecord={() =>
                setDashView({ type: 'detail', petId: pets[0].id })
              }
              onReminders={() => setDashView({ type: 'settings', section: 'notifications' })}
            />
          </>
        )}
        </div>
      </main>
      <SiteFooter />
      {presentingPet && presentingDocs.length > 0 && (
        <PresentScreen
          pet={presentingPet}
          docs={presentingDocs}
          onExit={() => setPresentingPetId(null)}
        />
      )}
      {capturedPhoto && pets && pets.length > 0 && (
        <PhotoConfirmScreen
          file={capturedPhoto}
          pets={pets}
          saving={savingPhoto}
          limitError={photoLimitError}
          onSave={handleSavePhoto}
          onUpgrade={() => { setCapturedPhoto(null); setDashView({ type: 'settings', section: 'account' }); }}
          onDiscard={() => { setCapturedPhoto(null); setPhotoLimitError(null); }}
        />
      )}
      {walkScreenOpen && (
        <WalkScreen
          pets={livingPets}
          walk={walk}
          onClose={() => setWalkScreenOpen(false)}
          onOpenHistory={() => { setWalkScreenOpen(false); setDashView({ type: 'walk-history' }); }}
        />
      )}
      {!walkScreenOpen && walk.phase !== 'idle' && (
        <WalkMiniBar walk={walk} onExpand={() => setWalkScreenOpen(true)} />
      )}
      {showTour && <OnboardingTour onDone={() => setShowTour(false)} />}
    </>
  );
}

// The bottom bar's Summary tab: today's AI-written story of the household's
// last 7 days, with the week's photos and light per-pet numbers. The server
// generates the story at most once per day per pool and caches it — the
// first visit of the day is the slow one (several seconds of model time),
// so the loading state says what's happening rather than showing a bare
// spinner. Deliberately no charts, no gauges, no red/amber status labels:
// this screen replaced Trends precisely because "Off track" read as a
// scolding. Numbers appear as plain facts; the story carries the meaning.
function SummaryScreen({
  pets,
  onAddPet,
  onOpenEntry,
}: {
  pets: Pet[];
  onAddPet: () => void;
  onOpenEntry: (kind: 'weeks' | 'months', entryKey: string) => void;
}) {
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [failed, setFailed] = useState(false);
  // The persistent archive (weekly stories every Monday, month rollups on
  // the 1st — server crons). Loads alongside today's story; an empty
  // archive just hides the section (weeks accrue from 2026-07-13 on).
  const [archive, setArchive] = useState<{ weeks: SummaryArchiveItem[]; months: SummaryArchiveItem[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSummary()
      .then((res) => { if (!cancelled) setData(res); })
      .catch(() => { if (!cancelled) setFailed(true); });
    getSummaryArchive()
      .then((res) => { if (!cancelled) setArchive(res); })
      .catch(() => {}); // archive is best-effort; today's story is the screen
    return () => { cancelled = true; };
  }, []);

  if (pets.length === 0) {
    return (
      <div className="page summary-all">
        <h1 className="large-title">Summary</h1>
        <div className="card summary-all__empty">
          <p>Add your first pet and the story of your week starts here.</p>
          <button className="btn btn--primary" onClick={onAddPet}>Add a pet</button>
        </div>
      </div>
    );
  }

  const moodEmoji = (avg: number | null) =>
    avg === null ? null : avg >= 4.5 ? '😄' : avg >= 3.5 ? '🙂' : avg >= 2.5 ? '😐' : avg >= 1.5 ? '🙁' : '😢';
  const deadlineCopy = (deadline: NonNullable<SummaryResponse['deadlines']>[number]) =>
    deadline.status === 'overdue'
      ? `${deadline.kind === 'doc' ? 'Expired' : 'Due'} ${Math.abs(deadline.days)}d ago`
      : deadline.status === 'today'
        ? 'Due today'
        : deadline.days === 1
          ? 'Due tomorrow'
          : `Due in ${deadline.days}d`;
  const accessiblePetIds = new Set(pets.map((pet) => pet.id));
  const visiblePhotos = data?.photos.filter((photo) => accessiblePetIds.has(photo.petId)) ?? [];
  const visibleChips = data?.pets.filter((pet) => accessiblePetIds.has(pet.petId)) ?? [];
  const visibleInsights = data?.insights?.filter((item) => accessiblePetIds.has(item.petId)) ?? [];
  const visibleDeadlines = data?.deadlines?.filter((item) => accessiblePetIds.has(item.petId)) ?? [];

  return (
    <div className="page summary-all">
      <header className="summary-all__heading">
        <h1 className="large-title">Summary</h1>
        {data && (
          <p className="subtle summary-all__period">
            Week of {formatDate(data.rangeStart)} – {formatDate(data.rangeEnd)}
          </p>
        )}
      </header>
      {failed ? (
        <div className="card summary-all__empty">
          <p>Couldn't load today's summary — check your connection and try again.</p>
        </div>
      ) : data === null ? (
        <div className="card summary-all__writing" role="status">
          <span className="summary-all__writing-icon" aria-hidden="true">✍️</span>
          <p>Writing today's story…</p>
          <p className="subtle">The first look of the day takes a few seconds.</p>
        </div>
      ) : (
        <>
          {visiblePhotos.length > 0 && (
            <div className="summary-all__photos">
              {visiblePhotos.map((p) => (
                <img key={p.id} src={p.url} alt="" loading="lazy" />
              ))}
            </div>
          )}
          {data.story ? (
            <div className="card summary-all__story">
              {data.story.split(/\n\n+/).map((para, i) => (
                <p key={i}>{para}</p>
              ))}
            </div>
          ) : (
            <div className="card summary-all__empty">
              <p>
                {data.reason === 'AI_FAILED'
                  ? "Couldn't write today's story — try again in a little while."
                  : 'Not much logged yet this week — check off a few Daily items or snap a photo, and the story starts here.'}
              </p>
            </div>
          )}
          {visibleDeadlines.length > 0 && (
            <section className="card summary-all__section">
              <div className="summary-all__section-head">
                <h2>Upcoming deadlines</h2>
                <p className="subtle">The next things that need attention.</p>
              </div>
              <div className="summary-all__list">
                {visibleDeadlines.map((item) => (
                  <div key={`${item.kind}-${item.petId}-${item.label}-${item.date}`} className="summary-all__list-row">
                    <div>
                      <strong>{item.petName}</strong> · {item.label}
                    </div>
                    <span className="subtle">
                      {deadlineCopy(item)} · {formatDate(item.date)}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}
          {visibleInsights.length > 0 && (
            <section className="card summary-all__section">
              <div className="summary-all__section-head">
                <h2>Unusual changes</h2>
                <p className="subtle">Signals worth a quick look.</p>
              </div>
              <div className="summary-all__list">
                {visibleInsights.map((item) => (
                  <div key={`${item.petId}-${item.text}`} className="summary-all__list-row">
                    <strong>{item.petName}</strong>
                    <span className="subtle">{item.text}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
          <div className="summary-all__chips">
            {visibleChips.map((p) => (
              <div key={p.petId} className="summary-all__chip card">
                <span className="summary-all__chip-name">{p.name}</span>
                <span className="subtle">
                  {[
                    p.walks && p.walks.count > 0
                      ? `${p.walks.count} walk${p.walks.count === 1 ? '' : 's'} · ${p.walks.miles} mi`
                      : null,
                    // Feeding lives here as a quiet stat — deliberately kept
                    // OUT of the story narrative (see GET /summary).
                    p.meals && p.meals.done > 0 ? `🍽 ${p.meals.done} meals logged` : null,
                    p.carePct > 0 ? `${p.carePct}% of care done` : null,
                    moodEmoji(p.moodAvg),
                  ]
                    .filter(Boolean)
                    .join(' · ') || 'A quiet week'}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {archive && (archive.months.length > 0 || archive.weeks.length > 0) && (
        <section className="summary-archive">
          <h2 className="summary-archive__title">Story archive</h2>
          {archive.months.map((m) => (
            <button
              key={`m-${m.key}`}
              type="button"
              className="summary-archive__item card"
              onClick={() => { hapticTap(); onOpenEntry('months', m.key); }}
            >
              <span className="summary-archive__item-label">
                📖 {m.monthLabel ?? m.key}
              </span>
              <span className="subtle summary-archive__item-preview">{m.preview}…</span>
            </button>
          ))}
          {archive.weeks.map((w) => (
            <button
              key={`w-${w.key}`}
              type="button"
              className="summary-archive__item card"
              onClick={() => { hapticTap(); onOpenEntry('weeks', w.key); }}
            >
              <span className="summary-archive__item-label">
                Week of {formatDate(w.rangeStart)}
              </span>
              <span className="subtle summary-archive__item-preview">{w.preview}…</span>
            </button>
          ))}
        </section>
      )}
    </div>
  );
}

// A saved story from the archive — same layout as today's story, with a
// back header (push/pop pattern like albums → album).
function SummaryArchiveEntryScreen({
  kind,
  entryKey,
  onBack,
}: {
  kind: 'weeks' | 'months';
  entryKey: string;
  onBack: () => void;
}) {
  const [entry, setEntry] = useState<SummaryArchiveEntry | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getSummaryEntry(kind, entryKey)
      .then((res) => { if (!cancelled) setEntry(res); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [kind, entryKey]);

  const title = entry
    ? entry.monthLabel ?? `Week of ${formatDate(entry.rangeStart)}`
    : ' ';

  return (
    <div className="page summary-all">
      <header className="summary-entry__header">
        <button className="summary-entry__back btn btn--link" type="button" onClick={onBack}>
          ‹ Summary
        </button>
        <h1 className="summary-entry__title">{title}</h1>
      </header>
      {failed ? (
        <div className="card summary-all__empty">
          <p>Couldn't load this story — try again in a moment.</p>
        </div>
      ) : entry === null ? (
        <p className="subtle">Loading…</p>
      ) : (
        <>
          {entry.photos.length > 0 && (
            <div className="summary-all__photos">
              {entry.photos.map((p) => (
                <img key={p.id} src={p.url} alt="" loading="lazy" />
              ))}
            </div>
          )}
          <div className="card summary-all__story">
            {entry.story.split(/\n\n+/).map((para, i) => (
              <p key={i}>{para}</p>
            ))}
          </div>
          <p className="subtle summary-archive__range">
            {formatDate(entry.rangeStart)} – {formatDate(entry.rangeEnd)}
          </p>
        </>
      )}
    </div>
  );
}

// ---- account menu (header avatar chip) ----

// The bottom bar's Passport tab: every pet's share-ready passport in one
// place — answers "which pet?" by listing them all.
function PassportsAllScreen({
  pets,
  onPassportChanged,
  onNotice,
  onError,
  onAddPet,
}: {
  pets: Pet[];
  onPassportChanged: () => void;
  onNotice: (msg: string) => void;
  onError: (msg: string | null) => void;
  onAddPet: () => void;
}) {
  if (pets.length === 0) {
    return (
      <div className="empty-overview">
        <span className="empty-state__icon" aria-hidden="true">🐾</span>
        <p>Passports start with a pet. Add yours to get going.</p>
        <button className="btn btn--primary" onClick={onAddPet}>
          Add your first pet
        </button>
      </div>
    );
  }
  return (
    <div className="passport-all">
      <h1 className="large-title">Passport</h1>
      {pets.map((pet) => (
        <section key={pet.id} className="passport-all__pet">
          <div className="passport-all__pet-header">
            <PetAvatar pet={pet} size={40} />
            <span>{pet.name}</span>
          </div>
          <PassportTabSection
            pet={pet}
            onPassportChanged={onPassportChanged}
            onNotice={onNotice}
            onError={onError}
          />
        </section>
      ))}
    </div>
  );
}

// The avatar menu is the settings hub: three focused screens instead of one
// long page. Change password lives inside Account, not here.
function AccountMenu({
  email,
  onOpenSection,
  onOpenPassports,
  onLogout,
}: {
  email: string;
  onOpenSection: (section: SettingsSection) => void;
  onOpenPassports: () => void;
  onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent | TouchEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="profile-menu" ref={ref}>
      <button
        className="profile-menu__trigger"
        onClick={() => { hapticTap(); setOpen((v) => !v); }}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Account menu"
      >
        <span className="avatar-chip" aria-hidden="true">{initialsFromEmail(email)}</span>
      </button>
      {open && (
        <div className="profile-menu__dropdown" role="menu">
          <div className="profile-menu__header">{email}</div>
          <div className="profile-menu__divider" />
          {/* Passport lives here, not the header or the tab bar (bounced
              between both — header icon 2026-07-13, wasn't liked either;
              the tab bar slot went to Walk that same day). */}
          <button
            role="menuitem"
            onClick={() => { setOpen(false); onOpenPassports(); }}
          >
            Passport
          </button>
          <div className="profile-menu__divider" />
          <button
            role="menuitem"
            onClick={() => { setOpen(false); onOpenSection('account'); }}
          >
            Account
          </button>
          <button
            role="menuitem"
            onClick={() => { setOpen(false); onOpenSection('notifications'); }}
          >
            Notifications
          </button>
          <button
            role="menuitem"
            onClick={() => { setOpen(false); onOpenSection('family'); }}
          >
            Family
          </button>
          {/* Browser-only: mobile-web users never see the dashboard footer
              (the tab bar replaces it), so this is their quiet path to the
              iPhone app. Points at the App Store once APP_STORE_URL is set. */}
          {!isNative && (
            <a role="menuitem" href={APP_STORE_URL || '/#iphone'}>
              Get the iPhone app
            </a>
          )}
          <div className="profile-menu__divider" />
          <button
            role="menuitem"
            className="profile-menu__danger"
            onClick={() => { setOpen(false); onLogout(); }}
          >
            Log out
          </button>
        </div>
      )}
    </div>
  );
}

// ---- notice strip ----

function NoticeStrip({
  pets,
  allDocs,
  allMeds,
  onNavigateToPet,
}: {
  pets: Pet[];
  allDocs: Record<string, Doc[]>;
  allMeds: Record<string, Med[]>;
  onNavigateToPet: (petId: string, tab: 'records' | 'meds' | 'profile' | 'daily') => void;
}) {
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());

  const visible = computeNotices(pets, allDocs, allMeds)
    .filter((n) => !isDismissed(n) && !dismissedIds.has(n.id))
    .slice(0, MAX_NOTICES);

  if (visible.length === 0) return null;

  function handleDismiss(notice: Notice) {
    dismissNotice(notice);
    setDismissedIds((prev) => new Set([...prev, notice.id]));
  }

  return (
    <div className="notice-strip" role="region" aria-label="Notifications">
      {visible.map((notice) => (
        <NoticeCard
          key={notice.id}
          notice={notice}
          onDismiss={() => handleDismiss(notice)}
          onNavigate={() => onNavigateToPet(notice.petId, noticeTab(notice.type))}
        />
      ))}
    </div>
  );
}

function NoticeCard({
  notice,
  onDismiss,
  onNavigate,
}: {
  notice: Notice;
  onDismiss: () => void;
  onNavigate: () => void;
}) {
  const typeClass = notice.type.startsWith('birthday')
    ? 'birthday'
    : notice.type === 'overdue' || notice.type === 'med-overdue'
      ? 'overdue'
      : notice.type === 'duesoon-critical' || notice.type === 'med-due'
        ? 'critical'
        : notice.type === 'duesoon-warning'
          ? 'warning'
          : notice.type === 'dob-nudge'
            ? 'nudge'
            : 'headsup';

  return (
    <div className={`notice-card notice-card--${typeClass}`}>
      <button
        className="notice-card__body"
        onClick={onNavigate}
        aria-label={`${notice.message} — tap to view`}
      >
        {notice.message}
      </button>
      <button
        className="notice-card__dismiss"
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}

// ---- onboarding checklist ----

// Dismissible "Get set up" card for new accounts. Items tick automatically
// from real state (except Add-to-Home-Screen, which iOS can't report — that
// one checks off when tapped). Hidden forever once dismissed or complete.
const ONBOARDING_DISMISSED_KEY = 'petshots.onboarding.dismissed';
const ONBOARDING_HOMESCREEN_KEY = 'petshots.onboarding.homescreen';

function isStandaloneDisplay(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

function OnboardingChecklist({
  pets,
  allDocs,
  onAddPet,
  onScanRecord,
  onReminders,
}: {
  pets: Pet[];
  allDocs: Record<string, Doc[]>;
  onAddPet: () => void;
  onScanRecord: () => void;
  onReminders: () => void;
}) {
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(ONBOARDING_DISMISSED_KEY) === '1',
  );
  const [homeScreenSeen, setHomeScreenSeen] = useState(
    () => localStorage.getItem(ONBOARDING_HOMESCREEN_KEY) === '1',
  );
  const [showHomeSteps, setShowHomeSteps] = useState(false);
  const [remindersOn, setRemindersOn] = useState<boolean | null>(null);

  useEffect(() => {
    if (dismissed) return;
    let live = true;
    getSettings()
      .then((s) => { if (live) setRemindersOn(s.remindersEnabled === true); })
      .catch(() => { if (live) setRemindersOn(false); });
    return () => { live = false; };
  }, [dismissed]);

  if (dismissed) return null;

  const isMobile = /iphone|ipad|ipod|android/i.test(navigator.userAgent);
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const showHomeItem = isMobile && !isStandaloneDisplay();

  const items: {
    key: string;
    label: string;
    done: boolean;
    onGo: () => void;
  }[] = [
    { key: 'pet', label: 'Add your pet', done: pets.length > 0, onGo: onAddPet },
    {
      key: 'record',
      label: 'Scan your first record',
      done: Object.values(allDocs).some((docs) => docs.length > 0),
      onGo: onScanRecord,
    },
    {
      key: 'reminders',
      label: 'Turn on vaccine reminders',
      done: remindersOn === true,
      onGo: onReminders,
    },
    ...(showHomeItem
      ? [{
          key: 'homescreen',
          label: 'Add Petshots to your home screen',
          done: homeScreenSeen,
          onGo: () => {
            setShowHomeSteps((v) => !v);
            localStorage.setItem(ONBOARDING_HOMESCREEN_KEY, '1');
            setHomeScreenSeen(true);
          },
        }]
      : []),
  ];

  // Everything done (and the settings fetch has resolved) -> nothing to teach.
  if (remindersOn !== null && items.every((i) => i.done)) return null;

  function handleDismiss() {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, '1');
    setDismissed(true);
  }

  return (
    <section className="card onboarding" aria-label="Getting started checklist">
      <div className="onboarding__header">
        <h2 className="card__title">Get set up</h2>
        <button className="notice-card__dismiss" onClick={handleDismiss} aria-label="Dismiss checklist">
          ✕
        </button>
      </div>
      <ul className="onboarding__list">
        {items.map((item) => (
          <li key={item.key}>
            <button
              className={`onboarding__item${item.done ? ' onboarding__item--done' : ''}`}
              onClick={item.onGo}
              disabled={item.done && item.key !== 'homescreen'}
            >
              <span className="onboarding__check" aria-hidden="true">
                {item.done ? '✓' : '○'}
              </span>
              <span>{item.label}</span>
            </button>
            {item.key === 'homescreen' && showHomeSteps && (
              <p className="subtle onboarding__steps">
                {isIos
                  ? 'In Safari: tap the Share button, scroll down, then tap "Add to Home Screen".'
                  : 'In Chrome: tap the ⋮ menu, then "Add to Home screen".'}{' '}
                Petshots opens like an app — records ready at the door.
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---- pet avatar ----

function PetAvatar({ pet, size = 36 }: { pet: Pet; size?: number }) {
  return (
    <span className="avatar" style={{ width: size, height: size }} aria-hidden="true">
      {pet.avatarUrl ? (
        <img src={pet.avatarUrl} alt="" />
      ) : (
        <span className="avatar__emoji">{speciesEmoji(pet.species)}</span>
      )}
    </span>
  );
}

// ---- pet overview pin (big round portrait, like a pinned contact) ----

function PetPin({
  pet,
  docs,
  meds,
  docsLoading,
  onSelect,
  onPresent,
}: {
  pet: Pet;
  docs: Doc[] | undefined;
  meds: Med[] | undefined;
  docsLoading: boolean;
  onSelect: () => void;
  onPresent: (() => void) | null; // long-press → fullscreen records (the door moment)
}) {
  // Memorial pets stay on the overview (their records are still one tap
  // away) but read as a remembrance, not a to-do: dimmed, dove, no
  // vaccine-status ring or nag line.
  const isMemorial = pet.memorial === true;
  const status = isMemorial ? 'none' : docs ? petOverallStatus(docs, meds) : 'none';
  const subLine = isMemorial
    ? '🕊️ In loving memory'
    : docsLoading && !docs
      ? 'Loading…'
      : petPinStatus(docs ?? [], meds);

  // Long-press = Present. Tap still opens the pet; moving the finger
  // (scrolling) cancels; the click after a fired press is swallowed.
  const pressTimer = useRef<number | undefined>(undefined);
  const pressStart = useRef<{ x: number; y: number } | null>(null);
  const pressFired = useRef(false);
  function cancelPress() {
    if (pressTimer.current !== undefined) {
      clearTimeout(pressTimer.current);
      pressTimer.current = undefined;
    }
    pressStart.current = null;
  }

  return (
    <button
      className={`pet-pin${isMemorial ? ' pet-pin--memorial' : ''}`}
      onPointerDown={(e) => {
        if (!onPresent) return;
        pressFired.current = false;
        pressStart.current = { x: e.clientX, y: e.clientY };
        pressTimer.current = window.setTimeout(() => {
          pressFired.current = true;
          hapticSuccess();
          onPresent();
        }, 550);
      }}
      onPointerMove={(e) => {
        const s = pressStart.current;
        if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 12) cancelPress();
      }}
      onPointerUp={cancelPress}
      onPointerLeave={cancelPress}
      onPointerCancel={cancelPress}
      onContextMenu={(e) => {
        // long-press shouldn't ALSO pop the browser context menu
        if (onPresent) e.preventDefault();
      }}
      onClick={() => {
        if (pressFired.current) {
          pressFired.current = false;
          return;
        }
        onSelect();
      }}
      aria-label={`View ${pet.name}'s records — ${subLine}${onPresent ? '. Hold to present at the door' : ''}`}
    >
      <span className={`pet-pin__ring pet-pin__ring--${status}`}>
        <PetAvatar pet={pet} size={88} />
      </span>
      <span className="pet-pin__name">{pet.name}</span>
      <span className={`pet-pin__status pet-pin__status--${status}`}>{subLine}</span>
    </button>
  );
}

// ---- pet create/edit form (shared) ----

// Create-only (the New Pet sheet). Editing an existing pet — name, photo,
// health profile, delete — all lives in ProfileEditScreen.
function PetForm({
  submitLabel,
  onDone,
  onCancel,
  onError,
  onNotice,
}: {
  submitLabel: string;
  onDone: (pet?: Pet) => Promise<void>;
  onCancel?: () => void;
  onError: (msg: string | null) => void;
  onNotice: (msg: string) => void;
}) {
  const [name, setName] = useState('');
  const [species, setSpecies] = useState('dog');
  const [busy, setBusy] = useState(false);
  const photoRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const photo = photoRef.current?.files?.[0];
    if (photo) {
      if (!AVATAR_TYPES.includes(photo.type)) {
        onError('Pet photo must be a JPG, PNG, or WebP image.');
        return;
      }
    }
    setBusy(true);
    onError(null);
    try {
      const saved = await createPet(name.trim(), species);
      if (photo) await uploadAvatar(saved.pet.id, photo);
      onNotice(`${saved.pet.name} added`);
      await onDone(saved.pet);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not save pet');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={handleSubmit}>
      <label>
        Pet name
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <label>
        Species
        <select value={species} onChange={(e) => setSpecies(e.target.value)}>
          <option value="dog">Dog</option>
          <option value="cat">Cat</option>
          <option value="other">Other</option>
        </select>
      </label>
      <label>
        Photo (optional · JPG, PNG · large photos are compressed automatically)
        <input ref={photoRef} type="file" accept="image/jpeg,image/png,image/webp" />
      </label>
      <div className="actions">
        <button className="btn btn--primary" type="submit" disabled={busy || !name.trim()}>
          {busy ? 'Saving…' : submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

// ---- vaccine status ----

// Headline health check across all documents: the most severe status wins.
function StatusSummary({ docs }: { docs: Doc[] }) {
  const dated = trackedDocs(docs).filter((d) => d.expiry);
  if (dated.length === 0) {
    return (
      <section className="summary summary--none">
        Add expiration dates to your documents to track vaccine status.
      </section>
    );
  }
  const overdue = dated.filter((d) => statusOf(d.expiry) === 'overdue');
  const dueSoon = dated.filter((d) => statusOf(d.expiry) === 'due-soon');

  if (overdue.length > 0) {
    return (
      <section className="summary summary--overdue">
        ⚠ {overdue.length} vaccine{overdue.length > 1 ? 's are' : ' is'} overdue —{' '}
        {overdue.map((d) => d.label).join(', ')}.
      </section>
    );
  }
  if (dueSoon.length > 0) {
    return (
      <section className="summary summary--due-soon">
        ⏰ {dueSoon.length} vaccine{dueSoon.length > 1 ? 's are' : ' is'} due soon —{' '}
        {dueSoon.map((d) => d.label).join(', ')}.
      </section>
    );
  }
  return <section className="summary summary--current">✓ All vaccines are up to date.</section>;
}

function StatusBadge({ expiry }: { expiry?: string }) {
  const status = statusOf(expiry);
  const text =
    status === 'overdue'
      ? `Overdue ${Math.abs(daysUntil(expiry!))}d`
      : status === 'due-soon'
        ? `Due in ${daysUntil(expiry!)}d`
        : status === 'current'
          ? 'Current'
          : 'No date';
  return <span className={`status status--${status}`}>{text}</span>;
}

function DashboardSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <section className="card">
        <span className="skeleton skeleton--title" />
        <span className="skeleton skeleton--line" />
      </section>
      <section className="card">
        <span className="skeleton skeleton--line" />
        <span className="skeleton skeleton--line" />
        <span className="skeleton skeleton--line" />
      </section>
    </div>
  );
}

// ---- pet detail screen ----

function PetDetailScreen({
  pet,
  initialTab,
  onTabChange,
  dailyDate,
  onDailyDateChange,
  docs,
  meds,
  onMedsChanged,
  limits,
  onOpenProfile,
  onViewDoc,
  onEditDoc,
  onReviewExtraction,
  onDocsChanged,
  onUpgrade,
  onError,
  onNotice,
}: {
  pet: Pet;
  initialTab?: PetTab;
  onTabChange: (tab: PetTab) => void; // header shows the date picker on 'daily'
  dailyDate: string;
  onDailyDateChange: (date: string) => void;
  docs: Doc[];
  meds: Med[] | undefined;
  onMedsChanged: (meds: Med[]) => void;
  limits: Limits;
  onOpenProfile: () => void; // hero name tap — the pet's identity screen
  onViewDoc: (doc: Doc) => void;
  onEditDoc: (doc: Doc) => void;
  onReviewExtraction: (
    uploadId: string | null,
    fileName: string,
    extraction: Extraction | null,
    aiNote?: string,
    duplicateOf?: DuplicateInfo,
  ) => void;
  onDocsChanged: () => Promise<void>;
  onUpgrade: () => void;
  onError: (msg: string | null) => void;
  onNotice: (msg: string) => void;
}) {
  // Daily is the landing tab — opening a pet means today's care first;
  // records are one segment away.
  const [tab, setTab] = useState<PetTab>(initialTab ?? 'daily');
  // Report the active segment up (incl. on mount) — the dashboard header
  // shows the date picker only while Daily is up. onTabChange is a stable
  // useCallback, so this fires exactly on tab changes.
  useEffect(() => {
    onTabChange(tab);
  }, [tab, onTabChange]);
  const [showPhoto, setShowPhoto] = useState(false);
  // Count on the Meds tab: meds needing action right now (due/overdue).
  const medsDue = trackedMeds(meds).filter(
    (m) => medStatus(m).status !== 'current',
  ).length;

  return (
    <div className="screen-view">
      {/* No nav row here on purpose — editing lives inside the Profile tab. */}

      <div className="screen-view__body">
        <div className="pet-detail__hero">
          {pet.avatarUrl ? (
            <button
              className="pet-detail__hero-photo"
              type="button"
              onClick={() => setShowPhoto(true)}
              aria-label={`View ${pet.name}'s photo full screen`}
            >
              <PetAvatar pet={pet} size={72} />
            </button>
          ) : (
            <PetAvatar pet={pet} size={72} />
          )}
          {/* The name IS the door to the pet's identity screen — a trailing
              chevron signals it's tappable (iOS contact-card convention). */}
          <button
            type="button"
            className="pet-detail__hero-open"
            onClick={() => { hapticTap(); onOpenProfile(); }}
            aria-label={`View ${pet.name}'s profile`}
          >
            <span className="pet-detail__hero-name">
              {pet.name} <span className="pet-detail__hero-chevron" aria-hidden="true">›</span>
            </span>
            <span className="subtle">
              {speciesEmoji(pet.species)}{' '}
              {pet.species.charAt(0).toUpperCase() + pet.species.slice(1)}
              {pet.breed ? ` · ${pet.breed}` : ''}
            </span>
          </button>
        </div>

        <div className="tab-bar">
          <button
            className={`tab-bar__tab${tab === 'daily' ? ' tab-bar__tab--active' : ''}`}
            onClick={() => { hapticTap(); setTab('daily'); }}
          >
            Daily
          </button>
          <button
            className={`tab-bar__tab${tab === 'records' ? ' tab-bar__tab--active' : ''}`}
            onClick={() => { hapticTap(); setTab('records'); }}
          >
            Records
          </button>
          <button
            className={`tab-bar__tab${tab === 'meds' ? ' tab-bar__tab--active' : ''}`}
            onClick={() => { hapticTap(); setTab('meds'); }}
          >
            Meds
            {medsDue > 0 && <span className="tab-badge">{medsDue}</span>}
          </button>
        </div>

        {tab === 'records' ? (
          <>
            {trackedDocs(docs).length > 0 && <StatusSummary docs={docs} />}
            <DocsSection
              petId={pet.id}
              docs={docs}
              maxDocs={limits.maxDocs}
              readOnly={pet.active === false}
              onUpgrade={onUpgrade}
              onChanged={onDocsChanged}
              onError={onError}
              onNotice={onNotice}
              onViewDoc={onViewDoc}
              onEditDoc={onEditDoc}
              onReviewExtraction={onReviewExtraction}
            />
          </>
        ) : tab === 'daily' ? (
          <PetDailyHistory
            petId={pet.id}
            date={dailyDate}
            onDateChange={onDailyDateChange}
            historyDays={limits.dailyHistoryDays ?? DAILY_HISTORY_FALLBACK_DAYS}
            onError={onError}
            onNotice={onNotice}
            onUpgrade={onUpgrade}
            onMedsChanged={onMedsChanged}
          />
        ) : (
          <MedsSection
            petId={pet.id}
            maxMeds={limits.maxMeds}
            readOnly={pet.active === false}
            onUpgrade={onUpgrade}
            onError={onError}
            onNotice={onNotice}
            onMedsChanged={onMedsChanged}
          />
        )}
      </div>
      {showPhoto && pet.avatarUrl && (
        <PhotoLightbox src={pet.avatarUrl} alt={pet.name} onClose={() => setShowPhoto(false)} />
      )}
    </div>
  );
}

// ---- pet profile screen (the pet's identity, pushed from the detail hero) ----

function PetProfileScreen({
  pet,
  onBack,
  onEditProfile,
  onPetChanged,
  onError,
}: {
  pet: Pet;
  onBack: () => void;
  onEditProfile: () => void; // the ONE edit affordance — name/photo/health/delete all live there
  onPetChanged: () => void; // weight log syncs the profile's display weight
  onError: (msg: string | null) => void;
}) {
  const [showPhoto, setShowPhoto] = useState(false);

  return (
    <div className="screen-view">
      <nav className="screen-nav">
        <button className="screen-nav__back btn btn--link" type="button" onClick={onBack}>
          ‹ {pet.name}
        </button>
        <span className="screen-nav__title">Profile</span>
      </nav>
      <div className="screen-view__body">
        <div className="pet-detail__hero">
          {pet.avatarUrl ? (
            <button
              className="pet-detail__hero-photo"
              type="button"
              onClick={() => setShowPhoto(true)}
              aria-label={`View ${pet.name}'s photo full screen`}
            >
              <PetAvatar pet={pet} size={72} />
            </button>
          ) : (
            <PetAvatar pet={pet} size={72} />
          )}
          <div className="pet-detail__hero-info">
            <span className="pet-detail__hero-name">{pet.name}</span>
            <span className="subtle">
              {speciesEmoji(pet.species)}{' '}
              {pet.species.charAt(0).toUpperCase() + pet.species.slice(1)}
              {pet.breed ? ` · ${pet.breed}` : ''}
            </span>
          </div>
        </div>
        <ProfileSection pet={pet} />
        <WeightSection petId={pet.id} onPetChanged={onPetChanged} onError={onError} />
        <button type="button" className="btn profile-editpet" onClick={onEditProfile}>
          Edit profile
        </button>
      </div>
      {showPhoto && pet.avatarUrl && (
        <PhotoLightbox src={pet.avatarUrl} alt={pet.name} onClose={() => setShowPhoto(false)} />
      )}
    </div>
  );
}

// ---- daily care checklist ----

const MOODS: { value: number; emoji: string; label: string }[] = [
  { value: 1, emoji: '😢', label: 'Rough' },
  { value: 2, emoji: '😕', label: 'Off' },
  { value: 3, emoji: '😐', label: 'Okay' },
  { value: 4, emoji: '🙂', label: 'Good' },
  { value: 5, emoji: '😄', label: 'Great' },
];

// "darya checked this at 8:31 AM" — email local-part + local time.
function whoAndWhen(by: string, at: string): string {
  const name = by.split('@')[0];
  const time = new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${name} · ${time}`;
}

// Date dropdown title for the pet-detail Daily tab ("Today, July 9 ▾"):
// quick list of the retained two weeks, plus a date field for the deeper
// paid-plan history.
function DateNav({
  date,
  historyDays,
  onChange,
}: {
  date: string;
  historyDays: number;
  onChange: (date: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const today = localToday();
  const minDate = addDays(today, -(historyDays - 1));

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent | TouchEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // The quick list covers the two retained weeks; deeper history (paid) is
  // reachable through the date field at the bottom.
  const quickDays = Array.from(
    { length: Math.min(historyDays, 14) },
    (_, i) => addDays(today, -i),
  );

  return (
    <div className="date-nav" ref={ref}>
      {/* Visible day-step buttons — the swipe gesture exists but isn't
          discoverable; these are, and they edit the same date state. */}
      <button
        type="button"
        className="date-nav__step"
        aria-label="Previous day"
        disabled={date <= minDate}
        title={date <= minDate && historyDays <= 14 ? 'Daily history goes back 2 weeks on your plan' : undefined}
        onClick={() => { hapticTap(); onChange(addDays(date, -1)); }}
      >
        ‹
      </button>
      <button
        type="button"
        className="date-nav__btn large-title"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => { hapticTap(); setOpen((v) => !v); }}
      >
        {dailyDateLabel(date)}
        <span className="date-nav__chevron" aria-hidden="true">▾</span>
      </button>
      <button
        type="button"
        className="date-nav__step"
        aria-label="Next day"
        disabled={date >= localToday()}
        onClick={() => { hapticTap(); onChange(addDays(date, 1)); }}
      >
        ›
      </button>
      {open && (
        <div className="date-nav__dropdown" role="menu">
          {quickDays.map((d) => (
            <button
              key={d}
              type="button"
              role="menuitem"
              className={`date-nav__option${d === date ? ' date-nav__option--selected' : ''}`}
              onClick={() => { hapticTap(); setOpen(false); onChange(d); }}
            >
              {dailyDateLabel(d)}
              {d === date && <span aria-hidden="true">✓</span>}
            </button>
          ))}
          {historyDays > 14 && (
            <>
              <div className="profile-menu__divider" />
              <label className="date-nav__picker">
                <span className="subtle">Older…</span>
                <input
                  type="date"
                  value={date}
                  min={minDate}
                  max={today}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v && v >= minDate && v <= today) {
                      setOpen(false);
                      onChange(v);
                    }
                  }}
                />
              </label>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Pet-detail Daily tab: the date dropdown + swipe-back history wrapped
// around the self-contained DailySection. Swipe right = one day back,
// swipe left = forward; past days render read-only; depth is plan-gated
// (free 2 weeks, paid a year — server-enforced too).
function PetDailyHistory({
  petId,
  date,
  onDateChange,
  historyDays,
  onError,
  onNotice,
  onUpgrade,
  onMedsChanged,
}: {
  petId: string;
  date: string; // owned by the dashboard — the header's DateNav edits it too
  onDateChange: (date: string) => void;
  historyDays: number;
  onError: (msg: string | null) => void;
  onNotice: (msg: string) => void;
  onUpgrade: () => void;
  onMedsChanged: (meds: Med[]) => void;
}) {
  // One-time discoverability tip — touch devices only (desktop can't swipe),
  // gone forever once dismissed or once the user actually swipes.
  const [showHint, setShowHint] = useState(
    () =>
      window.matchMedia('(pointer: coarse)').matches &&
      !localStorage.getItem('petshots.dailySwipeHint'),
  );
  // Shown in place of the swipe hint once a free-plan user swipes/steps past
  // the 2-week window — the boundary itself is the natural upgrade moment.
  const [hitHistoryLimit, setHitHistoryLimit] = useState(false);
  const today = localToday();
  const minDate = addDays(today, -(historyDays - 1));

  useEffect(() => setHitHistoryLimit(false), [date]);

  function dismissHint() {
    localStorage.setItem('petshots.dailySwipeHint', '1');
    setShowHint(false);
  }

  function step(delta: -1 | 1) {
    const next = addDays(date, delta);
    if (next > today) return; // already on today — nothing newer to show
    if (next < minDate) {
      if (historyDays > 14) onNotice('That’s the end of the saved history.');
      else setHitHistoryLimit(true);
      return;
    }
    if (showHint) dismissHint(); // they found the gesture — tip served its purpose
    hapticTap();
    onDateChange(next);
  }

  // Whole-screen swipe while this tab is mounted: listeners live on document
  // so the gesture works from the hero, the header, anywhere — not just the
  // list card. Unmounting (switching segment/screen) removes them. No dep
  // array on purpose: re-registering keeps the closures fresh per render.
  useEffect(() => {
    let start: { x: number; y: number } | null = null;
    const onStart = (e: TouchEvent) => {
      // Ignore multi-touch (pinch on the photo lightbox etc.).
      start = e.touches.length === 1
        ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
        : null;
    };
    const onEnd = (e: TouchEvent) => {
      if (!start) return;
      const dx = e.changedTouches[0].clientX - start.x;
      const dy = e.changedTouches[0].clientY - start.y;
      start = null;
      // Horizontal swipe: right = back a day, left = forward.
      if (Math.abs(dx) > 60 && Math.abs(dy) < 50) step(dx > 0 ? -1 : 1);
    };
    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchend', onEnd);
    };
  });

  return (
    <div className="pet-daily">
      {showHint && (
        <p className="daily-swipe-hint" role="status">
          <span>Tip: swipe right anywhere on this screen to see yesterday — swipe left to come back.</span>
          <button
            type="button"
            className="daily-swipe-hint__close"
            aria-label="Dismiss tip"
            onClick={dismissHint}
          >
            ✕
          </button>
        </p>
      )}
      {hitHistoryLimit ? (
        <p className="daily-past-note" role="status">
          Daily history goes back 2 weeks on your plan.{' '}
          <button className="btn btn--link" onClick={onUpgrade}>
            Upgrade for a year of history →
          </button>
        </p>
      ) : (
        date !== today && (
          <p className="daily-past-note" role="status">
            Viewing a past day — swipe left or tap the date to get back to today.
          </p>
        )
      )}
      <DailySection
        petId={petId}
        date={date}
        onError={onError}
        onNotice={onNotice}
        onMedsChanged={onMedsChanged}
      />
    </div>
  );
}

// The bottom tab bar's "Daily" tab: every pet's TODAY checklist + mood in
// one screen — open the app, check off breakfast, done. Reuses DailySection
// per pet (it's self-contained: loads its own data by petId). History
// browsing lives on the pet-detail Daily tab, not here.
function DailyAllScreen({
  pets,
  onError,
  onNotice,
  onOpenPet,
  onMedsChanged,
  onAddPet,
}: {
  pets: Pet[];
  onError: (msg: string | null) => void;
  onNotice: (msg: string) => void;
  onOpenPet: (petId: string) => void;
  onMedsChanged: (petId: string, meds: Med[]) => void;
  onAddPet: () => void;
}) {
  if (pets.length === 0) {
    return (
      <div className="empty-overview">
        <span className="empty-state__icon" aria-hidden="true">🐾</span>
        <p>The daily checklist starts with a pet. Add yours to get going.</p>
        <button className="btn btn--primary" onClick={onAddPet}>
          Add your first pet
        </button>
      </div>
    );
  }
  return (
    <div className="daily-all">
      <h1 className="large-title">Daily</h1>
      {pets.map((pet) => (
        <DailyPetSection
          key={pet.id}
          pet={pet}
          onOpenPet={onOpenPet}
          onError={onError}
          onNotice={onNotice}
          onMedsChanged={(meds) => onMedsChanged(pet.id, meds)}
        />
      ))}
    </div>
  );
}

// One pet's block on the all-pets Daily screen: avatar + name open the pet
// (detail with its tabs); the ▾ disclosure collapses that pet's agenda.
// Collapsed pets are remembered per device.
const DAILY_COLLAPSED_KEY = 'petshots.dailyCollapsed';

function readDailyCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(DAILY_COLLAPSED_KEY);
    const ids = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function DailyPetSection({
  pet,
  onOpenPet,
  onError,
  onNotice,
  onMedsChanged,
}: {
  pet: Pet;
  onOpenPet: (petId: string) => void;
  onError: (msg: string | null) => void;
  onNotice: (msg: string) => void;
  onMedsChanged: (meds: Med[]) => void;
}) {
  const [collapsed, setCollapsed] = useState(() => readDailyCollapsed().has(pet.id));

  function toggle() {
    hapticTap();
    const next = !collapsed;
    setCollapsed(next);
    try {
      const ids = readDailyCollapsed();
      if (next) ids.add(pet.id);
      else ids.delete(pet.id);
      localStorage.setItem(DAILY_COLLAPSED_KEY, JSON.stringify([...ids]));
    } catch {
      // storage unavailable — the toggle still works for this visit
    }
  }

  return (
    <section className="daily-all__pet">
      <div className="daily-all__pet-header">
        <button
          type="button"
          className="daily-all__pet-open"
          onClick={() => onOpenPet(pet.id)}
        >
          <PetAvatar pet={pet} size={40} />
          <span className="daily-all__pet-name">{pet.name}</span>
        </button>
        <button
          type="button"
          className="daily-all__disclose"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Show ${pet.name}'s daily list` : `Hide ${pet.name}'s daily list`}
        >
          <span
            className={`daily-all__disclose-chevron${collapsed ? ' daily-all__disclose-chevron--collapsed' : ''}`}
            aria-hidden="true"
          >
            ▾
          </span>
        </button>
      </div>
      {!collapsed && (
        <DailySection petId={pet.id} onError={onError} onNotice={onNotice} onMedsChanged={onMedsChanged} />
      )}
    </section>
  );
}

function DailySection({
  petId,
  date,
  onError,
  onNotice,
  onMedsChanged,
}: {
  petId: string;
  date?: string; // defaults to today; past days render read-only
  onError: (msg: string | null) => void;
  onNotice: (msg: string) => void;
  onMedsChanged: (meds: Med[]) => void;
}) {
  const [state, setState] = useState<DailyState | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [newItem, setNewItem] = useState('');
  const [busy, setBusy] = useState(false);
  const [nudgingItemId, setNudgingItemId] = useState<string | null>(null);
  const [nudgedItems, setNudgedItems] = useState<Record<string, true>>({});
  const [mealNudgeDismissed, setMealNudgeDismissed] = useState(
    () => localStorage.getItem(`petshots.mealNudgeDismissed.${petId}`) === '1',
  );
  const day = date ?? localToday();
  // Past days are history, not a backfill surface — checks/mood are view-only.
  const readOnly = day !== localToday();

  const load = useCallback(() => {
    setLoading(true);
    getDaily(petId, day)
      .then(setState)
      .catch((err) => onError(err instanceof Error ? err.message : 'Could not load the daily list'))
      .finally(() => setLoading(false));
  }, [petId, day, onError]);
  useEffect(() => {
    load();
  }, [load]);
  // Leaving today (swipe-back) closes an open list editor — history is view-only.
  useEffect(() => {
    if (readOnly) setEditing(false);
  }, [readOnly]);
  useEffect(() => {
    setNudgingItemId(null);
    setNudgedItems({});
  }, [petId, day]);

  // Med check-offs change the med schedule — keep the rest of the app in sync.
  const refreshMeds = useCallback(() => {
    listMeds(petId)
      .then((r) => onMedsChanged(r.meds))
      .catch(() => {});
  }, [petId, onMedsChanged]);

  // Check rows toggle; counter rows pass an explicit +1 (true) / -1 (false).
  async function toggle(item: DailyItem, value?: boolean) {
    if (!state || readOnly) return;
    const next = value ?? state.checks[item.id] === undefined;
    onError(null);
    if (next) hapticTap(); // native: light tap on check-off / count-up
    try {
      const res = await checkDaily(petId, day, item.id, next);
      setState((s) => (s ? { ...s, checks: res.checks } : s));
      if (item.med) {
        if (next) hapticSuccess();
        refreshMeds();
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not update the list');
      load();
    }
  }

  async function pickMood(value: number) {
    if (readOnly) return;
    onError(null);
    hapticTap();
    try {
      const res = await setDailyMood(petId, day, value);
      setState((s) => (s ? { ...s, mood: res.mood } : s));
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not save the mood');
    }
  }

  async function saveItems(items: { id?: string; name: string }[]) {
    setBusy(true);
    onError(null);
    try {
      await saveDailyItems(petId, items, day);
      load();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not save the list');
    } finally {
      setBusy(false);
    }
  }

  async function nudge(item: DailyItem) {
    if (readOnly) return;
    setNudgingItemId(item.id);
    onError(null);
    try {
      const res = await nudgeDailyTask(petId, item.id);
      setNudgedItems((prev) => ({ ...prev, [item.id]: true }));
      onNotice(
        res.notified === 1 ? 'Nudged 1 household member.' : `Nudged ${res.notified} household members.`,
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not send the nudge');
    } finally {
      setNudgingItemId(null);
    }
  }

  if (loading) return <p className="subtle">Loading…</p>;
  if (!state) return null;

  const customItems = state.items.filter((i) => !i.med);
  const doneCount = state.items.filter((i) => state.checks[i.id]).length;
  // Meal-tracking disuse prompt (server-computed hint; see DailyState).
  // Dismissal is per-pet, per-device — a "Keep" shouldn't chase the user
  // across the family's phones.
  const isFeedingItem = (i: DailyItem) =>
    i.id === 'preset-breakfast' || i.id === 'preset-dinner' || /\b(breakfast|lunch|dinner|meal|feed(ing)?)\b/i.test(i.name);
  const mealNudgeKey = `petshots.mealNudgeDismissed.${petId}`;
  const showMealNudge =
    !readOnly && state.feedingIdle === true && !mealNudgeDismissed && customItems.some(isFeedingItem);

  async function dropFeedingItems() {
    hapticTap();
    localStorage.setItem(mealNudgeKey, '1');
    setMealNudgeDismissed(true);
    await saveItems(customItems.filter((i) => !isFeedingItem(i)));
  }

  return (
    <section className="card daily">
      <div className="daily__mood">
        <span className="daily__mood-label">
          {readOnly ? 'Mood that day' : "How's your pet today?"}
        </span>
        <div className="daily__mood-row" role="radiogroup" aria-label="Mood today">
          {MOODS.map((m) => (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={state.mood?.value === m.value}
              className={`daily__mood-btn${state.mood?.value === m.value ? ' daily__mood-btn--active' : ''}`}
              title={m.label}
              disabled={readOnly}
              onClick={() => void pickMood(m.value)}
            >
              {m.emoji}
            </button>
          ))}
        </div>
        {state.mood && (
          <span className="subtle daily__mood-who">
            {MOODS.find((m) => m.value === state.mood!.value)?.label} —{' '}
            {whoAndWhen(state.mood.by, state.mood.at)}
          </span>
        )}
      </div>

      <div className="daily__head">
        <h3 className="daily__title">
          {readOnly ? 'The list that day' : "Today's list"}
          <span className="subtle"> · {doneCount}/{state.items.length} done</span>
        </h3>
        {!readOnly && (
          <button className="btn btn--link" type="button" onClick={() => setEditing((e) => !e)}>
            {editing ? 'Done' : 'Edit list'}
          </button>
        )}
      </div>

      {showMealNudge && (
        <div className="daily__meal-nudge" role="status">
          <p>Not tracking meals? They can come off this list — everything else stays.</p>
          <div className="daily__meal-nudge-actions">
            <button type="button" className="btn btn--link" disabled={busy} onClick={() => void dropFeedingItems()}>
              Remove meal items
            </button>
            <button
              type="button"
              className="btn btn--link"
              onClick={() => {
                localStorage.setItem(mealNudgeKey, '1');
                setMealNudgeDismissed(true);
              }}
            >
              Keep them
            </button>
          </div>
        </div>
      )}

      {state.items.length === 0 && (
        <p className="subtle">
          {readOnly
            ? 'Nothing recorded on this day.'
            : 'Nothing on the list — add feeding times, walks, or meds.'}
        </p>
      )}

      {state.items.map((item) => {
        const checkInfo = state.checks[item.id];
        const canNudge =
          !readOnly &&
          !checkInfo &&
          !item.med &&
          (state.householdRecipients ?? 0) > 0;
        const removeBtn = editing && !item.med && (
          <button
            type="button"
            className="btn btn--link btn--danger"
            disabled={busy}
            onClick={() => void saveItems(customItems.filter((c) => c.id !== item.id))}
          >
            Remove
          </button>
        );
        // Counter items were removed from the product (s26) — any stored one
        // renders as a plain check row (server still speaks count semantics).
        return (
          <div className={`daily-item${checkInfo ? ' daily-item--done' : ''}`} key={item.id}>
            <button
              type="button"
              className="daily-item__check"
              role="checkbox"
              aria-checked={!!checkInfo}
              aria-label={`${item.name}${checkInfo ? ' (done)' : ''}`}
              disabled={readOnly}
              onClick={() => void toggle(item)}
            >
              {checkInfo ? '✓' : ''}
            </button>
            <span className="daily-item__name">
              {item.name}
              {item.med ? ' 💊' : ''}
              {checkInfo && (
                <span className="subtle daily-item__who">{whoAndWhen(checkInfo.by, checkInfo.at)}</span>
              )}
            </span>
            {canNudge && (
              <button
                type="button"
                className="btn btn--link daily-item__nudge"
                disabled={nudgingItemId === item.id || nudgedItems[item.id]}
                onClick={() => void nudge(item)}
              >
                {nudgedItems[item.id] ? 'Nudged' : nudgingItemId === item.id ? 'Nudging…' : 'Nudge'}
              </button>
            )}
            {removeBtn}
          </div>
        );
      })}

      {editing ? (
        <form
          className="daily__add"
          onSubmit={(e) => {
            e.preventDefault();
            const name = newItem.trim();
            if (!name) return;
            setNewItem('');
            void saveItems([...customItems, { name }]);
          }}
        >
          <div className="daily__add-row">
            <input
              value={newItem}
              onChange={(e) => setNewItem(e.target.value)}
              placeholder="Add to the list (e.g. Evening walk)"
              maxLength={60}
            />
            <button className="btn btn--primary" type="submit" disabled={busy || !newItem.trim()}>
              Add
            </button>
          </div>
        </form>
      ) : readOnly ? null : (
        <p className="subtle daily__hint">
          Everyone in your family sees this list — and who checked what. Meds due today
          appear automatically; checking one marks it as given.
        </p>
      )}
    </section>
  );
}

// ---- fullscreen photo lightbox ----

function PhotoLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={`${alt}'s photo`} onClick={onClose}>
      <button className="present__exit" type="button" aria-label="Close photo" onClick={onClose}>
        ✕
      </button>
      <img className="lightbox__img" src={src} alt={alt} />
    </div>
  );
}

// ---- documents ----

// Compared against by ReviewExtractionScreen to decide whether to show a
// quiet upgrade link alongside this note — kept as one constant so the two
// spots can't drift.
const AI_QUOTA_NOTE = "You've used today's document scans — fill in the details below and they'll save just the same.";

// Friendly framing for the machine-readable analyze errors — every one of
// these lands the user on the manual form with their upload intact.
function aiFailureNote(message: string): string {
  if (message === 'AI_QUOTA_EXCEEDED') return AI_QUOTA_NOTE;
  if (message === 'TOO_LARGE_FOR_AI')
    return 'This file is too large to read automatically — fill in the details below.';
  if (message === 'UNSUPPORTED_TYPE_FOR_AI')
    return "This file type can't be read automatically — fill in the details below.";
  return "We couldn't read this document automatically — fill in the details below.";
}

function DocsSection({
  petId,
  docs,
  maxDocs,
  readOnly = false,
  onUpgrade,
  onChanged,
  onError,
  onNotice,
  onViewDoc,
  onEditDoc,
  onReviewExtraction,
}: {
  petId: string;
  docs: Doc[];
  maxDocs: number;
  readOnly?: boolean;
  onUpgrade: () => void;
  onChanged: () => Promise<void>;
  onError: (msg: string | null) => void;
  onNotice: (msg: string) => void;
  onViewDoc: (doc: Doc) => void;
  onEditDoc: (doc: Doc) => void;
  onReviewExtraction: (
    uploadId: string | null,
    fileName: string,
    extraction: Extraction | null,
    aiNote?: string,
    duplicateOf?: DuplicateInfo,
  ) => void;
}) {
  // Upload flow: pick file -> temp upload -> Claude reads it -> review screen.
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'analyzing'>('idle');
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  // Once the user (or the analyze result) has moved on to the review screen,
  // a late-resolving analyze call must not hand off a second time.
  const handedOffRef = useRef(false);
  const atLimit = docs.length >= maxDocs;
  const [showArchived, setShowArchived] = useState(false);
  // Archived records stay stored (and still count toward the plan limit) but
  // drop out of the main list into a collapsed section the owner can reopen.
  const active = docs.filter((d) => !d.dismissed);
  const archived = docs.filter((d) => d.dismissed);

  async function handleFilePicked() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    if (fileRef.current) fileRef.current.value = '';

    if (!ALLOWED_EXTS.includes(extOf(file.name))) {
      onError('Please choose a PDF, JPG, or PNG file.');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      onError(
        `That file is ${formatSize(file.size)} - the limit is ${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MB.`,
      );
      return;
    }

    onError(null);
    handedOffRef.current = false;
    setFileName(file.name);
    setPhase('uploading');
    let id: string;
    try {
      id = await uploadForAnalysis(petId, file);
    } catch (err) {
      setPhase('idle');
      onError(err instanceof Error ? err.message : 'Upload failed');
      return;
    }
    setUploadId(id);
    setPhase('analyzing');
    try {
      const { extraction, duplicate } = await analyzeUpload(petId, id);
      if (handedOffRef.current) return; // user already chose manual entry
      handedOffRef.current = true;
      setPhase('idle');
      if (duplicate) {
        // Byte-identical to an existing record — no extraction was run. The
        // review screen leads with the warning and a prominent Cancel.
        onReviewExtraction(id, file.name, null, undefined, duplicate);
        return;
      }
      onReviewExtraction(id, file.name, extraction ?? null);
    } catch (err) {
      if (handedOffRef.current) return;
      handedOffRef.current = true;
      setPhase('idle');
      // The upload itself succeeded — fall through to manual entry.
      onReviewExtraction(
        id,
        file.name,
        null,
        aiFailureNote(err instanceof Error ? err.message : ''),
      );
    }
  }

  function enterManually() {
    if (!uploadId || handedOffRef.current) return;
    handedOffRef.current = true;
    setPhase('idle');
    onReviewExtraction(uploadId, fileName, null);
  }

  return (
    <section className="card">
      <h2 className="card__title">
        Records · {docs.length}/{maxDocs}
      </h2>

      {docs.length === 0 ? (
        <div className="empty-state">
          <span className="empty-state__icon" aria-hidden="true">
            📄
          </span>
          No records yet. Snap a photo of the vaccine cert from your vet — we'll
          read the names and dates for you.
        </div>
      ) : active.length > 0 ? (
        <ul className="doc-list">
          {active.map((doc) => (
            <DocItem
              key={doc.id}
              petId={petId}
              doc={doc}
              onView={() => onViewDoc(doc)}
              onEdit={() => onEditDoc(doc)}
              onChanged={onChanged}
              onError={onError}
              onNotice={onNotice}
            />
          ))}
        </ul>
      ) : (
        <p className="subtle">Every record here is archived — see below.</p>
      )}

      {archived.length > 0 && (
        <div className="doc-archived">
          <button
            type="button"
            className="doc-archived__toggle btn btn--link"
            aria-expanded={showArchived}
            onClick={() => setShowArchived((v) => !v)}
          >
            {showArchived ? '▾' : '▸'} Archived · {archived.length}
          </button>
          {showArchived && (
            <ul className="doc-list doc-list--archived">
              {archived.map((doc) => (
                <DocItem
                  key={doc.id}
                  petId={petId}
                  doc={doc}
                  onView={() => onViewDoc(doc)}
                  onEdit={() => onEditDoc(doc)}
                  onChanged={onChanged}
                  onError={onError}
                  onNotice={onNotice}
                />
              ))}
            </ul>
          )}
        </div>
      )}

      {readOnly ? (
        <p className="subtle">
          This pet is read-only on your plan — everything stays viewable.{' '}
          <button type="button" className="btn btn--link" onClick={onUpgrade}>
            Upgrade to add records →
          </button>
        </p>
      ) : atLimit ? (
        <p className="subtle">
          You've reached the {maxDocs}-document limit. Delete one to add another.
        </p>
      ) : phase !== 'idle' ? (
        <div className="ai-status" role="status">
          <span className="ai-status__spinner" aria-hidden="true" />
          <div className="ai-status__text">
            <strong>
              {phase === 'uploading' ? 'Uploading…' : 'Reading your document…'}
            </strong>
            <span className="subtle">
              {phase === 'uploading'
                ? fileName
                : 'Finding vaccine names and dates — a few seconds.'}
            </span>
            {phase === 'analyzing' && (
              <button type="button" className="btn btn--link" onClick={enterManually}>
                Enter details manually instead
              </button>
            )}
          </div>
        </div>
      ) : (
        <>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.jpg,.jpeg,.png"
            className="visually-hidden"
            aria-hidden="true"
            tabIndex={-1}
            onChange={() => void handleFilePicked()}
          />
          <button className="btn btn--add" onClick={() => fileRef.current?.click()}>
            + Add record
          </button>
          <button
            className="btn btn--link"
            type="button"
            onClick={() => onReviewExtraction(null, '', null)}
          >
            or add manually
          </button>
          <p className="subtle ai-hint">
            Pick a photo or PDF — we'll read the vaccine names and dates for you.
          </p>
        </>
      )}
    </section>
  );
}

function DocItem({
  petId,
  doc,
  onView,
  onEdit,
  onChanged,
  onError,
  onNotice,
}: {
  petId: string;
  doc: Doc;
  onView: () => void;
  onEdit: () => void;
  onChanged: () => Promise<void>;
  onError: (msg: string | null) => void;
  onNotice: (msg: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const status = statusOf(doc.expiry);

  // Close the ⋯ menu on outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent | TouchEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setConfirming(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        setConfirming(false);
      }
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  async function handleDelete() {
    setBusy(true);
    onError(null);
    try {
      await deleteDoc(petId, doc.id);
      await onChanged();
      onNotice('Document deleted');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Delete failed');
      setBusy(false);
      setMenuOpen(false);
      setConfirming(false);
    }
    // On success the row unmounts after onChanged(), so no state reset needed.
  }

  async function handleArchive() {
    setBusy(true);
    onError(null);
    try {
      await setDocArchived(petId, doc.id, !doc.dismissed);
      await onChanged();
      onNotice(doc.dismissed ? `${doc.label} restored` : `${doc.label} archived`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed');
      setBusy(false);
      setMenuOpen(false);
    }
    // On success the row re-renders under onChanged(), so no state reset needed.
  }

  return (
    <li className={`doc-item${doc.dismissed ? ' doc-item--archived' : ''}`}>
      <button className="doc-main" onClick={onView} aria-label={`View details for ${doc.label}`}>
        <span className={`doc-dot doc-dot--${status}`} aria-hidden="true" />
        <span className="doc-meta">
          <span className="doc-label">
            {doc.label} <StatusBadge expiry={doc.expiry} />
          </span>
          <span className="subtle">
            {doc.expiry
              ? `${status === 'overdue' ? 'Expired' : 'Expires'} ${formatDate(doc.expiry)}`
              : 'No expiry date'}
          </span>
        </span>
      </button>

      <div className="doc-menu-wrap" ref={menuRef}>
        <button
          className="btn btn--icon"
          aria-label={`Options for ${doc.label}`}
          aria-expanded={menuOpen}
          onClick={() => {
            setMenuOpen((v) => !v);
            setConfirming(false);
          }}
          disabled={busy}
        >
          ⋯
        </button>
        {menuOpen && (
          <div className="doc-menu" role="menu">
            <button
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onEdit();
              }}
            >
              Edit label / date
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                void handleArchive();
              }}
            >
              {doc.dismissed ? 'Restore to records' : 'Archive (hide)'}
            </button>
            {confirming ? (
              <button role="menuitem" className="doc-menu__danger" onClick={handleDelete}>
                {busy ? 'Deleting…' : 'Confirm delete'}
              </button>
            ) : (
              <button
                role="menuitem"
                className="doc-menu__danger"
                onClick={() => setConfirming(true)}
              >
                Delete
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function DocDetailScreen({
  doc,
  species,
  onBack,
  onEdit,
}: {
  doc: Doc;
  species?: string;
  onBack: () => void;
  onEdit: () => void;
}) {
  const status = statusOf(doc.expiry);
  const blurb = vaccineBlurb(doc.label);
  const cadenceNote = vaccineCadenceNote(doc.label, species);
  const isImage = IMAGE_EXTS.includes(extOf(doc.filename));

  return (
    <div className="screen-view">
      <nav className="screen-nav">
        <button className="screen-nav__back btn btn--link" type="button" onClick={onBack}>
          ‹ Records
        </button>
        <span className="screen-nav__title">Record Details</span>
        <button className="screen-nav__action btn btn--link" type="button" onClick={onEdit}>
          ✎ Edit
        </button>
      </nav>
      <div className="screen-view__body doc-detail">
        <h2 className="doc-detail__label">{doc.label}</h2>
        <div className="doc-detail__status">
          <StatusBadge expiry={doc.expiry} />
          <span className="subtle doc-detail__expiry">
            {doc.expiry
              ? `${status === 'overdue' ? 'Expired' : 'Expires'} ${formatDate(doc.expiry)}`
              : 'No expiry date set'}
          </span>
        </div>

        {doc.dismissed && (
          <p className="doc-detail__archived-note subtle">
            📥 Archived — hidden from the records list and status, and off your passport. Edit to
            restore it.
          </p>
        )}

        {doc.given && (
          <p className="subtle doc-detail__given">💉 Given {formatDate(doc.given)}</p>
        )}

        {(blurb || cadenceNote) && (
          <div className="doc-detail__about">
            {blurb && <p className="doc-detail__blurb">{blurb}</p>}
            {cadenceNote && <p className="doc-detail__cadence">🗓️ {cadenceNote}</p>}
            <p className="doc-detail__disclaimer subtle">
              Petshots isn't a vet. Vaccine schedules vary by pet, local laws, and your vet's
              guidance — always confirm with your veterinarian.
            </p>
          </div>
        )}

        <p className="doc-detail__reminder subtle">
          {doc.remindersEnabled !== false ? '🔔 Reminders on' : '🔕 Reminders off'} · Edit to change
        </p>

        {isImage && (
          <div className="doc-detail__preview">
            <img src={doc.url} alt={doc.label} loading="lazy" />
          </div>
        )}

        {doc.filename !== '_manual' && (
          <a
            className="btn btn--primary btn--lg doc-detail__open"
            href={doc.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open certificate ↗
          </a>
        )}

      </div>
    </div>
  );
}

function EditDocScreen({
  petId,
  doc,
  onDone,
  onCancel,
  onError,
  onNotice,
}: {
  petId: string;
  doc: Doc;
  onDone: () => Promise<void>;
  onCancel: () => void;
  onError: (msg: string | null) => void;
  onNotice: (msg: string) => void;
}) {
  const [label, setLabel] = useState(doc.label);
  const [expiry, setExpiry] = useState(doc.expiry ?? '');
  const [given, setGiven] = useState(doc.given ?? '');
  const [remindersEnabled, setRemindersEnabled] = useState(doc.remindersEnabled !== false);
  const [busy, setBusy] = useState(false);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    const next = label.trim();
    if (!next) return;
    setBusy(true);
    onError(null);
    try {
      // given: '' clears the stored date server-side; a value replaces it.
      await updateDoc(petId, doc.id, next, expiry || undefined, remindersEnabled, given);
      await onDone();
      onNotice('Document updated');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setBusy(false);
    }
  }

  async function handleArchive() {
    setBusy(true);
    onError(null);
    try {
      await setDocArchived(petId, doc.id, !doc.dismissed);
      await onDone();
      onNotice(doc.dismissed ? `${doc.label} restored` : `${doc.label} archived`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed');
      setBusy(false);
    }
  }

  return (
    <div className="screen-view screen-view--sheet">
      <nav className="screen-nav">
        <button className="screen-nav__back btn btn--link" type="button" onClick={onCancel}>
          ‹ Records
        </button>
        <span className="screen-nav__title">Edit Record</span>
      </nav>
      <form className="form" onSubmit={handleSave}>
        <label>
          Label
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            autoFocus
            required
          />
        </label>
        <label>
          Date given (optional)
          <input
            type="date"
            value={given}
            onChange={(e) => setGiven(e.target.value)}
          />
        </label>
        <label>
          Expiration date (optional)
          <input
            type="date"
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
          />
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={remindersEnabled}
            onChange={(e) => setRemindersEnabled(e.target.checked)}
          />
          <span>Send reminders before this expires</span>
        </label>
        <div className="actions">
          <button className="btn btn--primary" type="submit" disabled={busy || !label.trim()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button className="btn" type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
        <div className="edit-doc__archive">
          <button type="button" className="btn btn--link" onClick={() => void handleArchive()} disabled={busy}>
            {doc.dismissed ? '↩ Restore to records' : '📥 Archive (hide from records)'}
          </button>
          <p className="subtle">
            {doc.dismissed
              ? 'Restoring brings it back into the records list and vaccine status.'
              : "Hides it from the list and stops its reminders — it won't count toward overdue status. Still viewable under Archived, and off your shareable passport."}
          </p>
        </div>
      </form>
    </div>
  );
}

// ---- AI extraction review ----

// Typical booster cadences for tap-to-fill expiry suggestions
// (VACCINE_CADENCES) now live in productConfig.ts.

// Vaccines are grouped by shared expiry date on the review screen.
// Group-level fields (expiry, given, reminder) apply to all rows in the group.
interface ReviewGroupRow {
  key: string;
  include: boolean;
  label: string;
}

interface ReviewGroup {
  id: string;
  expiry: string;
  given: string;
  remindersEnabled: boolean;
  validityHint: string;   // e.g. "1 year" or "3 months", from printed duration
  expiryFrom?: string;    // "Calculated from..." note for suggested expiry
  rows: ReviewGroupRow[];
}

interface ProfileCandidate {
  field: keyof ProfilePatch;
  title: string;
  value: string;
  current?: string; // existing profile value when it conflicts
}

// Offer a profile field only when the document had a value AND it adds
// something: empty profile field -> checked by default; conflicting value ->
// unchecked with the current value shown, so nothing is silently overwritten.
function profileCandidates(pet: Pet, extraction: Extraction | null): ProfileCandidate[] {
  if (!extraction) return [];
  const out: ProfileCandidate[] = [];
  const add = (field: keyof ProfilePatch, title: string, value?: string, current?: string) => {
    const v = value?.trim();
    if (!v) return;
    const cur = current?.trim();
    if (cur && cur.toLowerCase() === v.toLowerCase()) return; // already matches
    out.push({ field, title, value: v, current: cur || undefined });
  };
  add('breed', 'Breed', extraction.pet.breed, pet.breed);
  add('dob', 'Birthday', extraction.pet.birthday, pet.dob);
  add('weight', 'Weight', extraction.pet.weight, pet.weight);
  add('microchip', 'Microchip', extraction.pet.microchip, pet.microchip);
  const vetName = [extraction.vet.name, extraction.vet.clinic].filter(Boolean).join(' — ');
  add('vetName', 'Vet', vetName, pet.vetName);
  add('vetPhone', 'Vet phone', extraction.vet.phone, pet.vetPhone);
  return out;
}

function ReviewExtractionScreen({
  pet,
  docs,
  maxDocs,
  uploadId,
  fileName,
  extraction,
  aiNote,
  duplicateOf,
  onDone,
  onCancel,
  onError,
  onUpgrade,
}: {
  pet: Pet;
  docs: Doc[];
  maxDocs: number;
  uploadId: string | null; // null for manual entry (no file uploaded)
  fileName: string;
  extraction: Extraction | null;
  aiNote?: string;
  duplicateOf?: DuplicateInfo;
  onDone: (message: string, profileApplied: boolean) => Promise<void>;
  onCancel: () => void;
  onError: (msg: string | null) => void;
  // Only passed for free-plan callers — paid plans have no higher tier for
  // this quota to point at. Renders a quiet link next to the AI_QUOTA_NOTE
  // note only (not the other soft AI-failure notes).
  onUpgrade?: () => void;
}) {
  const remaining = Math.max(0, maxDocs - docs.length);
  const vaccines = extraction?.vaccines ?? [];

  // Build groups: vaccines sharing the same expiry date are grouped together
  // so they share one date pair, one reminder toggle, and one "Skip" per row.
  const [groups, setGroups] = useState<ReviewGroup[]>(() => {
    if (vaccines.length === 0) {
      // Manual entry: single flat group, no header shown
      return [{
        id: 'g0', expiry: '', given: '', remindersEnabled: true,
        validityHint: '', rows: [{ key: 'r0', include: true, label: '' }],
      }];
    }

    // Cluster by the expiry date (suggestedExpiry if no printed expiry)
    const buckets = new Map<string, typeof vaccines>();
    vaccines.forEach(v => {
      const k = v.expiry ?? v.suggestedExpiry ?? '';
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k)!.push(v);
    });

    let ri = 0;
    const gs: ReviewGroup[] = [];
    let gi = 0;
    for (const [expiryKey, vax] of buckets) {
      const vt = vax[0].validityText?.trim() ?? '';
      const allSameVt = vax.every(v => (v.validityText?.trim() ?? '') === vt);
      gs.push({
        id: `g${gi++}`,
        expiry: expiryKey,
        given: vax[0].dateGiven ?? '',
        remindersEnabled: true,
        validityHint: allSameVt ? vt : '',
        expiryFrom: !vax[0].expiry && vax[0].suggestedExpiry && vax[0].validityText
          ? `Calculated from "${vax[0].validityText.trim()}" printed on the document — double-check it.`
          : undefined,
        rows: vax.map(v => ({ key: `r${ri++}`, include: ri - 1 < remaining, label: v.name })),
      });
    }

    // Sort: dated groups ascending, no-expiry at end
    gs.sort((a, b) => {
      if (!a.expiry) return 1;
      if (!b.expiry) return -1;
      return a.expiry.localeCompare(b.expiry);
    });
    return gs;
  });

  const [candidates] = useState<ProfileCandidate[]>(() => profileCandidates(pet, extraction));
  const [applyProfile, setApplyProfile] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(candidates.map((c) => [c.field, !c.current])),
  );
  const [busy, setBusy] = useState(false);
  // Same-name existing records the user chose to KEEP (not replace). Keyed by
  // normalized label; absent = the default, which is to replace. We only store
  // explicit opt-outs so newly-typed matches default to "replace" with no effect.
  const [keepOld, setKeepOld] = useState<Record<string, boolean>>({});

  const allRows = groups.flatMap(g => g.rows);
  const included = allRows.filter(r => r.include);
  const missingLabel = included.some(r => !r.label.trim());

  const cadenceFor = (label: string) => VACCINE_CADENCES.find((c) => c.match.test(label));

  // Index the pet's existing records by normalized label so re-adding a shot
  // ("Bordetella", "DHPP", "Rabies"…) can offer to replace the old, usually
  // expired, record instead of stacking a second copy of the same vaccine.
  const normLabel = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const docsByLabel = new Map<string, Doc[]>();
  for (const d of docs) {
    const k = normLabel(d.label);
    if (!k) continue;
    const arr = docsByLabel.get(k);
    if (arr) arr.push(d);
    else docsByLabel.set(k, [d]);
  }

  // One entry per existing label the user is re-adding, carrying the old
  // record(s) that would be swapped out.
  const replaceMatches = [...new Set(included.map((r) => normLabel(r.label)).filter(Boolean))]
    .filter((k) => docsByLabel.has(k))
    .map((k) => ({ key: k, oldDocs: docsByLabel.get(k)! }));
  const willReplace = (k: string) => keepOld[k] !== true;
  const replacedDocs = replaceMatches.filter((m) => willReplace(m.key)).flatMap((m) => m.oldDocs);

  // Replacing a record frees its slot, so the budget is the NET count after the
  // swap — otherwise a full pet couldn't re-vaccinate without deleting first.
  const effectiveRemaining = remaining + replacedDocs.length;
  const overBudget = included.length > effectiveRemaining;

  const existingLabels = docs.map((d) => d.label.trim().toLowerCase());
  const isDupe = (label: string) => {
    const l = label.trim().toLowerCase();
    if (l.length < 3) return false;
    return existingLabels.some((e) => e === l || e.includes(l) || l.includes(e));
  };

  const setGroup = (id: string, patch: Partial<ReviewGroup>) =>
    setGroups(prev => prev.map(g => g.id === id ? { ...g, ...patch } : g));

  const setGroupRow = (groupId: string, rowKey: string, patch: Partial<ReviewGroupRow>) =>
    setGroups(prev => prev.map(g => g.id === groupId ? {
      ...g, rows: g.rows.map(r => r.key === rowKey ? { ...r, ...patch } : r),
    } : g));

  async function handleSave() {
    if (included.length === 0 || overBudget || missingLabel) return;
    const records: CommitRecord[] = groups.flatMap(g =>
      g.rows.filter(r => r.include).map(r => ({
        label: r.label.trim(),
        given: g.given || undefined,
        expiry: g.expiry || undefined,
        remindersEnabled: g.remindersEnabled,
      })),
    );
    const profile: ProfilePatch = {};
    for (const c of candidates) {
      if (applyProfile[c.field]) profile[c.field] = c.value;
    }
    const profileApplied = Object.keys(profile).length > 0;
    const replaceDocIds = replacedDocs.map((d) => d.id);

    setBusy(true);
    onError(null);
    try {
      if (uploadId) {
        await commitUpload(pet.id, uploadId, records, profileApplied ? profile : undefined, replaceDocIds);
      } else {
        await createManualRecords(pet.id, records, replaceDocIds);
      }
      const verb = replaceDocIds.length > 0 ? 'updated' : 'added';
      const noun = records.length === 1 ? `Record ${verb}` : `${records.length} records ${verb}`;
      await onDone(profileApplied ? `${noun} · profile updated` : noun, profileApplied);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Save failed');
      setBusy(false);
    }
  }

  const intro = duplicateOf
    ? {
        tone: 'warn' as const,
        text: `⚠️ This is the exact same file as ${pet.name}'s existing "${duplicateOf.label}" record${
          duplicateOf.expiry ? ` (expires ${formatDate(duplicateOf.expiry)})` : ''
        }. You probably don't need to save it again.`,
      }
    : aiNote
    ? { tone: 'warn' as const, text: aiNote }
    : extraction && vaccines.length > 0
      ? {
          tone: 'ok' as const,
          text: `✨ We read ${fileName} — check everything looks right, then save.`,
        }
      : extraction && !extraction.isPetHealthDocument
        ? {
            tone: 'warn' as const,
            text: "This doesn't look like a pet health document — you can still save it as a record below.",
          }
        : extraction
          ? {
              tone: 'warn' as const,
              text: "We couldn't find vaccine entries in this document — fill in the details below.",
            }
          : null;

  const isManual = vaccines.length === 0;

  return (
    <div className="screen-view screen-view--sheet">
      <nav className="screen-nav">
        <button className="screen-nav__back btn btn--link" type="button" onClick={onCancel} disabled={busy}>
          ‹ Records
        </button>
        <span className="screen-nav__title">Review &amp; Save</span>
      </nav>
      <div className="screen-view__body">
        {intro && (
          <p className={`ai-note${intro.tone === 'ok' ? ' ai-note--ok' : ''}`} role="status">
            {intro.text}
            {aiNote === AI_QUOTA_NOTE && onUpgrade && (
              <>
                {' '}
                <button className="btn btn--link" onClick={onUpgrade}>
                  Upgrade for more scans →
                </button>
              </>
            )}
          </p>
        )}

        <section className="card">
          <h2 className="card__title">
            {vaccines.length > 0 ? `Vaccines found · ${vaccines.length}` : 'New record'}
          </h2>

          {isManual ? (
            // Manual entry: flat form with no group container
            <div className="review-row">
              <label>
                Label
                <input
                  value={groups[0].rows[0].label}
                  onChange={(e) => setGroupRow('g0', 'r0', { label: e.target.value })}
                  placeholder="e.g. Rabies"
                />
              </label>
              <div className="review-row__dates">
                <label>
                  Date given (optional)
                  <input type="date" value={groups[0].given}
                    onChange={(e) => setGroup('g0', { given: e.target.value })} />
                </label>
                <label>
                  Expiration date (optional)
                  <input type="date" value={groups[0].expiry}
                    onChange={(e) => setGroup('g0', { expiry: e.target.value, expiryFrom: undefined })} />
                </label>
              </div>
              <label className="checkbox-label">
                <input type="checkbox" checked={groups[0].remindersEnabled}
                  onChange={(e) => setGroup('g0', { remindersEnabled: e.target.checked })} />
                <span>Send reminders before this expires</span>
              </label>
            </div>
          ) : (
            // Grouped form: each card groups vaccines that share an expiry date
            groups.map(group => {
              const activeRows = group.rows.filter(r => r.include);
              const firstActiveLabel = activeRows[0]?.label ?? '';
              const cadence = !group.expiry && group.given ? cadenceFor(firstActiveLabel) : null;

              return (
                <div className="review-group" key={group.id}>
                  <div className="review-group__header">
                    <div className="review-group__meta">
                      <div className="review-group__dates">
                        <label>
                          {group.expiry ? 'Expires' : 'Expiration date'}
                          <input type="date" value={group.expiry}
                            onChange={(e) => setGroup(group.id, { expiry: e.target.value, expiryFrom: undefined })} />
                        </label>
                        <label>
                          Date given
                          <input type="date" value={group.given}
                            onChange={(e) => setGroup(group.id, { given: e.target.value })} />
                        </label>
                      </div>
                      {group.validityHint && (
                        <span className="review-group__hint">{group.validityHint}</span>
                      )}
                      {group.expiry && group.expiryFrom && (
                        <p className="subtle review-row__suggest-note">💡 {group.expiryFrom}</p>
                      )}
                      {cadence && activeRows.length === 1 && (
                        <div className="review-row__chips">
                          <span className="subtle">
                            No expiry printed — typical {cadence.label} boosters:
                          </span>
                          {cadence.options.map((o) => (
                            <button key={o.months} type="button" className="preset-chip"
                              onClick={() => setGroup(group.id, {
                                expiry: addInterval(group.given, o.months, 'month'),
                                expiryFrom: `Suggested from a typical ${o.text} booster schedule — not printed on the document.`,
                              })}
                            >
                              + {o.text}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <label className="toggle review-group__reminder" aria-label="Send reminders before this group expires">
                      <input type="checkbox" checked={group.remindersEnabled}
                        onChange={(e) => setGroup(group.id, { remindersEnabled: e.target.checked })} />
                      <span className="toggle__track" />
                    </label>
                  </div>

                  <div className="review-group__rows">
                    {group.rows.map(row => (
                      <div className={`review-group__row${row.include ? '' : ' review-group__row--skip'}`} key={row.key}>
                        {row.include ? (
                          <>
                            <input
                              className="review-group__label-input"
                              value={row.label}
                              onChange={(e) => setGroupRow(group.id, row.key, { label: e.target.value })}
                              placeholder="Vaccine name"
                            />
                            {isDupe(row.label) && (
                              <span className="review-group__dupe">⚠️ already saved</span>
                            )}
                            <button type="button" className="review-group__skip btn btn--link"
                              onClick={() => setGroupRow(group.id, row.key, { include: false })}>
                              Skip
                            </button>
                          </>
                        ) : (
                          <>
                            <span className="review-group__skipped-label">{row.label || '(unnamed)'}</span>
                            <button type="button" className="review-group__skip btn btn--link"
                              onClick={() => setGroupRow(group.id, row.key, { include: true })}>
                              Undo
                            </button>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })
          )}

          {allRows.length > effectiveRemaining && (
            <p className="subtle" style={{ marginTop: '0.75rem' }}>
              Your plan has {effectiveRemaining} record slot{effectiveRemaining === 1 ? '' : 's'} left
              for {pet.name}
              {overBudget ? ` — skip ${included.length - effectiveRemaining} to save.` : '.'}
            </p>
          )}

          <button
            type="button"
            className="btn btn--link"
            onClick={() => {
              const id = `g-x${Date.now()}`;
              const key = `r-x${Date.now()}`;
              setGroups(prev => [...prev, {
                id, expiry: '', given: '', remindersEnabled: true,
                validityHint: '', rows: [{ key, include: true, label: '' }],
              }]);
            }}
          >
            + Add another record from this document
          </button>
        </section>

        {replaceMatches.length > 0 && (
          <section className="card">
            <h2 className="card__title">
              Replace {pet.name}'s existing record{replaceMatches.length > 1 ? 's' : ''}?
            </h2>
            <p className="subtle">
              {pet.name} already {replaceMatches.length === 1 ? 'has a record' : 'has records'} with
              the same name. Replace to swap the old one out; uncheck to keep both.
            </p>
            {replaceMatches.map((m) => {
              const old = m.oldDocs[0];
              const st = statusOf(old.expiry);
              const when = old.expiry
                ? `${st === 'overdue' ? 'expired' : 'expires'} ${formatDate(old.expiry)}`
                : 'no expiry';
              return (
                <label className="checkbox-label review-profile__item" key={m.key}>
                  <input
                    type="checkbox"
                    checked={willReplace(m.key)}
                    onChange={(e) =>
                      setKeepOld((prev) => ({ ...prev, [m.key]: !e.target.checked }))
                    }
                  />
                  <span>
                    Replace <strong>{old.label}</strong>
                    {m.oldDocs.length > 1 && ` (${m.oldDocs.length} records)`}
                    <span className="subtle"> · old one {when}</span>
                  </span>
                </label>
              );
            })}
          </section>
        )}

        {candidates.length > 0 && (
          <section className="card">
            <h2 className="card__title">Also update {pet.name}'s profile?</h2>
            {candidates.map((c) => (
              <label className="checkbox-label review-profile__item" key={c.field}>
                <input
                  type="checkbox"
                  checked={!!applyProfile[c.field]}
                  onChange={(e) =>
                    setApplyProfile((prev) => ({ ...prev, [c.field]: e.target.checked }))
                  }
                />
                <span>
                  <strong>{c.title}:</strong> {c.value}
                  {c.current && <span className="subtle"> · currently "{c.current}"</span>}
                </span>
              </label>
            ))}
          </section>
        )}

        <div className="actions">
          {/* Duplicate upload: Cancel is the sane choice, so it gets the emphasis. */}
          <button
            className={`btn btn--lg${duplicateOf ? '' : ' btn--primary'}`}
            type="button"
            onClick={() => void handleSave()}
            disabled={busy || included.length === 0 || overBudget || missingLabel}
          >
            {busy
              ? 'Saving…'
              : duplicateOf
                ? 'Save anyway'
                : included.length > 1
                  ? `Save ${included.length} records`
                  : 'Save record'}
          </button>
          <button
            className={`btn${duplicateOf ? ' btn--primary btn--lg' : ''}`}
            type="button"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
        </div>
        {missingLabel && <p className="subtle">Every selected record needs a label.</p>}
        <p className="subtle">Cancelling discards this upload.</p>
      </div>
    </div>
  );
}

// ---- medications ----

// Quick-add presets: the meds people actually give on a schedule. Daily meds
// default reminders OFF (a daily email is noise); interval meds default ON.
const MED_PRESETS: { name: string; interval: number; unit: MedUnit; reminders: boolean }[] = [
  { name: 'Heartworm prevention', interval: 1, unit: 'month', reminders: true },
  { name: 'Flea & tick prevention', interval: 1, unit: 'month', reminders: true },
  { name: 'Bravecto', interval: 12, unit: 'week', reminders: true },
  { name: 'Joint supplement', interval: 1, unit: 'day', reminders: false },
  { name: 'Thyroid medication', interval: 1, unit: 'day', reminders: false },
  { name: 'Insulin', interval: 1, unit: 'day', reminders: false },
];

const CADENCE_OPTIONS: { value: string; label: string; interval: number; unit: MedUnit }[] = [
  { value: '1:day', label: 'Daily', interval: 1, unit: 'day' },
  { value: '1:week', label: 'Weekly', interval: 1, unit: 'week' },
  { value: '2:week', label: 'Every 2 weeks', interval: 2, unit: 'week' },
  { value: '1:month', label: 'Monthly', interval: 1, unit: 'month' },
  { value: '2:month', label: 'Every 2 months', interval: 2, unit: 'month' },
  { value: '3:month', label: 'Every 3 months', interval: 3, unit: 'month' },
  { value: '12:week', label: 'Every 12 weeks', interval: 12, unit: 'week' },
  { value: '6:month', label: 'Every 6 months', interval: 6, unit: 'month' },
  { value: '12:month', label: 'Yearly', interval: 12, unit: 'month' },
];

function cadenceLabel(interval: number, unit: MedUnit): string {
  const preset = CADENCE_OPTIONS.find((o) => o.interval === interval && o.unit === unit);
  if (preset) return preset.label;
  return `Every ${interval} ${unit}${interval !== 1 ? 's' : ''}`;
}

// Meds use a tighter urgency window than vaccines (a monthly med inside a
// 30-day "due soon" window would never leave it) — and the lookahead must
// also shrink with the cadence: a daily med is ALWAYS within a few days of
// its next dose, so a fixed window flagged it "due tomorrow" the moment it
// was given. Lookahead = min(MED_LOOKAHEAD_MAX_DAYS, interval-1) days, so
// short-cycle meds only alarm on their actual due day.
function medStatus(
  med: Pick<Med, 'nextDue' | 'interval' | 'unit'>,
): { status: Status; pill: string | null } {
  const days = daysUntil(med.nextDue);
  const intervalDays =
    med.unit === 'day' ? med.interval : med.unit === 'week' ? med.interval * 7 : med.interval * 30;
  const lookahead = Math.min(DASHBOARD_CONFIG.MED_LOOKAHEAD_MAX_DAYS, Math.max(0, intervalDays - 1));
  if (days < 0) return { status: 'overdue', pill: `Overdue ${-days}d` };
  if (days === 0) return { status: 'due-soon', pill: 'Due today' };
  if (days > lookahead) return { status: 'current', pill: null };
  if (days === 1) return { status: 'due-soon', pill: 'Due tomorrow' };
  return { status: 'due-soon', pill: `Due in ${days}d` };
}

// Reminder emails go to settings.email, which users who never opened Settings
// don't have yet. Backfill it (once per session) so a med's reminder toggle
// alone is enough to actually get email.
let reminderEmailEnsured = false;
async function ensureReminderEmail(email: string) {
  if (reminderEmailEnsured || !email) return;
  reminderEmailEnsured = true;
  try {
    const s = await getSettings();
    if (!s.email) await saveSettings({ ...DEFAULT_SETTINGS, ...s, email });
  } catch {
    // Non-fatal: the reminder Lambda simply skips users without an email.
  }
}

function MedsSummary({ meds: allMeds }: { meds: Med[] }) {
  const meds = trackedMeds(allMeds); // dismissed meds are never "due"
  if (meds.length === 0) return null;
  const overdue = meds.filter((m) => daysUntil(m.nextDue) < 0);
  const dueToday = meds.filter((m) => daysUntil(m.nextDue) === 0);
  if (overdue.length > 0) {
    return (
      <section className="summary summary--overdue">
        ⚠ {overdue.length} medication{overdue.length > 1 ? 's are' : ' is'} overdue —{' '}
        {overdue.map((m) => m.name).join(', ')}.
      </section>
    );
  }
  if (dueToday.length > 0) {
    return (
      <section className="summary summary--due-soon">
        💊 Due today — {dueToday.map((m) => m.name).join(', ')}.
      </section>
    );
  }
  return <section className="summary summary--current">✓ All medications on schedule.</section>;
}

function MedsSection({
  petId,
  maxMeds,
  readOnly = false,
  onUpgrade,
  onError,
  onNotice,
  onMedsChanged,
}: {
  petId: string;
  maxMeds: number;
  readOnly?: boolean;
  onUpgrade: () => void;
  onError: (msg: string | null) => void;
  onNotice: (msg: string) => void;
  // Keeps the dashboard-level med cache (overview pins, tab badge) in sync.
  onMedsChanged?: (meds: Med[]) => void;
}) {
  const { email } = useAuth();
  const [meds, setMeds] = useState<Med[] | null>(null); // null = loading
  const [form, setForm] = useState<
    | { mode: 'closed' }
    | { mode: 'add'; preset?: (typeof MED_PRESETS)[number] }
    | { mode: 'edit'; med: Med }
  >({ mode: 'closed' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setMeds(null);
    setForm({ mode: 'closed' });
    listMeds(petId)
      .then((r) => { if (live) { setMeds(r.meds); onMedsChanged?.(r.meds); } })
      .catch((err) => {
        if (live) {
          setMeds([]);
          onError(err instanceof Error ? err.message : 'Could not load medications');
        }
      });
    return () => { live = false; };
  }, [petId, onError]);

  // Whole-list save with rollback: local state is the source of truth, the
  // server echo (cleaned ids/fields) replaces it on success.
  async function persist(next: Med[], successNotice?: string): Promise<boolean> {
    const prev = meds;
    setMeds(next);
    setBusy(true);
    onError(null);
    try {
      const res = await saveMeds(petId, next);
      setMeds(res.meds);
      onMedsChanged?.(res.meds);
      if (next.some((m) => m.remindersEnabled)) void ensureReminderEmail(email ?? '');
      if (successNotice) onNotice(successNotice);
      return true;
    } catch (err) {
      setMeds(prev);
      onError(err instanceof Error ? err.message : 'Could not save medications');
      return false;
    } finally {
      setBusy(false);
    }
  }

  function handleToggleReminders(med: Med, enabled: boolean) {
    const next = (meds ?? []).map((m) =>
      m.id === med.id ? { ...m, remindersEnabled: enabled } : m,
    );
    void persist(next, enabled ? `Reminders on for ${med.name}` : `Reminders off for ${med.name}`);
  }

  function handleDelete(med: Med) {
    void persist((meds ?? []).filter((m) => m.id !== med.id), `${med.name} removed`);
  }

  // "Stop tracking" keeps the med on record but ends all due-date nagging
  // (banners, overview status, passport, email). Resuming leaves reminders
  // off so the user re-opts-in deliberately.
  function handleDismiss(med: Med, dismissed: boolean) {
    const next = (meds ?? []).map((m) =>
      m.id === med.id
        ? { ...m, dismissed: dismissed || undefined, remindersEnabled: dismissed ? false : m.remindersEnabled }
        : m,
    );
    void persist(
      next,
      dismissed
        ? `${med.name} is no longer tracked — it stays on record`
        : `Tracking resumed for ${med.name}`,
    );
  }

  async function handleFormSave(med: Med) {
    const current = meds ?? [];
    const next =
      form.mode === 'edit'
        ? current.map((m) => (m.id === med.id ? med : m))
        : [...current, med];
    const ok = await persist(next, form.mode === 'edit' ? 'Medication updated' : `${med.name} added`);
    if (ok) setForm({ mode: 'closed' });
  }

  if (meds === null) {
    return (
      <section className="card" aria-busy="true" aria-label="Loading medications">
        <span className="skeleton skeleton--line" />
        <span className="skeleton skeleton--line" />
      </section>
    );
  }

  const existingNames = new Set(meds.map((m) => m.name.toLowerCase()));
  const availablePresets = MED_PRESETS.filter((p) => !existingNames.has(p.name.toLowerCase()));
  const atLimit = meds.length >= maxMeds;

  return (
    <>
      <MedsSummary meds={meds} />
      <section className="card">
        <h2 className="card__title">Medications · {meds.length}</h2>

        {meds.length === 0 && form.mode === 'closed' && (
          <div className="empty-state">
            <span className="empty-state__icon" aria-hidden="true">💊</span>
            Track heartworm, flea &amp; tick, and any other meds here. Add one
            and we'll email you when the next dose is due.
          </div>
        )}

        {meds.length > 0 && (
          <ul className="doc-list">
            {meds.map((med) => (
              <MedItem
                key={med.id}
                med={med}
                busy={busy}
                onToggleReminders={(enabled) => handleToggleReminders(med, enabled)}
                onEdit={() => setForm({ mode: 'edit', med })}
                onDelete={() => handleDelete(med)}
                onDismiss={(dismissed) => handleDismiss(med, dismissed)}
              />
            ))}
          </ul>
        )}

        {form.mode !== 'closed' ? (
          <MedForm
            key={form.mode === 'edit' ? form.med.id : (form.preset?.name ?? 'new')}
            initial={form.mode === 'edit' ? form.med : undefined}
            preset={form.mode === 'add' ? form.preset : undefined}
            busy={busy}
            onSave={handleFormSave}
            onCancel={() => setForm({ mode: 'closed' })}
          />
        ) : readOnly ? (
          <p className="subtle">
            This pet is read-only on your plan — existing meds stay editable.{' '}
            <button type="button" className="btn btn--link" onClick={onUpgrade}>
              Upgrade to add meds →
            </button>
          </p>
        ) : atLimit ? (
          <p className="subtle">
            You've reached the {maxMeds}-medication limit. Remove one to add another.
          </p>
        ) : (
          <div className="med-add">
            {availablePresets.length > 0 && (
              <div className="preset-chips" role="group" aria-label="Common medications">
                {availablePresets.map((p) => (
                  <button
                    key={p.name}
                    type="button"
                    className="preset-chip"
                    onClick={() => setForm({ mode: 'add', preset: p })}
                  >
                    + {p.name}
                  </button>
                ))}
              </div>
            )}
            <button className="btn btn--add" onClick={() => setForm({ mode: 'add' })}>
              + Add your own
            </button>
          </div>
        )}
      </section>
    </>
  );
}

function MedItem({
  med,
  busy,
  onToggleReminders,
  onEdit,
  onDelete,
  onDismiss,
}: {
  med: Med;
  busy: boolean;
  onToggleReminders: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  onDismiss: (dismissed: boolean) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const dismissed = med.dismissed === true;
  const { status, pill } = dismissed
    ? { status: 'none' as Status, pill: 'Not tracked' }
    : medStatus(med);

  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent | TouchEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setConfirming(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        setConfirming(false);
      }
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  return (
    <li className={`med-item${dismissed ? ' med-item--dismissed' : ''}`}>
      <div className="med-item__row">
        <span className={`doc-dot doc-dot--${status}`} aria-hidden="true" />
        <span className="doc-meta">
          <span className="doc-label">
            {med.name}{' '}
            {pill && <span className={`status status--${status}`}>{pill}</span>}
          </span>
          <span className="subtle">
            {dismissed
              ? 'Kept for your records — no due-date tracking'
              : `${cadenceLabel(med.interval, med.unit)} · Next due ${formatDate(med.nextDue)}${
                  med.lastGiven ? ` · Last given ${formatDate(med.lastGiven)}` : ''
                }`}
          </span>
        </span>
        <div className="doc-menu-wrap" ref={menuRef}>
          <button
            className="btn btn--icon"
            aria-label={`Options for ${med.name}`}
            aria-expanded={menuOpen}
            onClick={() => { setMenuOpen((v) => !v); setConfirming(false); }}
            disabled={busy}
          >
            ⋯
          </button>
          {menuOpen && (
            <div className="doc-menu" role="menu">
              <button role="menuitem" onClick={() => { setMenuOpen(false); onEdit(); }}>
                Edit
              </button>
              <button
                role="menuitem"
                onClick={() => { setMenuOpen(false); onDismiss(!dismissed); }}
              >
                {dismissed ? 'Resume tracking' : 'Stop tracking'}
              </button>
              {confirming ? (
                <button
                  role="menuitem"
                  className="doc-menu__danger"
                  onClick={() => { setMenuOpen(false); onDelete(); }}
                >
                  Confirm delete
                </button>
              ) : (
                <button
                  role="menuitem"
                  className="doc-menu__danger"
                  onClick={() => setConfirming(true)}
                >
                  Delete
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {!dismissed && (
        <div className="med-item__actions">
          {/* Giving a med happens on the Daily tab (checking its row) — this
              tab is schedule + reminders only, so the toggles line up. */}
          <label className="med-remind">
            <span className="med-remind__label subtle">
              {med.remindersEnabled ? '🔔 Reminders' : '🔕 Reminders'}
            </span>
            <span className="toggle toggle--sm" aria-label={`Toggle reminders for ${med.name}`}>
              <input
                type="checkbox"
                checked={med.remindersEnabled}
                onChange={(e) => onToggleReminders(e.target.checked)}
                disabled={busy}
              />
              <span className="toggle__track" />
            </span>
          </label>
        </div>
      )}
    </li>
  );
}

function MedForm({
  initial,
  preset,
  busy,
  onSave,
  onCancel,
}: {
  initial?: Med; // present = edit mode
  preset?: (typeof MED_PRESETS)[number];
  busy: boolean;
  onSave: (med: Med) => void;
  onCancel: () => void;
}) {
  const source = initial ?? (preset ? { ...preset, nextDue: todayYMD(), remindersEnabled: preset.reminders } : null);
  const initialCadence = source
    ? (CADENCE_OPTIONS.find((o) => o.interval === source.interval && o.unit === source.unit)?.value ?? 'custom')
    : '1:month';

  const [name, setName] = useState(source?.name ?? '');
  const [cadence, setCadence] = useState(initialCadence);
  const [customDays, setCustomDays] = useState(
    initialCadence === 'custom' && source ? String(source.interval) : '30',
  );
  const [nextDue, setNextDue] = useState(initial?.nextDue ?? todayYMD());
  const [remindersEnabled, setRemindersEnabled] = useState(
    initial ? initial.remindersEnabled : (preset ? preset.reminders : true),
  );

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || !nextDue) return;
    let interval: number;
    let unit: MedUnit;
    if (cadence === 'custom') {
      interval = Math.max(1, Math.min(365, Math.round(Number(customDays) || 1)));
      unit = 'day';
    } else {
      const opt = CADENCE_OPTIONS.find((o) => o.value === cadence)!;
      interval = opt.interval;
      unit = opt.unit;
    }
    onSave({
      id: initial?.id ?? crypto.randomUUID(),
      name: trimmed,
      interval,
      unit,
      nextDue,
      remindersEnabled,
      lastGiven: initial?.lastGiven,
    });
  }

  return (
    <form className="form med-form" onSubmit={handleSubmit}>
      <label>
        Medication
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Heartworm prevention"
          maxLength={100}
          autoFocus={!initial}
          required
        />
      </label>
      <label>
        How often
        <select value={cadence} onChange={(e) => setCadence(e.target.value)}>
          {CADENCE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
          <option value="custom">Every N days…</option>
        </select>
      </label>
      {cadence === 'custom' && (
        <label>
          Repeat every (days)
          <input
            type="number"
            min={1}
            max={365}
            value={customDays}
            onChange={(e) => setCustomDays(e.target.value)}
            required
          />
        </label>
      )}
      <label>
        Next dose due
        <input
          type="date"
          value={nextDue}
          onChange={(e) => setNextDue(e.target.value)}
          required
        />
      </label>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={remindersEnabled}
          onChange={(e) => setRemindersEnabled(e.target.checked)}
        />
        <span>Email me when a dose is due</span>
      </label>
      <div className="actions">
        <button className="btn btn--primary" type="submit" disabled={busy || !name.trim()}>
          {busy ? 'Saving…' : initial ? 'Save' : 'Add medication'}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---- profile read view ----

function profileAge(dob?: string): string | null {
  if (!dob) return null;
  const today = new Date();
  const birth = new Date(`${dob}T00:00:00`);
  const years = today.getFullYear() - birth.getFullYear();
  const months = today.getMonth() - birth.getMonth();
  const adjusted = months < 0 || (months === 0 && today.getDate() < birth.getDate()) ? years - 1 : years;
  if (adjusted < 1) {
    const m = ((today.getFullYear() - birth.getFullYear()) * 12 + today.getMonth() - birth.getMonth());
    return `${m} month${m !== 1 ? 's' : ''} old`;
  }
  return `${adjusted} year${adjusted !== 1 ? 's' : ''} old`;
}

function ProfileField({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div className="profile-field">
      <span className="profile-field__label">{label}</span>
      <span className="profile-field__value">{value}</span>
    </div>
  );
}

// Read-only — the single "Edit profile" button on PetProfileScreen is the
// one edit affordance (two edit buttons on one screen confused people).
function ProfileSection({ pet }: { pet: Pet }) {
  const hasAny = pet.breed || pet.dob || pet.weight || pet.allergies || pet.behavior ||
    pet.vetName || pet.emergencyContact || pet.microchip || pet.fixed !== undefined || pet.notes;

  if (!hasAny) {
    return (
      <div className="profile-empty">
        <p className="subtle">
          No health profile yet — add breed, allergies, and vet info with Edit profile below.
        </p>
      </div>
    );
  }

  return (
    <div className="profile-view">
      {(pet.breed || pet.dob || pet.weight || pet.fixed !== undefined) && (
        <section className="profile-section">
          <h3 className="profile-section__title">About</h3>
          <ProfileField label="Breed" value={pet.breed} />
          <ProfileField label="Age" value={profileAge(pet.dob)} />
          <ProfileField label="Weight" value={pet.weight} />
          <ProfileField label="Status" value={pet.fixed !== undefined ? (pet.fixed ? 'Spayed / Neutered' : 'Intact') : undefined} />
          <ProfileField label="Microchip" value={pet.microchip} />
        </section>
      )}
      {(pet.allergies || pet.behavior || pet.notes) && (
        <section className="profile-section">
          <h3 className="profile-section__title">Health Notes</h3>
          <ProfileField label="Allergies" value={pet.allergies} />
          <ProfileField label="Behavior" value={pet.behavior} />
          <ProfileField label="Special instructions" value={pet.notes} />
        </section>
      )}
      {(pet.vetName || pet.vetPhone || pet.emergencyContact) && (
        <section className="profile-section">
          <h3 className="profile-section__title">Contacts</h3>
          <ProfileField label="Vet" value={pet.vetName} />
          <ProfileField label="Vet phone" value={pet.vetPhone} />
          <ProfileField label="Emergency contact" value={pet.emergencyContact} />
        </section>
      )}
    </div>
  );
}

// ---- weight log (Profile tab card) ----

// Tiny inline trend, last 12 entries. No axes — the numbers are in the list;
// this is just "which way is it going".
function WeightSparkline({ entries }: { entries: WeightEntry[] }) {
  const pts = entries.slice(-12);
  if (pts.length < 2) return null;
  const W = 132;
  const H = 36;
  const PAD = 4;
  const min = Math.min(...pts.map((e) => e.weight));
  const max = Math.max(...pts.map((e) => e.weight));
  const span = max - min || 1;
  const coords = pts
    .map((e, i) => {
      const x = PAD + (i * (W - PAD * 2)) / (pts.length - 1);
      const y = H - PAD - ((e.weight - min) / span) * (H - PAD * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg
      className="weight-spark"
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      aria-label="Weight trend"
      role="img"
    >
      <polyline points={coords} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function WeightSection({
  petId,
  onPetChanged,
  onError,
}: {
  petId: string;
  onPetChanged: () => void; // profile display weight is server-synced
  onError: (msg: string | null) => void;
}) {
  const [entries, setEntries] = useState<WeightEntry[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [weight, setWeight] = useState('');
  const [unit, setUnit] = useState<'lb' | 'kg'>(
    (localStorage.getItem('petshots.weightUnit') as 'lb' | 'kg') || 'lb',
  );
  const [date, setDate] = useState(localToday());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    listWeights(petId)
      .then((r) => { if (live) setEntries(r.entries); })
      .catch(() => { if (live) setEntries([]); });
    return () => { live = false; };
  }, [petId]);

  async function handleLog(e: FormEvent) {
    e.preventDefault();
    const value = Number(weight);
    if (!Number.isFinite(value) || value <= 0) {
      onError('Enter a weight greater than zero.');
      return;
    }
    setBusy(true);
    onError(null);
    try {
      const res = await logWeight(petId, date, value, unit);
      setEntries(res.entries);
      localStorage.setItem('petshots.weightUnit', unit);
      setWeight('');
      setAdding(false);
      setDate(localToday());
      onPetChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not log the weight');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(d: string) {
    setBusy(true);
    onError(null);
    try {
      const res = await deleteWeight(petId, d);
      setEntries(res.entries);
      onPetChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not remove the entry');
    } finally {
      setBusy(false);
    }
  }

  if (entries === null) return null;

  const latest = entries[entries.length - 1];
  const previous = entries[entries.length - 2];
  const delta = latest && previous ? latest.weight - previous.weight : null;
  const recent = [...entries].slice(-5).reverse();

  return (
    <section className="profile-section weight-card">
      <h3 className="profile-section__title">Weight over time</h3>

      {latest ? (
        <div className="weight-card__now">
          <span className="weight-card__value">
            {latest.weight} {latest.unit}
            {delta !== null && delta !== 0 && (
              <span className={`weight-card__delta ${delta > 0 ? 'weight-card__delta--up' : 'weight-card__delta--down'}`}>
                {delta > 0 ? '▲' : '▼'} {Math.abs(Math.round(delta * 100) / 100)} {latest.unit}
              </span>
            )}
          </span>
          <WeightSparkline entries={entries} />
        </div>
      ) : (
        <p className="subtle">
          No weigh-ins yet. Log one after each vet visit (or the bathroom-scale
          trick: hold them, subtract yourself).
        </p>
      )}

      {recent.map((e) => (
        <div className="weight-row" key={e.date}>
          <span className="weight-row__main">
            {formatDate(e.date)} · <strong>{e.weight} {e.unit}</strong>
            <span className="subtle weight-row__who"> — {e.by.split('@')[0]}</span>
          </span>
          <button
            type="button"
            className="btn btn--icon"
            aria-label={`Delete the ${formatDate(e.date)} weigh-in`}
            disabled={busy}
            onClick={() => void handleDelete(e.date)}
          >
            ✕
          </button>
        </div>
      ))}

      {adding ? (
        <form className="weight-add" onSubmit={handleLog}>
          <input
            type="number"
            inputMode="decimal"
            step="0.1"
            min="0.1"
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
            placeholder="Weight"
            autoFocus
            required
          />
          <select value={unit} onChange={(e) => setUnit(e.target.value as 'lb' | 'kg')}>
            <option value="lb">lb</option>
            <option value="kg">kg</option>
          </select>
          <input
            type="date"
            value={date}
            max={localToday()}
            onChange={(e) => setDate(e.target.value)}
            required
          />
          <div className="actions">
            <button className="btn btn--primary" type="submit" disabled={busy || !weight}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button className="btn" type="button" disabled={busy} onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button className="btn" type="button" onClick={() => setAdding(true)}>
          + Log weight
        </button>
      )}
    </section>
  );
}

// ---- passport tab ----

function PassportTabSection({
  pet,
  onPassportChanged,
  onNotice,
  onError,
}: {
  pet: Pet;
  onPassportChanged: () => void;
  onNotice: (msg: string) => void;
  onError: (msg: string | null) => void;
}) {
  const navigate = useNavigate(); // "View passport" opens the real public page in-app
  const [expiry, setExpiry] = useState('30d');
  const [busy, setBusy] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const passportUrl = pet.passportToken
    ? `https://petshots.app/p/${pet.passportToken}`
    : null;

  useEffect(() => {
    if (!passportUrl) { setQrDataUrl(null); return; }
    // Always dark-on-white: inverted QR codes fail on many scanners.
    void QRCode.toDataURL(passportUrl, { width: 220, margin: 2, color: { dark: '#111827', light: '#ffffff' } })
      .then(setQrDataUrl)
      .catch(() => {});
  }, [passportUrl]);

  function expiryDate(): string | undefined {
    if (expiry === 'never') return undefined;
    const days = expiry === '7d' ? 7 : expiry === '30d' ? 30 : expiry === '90d' ? 90 : 365;
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
  }

  async function handleGenerate() {
    setBusy(true);
    onError(null);
    try {
      await createPassport(pet.id, expiryDate());
      onPassportChanged();
      onNotice('Passport link generated');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not generate passport');
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke() {
    setBusy(true);
    onError(null);
    try {
      await revokePassport(pet.id);
      onPassportChanged();
      onNotice('Passport link revoked');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not revoke passport');
    } finally {
      setBusy(false);
    }
  }

  async function handleCopy() {
    if (!passportUrl) return;
    try {
      await navigator.clipboard.writeText(passportUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      onError('Could not copy — try long-pressing the link');
    }
  }

  async function handleShare() {
    if (!passportUrl) return;
    const shareData = {
      title: `${pet.name}'s vaccination records`,
      text: `${pet.name}'s shot records are always up to date — view them anytime with Petshots 🐾`,
      url: passportUrl,
    };
    if (typeof navigator.share === 'function') {
      try { await navigator.share(shareData); } catch { /* user cancelled */ }
    } else {
      await handleCopy();
    }
  }

  if (!passportUrl) {
    if (pet.household) {
      return (
        <div className="share-tab card">
          <p className="subtle">
            Only the family owner can create share links for {pet.name}.
          </p>
        </div>
      );
    }
    return (
      <div className="share-tab card">
        <p className="share-tab__intro">
          Generate a link anyone can open — no login required. Share it with your groomer,
          boarding facility, or vet ahead of check-in.
        </p>
        <label className="share-tab__expiry-label">
          Link expires
          <select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
            <option value="7d">In 7 days</option>
            <option value="30d">In 30 days</option>
            <option value="90d">In 90 days</option>
            <option value="1y">In 1 year</option>
            <option value="never">Never</option>
          </select>
        </label>
        <button className="btn btn--primary" onClick={handleGenerate} disabled={busy}>
          {busy ? 'Generating…' : `Generate passport for ${pet.name}`}
        </button>
      </div>
    );
  }

  return (
    <div className="share-tab card">
      {qrDataUrl && (
        <div className="share-tab__qr-wrap">
          <img className="share-tab__qr" src={qrDataUrl} alt="QR code — scan to open passport" />
        </div>
      )}

      <div className="share-tab__url-row">
        <span className="share-tab__url" title={passportUrl}>{passportUrl}</span>
      </div>

      <div className="share-tab__actions">
        <button className="btn btn--primary" onClick={handleShare}>
          Share passport ↗
        </button>
        <button className="btn" onClick={handleCopy}>
          {copied ? 'Copied!' : 'Copy link'}
        </button>
        <button
          className="btn"
          onClick={() => navigate(`/p/${pet.passportToken}?preview=1`)}
        >
          View passport
        </button>
      </div>

      {pet.passportExpiry && (
        <p className="share-tab__expiry subtle">
          Expires {formatDate(pet.passportExpiry)}
        </p>
      )}

      {pet.household ? (
        <p className="subtle">Only the family owner can revoke this link.</p>
      ) : (
        <div className="share-tab__revoke">
          <button
            className="btn btn--link btn--danger"
            onClick={handleRevoke}
            disabled={busy}
          >
            {busy ? 'Revoking…' : 'Revoke link'}
          </button>
          <span className="subtle share-tab__revoke-hint">Revoked links stop working immediately.</span>
        </div>
      )}
    </div>
  );
}

// ---- profile edit screen ----

function ProfileEditScreen({
  pet,
  onDone,
  onCancel,
  onDeletePet,
  onError,
  onNotice,
}: {
  pet: Pet;
  onDone: () => Promise<void>;
  onCancel: () => void;
  onDeletePet?: (petId: string) => void;
  onError: (msg: string | null) => void;
  onNotice: (msg: string) => void;
}) {
  const [name, setName] = useState(pet.name);
  const [species, setSpecies] = useState(pet.species);
  const photoRef = useRef<HTMLInputElement>(null);
  const [breed, setBreed] = useState(pet.breed ?? '');
  const [dob, setDob] = useState(pet.dob ?? '');
  const [weight, setWeight] = useState(pet.weight ?? '');
  const [fixed, setFixed] = useState<'' | 'true' | 'false'>(
    pet.fixed === true ? 'true' : pet.fixed === false ? 'false' : ''
  );
  const [microchip, setMicrochip] = useState(pet.microchip ?? '');
  const [allergies, setAllergies] = useState(pet.allergies ?? '');
  const [behavior, setBehavior] = useState(pet.behavior ?? '');
  const [notes, setNotes] = useState(pet.notes ?? '');
  const [vetName, setVetName] = useState(pet.vetName ?? '');
  const [vetPhone, setVetPhone] = useState(pet.vetPhone ?? '');
  const [emergencyContact, setEmergencyContact] = useState(pet.emergencyContact ?? '');
  const [busy, setBusy] = useState(false);
  // Memorial state — PUT /pets is a full replace, so these ride along on
  // every save (see handleSave) or the flag would silently clear.
  const [memorial, setMemorial] = useState(pet.memorial === true);
  const [passedOn, setPassedOn] = useState(pet.passedOn ?? '');
  const [confirmingMemorial, setConfirmingMemorial] = useState(false);
  // Deleting is deliberate: type the pet's name to arm the button. The old
  // one-tap-then-undo-toast flow was too easy to trip without noticing.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteText, setDeleteText] = useState('');
  const deleteArmed =
    deleteText.trim().toLowerCase() === pet.name.trim().toLowerCase();

  function currentFields(over?: { memorial?: boolean; passedOn?: string }) {
    return {
      name: name.trim() || pet.name,
      species,
      breed: breed || undefined,
      dob: dob || undefined,
      weight: weight || undefined,
      fixed: fixed === 'true' ? true : fixed === 'false' ? false : undefined,
      microchip: microchip || undefined,
      allergies: allergies || undefined,
      behavior: behavior || undefined,
      notes: notes || undefined,
      vetName: vetName || undefined,
      vetPhone: vetPhone || undefined,
      emergencyContact: emergencyContact || undefined,
      memorial: (over?.memorial ?? memorial) || undefined,
      passedOn: (over?.passedOn ?? passedOn) || undefined,
    };
  }

  // Setting/clearing the memorial flag saves immediately (its own quiet
  // moment, not bundled with "Save profile") — reminders, stories, and
  // badges stop right away, not whenever the form next gets submitted.
  async function handleMemorial(next: boolean, date?: string) {
    setBusy(true);
    onError(null);
    try {
      await updatePet(pet.id, currentFields({ memorial: next, passedOn: next ? (date ?? '') : '' }));
      setMemorial(next);
      setPassedOn(next ? (date ?? '') : '');
      setConfirmingMemorial(false);
      onNotice(next ? `${pet.name} is remembered here whenever you need it.` : 'Memorial removed');
      await onDone();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not update');
    } finally {
      setBusy(false);
    }
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    const photo = photoRef.current?.files?.[0];
    if (photo) {
      if (!AVATAR_TYPES.includes(photo.type)) {
        onError('Pet photo must be a JPG, PNG, or WebP image.');
        return;
      }
    }
    setBusy(true);
    onError(null);
    try {
      await updatePet(pet.id, currentFields());
      if (photo) await uploadAvatar(pet.id, photo);
      onNotice('Profile saved');
      await onDone();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not save profile');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen-view screen-view--sheet">
      <nav className="screen-nav">
        <button className="screen-nav__back btn btn--link" type="button" onClick={onCancel}>
          ‹ {pet.name}
        </button>
        <span className="screen-nav__title">Edit Profile</span>
      </nav>
      <form className="form profile-form" onSubmit={handleSave}>
        <fieldset className="profile-form__group">
          <legend>Name &amp; photo</legend>
          <label>Pet name
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label>Species
            <select value={species} onChange={(e) => setSpecies(e.target.value)}>
              <option value="dog">Dog</option>
              <option value="cat">Cat</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label>
            New photo (optional · JPG, PNG · large photos are compressed automatically)
            <input ref={photoRef} type="file" accept="image/jpeg,image/png,image/webp" />
          </label>
        </fieldset>

        <p className="profile-form__hint subtle">Everything below is optional.</p>

        <fieldset className="profile-form__group">
          <legend>About</legend>
          <label>Breed
            <input value={breed} onChange={(e) => setBreed(e.target.value)} placeholder="e.g. Labrador Retriever" />
          </label>
          <label>Date of birth
            <input type="date" value={dob} onChange={(e) => setDob(e.target.value)} />
          </label>
          <label>Weight
            <input value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="e.g. 45 lbs" />
          </label>
          <label>Spayed / Neutered
            <select value={fixed} onChange={(e) => setFixed(e.target.value as '' | 'true' | 'false')}>
              <option value="">Unknown</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </label>
          <label>Microchip number
            <input value={microchip} onChange={(e) => setMicrochip(e.target.value)} placeholder="15-digit ID" />
          </label>
        </fieldset>

        <fieldset className="profile-form__group">
          <legend>Health notes</legend>
          <label>Known allergies
            <textarea value={allergies} onChange={(e) => setAllergies(e.target.value)} placeholder="e.g. Chicken, pollen" rows={2} />
          </label>
          <label>Behavior notes
            <textarea value={behavior} onChange={(e) => setBehavior(e.target.value)} placeholder="e.g. Reactive on leash, anxious around loud noises" rows={2} />
          </label>
          <label>Special instructions
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Needs medication twice daily, feed at 7am/6pm" rows={2} />
          </label>
        </fieldset>

        <fieldset className="profile-form__group">
          <legend>Contacts</legend>
          <label>Vet name
            <input value={vetName} onChange={(e) => setVetName(e.target.value)} placeholder="e.g. Dr. Smith at Riverside Vet" />
          </label>
          <label>Vet phone
            <input type="tel" value={vetPhone} onChange={(e) => setVetPhone(e.target.value)} placeholder="(555) 000-0000" />
          </label>
          <label>Emergency contact
            <input value={emergencyContact} onChange={(e) => setEmergencyContact(e.target.value)} placeholder="Name · phone number" />
          </label>
        </fieldset>

        <div className="actions">
          <button className="btn btn--primary" type="submit" disabled={busy || !name.trim()}>
            {busy ? 'Saving…' : 'Save profile'}
          </button>
          <button className="btn" type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>

        {/* Memorial — deliberately NOT in the danger zone: nothing is
            deleted. Records, photos, and the passport stay; reminders,
            stories, badges, Daily, and walks quietly stop. */}
        <fieldset className="profile-form__group">
          <legend>Memorial</legend>
          {memorial ? (
            <div className="memorial-state">
              <p className="memorial-state__line">
                🕊️ In loving memory{passedOn ? ` · ${formatDate(passedOn)}` : ''}
              </p>
              <p className="subtle">
                {pet.name}'s records and photos are kept right here. Reminders
                and stories no longer include {pet.name}.
              </p>
              <button
                type="button"
                className="btn btn--link"
                disabled={busy}
                onClick={() => void handleMemorial(false)}
              >
                Undo — marked by mistake
              </button>
            </div>
          ) : !confirmingMemorial ? (
            <button
              type="button"
              className="btn btn--link memorial-open"
              disabled={busy}
              onClick={() => setConfirmingMemorial(true)}
            >
              {pet.name} has passed away…
            </button>
          ) : (
            <div className="memorial-confirm">
              <p className="subtle">
                We're so sorry. Everything about {pet.name} stays saved — records,
                photos, milestones. Reminders and weekly stories will quietly stop
                mentioning {pet.name}. You can undo this anytime.
              </p>
              <label>
                Date (optional)
                <input
                  type="date"
                  value={passedOn}
                  onChange={(e) => setPassedOn(e.target.value)}
                />
              </label>
              <div className="actions">
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => { setConfirmingMemorial(false); setPassedOn(pet.passedOn ?? ''); }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={busy}
                  onClick={() => void handleMemorial(true, passedOn)}
                >
                  {busy ? 'Saving…' : 'Confirm'}
                </button>
              </div>
            </div>
          )}
        </fieldset>

        {onDeletePet && !pet.household && (
          <fieldset className="profile-form__group profile-form__group--danger">
            <legend>Danger zone</legend>
            {!confirmingDelete ? (
              <button
                type="button"
                className="btn btn--danger"
                disabled={busy}
                onClick={() => { setConfirmingDelete(true); setDeleteText(''); }}
              >
                Delete {pet.name}…
              </button>
            ) : (
              <div className="danger-confirm">
                <p className="danger-confirm__warning">
                  This permanently deletes {pet.name} — every record, medication,
                  daily history, weigh-in, and any shared passport link.
                  <strong> There is no undo.</strong>
                </p>
                <label>
                  Type <strong>{pet.name}</strong> to confirm
                  <input
                    value={deleteText}
                    onChange={(e) => setDeleteText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
                    placeholder={pet.name}
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    autoFocus
                  />
                </label>
                <div className="actions">
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => { setConfirmingDelete(false); setDeleteText(''); }}
                  >
                    Keep {pet.name}
                  </button>
                  <button
                    type="button"
                    className="btn btn--danger"
                    disabled={busy || !deleteArmed}
                    onClick={() => onDeletePet(pet.id)}
                  >
                    Delete forever
                  </button>
                </div>
              </div>
            )}
          </fieldset>
        )}
        {pet.household && (
          <p className="subtle">
            {pet.name} is a family pet — only the family owner can delete it.
          </p>
        )}
      </form>
    </div>
  );
}

// ---- present mode (full-screen swipeable carousel) ----

// The door moment leads with the paper the front desk actually asks for:
// current rabies certs first, then expired rabies, then everything else in
// its existing urgency order. Label-based (cats and dogs alike get rabies
// records) — a pet with no "rabies"-labeled record just keeps urgency order.
//
// Then dedupe by file identity: one AI-scanned visit summary commits as N
// records (Rabies, Bordetella, …) all backed by the same bytes — flipping
// through five copies of the same page helps nobody, so each file shows once
// (the first occurrence, i.e. under its most door-relevant label).
function presentOrder(docs: Doc[]): Doc[] {
  const isRabies = (d: Doc) => /rabies/i.test(d.label);
  const current = (d: Doc) => statusOf(d.expiry) !== 'overdue';
  const ordered = [
    ...docs.filter((d) => isRabies(d) && current(d)),
    ...docs.filter((d) => isRabies(d) && !current(d)),
    ...docs.filter((d) => !isRabies(d)),
  ];
  // Identity: ETag (content MD5) when the API sent one; filename+size for
  // door caches written before etag existed; a doc with neither (size 0 from
  // an old cache) is treated as unique rather than risk hiding a real record.
  const seen = new Set<string>();
  return ordered.filter((d) => {
    const key = d.etag
      ? `e:${d.etag}:${d.size}`
      : d.size
        ? `f:${d.filename}:${d.size}`
        : `id:${d.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function PresentScreen({
  pet,
  docs,
  onExit,
}: {
  pet: Pet;
  docs: Doc[];
  onExit: () => void;
}) {
  const ordered = presentOrder(docs);
  const [current, setCurrent] = useState(0);
  const slidesRef = useRef<HTMLDivElement>(null);

  // Dismiss on Escape key.
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onExit(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onExit]);

  // Lock body scroll while presenting.
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  function handleScroll() {
    const el = slidesRef.current;
    if (!el) return;
    setCurrent(Math.round(el.scrollLeft / el.clientWidth));
  }

  return (
    <div className="present" role="dialog" aria-label={`${pet.name}'s records`}>
      <button className="present__exit" onClick={onExit} aria-label="Exit presentation">✕</button>

      <div className="present__slides" ref={slidesRef} onScroll={handleScroll}>
        {ordered.map((doc) => {
          const isImage = IMAGE_EXTS.includes(extOf(doc.filename));
          const status = statusOf(doc.expiry);
          return (
            <div key={doc.id} className="present__slide">
              <div className="present__doc-header">
                <span className="present__doc-label">{doc.label}</span>
                <div className="present__doc-meta">
                  <StatusBadge expiry={doc.expiry} />
                  {doc.expiry && (
                    <span className="present__doc-expiry">
                      {status === 'overdue' ? 'Expired' : 'Expires'} {formatDate(doc.expiry)}
                    </span>
                  )}
                </div>
              </div>

              <div className="present__doc-content">
                {isImage ? (
                  <img
                    src={doc.url}
                    alt={doc.label}
                    className="present__doc-img"
                    loading="lazy"
                  />
                ) : (
                  <div className="present__pdf-card">
                    <span className="present__pdf-icon" aria-hidden="true">📄</span>
                    <p className="present__pdf-name">{doc.label}</p>
                    <a
                      href={doc.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn btn--primary btn--lg"
                    >
                      Open PDF ↗
                    </a>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="present__footer">
        <span className="present__pet-name">{pet.name}</span>
        {ordered.length > 1 && (
          <div className="present__dots" aria-hidden="true">
            {ordered.map((_, i) => (
              <span key={i} className={`present__dot${i === current ? ' present__dot--active' : ''}`} />
            ))}
          </div>
        )}
        {ordered.length > 1 && (
          <span className="present__counter">{current + 1} / {ordered.length}</span>
        )}
      </div>
    </div>
  );
}

// ---- photo confirm (swipe-right camera capture) ----
// Shown as soon as the hidden camera <input> returns a file. Save/Discard,
// then a pet picker only when there's more than one pet (skip straight to
// upload for a single-pet account). A 409 from the daily save cap — the
// ONLY place that limit is ever surfaced — closes this screen and shows up
// in the shared error banner, same as every other error path in this app.
// The native camera's own "Use Photo" screen already asked save-or-discard —
// asking again here would be a redundant extra tap (Mark, 2026-07-13). A
// single-pet account just needs a moment of "Saving…" feedback (auto-fires
// on mount); a multi-pet account only needs to answer "which pet," so that's
// the only interaction left. A ✕ stays as a pure cancel/escape hatch (e.g.
// the camera fired by accident), not framed as "discard this good photo."
function PhotoConfirmScreen({
  file,
  pets,
  saving,
  limitError,
  onSave,
  onUpgrade,
  onDiscard,
}: {
  file: File;
  pets: Pet[];
  saving: boolean;
  limitError: string | null;
  onSave: (petId: string) => void;
  onUpgrade: () => void;
  onDiscard: () => void;
}) {
  const [previewUrl] = useState(() => URL.createObjectURL(file));
  useEffect(() => () => URL.revokeObjectURL(previewUrl), [previewUrl]);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !saving) onDiscard();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onDiscard, saving]);

  const onlyPet = pets.length === 1 ? pets[0] : null;
  useEffect(() => {
    if (onlyPet && !saving) onSave(onlyPet.id);
    // Fire once, right when this single-pet screen mounts — not on every
    // `saving` flip (that would re-trigger the save after it completes).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="photo-confirm" role="dialog" aria-label={onlyPet ? 'Saving photo' : 'Save photo'}>
      {!saving && (
        <button className="photo-confirm__exit" onClick={onDiscard} aria-label="Cancel">
          ✕
        </button>
      )}
      <img src={previewUrl} alt="" className="photo-confirm__preview" />
      {limitError ? (
        <div className="photo-confirm__picker">
          <p className="photo-confirm__picker-title">{limitError}</p>
          <button type="button" className="btn btn--primary" onClick={onUpgrade}>
            Upgrade →
          </button>
        </div>
      ) : onlyPet ? (
        <p className="photo-confirm__status">Saving…</p>
      ) : (
        <div className="photo-confirm__picker">
          <p className="photo-confirm__picker-title">Save to which pet?</p>
          <div className="photo-confirm__picker-grid">
            {pets.map((pet) => (
              <button
                key={pet.id}
                type="button"
                className="photo-confirm__picker-pet"
                onClick={() => onSave(pet.id)}
                disabled={saving}
              >
                <PetAvatar pet={pet} size={56} />
                <span>{pet.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- walk tracking (the 🚶 header button — GPS session, then a multi-pet
// picker since one walk can cover more than one pet) ----

// Pure math, no dependency — great-circle distance between two GPS fixes.
function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000; // Earth radius, meters
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// Foreground-only tracking (no "Always" location permission, no background
// App Store review complexity — confirmed with Mark, 2026-07-13). GPS fixes
// closer than 3m apart are ignored as jitter rather than counted as movement.
//
// Tracking state lives HERE, in a hook called unconditionally from Dashboard
// (2026-07-15) — not inside WalkScreen as local state, which is what made
// the walk screen impossible to leave without killing the walk (unmounting
// WalkScreen used to run the GPS-watch cleanup). Since Dashboard never
// unmounts during normal in-app navigation, lifting the state here means a
// walk keeps tracking in the background regardless of what's on screen —
// WalkScreen (below) becomes a thin, safely-mountable/unmountable view over
// whatever this hook is doing. 'idle' is the true at-rest state: no
// permission requested, no GPS watch, until beginWalk() is called.
function useWalkTracker(pets: Pet[], onSaved: (msg: string) => void, onError: (msg: string | null) => void) {
  // idle = no walk exists · acquiring = permission/GPS warm-up · ready =
  // armed, nothing recorded yet (Start hasn't been pressed) · active ⇄
  // paused (fitness-app convention: you pause first, then hold End to
  // really stop) · summary = ended, pick pet(s), Save or Discard.
  const [phase, setPhase] = useState<'idle' | 'acquiring' | 'ready' | 'active' | 'paused' | 'summary'>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [distanceMeters, setDistanceMeters] = useState(0);
  const [paceLabel, setPaceLabel] = useState('—');
  const [selectedPetIds, setSelectedPetIds] = useState<Set<string>>(new Set());
  // Family-tagged walks: who else was on this walk, from the household's
  // participant list (fetched fresh when the walk ends — solo accounts get
  // an empty list back and the picker just doesn't render).
  const [participants, setParticipants] = useState<string[]>([]);
  const [selectedMemberEmails, setSelectedMemberEmails] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [holdingEnd, setHoldingEnd] = useState(false);
  const startedAtRef = useRef<number | null>(null);
  const endedAtRef = useRef<number | null>(null);
  const lastCoordRef = useRef<{ lat: number; lon: number } | null>(null);
  const watchIdRef = useRef<string | null>(null);
  // Moving time only: accumulated across active segments, frozen while
  // paused. segmentStartRef marks the current active segment's start.
  const activeMsRef = useRef(0);
  const segmentStartRef = useRef<number | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const holdTimerRef = useRef<number | null>(null);
  // Rolling-window pace samples: {t, dist} pairs, cumulative distance at
  // time t, pruned to the last PACE_WINDOW_MS. Recomputed every tick (not
  // just on new GPS fixes) so pace decays toward '—' if movement stops —
  // see the pace-recompute block in the elapsed-timer effect below.
  const paceSamplesRef = useRef<{ t: number; dist: number }[]>([]);
  const PACE_WINDOW_MS = 30_000;
  const PACE_MIN_SPAN_MS = 10_000;
  const PACE_MIN_MILES = 0.015; // ~79 ft — filters GPS-noise "movement"

  function resetPace() {
    paceSamplesRef.current = [];
    setPaceLabel('—');
  }

  // True unmount safety only (e.g. logout tears down Dashboard entirely) —
  // discardWalk() below is the normal, explicit way tracking stops.
  useEffect(() => {
    return () => {
      if (isNative) void backgroundWalkEnd();
      else if (watchIdRef.current) void Geolocation.clearWatch({ id: watchIdRef.current });
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (phase !== 'active') return;
    const timer = setInterval(() => {
      if (segmentStartRef.current !== null) {
        setElapsedMs(activeMsRef.current + (Date.now() - segmentStartRef.current));
      }
      if (isNative) {
        // Native tracking runs entirely in BackgroundWalkPlugin (it keeps
        // recording via CLLocationManager even while the app is backgrounded
        // or the screen is locked) — poll its accumulated distance every
        // tick instead of listening for JS-side GPS fixes, which stop
        // arriving the moment iOS suspends the webview. This is also what
        // makes the displayed number catch up correctly the instant the app
        // returns to the foreground, without a separate appStateChange
        // listener — the interval just keeps ticking with GPS truth.
        void backgroundWalkSnapshot().then((meters) => {
          setDistanceMeters(meters);
          paceSamplesRef.current.push({ t: Date.now(), dist: meters });
        });
      }
      // Pace: average speed over the last PACE_WINDOW_MS, not since Start.
      // The old since-Start cumulative average never recovered from early
      // GPS noise (Mark, 2026-07-15) — a short rolling window instead
      // reflects CURRENT walking speed, same idea as Strava/Apple Fitness'
      // "current pace", and naturally settles toward '—' if you stop moving
      // since no new samples arrive to refresh the window.
      const now = Date.now();
      const cutoff = now - PACE_WINDOW_MS;
      const samples = paceSamplesRef.current;
      while (samples.length > 1 && samples[0].t < cutoff) samples.shift();
      if (samples.length >= 2) {
        const spanMs = now - samples[0].t;
        const spanMiles = (samples[samples.length - 1].dist - samples[0].dist) / 1609.344;
        if (spanMs >= PACE_MIN_SPAN_MS && spanMiles >= PACE_MIN_MILES) {
          const minPerMi = spanMs / 60000 / spanMiles;
          if (minPerMi <= 99) {
            const m = Math.floor(minPerMi);
            const s = Math.round((minPerMi - m) * 60);
            setPaceLabel(`${m}:${String(s).padStart(2, '0')}`);
          } else setPaceLabel('—');
        } else setPaceLabel('—');
      } else setPaceLabel('—');
    }, 1000);
    return () => clearInterval(timer);
  }, [phase]);

  // Called when the user taps the Walk tab with no walk in progress.
  // Resolves false (after calling onError) on permission/GPS failure — the
  // caller decides what to do with the walk-screen UI in that case; this
  // hook only owns tracking state, never screen visibility.
  async function beginWalk(): Promise<boolean> {
    if (phaseRef.current !== 'idle') return true; // a session already exists
    setPhase('acquiring');
    try {
      if (isNative) {
        const status = await requestAlwaysLocation();
        if (status === 'denied') {
          onError("Location access is needed to track a walk — check Settings and try again.");
          setPhase('idle');
          return false;
        }
        // Warm up the GPS now (mirrors the web path's early watchPosition
        // below) so the first fix isn't cold when Start is pressed —
        // handleStart() calls start() again, which resets the accumulated
        // distance, so nothing from this warm-up period is ever counted.
        await backgroundWalkStart();
        setPhase('ready');
        return true;
      }
      let perm = await Geolocation.checkPermissions();
      if (perm.location !== 'granted') perm = await Geolocation.requestPermissions();
      if (perm.location !== 'granted') {
        onError("Location access is needed to track a walk — check Settings and try again.");
        setPhase('idle');
        return false;
      }
      // Start the GPS watch now so the fix is warm by the time Start is
      // pressed — but only count movement while actually active (the ready
      // screen records nothing; pauses don't accumulate distance either).
      const id = await Geolocation.watchPosition({ enableHighAccuracy: true }, (pos) => {
        if (!pos) return;
        const { latitude, longitude } = pos.coords;
        if (phaseRef.current !== 'active') {
          lastCoordRef.current = null;
          return;
        }
        if (lastCoordRef.current) {
          const d = haversineMeters(lastCoordRef.current.lat, lastCoordRef.current.lon, latitude, longitude);
          if (d > 3) {
            setDistanceMeters((prev) => {
              const next = prev + d;
              paceSamplesRef.current.push({ t: Date.now(), dist: next });
              return next;
            });
          }
        }
        lastCoordRef.current = { lat: latitude, lon: longitude };
      });
      watchIdRef.current = id;
      setPhase('ready');
      return true;
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not start location tracking');
      setPhase('idle');
      return false;
    }
  }

  function handleStart() {
    hapticTap();
    startedAtRef.current = Date.now();
    segmentStartRef.current = Date.now();
    lastCoordRef.current = null;
    resetPace();
    setPhase('active');
    // Resets the plugin's accumulated distance to zero — anything counted
    // during the 'ready' warm-up (beginWalk's backgroundWalkStart call)
    // is discarded, matching lastCoordRef being cleared above for web.
    if (isNative) void backgroundWalkStart();
  }

  function handlePause() {
    hapticTap();
    if (segmentStartRef.current !== null) {
      activeMsRef.current += Date.now() - segmentStartRef.current;
      segmentStartRef.current = null;
    }
    setElapsedMs(activeMsRef.current);
    setPhase('paused');
    if (isNative) void backgroundWalkPause();
  }

  function handleResume() {
    hapticTap();
    segmentStartRef.current = Date.now();
    lastCoordRef.current = null; // don't count the distance jumped while paused
    resetPace(); // don't let the paused gap register as near-zero speed
    setPhase('active');
    if (isNative) void backgroundWalkResume();
  }

  // End Walk is hold-to-confirm (1.5s) from the paused state — a stray tap
  // can't end the walk, matching the pause-then-hold-stop convention.
  const HOLD_TO_END_MS = 1500;
  function startEndHold() {
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    setHoldingEnd(true);
    holdTimerRef.current = window.setTimeout(() => {
      holdTimerRef.current = null;
      setHoldingEnd(false);
      void handleEndWalk();
    }, HOLD_TO_END_MS);
  }
  function cancelEndHold() {
    setHoldingEnd(false);
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }

  async function handleEndWalk() {
    hapticSuccess();
    if (isNative) {
      // The plugin is the source of truth for distance on native (it kept
      // recording through any backgrounding) — read its final number rather
      // than trusting whatever the last poll happened to leave in state.
      setDistanceMeters(await backgroundWalkEnd());
    } else if (watchIdRef.current) {
      void Geolocation.clearWatch({ id: watchIdRef.current });
    }
    watchIdRef.current = null;
    endedAtRef.current = Date.now();
    setPhase('summary');
    if (pets.length === 1) setSelectedPetIds(new Set([pets[0].id]));
    getHousehold()
      .then((h) => setParticipants(h.participants))
      .catch(() => setParticipants([]));
  }

  function togglePet(petId: string) {
    setSelectedPetIds((prev) => {
      const next = new Set(prev);
      if (next.has(petId)) next.delete(petId);
      else next.add(petId);
      return next;
    });
  }

  function toggleMember(email: string) {
    setSelectedMemberEmails((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
  }

  // Resets everything so a future beginWalk() starts clean — same as the
  // old "fresh component mount" behavior, now explicit since the hook
  // persists across walks instead of remounting each time.
  function resetToIdle() {
    watchIdRef.current = null;
    startedAtRef.current = null;
    endedAtRef.current = null;
    lastCoordRef.current = null;
    activeMsRef.current = 0;
    segmentStartRef.current = null;
    resetPace();
    setElapsedMs(0);
    setDistanceMeters(0);
    setSelectedPetIds(new Set());
    setParticipants([]);
    setSelectedMemberEmails(new Set());
    setPhase('idle');
  }

  async function handleSave() {
    if (selectedPetIds.size === 0 || !startedAtRef.current || !endedAtRef.current) return;
    setSaving(true);
    try {
      const res = await createWalk(
        [...selectedPetIds],
        new Date(startedAtRef.current).toISOString(),
        new Date(endedAtRef.current).toISOString(),
        distanceMeters,
        [...selectedMemberEmails],
      );
      // One workout per walk regardless of how many pets came along. First
      // ever call shows the iOS Health permission sheet, after the toast.
      saveWalkToAppleHealth(startedAtRef.current, endedAtRef.current, distanceMeters);
      // "Rex burned ≈77 kcal" when the server could estimate it (dogs with a
      // logged weight); plain save message otherwise.
      const burns = Object.entries(res.kcalByPet ?? {})
        .map(([petId, kcal]) => `${pets.find((p) => p.id === petId)?.name ?? 'Pet'} ≈${kcal} kcal`)
        .join(' · ');
      const msg = burns ? `Walk saved. ${burns} burned.` : 'Walk saved.';
      resetToIdle();
      setSaving(false);
      onSaved(msg);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not save the walk');
      setSaving(false);
    }
  }

  // The only other way tracking stops (besides a successful Save) — Cancel
  // (ready, nothing recorded yet) and Discard walk (summary, recorded but
  // not saved) both call this.
  function discardWalk() {
    if (isNative) void backgroundWalkEnd();
    else if (watchIdRef.current) void Geolocation.clearWatch({ id: watchIdRef.current });
    resetToIdle();
  }

  return {
    phase, elapsedMs, distanceMeters, paceLabel, selectedPetIds, saving, holdingEnd,
    participants, selectedMemberEmails,
    beginWalk, handleStart, handlePause, handleResume,
    startEndHold, cancelEndHold, handleSave, discardWalk, togglePet, toggleMember,
  };
}

type WalkTracker = ReturnType<typeof useWalkTracker>;

// Presentational now (2026-07-15) — every field/handler comes from the
// `walk` hook result (see useWalkTracker above), so mounting/unmounting
// this component (driven by Dashboard's walkScreenOpen) has zero effect on
// tracking. onClose just hides the screen; onOpenHistory hides it AND
// navigates — both leave the walk running. Only the Cancel/Discard buttons
// actually stop tracking (via walk.discardWalk()).
function WalkScreen({
  pets,
  walk,
  onClose,
  onOpenHistory,
}: {
  pets: Pet[];
  walk: WalkTracker;
  onClose: () => void;
  onOpenHistory: () => void;
}) {
  const {
    phase, elapsedMs, distanceMeters, paceLabel, selectedPetIds, saving, holdingEnd,
    participants, selectedMemberEmails,
    handleStart, handlePause, handleResume, startEndHold, cancelEndHold,
    handleSave, discardWalk, togglePet, toggleMember,
  } = walk;

  function handleCancel() {
    discardWalk();
    onClose();
  }

  const miles = (distanceMeters / 1609.344).toFixed(2);

  // No ✕ anywhere: it never said whether it cancelled, logged, or minimized
  // (Mark, 2026-07-13). Ready has an explicit Cancel (nothing recorded yet);
  // once tracking, Pause → hold End → Save/Discard is how a walk truly
  // ends. Minimize (2026-07-15) is the third, explicitly-labeled option —
  // same "say exactly what it does" lesson that killed the old ✕ — for
  // stepping away without ending anything (e.g. snapping a photo mid-walk).
  return (
    <div className="walk-screen" role="dialog" aria-label="Walk tracking">
      <button type="button" className="walk-screen__minimize" onClick={onClose}>
        ⌄ Minimize
      </button>
      {phase === 'acquiring' && (
        <div className="walk-screen__ready">
          <span className="walk-screen__icon" aria-hidden="true">🛰️</span>
          <p>Finding your location…</p>
        </div>
      )}
      {(phase === 'ready' || phase === 'active' || phase === 'paused') && (
        <div className="walk-screen__active">
          {phase === 'paused' && <div className="walk-screen__paused-badge">Paused</div>}
          <div className="walk-screen__stat">{formatElapsed(elapsedMs)}</div>
          <div className="walk-screen__stat-label">Elapsed</div>
          <div className="walk-screen__stat">{miles} mi</div>
          <div className="walk-screen__stat-label">Distance</div>
          <div className="walk-screen__stat walk-screen__stat--minor">{paceLabel}</div>
          <div className="walk-screen__stat-label">Pace /mi</div>
          {phase === 'ready' && (
            <>
              <button type="button" className="btn btn--primary btn--lg" onClick={handleStart}>
                Start Walk
              </button>
              <div className="walk-screen__ready-links">
                <button
                  type="button"
                  className="btn btn--link walk-screen__discard"
                  onClick={handleCancel}
                >
                  Cancel
                </button>
                <button type="button" className="btn btn--link" onClick={onOpenHistory}>
                  Walk history →
                </button>
              </div>
            </>
          )}
          {phase === 'active' && (
            <button type="button" className="btn btn--primary btn--lg" onClick={handlePause}>
              Pause
            </button>
          )}
          {phase === 'paused' && (
            <div className="walk-screen__paused-controls">
              <button type="button" className="btn btn--primary btn--lg" onClick={handleResume}>
                Resume
              </button>
              <button
                type="button"
                className={`btn btn--lg walk-screen__end-hold${holdingEnd ? ' walk-screen__end-hold--holding' : ''}`}
                onPointerDown={startEndHold}
                onPointerUp={cancelEndHold}
                onPointerLeave={cancelEndHold}
                onPointerCancel={cancelEndHold}
                onContextMenu={(e) => e.preventDefault()}
              >
                <span className="walk-screen__end-hold-fill" aria-hidden="true" />
                <span className="walk-screen__end-hold-label">Hold to End</span>
              </button>
            </div>
          )}
        </div>
      )}
      {phase === 'summary' && (
        <div className="walk-screen__summary">
          <p className="walk-screen__summary-stats">
            {formatElapsed(elapsedMs)} · {miles} mi
          </p>
          <p className="photo-confirm__picker-title">Who was on this walk?</p>
          <div className="photo-confirm__picker-grid">
            {pets.map((pet) => (
              <button
                key={pet.id}
                type="button"
                className={`walk-screen__picker-pet${selectedPetIds.has(pet.id) ? ' walk-screen__picker-pet--selected' : ''}`}
                onClick={() => togglePet(pet.id)}
                disabled={saving}
              >
                <PetAvatar pet={pet} size={56} />
                <span>{pet.name}</span>
                {selectedPetIds.has(pet.id) && (
                  <span className="walk-screen__picker-check" aria-hidden="true">✓</span>
                )}
              </button>
            ))}
          </div>
          {participants.length > 0 && (
            <>
              <p className="photo-confirm__picker-title">Walked with a family member?</p>
              <div className="photo-confirm__picker-grid">
                {participants.map((email) => (
                  <button
                    key={email}
                    type="button"
                    className={`walk-screen__picker-member${selectedMemberEmails.has(email) ? ' walk-screen__picker-pet--selected' : ''}`}
                    onClick={() => toggleMember(email)}
                    disabled={saving}
                  >
                    <span>{email}</span>
                    {selectedMemberEmails.has(email) && (
                      <span className="walk-screen__picker-check" aria-hidden="true">✓</span>
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
          <button
            type="button"
            className="btn btn--primary"
            onClick={handleSave}
            disabled={saving || selectedPetIds.size === 0}
          >
            {saving ? 'Saving…' : 'Save Walk'}
          </button>
          <button
            type="button"
            className="btn btn--link walk-screen__discard"
            onClick={handleCancel}
            disabled={saving}
          >
            Discard walk
          </button>
        </div>
      )}
    </div>
  );
}

// Floating indicator (2026-07-15) shown whenever a walk exists but the full
// screen isn't up — the whole point of minimizing: proof the walk is still
// tracking while you're off taking a photo or checking Daily. Tap to reopen.
function WalkMiniBar({ walk, onExpand }: { walk: WalkTracker; onExpand: () => void }) {
  const { phase, elapsedMs, distanceMeters } = walk;
  const miles = (distanceMeters / 1609.344).toFixed(2);
  const label =
    phase === 'summary'
      ? '✅ Walk ended — tap to save'
      : phase === 'paused'
        ? `⏸ Paused · ${formatElapsed(elapsedMs)} · ${miles} mi`
        : phase === 'active'
          ? `🚶 ${formatElapsed(elapsedMs)} · ${miles} mi`
          : '🚶 Walk ready — tap to resume';
  return (
    <button
      type="button"
      className="walk-mini-bar"
      onClick={() => { hapticTap(); onExpand(); }}
      aria-label="Walk in progress — tap to return to the walk screen"
    >
      <span className="walk-mini-bar__label">{label}</span>
      <span className="walk-mini-bar__chevron" aria-hidden="true">⌃</span>
    </button>
  );
}

// ---- achievements (swipe-left from overview) ----
// Live rolling stat cards computed server-side (GET /achievements), each a
// button pushing to that card's badge ladder (BadgeScreen below). Cats get
// no walk cards. An earned-count dot on the card hints there's something
// behind the tap. "Walk history" lives on the Walk screen itself now
// (2026-07-14) — it belongs where you actually go to walk your dog.
function AchievementsAllScreen({
  accessiblePetIds,
  onError,
  onLoaded,
  onOpenBadges,
}: {
  accessiblePetIds: string[];
  onError: (msg: string | null) => void;
  onLoaded: (pets: PetAchievements[]) => void;
  onOpenBadges: (petId: string, cardId: string) => void;
}) {
  const [pets, setPets] = useState<PetAchievements[] | null>(null);
  const [leaderboard, setLeaderboard] = useState<WalkLeaderboard | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await getAchievements();
        if (!cancelled) {
          const allowed = new Set(accessiblePetIds);
          const visiblePets = res.pets.filter((pet) => allowed.has(pet.petId));
          setPets(visiblePets);
          setLeaderboard(res.leaderboard);
          onLoaded(visiblePets); // cached for the badge drill-down screen
        }
      } catch (err) {
        if (!cancelled) onError(err instanceof Error ? err.message : 'Could not load achievements');
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onError]);

  return (
    <div className="albums-all">
      <h1 className="large-title">Achievements</h1>
      {leaderboard && leaderboard.members.length >= 2 && (
        <FamilyLeaderboard board={leaderboard} />
      )}
      {pets === null ? (
        <p className="albums-all__loading">Loading…</p>
      ) : pets.length === 0 ? (
        <p className="albums-all__loading">Add a pet to start earning achievements.</p>
      ) : (
        pets.map((pet) => (
          <section key={pet.petId} className="albums-all__pet">
            <div className="albums-all__pet-header">
              <span>{pet.petName}</span>
            </div>
            <div className="achievements__grid">
              {pet.cards.map((card) => {
                const earned = card.badges.filter((b) => b.earnedAt).length;
                return (
                  <button
                    key={card.id}
                    type="button"
                    className="achievements__card"
                    onClick={() => onOpenBadges(pet.petId, card.id)}
                  >
                    <span className="achievements__card-icon" aria-hidden="true">{card.icon}</span>
                    <span className="achievements__card-value">{card.value}</span>
                    <span className="achievements__card-label">{card.label}</span>
                    <span className="achievements__card-badges">
                      🏅 {earned}/{card.badges.length}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

// One card's badge ladder: earned trophies (congrats line + date, "New!"
// ribbon while fresh) on top, still-locked goals dimmed below. Earned state
// is server-persisted and never un-earns — the card's live number can drop
// (e.g. a deleted walk) while the trophies stay.
function BadgeScreen({
  petId,
  cardId,
  preloaded,
  onBack,
  onError,
}: {
  petId: string;
  cardId: string;
  preloaded: PetAchievements[] | null;
  onBack: () => void;
  onError: (msg: string | null) => void;
}) {
  // Normally served straight from the achievements screen's fetch (this is
  // always reached by tapping a card there); the fallback fetch only runs if
  // that cache is somehow empty (e.g. after an error on the parent screen).
  const [pets, setPets] = useState<PetAchievements[] | null>(preloaded);

  useEffect(() => {
    if (preloaded) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await getAchievements();
        if (!cancelled) setPets(res.pets);
      } catch (err) {
        if (!cancelled) onError(err instanceof Error ? err.message : 'Could not load badges');
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onError]);

  const pet = pets?.find((p) => p.petId === petId);
  const card = pet?.cards.find((c) => c.id === cardId);
  const earned = card?.badges.filter((b) => b.earnedAt) ?? [];
  const locked = card?.badges.filter((b) => !b.earnedAt) ?? [];
  // daysUntil() is negative for past dates: earned 2 days ago -> -2.
  const isNew = (earnedAt: string) => -daysUntil(earnedAt) < ACHIEVEMENTS_CONFIG.NEW_BADGE_RIBBON_DAYS;

  return (
    <div className="screen-view">
      <nav className="screen-nav">
        <button className="screen-nav__back btn btn--link" type="button" onClick={onBack}>
          ‹ Achievements
        </button>
        <span className="screen-nav__title">Badges</span>
      </nav>
      <div className="screen-view__body">
        {pets === null ? (
          <p className="albums-all__loading">Loading…</p>
        ) : !pet || !card ? (
          <p className="albums-all__loading">Couldn't find that achievement.</p>
        ) : (
          <div className="badges">
            <div className="badges__hero">
              <span className="badges__hero-icon" aria-hidden="true">{card.icon}</span>
              <div>
                <h1 className="badges__hero-title">{card.label}</h1>
                <p className="badges__hero-sub">
                  {pet.petName} · now: {card.value} · {earned.length} of {card.badges.length} badges earned
                </p>
              </div>
            </div>

            <h2 className="badges__section-title">Earned</h2>
            {earned.length === 0 ? (
              <p className="badges__empty">Nothing earned yet — the first badge is the easiest one.</p>
            ) : (
              <ul className="badges__list">
                {earned.map((b) => (
                  <li key={b.id} className="badge-row badge-row--earned">
                    <span className="badge-row__icon" aria-hidden="true">{b.icon}</span>
                    <div className="badge-row__text">
                      <span className="badge-row__name">
                        {b.name}
                        {b.earnedAt && isNew(b.earnedAt) && <span className="badge-row__new">New!</span>}
                      </span>
                      <span className="badge-row__desc">🎉 {b.congrats}</span>
                      {b.earnedAt && <span className="badge-row__date">Earned {formatDate(b.earnedAt)}</span>}
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {locked.length > 0 && (
              <>
                <h2 className="badges__section-title">Still to earn</h2>
                <ul className="badges__list">
                  {locked.map((b) => (
                    <li key={b.id} className="badge-row badge-row--locked">
                      <span className="badge-row__icon" aria-hidden="true">{b.icon}</span>
                      <div className="badge-row__text">
                        <span className="badge-row__name">{b.name}</span>
                        <span className="badge-row__desc">{b.description}</span>
                      </div>
                      <span className="badge-row__lock" aria-hidden="true">🔒</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- family walk leaderboard (Achievements screen, households only) ----
// "Who's winning the week": ranked by miles (walk count breaks ties), a bar
// per member scaled to the leader. Only rendered when the household actually
// has 2+ people — a solo leaderboard is just a stat. Plain rank numbers, no
// medals/trophy — Mark decluttered the icons 2026-07-13; the bars carry the
// competitive read.
function FamilyLeaderboard({ board }: { board: WalkLeaderboard }) {
  const maxMiles = Math.max(...board.members.map((m) => m.miles), 0.1);
  const displayName = (email: string) =>
    email === board.me ? 'You' : email.split('@')[0];
  return (
    <section className="leaderboard">
      <div className="leaderboard__header">
        <span className="leaderboard__title">Family walk-off</span>
        <span className="leaderboard__label">{board.label}</span>
      </div>
      {board.members.map((m, i) => (
        <div
          key={m.email}
          className={`leaderboard__row${i === 0 && m.miles > 0 ? ' leaderboard__row--leader' : ''}`}
        >
          <span className="leaderboard__medal" aria-hidden="true">
            {m.miles > 0 || m.walks > 0 ? `${i + 1}.` : '–'}
          </span>
          <div className="leaderboard__bar-wrap">
            <span className="leaderboard__name">{displayName(m.email)}</span>
            <div
              className="leaderboard__bar"
              style={{ width: `${Math.max((m.miles / maxMiles) * 100, 2)}%` }}
            />
          </div>
          <span className="leaderboard__stats">
            {m.miles} mi · {m.walks} walk{m.walks === 1 ? '' : 's'}
          </span>
        </div>
      ))}
    </section>
  );
}

// ---- walk history (from the Achievements screen) ----
// Every pool walk, any age, newest first, grouped by day — with per-walk
// delete (two-tap inline confirm) so an accidental start or a tracker left
// running in the car can be scrubbed. Deleting recomputes the achievement
// card numbers server-side on the next visit; earned badges stay (trophy
// semantics, deliberate).
function WalkHistoryScreen({
  pets,
  onBack,
  onError,
  onNotice,
}: {
  pets: Pet[];
  onBack: () => void;
  onError: (msg: string | null) => void;
  onNotice: (msg: string) => void;
}) {
  const [walks, setWalks] = useState<WalkRecord[] | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await listWalks();
        if (!cancelled) setWalks(res.walks);
      } catch (err) {
        if (!cancelled) onError(err instanceof Error ? err.message : 'Could not load walks');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onError]);

  async function handleDelete(id: string) {
    setBusyId(id);
    try {
      await deleteWalk(id);
      setWalks((prev) => (prev ?? []).filter((w) => w.id !== id));
      onNotice('Walk deleted.');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not delete the walk');
    } finally {
      setBusyId(null);
      setConfirmId(null);
    }
  }

  const petName = (id: string) => pets.find((p) => p.id === id)?.name ?? 'a pet';
  const byDay = new Map<string, WalkRecord[]>();
  for (const w of walks ?? []) {
    const day = toYMD(new Date(w.startedAt));
    byDay.set(day, [...(byDay.get(day) ?? []), w]);
  }

  return (
    <div className="screen-view">
      <nav className="screen-nav">
        <button className="screen-nav__back btn btn--link" type="button" onClick={onBack}>
          ‹ Achievements
        </button>
        <span className="screen-nav__title">Walk history</span>
      </nav>
      <div className="screen-view__body">
        {walks === null ? (
          <p className="albums-all__loading">Loading…</p>
        ) : walks.length === 0 ? (
          <p className="albums-all__loading">No walks logged yet.</p>
        ) : (
          [...byDay.entries()].map(([day, dayWalks]) => (
            <section key={day} className="walk-history__day">
              <h2 className="badges__section-title">{formatDate(day)}</h2>
              <ul className="walk-history__list">
                {dayWalks.map((w) => (
                  <li key={w.id} className="walk-history__row">
                    <div className="walk-history__info">
                      <span className="walk-history__stats">
                        {(w.distanceMeters / 1609.344).toFixed(2)} mi ·{' '}
                        {formatElapsed(Date.parse(w.endedAt) - Date.parse(w.startedAt))}
                        {' · '}
                        {new Date(w.startedAt).toLocaleTimeString(undefined, {
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </span>
                      <span className="walk-history__meta">
                        {w.petIds.map(petName).join(', ')}
                        {(() => {
                          const kcal = Object.values(w.kcalByPet ?? {}).reduce((a, b) => a + b, 0);
                          return kcal > 0 ? ` · ≈${kcal} kcal` : '';
                        })()}
                        {w.by ? ` · by ${w.by.split('@')[0]}` : ''}
                      </span>
                    </div>
                    {confirmId === w.id ? (
                      <span className="walk-history__confirm">
                        <button
                          type="button"
                          className="btn btn--danger btn--sm"
                          disabled={busyId === w.id}
                          onClick={() => void handleDelete(w.id)}
                        >
                          {busyId === w.id ? 'Deleting…' : 'Delete?'}
                        </button>
                        <button
                          type="button"
                          className="btn btn--link btn--sm"
                          disabled={busyId === w.id}
                          onClick={() => setConfirmId(null)}
                        >
                          Keep
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="btn btn--link walk-history__delete"
                        aria-label="Delete this walk"
                        onClick={() => setConfirmId(w.id)}
                      >
                        🗑
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

// ---- albums (swipe-right from overview) ----
// v1 scope, deliberately simple: one section per pet, a thumbnail grid,
// tapping a thumbnail opens the full-screen viewer below. Mark flagged the
// presentation as likely needing another pass once he sees it — this favors
// a working mechanism over polish, same call as the rest of this session.
function AlbumsAllScreen({
  pets,
  onError,
  onNotice,
  onAddPet,
  onOpenPet,
}: {
  pets: Pet[];
  onError: (msg: string | null) => void;
  onNotice: (msg: string) => void;
  onAddPet: () => void;
  onOpenPet: (petId: string) => void;
}) {
  const [byPet, setByPet] = useState<Record<string, Photo[]>>({});
  const [loading, setLoading] = useState(true);
  const [viewer, setViewer] = useState<{ petId: string; index: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const entries = await Promise.all(
          pets.map(async (pet) => [pet.id, (await listPhotos(pet.id)).photos] as const),
        );
        if (!cancelled) setByPet(Object.fromEntries(entries));
      } catch (err) {
        if (!cancelled) onError(err instanceof Error ? err.message : 'Could not load albums');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // pets.length, not the pets array itself — a new array identity from an
    // unrelated reload (e.g. after saving a doc) shouldn't re-fetch every
    // pet's photos again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pets.length]);

  async function handleDelete(petId: string, photoId: string) {
    try {
      await deletePhoto(petId, photoId);
      setByPet((prev) => ({
        ...prev,
        [petId]: (prev[petId] ?? []).filter((p) => p.id !== photoId),
      }));
      onNotice('Photo deleted');
      setViewer(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not delete the photo');
    }
  }

  if (pets.length === 0) {
    return (
      <div className="empty-overview">
        <span className="empty-state__icon" aria-hidden="true">🐾</span>
        <p>Albums start with a pet. Add yours to get going.</p>
        <button className="btn btn--primary" onClick={onAddPet}>
          Add your first pet
        </button>
      </div>
    );
  }

  const viewerPet = viewer ? pets.find((p) => p.id === viewer.petId) : undefined;
  const viewerPhotos = viewer ? (byPet[viewer.petId] ?? []) : [];

  return (
    <div className="albums-all">
      <h1 className="large-title">Albums</h1>
      {loading ? (
        <p className="albums-all__loading">Loading…</p>
      ) : (
        pets.map((pet) => {
          const photos = byPet[pet.id] ?? [];
          // Capped preview — dozens of photos would otherwise overwhelm the
          // first screen (Mark, 2026-07-13). "See all" pushes to a per-pet
          // screen with the full set grouped by day.
          const preview = photos.slice(0, ALBUM_PREVIEW_COUNT);
          return (
            <section key={pet.id} className="albums-all__pet">
              <div className="albums-all__pet-header">
                <PetAvatar pet={pet} size={40} />
                <span>{pet.name}</span>
                <span className="albums-all__pet-count">
                  {photos.length === 0 ? 'No photos yet' : `${photos.length} photo${photos.length === 1 ? '' : 's'}`}
                </span>
              </div>
              {preview.length > 0 && (
                <div className="albums-all__grid">
                  {preview.map((photo, i) => (
                    <button
                      key={photo.id}
                      type="button"
                      className="albums-all__thumb"
                      onClick={() => setViewer({ petId: pet.id, index: i })}
                    >
                      <img src={photo.url} alt="" loading="lazy" />
                    </button>
                  ))}
                </div>
              )}
              {photos.length > ALBUM_PREVIEW_COUNT && (
                <button
                  type="button"
                  className="btn btn--link albums-all__see-all"
                  onClick={() => onOpenPet(pet.id)}
                >
                  See all {photos.length} photos →
                </button>
              )}
            </section>
          );
        })
      )}
      {viewer && viewerPet && viewerPhotos.length > 0 && (
        <PhotoViewerScreen
          pet={viewerPet}
          photos={viewerPhotos.slice(0, ALBUM_PREVIEW_COUNT)}
          startIndex={viewer.index}
          onExit={() => setViewer(null)}
          onDelete={(photoId) => handleDelete(viewer.petId, photoId)}
        />
      )}
    </div>
  );
}

// Groups a (newest-first) photo list into day buckets, day-newest-first —
// Map preserves insertion order, so no separate sort is needed as long as
// the input is already newest-first (which GET /pets/{petId}/photos returns).
function groupPhotosByDay(photos: Photo[]): { day: string; photos: Photo[] }[] {
  const map = new Map<string, Photo[]>();
  for (const photo of photos) {
    const day = toYMD(new Date(photo.uploadedAt));
    if (!map.has(day)) map.set(day, []);
    map.get(day)!.push(photo);
  }
  return [...map.entries()].map(([day, dayPhotos]) => ({ day, photos: dayPhotos }));
}

// One pet's full album, reached via "See all" from AlbumsAllScreen — the
// day-grouped view a dozens-of-photos collection actually needs (v1's
// combined overview screen deliberately only shows a capped preview).
function PetAlbumScreen({
  pet,
  onError,
  onNotice,
}: {
  pet: Pet;
  onError: (msg: string | null) => void;
  onNotice: (msg: string) => void;
}) {
  const [photos, setPhotos] = useState<Photo[] | null>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await listPhotos(pet.id);
        if (!cancelled) setPhotos(res.photos);
      } catch (err) {
        if (!cancelled) onError(err instanceof Error ? err.message : 'Could not load the album');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pet.id, onError]);

  async function handleDelete(photoId: string) {
    if (!photos) return;
    try {
      await deletePhoto(pet.id, photoId);
      setPhotos(photos.filter((p) => p.id !== photoId));
      onNotice('Photo deleted');
      setViewerIndex(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not delete the photo');
    }
  }

  const groups = photos ? groupPhotosByDay(photos) : [];
  // Index within the FULL flat list (not the day's subset) — so the viewer's
  // swipe carries across day boundaries instead of being trapped in one day.
  const indexById = new Map((photos ?? []).map((p, i) => [p.id, i]));

  return (
    <div className="albums-all pet-album">
      <div className="albums-all__pet-header">
        <PetAvatar pet={pet} size={40} />
        <h1 className="large-title pet-album__title">{pet.name}'s photos</h1>
      </div>
      {photos === null ? (
        <p className="albums-all__loading">Loading…</p>
      ) : photos.length === 0 ? (
        <p className="albums-all__loading">No photos yet.</p>
      ) : (
        groups.map((group) => (
          <section key={group.day} className="pet-album__day">
            <div className="pet-album__day-header">{formatDate(group.day)}</div>
            <div className="albums-all__grid">
              {group.photos.map((photo) => (
                <button
                  key={photo.id}
                  type="button"
                  className="albums-all__thumb"
                  onClick={() => setViewerIndex(indexById.get(photo.id) ?? 0)}
                >
                  <img src={photo.url} alt="" loading="lazy" />
                </button>
              ))}
            </div>
          </section>
        ))
      )}
      {photos && viewerIndex !== null && (
        <PhotoViewerScreen
          pet={pet}
          photos={photos}
          startIndex={viewerIndex}
          onExit={() => setViewerIndex(null)}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}

// Full-screen swipeable viewer — same CSS scroll-snap/dots/counter structure
// as PresentScreen above, adapted for photos (image-only, plus a delete
// action; no PDF branch since album photos are always images).
function PhotoViewerScreen({
  pet,
  photos,
  startIndex,
  onExit,
  onDelete,
}: {
  pet: Pet;
  photos: Photo[];
  startIndex: number;
  onExit: () => void;
  onDelete: (photoId: string) => void;
}) {
  const [current, setCurrent] = useState(startIndex);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const slidesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onExit();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onExit]);

  // Swiping to a different photo cancels an in-flight "confirm delete" —
  // it should never apply to a photo the user isn't looking at anymore.
  useEffect(() => setConfirmingDelete(false), [current]);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  useEffect(() => {
    const el = slidesRef.current;
    if (!el) return;
    el.scrollLeft = startIndex * el.clientWidth;
    // Only on mount — scrolling programmatically again on every render
    // would fight the user's own swipe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleScroll() {
    const el = slidesRef.current;
    if (!el) return;
    setCurrent(Math.round(el.scrollLeft / el.clientWidth));
  }

  return (
    <div className="present" role="dialog" aria-label={`${pet.name}'s photos`}>
      <button className="present__exit" onClick={onExit} aria-label="Exit viewer">✕</button>
      {confirmingDelete ? (
        <button
          className="photo-viewer__delete photo-viewer__delete--confirm"
          onClick={() => onDelete(photos[current].id)}
        >
          Confirm delete
        </button>
      ) : (
        <button
          className="photo-viewer__delete"
          onClick={() => setConfirmingDelete(true)}
          aria-label="Delete photo"
        >
          🗑️
        </button>
      )}

      <div className="present__slides" ref={slidesRef} onScroll={handleScroll}>
        {photos.map((photo) => (
          <div key={photo.id} className="present__slide">
            <div className="present__doc-content">
              <img src={photo.url} alt="" className="present__doc-img" loading="lazy" />
            </div>
          </div>
        ))}
      </div>

      <div className="present__footer">
        <span className="present__pet-name">{pet.name}</span>
        {photos.length > 1 && (
          <div className="present__dots" aria-hidden="true">
            {photos.map((_, i) => (
              <span key={i} className={`present__dot${i === current ? ' present__dot--active' : ''}`} />
            ))}
          </div>
        )}
        {photos.length > 1 && (
          <span className="present__counter">{current + 1} / {photos.length}</span>
        )}
      </div>
    </div>
  );
}

// ---- settings screen ----
// (REMINDER_DAY_OPTIONS lives in productConfig.ts — must match the server's
// accepted values.)

// One component, three focused screens (avatar menu → Account /
// Notifications / Family) — the shared load/persist machinery stays in one
// place, each screen renders only its groups.
const SETTINGS_TITLES: Record<SettingsSection, string> = {
  account: 'Account',
  notifications: 'Notifications',
  family: 'Family',
};

function SettingsScreen({
  section,
  email,
  sub,
  limits,
  theme,
  onThemeChange,
  onDone,
  onChangePassword,
  onLogout,
  onError,
  onNotice,
  onLimitsChange,
  onUpgrade,
  onAccountDeleted,
}: {
  section: SettingsSection;
  email: string;
  sub: string;
  limits: Limits;
  theme: Theme;
  onThemeChange: (t: Theme) => void;
  onDone: () => void;
  onChangePassword: () => void;
  onLogout: () => void;
  onError: (msg: string | null) => void;
  onNotice: (msg: string) => void;
  onLimitsChange: (limits: Limits) => void;
  onUpgrade: () => void;
  onAccountDeleted: () => void;
}) {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePw, setDeletePw] = useState('');
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // TestFlight/App Store build identification (2026-07-15) — null on web,
  // shown at the bottom of the Account section so a tester can confirm
  // which build they're running.
  const [appVersion, setAppVersion] = useState<{ version: string; build: string } | null>(null);
  useEffect(() => {
    void getAppVersion().then(setAppVersion);
  }, []);
  // StoreKit's monthly/annual products (native only) — fetched once per
  // Account screen visit, not app-wide, since offerings rarely change and
  // this screen is the only place they're shown.
  const [offering, setOffering] = useState<PaidOfferingPackages | null>(null);
  const [offeringLoading, setOfferingLoading] = useState(false);
  const [offeringError, setOfferingError] = useState<string | null>(null);

  const loadNativeOffering = useCallback(async () => {
    if (!isNative || !sub) return;
    setOfferingLoading(true);
    setOfferingError(null);
    try {
      setOffering(await getPaidOfferingPackages());
    } catch (error) {
      setOffering(null);
      setOfferingError(error instanceof Error ? error.message : 'App Store plans could not be loaded.');
    } finally {
      setOfferingLoading(false);
    }
  }, [sub]);

  useEffect(() => {
    if (section === 'account' && limits.plan === 'free') void loadNativeOffering();
  }, [limits.plan, loadNativeOffering, section]);

  async function handleDeleteAccount(e: FormEvent) {
    e.preventDefault();
    hapticWarning();
    setDeleting(true);
    setDeleteErr(null);
    try {
      await verifyPassword(email, deletePw);
    } catch {
      setDeleteErr('That password is incorrect.');
      setDeleting(false);
      return;
    }
    try {
      await deleteAccount();
      onAccountDeleted();
    } catch (err) {
      setDeleteErr(err instanceof Error ? err.message : 'Could not delete the account — try again.');
      setDeleting(false);
    }
  }

  // StoreKit returns an Apple-signed transaction. Our API verifies that
  // signature and appAccountToken before granting paid limits.
  async function handleNativePurchase(product: StoreKitProduct) {
    setBusy(true);
    onError(null);
    try {
      const result = await purchaseStoreKitProduct(sub, product);
      if (result.cancelled) return;
      if (result.pending) {
        onNotice('Purchase pending Apple approval. Paid access will activate after approval.');
        return;
      }
      if (!result.signedTransaction) throw new Error('Apple did not return a signed transaction.');
      const refreshed = await syncAppleTransactions([result.signedTransaction]);
      onLimitsChange(refreshed);
      if (refreshed.plan === 'paid') {
        onNotice('Payment received — welcome to Petshots Paid! 🎉');
        return;
      }
      if (refreshed.billingApple?.status === 'expired' && refreshed.billingApple.expiresAt) {
        const planLabel =
          refreshed.billingApple.productId === APPLE_IAP.ANNUAL_PRODUCT_ID ? 'yearly' : 'monthly';
        onError(
          `Apple processed the purchase, but this ${planLabel} sandbox subscription expired at ${formatDateTime(refreshed.billingApple.expiresAt)}. Try Restore Purchases or buy again while testing.`,
        );
        return;
      }
      onError(
        'Apple completed the purchase, but Petshots does not see an active subscription yet. Try Restore Purchases.',
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not complete purchase';
      if (message.includes('different Petshots account')) {
        onError(message);
      } else if (message.includes('Apple could not verify this purchase')) {
        onError(
          'Apple completed the purchase, but Petshots could not verify it yet. Try Restore Purchases while signed into this same Petshots account.',
        );
      } else {
        onError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleRestorePurchases() {
    setBusy(true);
    onError(null);
    try {
      const signedTransactions = await restoreStoreKitPurchases();
      const refreshed = await syncAppleTransactions(signedTransactions);
      onLimitsChange(refreshed);
      onNotice(
        refreshed.plan === 'paid'
          ? 'Purchases restored — welcome back to Petshots Paid!'
          : 'No active purchases found to restore.',
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not restore purchases');
    } finally {
      setBusy(false);
    }
  }

  async function handleTesterPlan(plan: 'free' | 'paid') {
    setBusy(true);
    onError(null);
    try {
      const refreshed = await setBillingTestPlan(plan);
      onLimitsChange(refreshed);
      onNotice(`${plan === 'paid' ? 'Paid' : 'Free'} tester mode is active.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not change tester mode');
    } finally {
      setBusy(false);
    }
  }

  // Only the Notifications screen reads settings.json — the other two render
  // immediately.
  useEffect(() => {
    if (section !== 'notifications') {
      setLoading(false);
      return;
    }
    getSettings()
      .then((s) => setSettings({ ...DEFAULT_SETTINGS, ...s, email: s.email || email }))
      .catch(() => setSettings({ ...DEFAULT_SETTINGS, email }))
      .finally(() => setLoading(false));
  }, [email, section]);

  // Auto-saves toggles/day-chips as they're changed — no explicit Save button.
  // Debounced so rapid-fire clicks (e.g. several day chips in a row) coalesce into one request.
  function persist(next: UserSettings) {
    hapticTap(); // every persist() call is a direct toggle/chip tap
    setSettings(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveStatus('saving');
    saveTimer.current = setTimeout(() => {
      saveSettings({ ...next, email })
        .then(() => setSaveStatus('saved'))
        .catch((err) => {
          setSaveStatus('error');
          onError(err instanceof Error ? err.message : 'Could not save settings');
        });
    }, 400);
  }

  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
  }, []);

  function toggleDay(day: number) {
    if (!settings) return;
    const days = settings.reminderDays.includes(day)
      ? settings.reminderDays.filter((d) => d !== day)
      : [...settings.reminderDays, day].sort((a, b) => a - b);
    persist({ ...settings, reminderDays: days });
  }

  const billingSources = limits.billingSources ?? (limits.billingSource ? [limits.billingSource] : []);
  const appleBilling = limits.billingApple;
  const applePlanLabel =
    appleBilling?.productId === APPLE_IAP.ANNUAL_PRODUCT_ID
      ? 'Yearly'
      : appleBilling?.productId === APPLE_IAP.MONTHLY_PRODUCT_ID
        ? 'Monthly'
        : 'Subscription';

  return (
    <div className="screen-view screen-view--root">
      <nav className="screen-nav">
        {/* Settings opens from the header avatar menu — the back button
            returns to whichever tab root the user came from. */}
        <button
          className="screen-nav__back btn btn--link"
          type="button"
          onClick={onDone}
        >
          ‹ Back
        </button>
        <span className="screen-nav__title">{SETTINGS_TITLES[section]}</span>
        {section === 'notifications' && saveStatus !== 'idle' && (
          <span className="settings-save-status" role="status" aria-live="polite">
            {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'saved' ? 'Saved' : ''}
          </span>
        )}
      </nav>
      <div className="screen-view__body">
        {loading ? (
          <p className="subtle">Loading…</p>
        ) : (
          <div className="form settings-form">

            {section === 'account' && (
            <>
            <section className="settings-group" aria-labelledby="profile-settings-title">
              <h2 className="settings-card__title" id="profile-settings-title">Profile</h2>
              <div className="settings-row">
                <span className="settings-row__label">
                  Signed in as
                  <span className="subtle settings-row__sub">{email}</span>
                </span>
              </div>
              <div className="settings-group__divider" />
              <button type="button" className="settings-nav-row" onClick={onChangePassword}>
                <span>Change password</span>
                <span className="settings-nav-row__chevron" aria-hidden="true">›</span>
              </button>
              <div className="settings-group__divider" />
              <button
                type="button"
                className="settings-nav-row settings-nav-row--danger"
                onClick={onLogout}
              >
                <span>Log out</span>
              </button>
            </section>

            <section className="settings-group" aria-labelledby="membership-settings-title">
              <h2 className="settings-card__title" id="membership-settings-title">Membership</h2>
              <div className="settings-row">
                <span className="settings-row__label">
                  {limits.plan === 'paid' ? 'Petshots Paid' : 'Free plan'}
                  <span className="subtle settings-row__sub">
                    {limits.maxPets} pets &middot;{' '}
                    {limits.maxDocs >= 999 ? 'Unlimited*' : limits.maxDocs} records &amp;{' '}
                    {limits.maxMeds} meds per pet
                  </span>
                </span>
              </div>
              <div className="plan-actions">
                {email.toLowerCase() === 'mark.gingrass@gmail.com' && (
                  <div className="tester-plan" aria-label="Tester plan preview">
                    <span className="tester-plan__label">
                      Tester mode
                      <span>Uses real server limits</span>
                    </span>
                    <div className="tester-plan__control" role="group" aria-label="Preview plan">
                      <button
                        type="button"
                        disabled={busy}
                        aria-pressed={limits.plan === 'free'}
                        className={limits.plan === 'free' ? 'tester-plan__option tester-plan__option--active' : 'tester-plan__option'}
                        onClick={() => void handleTesterPlan('free')}
                      >
                        Free
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        aria-pressed={limits.plan === 'paid'}
                        className={limits.plan === 'paid' ? 'tester-plan__option tester-plan__option--active' : 'tester-plan__option'}
                        onClick={() => void handleTesterPlan('paid')}
                      >
                        Paid
                      </button>
                    </div>
                  </div>
                )}
                {isNative ? (
                  limits.plan === 'paid' ? (
                    <>
                      {billingSources.includes('apple') && (
                        // App Store 3.1.1 concerns purchase steering, not
                        // managing an existing subscription — a deep link to
                        // Apple's own subscription-management screen is fine.
                        <a
                          className="btn"
                          href="itms-apps://apps.apple.com/account/subscriptions"
                        >
                          Manage App Store subscription
                        </a>
                      )}
                      {billingSources.includes('manual') && billingSources.length === 1 && (
                        <p className="subtle plan-fine-print">Paid access is active for this account.</p>
                      )}
                      {appleBilling && (
                        <p className="subtle plan-fine-print">
                          {applePlanLabel}
                          {appleBilling.status ? ` · ${appleBilling.status}` : ''}
                          {appleBilling.expiresAt ? ` · Expires ${formatDateTime(appleBilling.expiresAt)}` : ''}
                          {appleBilling.environment ? ` · ${appleBilling.environment}` : ''}
                        </p>
                      )}
                    </>
                  ) : (
                    <>
                      {offeringLoading && <p className="subtle plan-fine-print">Loading App Store plans…</p>}
                      {offeringError && (
                        <div className="plan-error" role="alert">
                          <span className="plan-error__icon" aria-hidden="true">!</span>
                          <div className="plan-error__copy">
                            <strong>Purchases unavailable</strong>
                            <p>{offeringError}</p>
                          </div>
                          <button
                            type="button"
                            className="plan-error__retry"
                            disabled={busy || offeringLoading}
                            onClick={() => void loadNativeOffering()}
                          >
                            Retry
                          </button>
                        </div>
                      )}
                      {(offering?.monthly || offering?.annual) && (
                        <div className="purchase-options">
                          {offering.monthly && (
                            <button
                              type="button"
                              className="purchase-option"
                              disabled={busy}
                              onClick={() => void handleNativePurchase(offering.monthly!)}
                            >
                              <span className="purchase-option__name">Monthly</span>
                              <strong>{offering.monthly.displayPrice}</strong>
                              <span className="purchase-option__period">per month</span>
                            </button>
                          )}
                          {offering.annual && (
                            <button
                              type="button"
                              className="purchase-option purchase-option--featured"
                              disabled={busy}
                              onClick={() => void handleNativePurchase(offering.annual!)}
                            >
                              <span className="purchase-option__badge">Best value</span>
                              <span className="purchase-option__name">Yearly</span>
                              <strong>{offering.annual.displayPrice}</strong>
                              <span className="purchase-option__period">per year</span>
                            </button>
                          )}
                        </div>
                      )}
                      {offering?.warning && (
                        <p className="subtle plan-fine-print">{offering.warning}</p>
                      )}
                      <p className="subtle plan-fine-print">
                        Paid plan: {PAID_PLAN_LIMITS.maxPets} pets, up to {PAID_PLAN_LIMITS.maxDocs} records per pet,{' '}
                        {PAID_PLAN_LIMITS.maxMeds} medications per pet.
                      </p>
                      <button
                        type="button"
                        className="btn btn--link"
                        disabled={busy}
                        onClick={() => void handleRestorePurchases()}
                      >
                        Restore purchases
                      </button>
                      {appleBilling && (
                        <p className="subtle plan-fine-print">
                          Last App Store sync
                          {appleBilling.updatedAt ? ` · ${formatDateTime(appleBilling.updatedAt)}` : ''}
                          {appleBilling.status ? ` · ${appleBilling.status}` : ''}
                          {appleBilling.expiresAt ? ` · Expires ${formatDateTime(appleBilling.expiresAt)}` : ''}
                          {appleBilling.environment ? ` · ${appleBilling.environment}` : ''}
                        </p>
                      )}
                    </>
                  )
                ) : limits.plan === 'free' ? (
                  <>
                    <p className="subtle plan-fine-print">
                      Upgrades are available only in the Petshots iPhone app through the App Store.
                    </p>
                    <p className="subtle plan-fine-print">
                      Paid plan: {PAID_PLAN_LIMITS.maxPets} pets, up to {PAID_PLAN_LIMITS.maxDocs} records per pet,{' '}
                      {PAID_PLAN_LIMITS.maxMeds} medications per pet.
                    </p>
                  </>
                ) : billingSources.includes('apple') ? (
                  <p className="subtle plan-fine-print">
                    Your subscription is managed through the App Store.
                  </p>
                ) : (
                  <p className="subtle plan-fine-print">Paid access is active for this account.</p>
                )}
              </div>
            </section>

            <section className="settings-group" aria-labelledby="appearance-settings-title">
              <h2 className="settings-card__title" id="appearance-settings-title">Appearance</h2>
              <div className="settings-row">
                <span className="settings-row__label">Theme</span>
                <div className="theme-toggle">
                  <button
                    type="button"
                    className={`theme-toggle__btn${theme === 'dark' ? ' theme-toggle__btn--active' : ''}`}
                    onClick={() => onThemeChange('dark')}
                  >
                    Dark
                  </button>
                  <button
                    type="button"
                    className={`theme-toggle__btn${theme === 'light' ? ' theme-toggle__btn--active' : ''}`}
                    onClick={() => onThemeChange('light')}
                  >
                    Light
                  </button>
                </div>
              </div>
            </section>
            </>
            )}

            {section === 'family' && <FamilySection onError={onError} onUpgrade={onUpgrade} />}

            {section === 'notifications' && (
            <section className="settings-group" aria-labelledby="email-settings-title">
              <h2 className="settings-card__title" id="email-settings-title">Email preferences</h2>
              <div className="settings-row">
                <label className="settings-row__label" htmlFor="optout-toggle">
                  Pause all email
                  <span className="subtle settings-row__sub">
                    Nothing from Petshots — no reminders, birthdays, or updates
                  </span>
                </label>
                <label className="toggle" aria-label="Toggle pause all email">
                  <input
                    id="optout-toggle"
                    type="checkbox"
                    checked={settings?.emailOptOut ?? false}
                    onChange={(e) => settings && persist({ ...settings, emailOptOut: e.target.checked })}
                  />
                  <span className="toggle__track" />
                </label>
              </div>
              {settings?.emailOptOut && (
                <p className="settings-hint subtle">
                  All email is paused. Your settings below are kept and take effect again when you
                  turn this off.
                </p>
              )}

              <div className="settings-group__divider" />

              <div className={settings?.emailOptOut ? 'settings-muted' : undefined}>
              <div className="settings-row">
                <label className="settings-row__label" htmlFor="marketing-toggle">
                  Product updates
                  <span className="subtle settings-row__sub">Tips, new features, and Petshots news</span>
                </label>
                <label className="toggle" aria-label="Toggle marketing emails">
                  <input
                    id="marketing-toggle"
                    type="checkbox"
                    checked={settings?.marketingOptIn ?? false}
                    onChange={(e) => settings && persist({ ...settings, marketingOptIn: e.target.checked })}
                  />
                  <span className="toggle__track" />
                </label>
              </div>

              <div className="settings-group__divider" />

              <div className="settings-row">
                <label className="settings-row__label" htmlFor="reminders-toggle">
                  Vaccine reminders
                  <span className="subtle settings-row__sub">Get emailed before records expire</span>
                </label>
                <label className="toggle" aria-label="Toggle vaccine reminders">
                  <input
                    id="reminders-toggle"
                    type="checkbox"
                    checked={settings?.remindersEnabled ?? false}
                    onChange={(e) => settings && persist({ ...settings, remindersEnabled: e.target.checked })}
                  />
                  <span className="toggle__track" />
                </label>
              </div>

              {settings?.remindersEnabled && (
                <>
                  <p className="settings-hint subtle">Send reminders to <strong>{email}</strong>:</p>
                  <div className="settings-days">
                    {REMINDER_DAY_OPTIONS.map(({ value, label }) => (
                      <label key={value} className="settings-day-chip">
                        <input
                          type="checkbox"
                          checked={settings.reminderDays.includes(value)}
                          onChange={() => toggleDay(value)}
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </div>
                  <p className="settings-hint subtle">
                    You'll also always get a heads-up 3 and 1 day before expiry, on the expiry date itself,
                    and — if it lapses — a follow-up every week for a month, then monthly until it's updated.
                  </p>
                </>
              )}

              <p className="settings-hint subtle">
                Medication reminders are set per medication on each pet's Meds tab: due-date and overdue
                (weekly, then monthly) reminders always apply when a med's toggle is on; meds due every
                week or longer also get a 3-day-ahead heads-up.
              </p>

              <div className="settings-group__divider" />

              <div className="settings-row">
                <label className="settings-row__label" htmlFor="digest-toggle">
                  Weekly digest
                  <span className="subtle settings-row__sub">
                    A Sunday summary of the week's care, mood, and weight — only when
                    there's something to report
                  </span>
                </label>
                <label className="toggle" aria-label="Toggle weekly digest">
                  <input
                    id="digest-toggle"
                    type="checkbox"
                    checked={(settings?.weeklyDigest ?? true) && (settings?.remindersEnabled ?? false)}
                    disabled={!settings?.remindersEnabled}
                    onChange={(e) => settings && persist({ ...settings, weeklyDigest: e.target.checked })}
                  />
                  <span className="toggle__track" />
                </label>
              </div>

              <PushRow onError={onError} />
              </div>
            </section>
            )}

            {section === 'account' && (
            <section className="settings-group settings-group--danger" aria-labelledby="delete-account-title">
              <h2 className="settings-card__title settings-card__title--danger" id="delete-account-title">
                Delete account
              </h2>
              {!deleteOpen ? (
                <div className="settings-row">
                  <p className="subtle settings-card__description">
                    Permanently removes your pets, records, and account.
                  </p>
                  <button
                    type="button"
                    className="btn btn--danger"
                    onClick={() => { setDeleteOpen(true); setDeleteErr(null); }}
                  >
                    Delete account…
                  </button>
                </div>
              ) : (
                <form className="danger-confirm" onSubmit={handleDeleteAccount}>
                  <p className="danger-confirm__warning">
                    This permanently deletes your account: every pet, all uploaded records and
                    medications, and any shared passport links. App Store subscriptions must be cancelled
                    separately with Apple; deleting Petshots data does not stop Apple's billing.
                    <strong> There is no undo.</strong>
                  </p>
                  <label>
                    Enter your password to confirm
                    <input
                      type="password"
                      value={deletePw}
                      onChange={(e) => setDeletePw(e.target.value)}
                      autoComplete="current-password"
                      autoFocus
                      required
                    />
                  </label>
                  {deleteErr && <p className="danger-confirm__error" role="alert">{deleteErr}</p>}
                  <div className="actions">
                    <button
                      type="button"
                      className="btn"
                      disabled={deleting}
                      onClick={() => { setDeleteOpen(false); setDeletePw(''); setDeleteErr(null); }}
                    >
                      Keep my account
                    </button>
                    <button
                      type="submit"
                      className="btn btn--danger"
                      disabled={deleting || !deletePw}
                    >
                      {deleting ? 'Deleting…' : 'Delete my account forever'}
                    </button>
                  </div>
                </form>
              )}
            </section>
            )}

            {section === 'account' && appVersion && (
              <p className="subtle settings-app-version">
                Petshots {appVersion.version} ({appVersion.build})
              </p>
            )}

          </div>
        )}
      </div>
    </div>
  );
}

// ---- push notifications (Settings row) ----
// Per-DEVICE toggle: the subscription lives in this browser; other devices
// have their own. Hidden where push can't work at all, with an install hint
// for iOS Safari (push needs the home-screen app there).
function PushRow({ onError }: { onError: (msg: string | null) => void }) {
  const [state, setState] = useState<PushState | 'loading'>('loading');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getPushState().then(setState);
  }, []);

  if (state === 'loading') return null;
  if (state === 'unsupported') {
    if (!iosNeedsInstall()) return null;
    return (
      <>
        <div className="settings-group__divider" />
        <div className="settings-row">
          <span className="settings-row__label">
            Push notifications
            <span className="subtle settings-row__sub">
              Add Petshots to your Home Screen first (Share → Add to Home Screen), then
              enable notifications here in the installed app.
            </span>
          </span>
        </div>
      </>
    );
  }

  async function toggle(next: boolean) {
    setBusy(true);
    onError(null);
    try {
      if (next) {
        await enablePush();
        setState('on');
      } else {
        await disablePush();
        setState('off');
      }
    } catch (err) {
      if (err instanceof Error && err.message === 'PERMISSION_DENIED') {
        setState('denied');
      } else {
        onError(err instanceof Error ? err.message : 'Could not update notifications');
        setState(await getPushState());
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="settings-group__divider" />
      <div className="settings-row">
        <span className="settings-row__label">
          Push notifications
          <span className="subtle settings-row__sub">
            {state === 'denied'
              ? isNative
                ? 'Blocked — allow notifications for Petshots in iOS Settings, then come back here.'
                : 'Blocked in your browser — allow notifications for petshots.app in browser settings, then reload.'
              : 'Reminders as notifications on this device, alongside email'}
          </span>
        </span>
        {state !== 'denied' && (
          <label className="toggle" aria-label="Toggle push notifications on this device">
            <input
              type="checkbox"
              checked={state === 'on'}
              disabled={busy}
              onChange={(e) => void toggle(e.target.checked)}
            />
            <span className="toggle__track" />
          </label>
        )}
      </div>
    </>
  );
}

// ---- family (Settings card) ----
// Owner: invite links (7-day expiry), member list with remove. Member: who
// you're sharing with + leave. Server enforces everything; this is just the
// controls.
function FamilySection({
  onError,
  onUpgrade,
}: {
  onError: (msg: string | null) => void;
  onUpgrade: () => void;
}) {
  const [household, setHousehold] = useState<Household | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null); // invite token
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null); // member sub
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null); // invite token
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteNote, setInviteNote] = useState<string | null>(null);

  const load = useCallback(() => {
    getHousehold()
      .then(setHousehold)
      .catch(() => setHousehold(null));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function handleInvite() {
    setBusy(true);
    onError(null);
    setInviteNote(null);
    const email = inviteEmail.trim();
    try {
      const res = await createInvite(email || undefined);
      if (email) {
        setInviteNote(
          res.emailDelivered === false
            ? "The invite was created but the email couldn't be sent — share the link below instead."
            : `Invite emailed to ${email}.`,
        );
      }
      setInviteEmail('');
      load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      onError(
        msg === 'MEMBER_LIMIT_REACHED'
          ? 'Your plan has no member seats left. Revoke a pending invite or upgrade.'
          : msg || 'Could not create the invite',
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleShare(url: string, token: string) {
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({
          title: 'Join my Petshots family',
          text: "Join my Petshots family — our pets' vaccine records and med reminders, shared.",
          url,
        });
        return;
      } catch {
        /* user cancelled */
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(token);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      onError('Could not copy — try long-pressing the link');
    }
  }

  async function handleRevoke(token: string) {
    setBusy(true);
    try {
      await revokeInvite(token);
      load();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not revoke the invite');
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(sub: string) {
    setBusy(true);
    try {
      await removeMember(sub);
      setConfirmRemove(null);
      load();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not remove the member');
    } finally {
      setBusy(false);
    }
  }

  async function handleLeave() {
    setBusy(true);
    try {
      await leaveHousehold();
      setConfirmLeave(false);
      load();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not leave the family');
    } finally {
      setBusy(false);
    }
  }

  if (!household) return null;

  if (household.role === 'member') {
    return (
      <section className="settings-group" aria-labelledby="family-settings-title">
        <h2 className="settings-card__title" id="family-settings-title">Your family</h2>
        <div className="settings-row">
          <span className="settings-row__label">
            You share <strong>{household.ownerEmail}</strong>'s family pets
            <span className="subtle settings-row__sub">
              Their records and reminders show alongside your own.
            </span>
          </span>
        </div>
        {confirmLeave ? (
          <div className="actions">
            <button className="btn btn--danger" type="button" disabled={busy} onClick={() => void handleLeave()}>
              {busy ? 'Leaving…' : 'Yes, leave the family'}
            </button>
            <button className="btn" type="button" disabled={busy} onClick={() => setConfirmLeave(false)}>
              Stay
            </button>
          </div>
        ) : (
          <button className="btn btn--link btn--danger" type="button" onClick={() => setConfirmLeave(true)}>
            Leave family…
          </button>
        )}
      </section>
    );
  }

  const seatsUsed = household.members.length + household.invites.length;
  return (
    <section className="settings-group" aria-labelledby="family-settings-title">
      <h2 className="settings-card__title" id="family-settings-title">Your family</h2>
      <p className="subtle">
        Family members see and update your pets' records, meds, and reminders.
        They can't delete pets or manage share links.
      </p>

      {household.members.map((m) => (
        <div key={m.sub}>
          <div className="settings-row">
            <span className="settings-row__label">
              {m.email}
              <span className="subtle settings-row__sub">Member since {formatDate(m.joinedAt.slice(0, 10))}</span>
            </span>
            {confirmRemove !== m.sub && (
              <button className="btn btn--link btn--danger" type="button" onClick={() => { hapticWarning(); setConfirmRemove(m.sub); }}>
                Remove…
              </button>
            )}
          </div>
          {confirmRemove === m.sub && (
            <div className="family-confirm" role="alert">
              <p>
                Remove <strong>{m.email}</strong> from your family? Their access to
                your pets ends immediately.
              </p>
              <span className="actions">
                <button className="btn" type="button" disabled={busy} onClick={() => setConfirmRemove(null)}>
                  Keep
                </button>
                <button className="btn btn--danger" type="button" disabled={busy} onClick={() => void handleRemove(m.sub)}>
                  Yes, remove
                </button>
              </span>
            </div>
          )}
        </div>
      ))}

      {household.invites.map((i) => (
        <div key={i.token}>
          <div className="settings-row">
            <span className="settings-row__label">
              {i.sentTo ? `Invite sent to ${i.sentTo}` : 'Invite link (pending)'}
              <span className="subtle settings-row__sub">Expires {formatDate(i.expiresAt.slice(0, 10))}</span>
            </span>
            <span className="actions">
              <button className="btn" type="button" onClick={() => void handleShare(i.url, i.token)}>
                {copied === i.token ? 'Copied!' : 'Share'}
              </button>
              {confirmRevoke !== i.token && (
                <button className="btn btn--link btn--danger" type="button" disabled={busy} onClick={() => { hapticWarning(); setConfirmRevoke(i.token); }}>
                  Revoke…
                </button>
              )}
            </span>
          </div>
          {confirmRevoke === i.token && (
            <div className="family-confirm" role="alert">
              <p>Revoke this invite? The link stops working immediately.</p>
              <span className="actions">
                <button className="btn" type="button" disabled={busy} onClick={() => setConfirmRevoke(null)}>
                  Keep
                </button>
                <button
                  className="btn btn--danger"
                  type="button"
                  disabled={busy}
                  onClick={() => { setConfirmRevoke(null); void handleRevoke(i.token); }}
                >
                  Yes, revoke
                </button>
              </span>
            </div>
          )}
        </div>
      ))}

      {inviteNote && <p className="subtle">{inviteNote}</p>}
      {seatsUsed < household.maxMembers ? (
        <form
          className="family-invite"
          onSubmit={(e) => {
            e.preventDefault();
            void handleInvite();
          }}
        >
          <input
            type="email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="their@email.com (optional)"
            autoComplete="off"
          />
          <button className="btn btn--primary" type="submit" disabled={busy}>
            {busy ? 'Working…' : inviteEmail.trim() ? 'Email invite' : 'Create invite link'}
          </button>
        </form>
      ) : (
        <p className="subtle">
          {household.maxMembers === 1 ? (
            <>
              Your plan includes 1 family member.{' '}
              <button className="btn btn--link" onClick={onUpgrade}>
                Upgrade for up to 5 →
              </button>
            </>
          ) : (
            `All ${household.maxMembers} member seats on your plan are in use.`
          )}
        </p>
      )}
    </section>
  );
}

function ChangePasswordScreen({
  onDone,
  onCancel,
  onError,
}: {
  onDone: () => void;
  onCancel: () => void;
  onError: (msg: string | null) => void;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (next !== confirm) { onError('New passwords do not match.'); return; }
    if (next.length < 8) { onError('New password must be at least 8 characters.'); return; }
    setBusy(true);
    onError(null);
    try {
      await changePassword(current, next);
      onDone();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not change password';
      onError(msg.includes('NotAuthorizedException') || msg.includes('Incorrect') ? 'Current password is incorrect.' : msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen-view screen-view--sheet">
      <nav className="screen-nav">
        <button className="screen-nav__back btn btn--link" type="button" onClick={onCancel}>
          ‹ Settings
        </button>
        <span className="screen-nav__title">Change Password</span>
      </nav>
      <form className="form" onSubmit={handleSubmit}>
        <label>
          Current password
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            autoFocus
            required
          />
        </label>
        <label>
          New password
          <input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            required
            minLength={8}
          />
        </label>
        <label>
          Confirm new password
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
          />
        </label>
        <div className="actions">
          <button className="btn btn--primary" type="submit" disabled={busy || !current || !next || !confirm}>
            {busy ? 'Saving…' : 'Change password'}
          </button>
          <button className="btn" type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
