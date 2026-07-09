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
  listDocs,
  updateDoc,
  deleteDoc,
  uploadForAnalysis,
  analyzeUpload,
  commitUpload,
  createManualRecords,
  listMeds,
  saveMeds,
  createPassport,
  revokePassport,
  createCheckout,
  createBillingPortal,
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
  localToday,
  listWeights,
  logWeight,
  deleteWeight,
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
} from '../api';
import { applyTheme, getSavedTheme, type Theme } from '../utils/theme';
import { readDoorCache, updateDoorCache } from '../doorCache';
import { getPushState, enablePush, disablePush, iosNeedsInstall, type PushState } from '../push';
import { isNative, hapticTap, hapticSuccess, hapticWarning } from '../native';
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
const MAX_AVATAR_BYTES = UPLOADS.MAX_AVATAR_BYTES;
const DUE_SOON_DAYS = DASHBOARD_CONFIG.DUE_SOON_DAYS;

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

// Worst-case status across a pet's docs AND meds — drives the overview pin ring.
function petOverallStatus(docs: Doc[], meds?: Med[]): Status {
  let worst = docs.reduce<Status>((w, doc) => {
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
function petPinStatus(docs: Doc[], meds?: Med[]): string {
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

type DashView =
  | { type: 'overview' }
  | { type: 'detail'; petId: string; tab?: 'records' | 'daily' | 'meds' | 'profile' | 'passport' }
  | { type: 'add-pet' }
  | { type: 'edit-pet'; petId: string }
  | { type: 'change-password' }
  | { type: 'settings' }
  // Combined every-pet daily view — the bottom tab bar's "Daily" tab.
  | { type: 'daily' };

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
  const { email, logout } = useAuth();
  const navigate = useNavigate();

  const [theme, setTheme] = useState<Theme>(getSavedTheme);

  const [pets, setPets] = useState<Pet[] | null>(null); // null = still loading
  const [limits, setLimits] = useState<Limits>(DEFAULT_LIMITS);
  // The app opens on the Daily tab wherever the bottom tab bar exists (phones
  // + native); desktop has no Daily tab, so it keeps the pets overview.
  const [dashView, setDashView] = useState<DashView>(() =>
    document.documentElement.dataset.native === 'true' ||
    window.matchMedia('(max-width: 767px)').matches
      ? { type: 'daily' }
      : { type: 'overview' },
  );
  // Which day the Daily tab shows. Swipe right / the date dropdown walk it
  // back through the retained history; re-entering the tab resets to today.
  const [dailyDate, setDailyDate] = useState<string>(localToday);
  const [allDocs, setAllDocs] = useState<Record<string, Doc[]>>({});
  const [allMeds, setAllMeds] = useState<Record<string, Med[]>>({});
  const [allDocsLoading, setAllDocsLoading] = useState(false);
  const [editView, setEditView] = useState<EditView>({ type: 'list' });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [presenting, setPresenting] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{
    pet: Pet;
    docs: Doc[];
    timerId: ReturnType<typeof setTimeout>;
  } | null>(null);
  // Keep a ref so the unmount cleanup can read current value without a stale closure.
  const pendingDeleteRef = useRef(pendingDelete);
  pendingDeleteRef.current = pendingDelete;

  const showNotice = useCallback((msg: string) => {
    setNotice(msg);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3000);
  }, []);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  // On unmount, commit any pending delete immediately so nothing leaks.
  useEffect(() => {
    return () => {
      const pd = pendingDeleteRef.current;
      if (pd) {
        clearTimeout(pd.timerId);
        void deletePet(pd.pet.id);
      }
    };
  }, []);

  // ---- bottom tab bar (mobile + native; desktop keeps the ProfileMenu) ----
  // Which tab owns the current view. The pets tab is a whole stack
  // (overview → detail → edit screens); daily and settings are single screens.
  const activeTab: MainTab =
    dashView.type === 'settings' || dashView.type === 'change-password'
      ? 'settings'
      : dashView.type === 'daily'
        ? 'daily'
        : 'pets';

  // Remember where the pets stack was so switching Daily → Pets restores the
  // pet you were looking at (per-tab stacks, like a real iOS tab bar).
  const lastPetsViewRef = useRef<DashView>({ type: 'overview' });
  if (activeTab === 'pets') lastPetsViewRef.current = dashView;

  // Where Settings should return to — it's reached from the avatar menu now,
  // so remember which tab root the user came from.
  const settingsReturnRef = useRef<DashView>({ type: 'overview' });
  function openSettings() {
    settingsReturnRef.current =
      activeTab === 'daily' ? { type: 'daily' } : { type: 'overview' };
    setDashView({ type: 'settings' });
  }

  function handleTabSelect(tab: MainTab) {
    if (tab === activeTab) {
      // iOS convention: re-tapping the active tab pops its stack to the root.
      if (tab === 'pets' && dashView.type !== 'overview') backToOverview();
      else if (tab === 'daily' && dailyDate !== localToday()) setDailyDate(localToday());
      return;
    }
    if (tab === 'pets') setDashView(lastPetsViewRef.current);
    else if (tab === 'daily') {
      setDailyDate(localToday());
      setDashView({ type: 'daily' });
    } else setDashView({ type: 'settings' });
  }

  // ---- screen transition direction (iOS push/pop) ----
  // Depth 0 = tab roots, 1 = pushed screens, 2 = nested. Sheet-presented
  // screens animate themselves (.screen-view--sheet slides up), so the
  // horizontal push is suppressed for them. The dir lives in a ref keyed by
  // the view so mid-animation re-renders can't cancel it.
  const isSheetView =
    dashView.type === 'add-pet' ||
    dashView.type === 'edit-pet' ||
    dashView.type === 'change-password' ||
    (dashView.type === 'detail' &&
      (editView.type === 'edit' ||
        editView.type === 'edit-profile' ||
        editView.type === 'review-extraction'));
  const viewDepth =
    dashView.type === 'overview' || dashView.type === 'daily' || dashView.type === 'settings'
      ? 0
      : dashView.type === 'edit-pet' ||
          dashView.type === 'change-password' ||
          (dashView.type === 'detail' && editView.type !== 'list')
        ? 2
        : 1;
  const viewKey =
    pets === null
      ? 'loading'
      : dashView.type === 'detail'
        ? `detail:${dashView.petId}:${editView.type}`
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

  // Pet currently being viewed in detail/edit-pet screens.
  const detailPet =
    dashView.type === 'detail' || dashView.type === 'edit-pet'
      ? (pets?.find((p) => p.id === dashView.petId) ?? null)
      : null;

  // Docs for the active detail pet, always sorted.
  const detailDocs = detailPet ? (allDocs[detailPet.id] ?? []) : [];

  const loadPets = useCallback(async () => {
    setError(null);
    try {
      const res = await listPets();
      setPets(res.pets);
      setLimits(res.limits ?? DEFAULT_LIMITS);
      return res.pets;
    } catch (err) {
      // Offline with saved records = the door moment. Skip the dead dashboard
      // and go straight to the offline copy.
      if (!navigator.onLine && readDoorCache()) {
        navigate('/door', { replace: true });
        return [];
      }
      setPets([]);
      setError(err instanceof Error ? err.message : 'Failed to load your pets');
      return [];
    }
  }, [navigate]);

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

  // Returning from Stripe checkout. The webhook that flips the plan usually
  // lands before the redirect does, but give it a moment and refetch limits.
  useEffect(() => {
    const billing = new URLSearchParams(window.location.search).get('billing');
    if (!billing) return;
    window.history.replaceState({}, '', window.location.pathname);
    if (billing === 'success') {
      showNotice('Payment received — welcome to Petshots Paid! 🎉');
      const t = setTimeout(() => void loadPets(), 2500);
      return () => clearTimeout(t);
    }
    if (billing === 'cancelled') showNotice('Checkout cancelled — nothing was charged');
  }, [showNotice, loadPets]);

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
      await navigator.clipboard.writeText(data.url);
      showNotice('Link copied');
    }
  }

  function backToOverview() {
    setDashView({ type: 'overview' });
    setEditView({ type: 'list' });
  }

  function handleDeletePetWithUndo(petId: string) {
    if (!pets) return;
    const pet = pets.find((p) => p.id === petId);
    if (!pet) return;
    hapticWarning();
    const docs = allDocs[petId] ?? [];

    // Commit any previously pending delete before starting a new one.
    if (pendingDelete) {
      clearTimeout(pendingDelete.timerId);
      void deletePet(pendingDelete.pet.id).catch(() => {});
    }

    // Optimistically remove pet from local state and navigate away.
    setPets((prev) => (prev ?? []).filter((p) => p.id !== petId));
    setAllDocs((prev) => { const n = { ...prev }; delete n[petId]; return n; });
    backToOverview();

    const timerId = setTimeout(async () => {
      setPendingDelete(null);
      try {
        await deletePet(petId);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Delete failed — restoring your pet');
        void loadPets();
      }
    }, 10000);

    setPendingDelete({ pet, docs, timerId });
  }

  function handleUndoDelete() {
    if (!pendingDelete) return;
    clearTimeout(pendingDelete.timerId);
    setPets((prev) =>
      [...(prev ?? []), pendingDelete.pet].sort((a, b) => a.name.localeCompare(b.name)),
    );
    setAllDocs((prev) => ({ ...prev, [pendingDelete.pet.id]: pendingDelete.docs }));
    showNotice(`${pendingDelete.pet.name} restored`);
    setPendingDelete(null);
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
                onSettings={openSettings}
                onChangePassword={() => setDashView({ type: 'change-password' })}
                onLogout={handleLogout}
              />
            </div>
          </div>
        </header>

        {pendingDelete && (
          <div className="undo-notice" role="status">
            <span>{pendingDelete.pet.name} deleted.</span>
            <button className="btn btn--link" onClick={handleUndoDelete}>Undo</button>
          </div>
        )}
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
        ) : dashView.type === 'edit-pet' && detailPet ? (
          <div className="screen-view screen-view--sheet">
            <nav className="screen-nav">
              <button
                className="screen-nav__back btn btn--link"
                type="button"
                onClick={() => setDashView({ type: 'detail', petId: detailPet.id })}
              >
                ‹ {detailPet.name}
              </button>
              <span className="screen-nav__title">Edit Pet</span>
            </nav>
            <div className="screen-view__body">
              <PetForm
                pet={detailPet}
                submitLabel="Save"
                onDone={async () => {
                  await loadPets();
                  setDashView({ type: 'detail', petId: detailPet.id });
                }}
                onCancel={() => setDashView({ type: 'detail', petId: detailPet.id })}
                onDeletePet={handleDeletePetWithUndo}
                onError={setError}
                onNotice={showNotice}
              />
            </div>
          </div>
        ) : dashView.type === 'settings' ? (
          <SettingsScreen
            email={email ?? ''}
            limits={limits}
            theme={theme}
            onThemeChange={(t) => { applyTheme(t); setTheme(t); }}
            onDone={() => setDashView(settingsReturnRef.current)}
            onChangePassword={() => setDashView({ type: 'change-password' })}
            onLogout={handleLogout}
            onError={setError}
            onAccountDeleted={() => { logout(); navigate('/'); }}
          />
        ) : dashView.type === 'change-password' ? (
          <ChangePasswordScreen
            onDone={() => { setDashView({ type: 'settings' }); showNotice('Password changed'); }}
            onCancel={() => setDashView({ type: 'settings' })}
            onError={setError}
          />
        ) : dashView.type === 'daily' ? (
          <DailyAllScreen
            pets={pets}
            date={dailyDate}
            historyDays={limits.dailyHistoryDays ?? DAILY_HISTORY_FALLBACK_DAYS}
            onDateChange={setDailyDate}
            onNotice={showNotice}
            onError={setError}
            onOpenPet={(petId) => setDashView({ type: 'detail', petId, tab: 'daily' })}
            onMedsChanged={(petId, meds) =>
              setAllMeds((prev) => ({ ...prev, [petId]: meds }))
            }
            onAddPet={() => setDashView({ type: 'add-pet' })}
          />
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
          ) : editView.type === 'edit-profile' ? (
            <ProfileEditScreen
              pet={detailPet}
              onDone={async () => { setEditView({ type: 'list' }); await loadPets(); }}
              onCancel={() => setEditView({ type: 'list' })}
              onError={setError}
              onNotice={showNotice}
            />
          ) : editView.type === 'doc' ? (
            <DocDetailScreen
              doc={editView.doc}
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
            />
          ) : (
            <PetDetailScreen
              pet={detailPet}
              initialTab={dashView.tab}
              docs={detailDocs}
              meds={allMeds[detailPet.id]}
              onMedsChanged={(meds) =>
                setAllMeds((prev) => ({ ...prev, [detailPet.id]: meds }))
              }
              limits={limits}
              onEditPet={() => setDashView({ type: 'edit-pet', petId: detailPet.id })}
              onPresent={() => setPresenting(true)}
              onEditProfile={() => setEditView({ type: 'edit-profile' })}
              onPetChanged={() => void loadPets()}
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
              onPassportChanged={() => void loadPets()}
              onUpgrade={() => setDashView({ type: 'settings' })}
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
              onNavigateToPet={(petId, tab) => setDashView({ type: 'detail', petId, tab })}
            />
            <h1 className="large-title">Pets</h1>
            <div className="pet-pins">
              {pets.map((pet) => (
                <PetPin
                  key={pet.id}
                  pet={pet}
                  docs={allDocs[pet.id]}
                  meds={allMeds[pet.id]}
                  docsLoading={allDocsLoading}
                  onSelect={() => setDashView({ type: 'detail', petId: pet.id })}
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
            {pets.length > limits.maxPets ? (
              // Over the cap (downgraded/lapsed plan): softer framing — their
              // data is intact, some pets just stopped accepting new records.
              <p className="pet-pins__limit">
                Your plan includes {limits.maxPets} pets, so{' '}
                {pets.length - limits.maxPets === 1
                  ? 'one of your pets is'
                  : `${pets.length - limits.maxPets} of your pets are`}{' '}
                read-only — everything stays viewable.
                {/* App Store 3.1.1: no external-purchase steering on iOS */}
                {!isNative && (
                  <>
                    {' '}
                    <button
                      className="btn btn--link"
                      onClick={() => setDashView({ type: 'settings' })}
                    >
                      Upgrade to unlock →
                    </button>
                  </>
                )}
              </p>
            ) : pets.length === limits.maxPets ? (
              <p className="pet-pins__limit">
                You're at the {limits.maxPets}-pet limit.{' '}
                {limits.plan === 'free' ? (
                  // App Store 3.1.1: no external-purchase steering on iOS
                  isNative ? null : (
                    <button
                      className="btn btn--link"
                      onClick={() => setDashView({ type: 'settings' })}
                    >
                      Upgrade for more →
                    </button>
                  )
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
              onReminders={() => setDashView({ type: 'settings' })}
            />
          </>
        )}
        </div>
      </main>
      {pets !== null && <TabBar active={activeTab} onSelect={handleTabSelect} />}
      <SiteFooter />
      {presenting && detailPet && detailDocs.length > 0 && (
        <PresentScreen
          pet={detailPet}
          docs={detailDocs}
          onExit={() => setPresenting(false)}
        />
      )}
    </>
  );
}

// ---- account menu (header avatar chip) ----

function AccountMenu({
  email,
  onSettings,
  onChangePassword,
  onLogout,
}: {
  email: string;
  onSettings: () => void;
  onChangePassword: () => void;
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
          <button
            role="menuitem"
            onClick={() => { setOpen(false); onSettings(); }}
          >
            Settings
          </button>
          <button
            role="menuitem"
            onClick={() => { setOpen(false); onChangePassword(); }}
          >
            Change password
          </button>
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
  onNavigateToPet: (petId: string, tab: 'records' | 'meds' | 'profile') => void;
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
}: {
  pet: Pet;
  docs: Doc[] | undefined;
  meds: Med[] | undefined;
  docsLoading: boolean;
  onSelect: () => void;
}) {
  const status = docs ? petOverallStatus(docs, meds) : 'none';
  const subLine = docsLoading && !docs ? 'Loading…' : petPinStatus(docs ?? [], meds);

  return (
    <button
      className="pet-pin"
      onClick={onSelect}
      aria-label={`View ${pet.name}'s records — ${subLine}`}
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

function PetForm({
  pet,
  submitLabel,
  onDone,
  onCancel,
  onDeletePet,
  onError,
  onNotice,
}: {
  pet?: Pet; // absent = create mode
  submitLabel: string;
  onDone: (pet?: Pet) => Promise<void>;
  onCancel?: () => void;
  onDeletePet?: (petId: string) => void;
  onError: (msg: string | null) => void;
  onNotice: (msg: string) => void;
}) {
  const [name, setName] = useState(pet?.name ?? '');
  const [species, setSpecies] = useState(pet?.species ?? 'dog');
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
      if (photo.size > MAX_AVATAR_BYTES) {
        onError(`That photo is ${formatSize(photo.size)} - the limit is 5 MB.`);
        return;
      }
    }
    setBusy(true);
    onError(null);
    try {
      const saved = pet
        ? await updatePet(pet.id, { name: name.trim(), species })
        : await createPet(name.trim(), species);
      if (photo) await uploadAvatar(saved.pet.id, photo);
      onNotice(pet ? 'Pet updated' : `${saved.pet.name} added`);
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
        Photo (optional · JPG, PNG · max 5 MB)
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
      {pet && onDeletePet && !pet.household && (
        <div className="actions">
          <button
            type="button"
            className="btn btn--link btn--danger"
            onClick={() => onDeletePet(pet.id)}
            disabled={busy}
          >
            Delete {pet.name}…
          </button>
        </div>
      )}
      {pet?.household && (
        <p className="subtle">
          {pet.name} is a family pet — only the family owner can delete it.
        </p>
      )}
    </form>
  );
}

// ---- vaccine status ----

// Headline health check across all documents: the most severe status wins.
function StatusSummary({ docs }: { docs: Doc[] }) {
  const dated = docs.filter((d) => d.expiry);
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
  docs,
  meds,
  onMedsChanged,
  limits,
  onEditPet,
  onPresent,
  onEditProfile,
  onPetChanged,
  onViewDoc,
  onEditDoc,
  onReviewExtraction,
  onDocsChanged,
  onPassportChanged,
  onUpgrade,
  onError,
  onNotice,
}: {
  pet: Pet;
  initialTab?: 'records' | 'daily' | 'meds' | 'profile' | 'passport';
  docs: Doc[];
  meds: Med[] | undefined;
  onMedsChanged: (meds: Med[]) => void;
  limits: Limits;
  onEditPet: () => void;
  onPresent: () => void;
  onEditProfile: () => void;
  onPetChanged: () => void; // weight log syncs the profile's display weight
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
  onPassportChanged: () => void;
  onUpgrade: () => void;
  onError: (msg: string | null) => void;
  onNotice: (msg: string) => void;
}) {
  // Records is the landing tab; the every-day surface moved to the app-level
  // Daily tab in the bottom bar, so opening a specific pet means its records.
  const [tab, setTab] = useState<'records' | 'daily' | 'meds' | 'profile' | 'passport'>(initialTab ?? 'records');
  const [showPhoto, setShowPhoto] = useState(false);
  // Count on the Meds tab: meds needing action right now (due/overdue).
  const medsDue = trackedMeds(meds).filter(
    (m) => medStatus(m).status !== 'current',
  ).length;

  return (
    <div className="screen-view">
      {/* Left slot: Present (records only). Right slot: Edit — always top-right,
          scoped to the active tab (records = pet, profile = health profile). */}
      <nav className="screen-nav">
        {(tab === 'records' || tab === 'daily') && docs.length > 0 ? (
          <button className="screen-nav__back btn btn--link present-trigger" type="button" onClick={onPresent}>
            ▶ Present Rabies Shots
          </button>
        ) : (
          <span />
        )}
        {tab === 'records' ? (
          <button className="screen-nav__action btn btn--link" type="button" onClick={onEditPet}>
            ✎ Edit
          </button>
        ) : tab === 'profile' ? (
          <button className="screen-nav__action btn btn--link" type="button" onClick={onEditProfile}>
            ✎ Edit
          </button>
        ) : (
          <span />
        )}
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

        <div className="tab-bar">
          <button
            className={`tab-bar__tab${tab === 'records' ? ' tab-bar__tab--active' : ''}`}
            onClick={() => { hapticTap(); setTab('records'); }}
          >
            Records
          </button>
          <button
            className={`tab-bar__tab${tab === 'daily' ? ' tab-bar__tab--active' : ''}`}
            onClick={() => { hapticTap(); setTab('daily'); }}
          >
            Daily
          </button>
          <button
            className={`tab-bar__tab${tab === 'meds' ? ' tab-bar__tab--active' : ''}`}
            onClick={() => { hapticTap(); setTab('meds'); }}
          >
            Meds
            {medsDue > 0 && <span className="tab-badge">{medsDue}</span>}
          </button>
          <button
            className={`tab-bar__tab${tab === 'profile' ? ' tab-bar__tab--active' : ''}`}
            onClick={() => { hapticTap(); setTab('profile'); }}
          >
            Profile
          </button>
          <button
            className={`tab-bar__tab${tab === 'passport' ? ' tab-bar__tab--active' : ''}`}
            onClick={() => { hapticTap(); setTab('passport'); }}
          >
            Passport
            {pet.passportToken && <span className="tab-dot" aria-hidden="true" />}
          </button>
        </div>

        {tab === 'records' ? (
          <>
            {docs.length > 0 && <StatusSummary docs={docs} />}
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
          <DailySection petId={pet.id} onError={onError} onMedsChanged={onMedsChanged} />
        ) : tab === 'meds' ? (
          <MedsSection
            petId={pet.id}
            maxMeds={limits.maxMeds}
            readOnly={pet.active === false}
            onUpgrade={onUpgrade}
            onError={onError}
            onNotice={onNotice}
            onMedsChanged={onMedsChanged}
          />
        ) : tab === 'profile' ? (
          <>
            <ProfileSection pet={pet} onEdit={onEditProfile} />
            <WeightSection petId={pet.id} onPetChanged={onPetChanged} onError={onError} />
          </>
        ) : (
          <PassportTabSection
            pet={pet}
            onPassportChanged={onPassportChanged}
            onNotice={onNotice}
            onError={onError}
          />
        )}
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

// The bottom tab bar's "Daily" tab: every pet's checklist + mood in one
// screen — open the app, check off breakfast, done. Reuses DailySection
// per pet (it's self-contained: loads its own data by petId). The title is a
// date dropdown, and horizontal swipes step a day back/forward, so past days
// are one gesture away (read-only; depth is plan-gated via historyDays).
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

function DailyAllScreen({
  pets,
  date,
  historyDays,
  onDateChange,
  onNotice,
  onError,
  onOpenPet,
  onMedsChanged,
  onAddPet,
}: {
  pets: Pet[];
  date: string;
  historyDays: number;
  onDateChange: (date: string) => void;
  onNotice: (msg: string) => void;
  onError: (msg: string | null) => void;
  onOpenPet: (petId: string) => void;
  onMedsChanged: (petId: string, meds: Med[]) => void;
  onAddPet: () => void;
}) {
  const touchRef = useRef<{ x: number; y: number } | null>(null);
  const today = localToday();
  const minDate = addDays(today, -(historyDays - 1));

  function step(delta: -1 | 1) {
    const next = addDays(date, delta);
    if (next > today) return; // already on today — nothing newer to show
    if (next < minDate) {
      onNotice(
        historyDays > 14
          ? 'That’s the end of the saved history.'
          : 'Daily history goes back 2 weeks on your plan.',
      );
      return;
    }
    hapticTap();
    onDateChange(next);
  }

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
    <div
      className="daily-all"
      onTouchStart={(e) => {
        touchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }}
      onTouchEnd={(e) => {
        const start = touchRef.current;
        touchRef.current = null;
        if (!start) return;
        const dx = e.changedTouches[0].clientX - start.x;
        const dy = e.changedTouches[0].clientY - start.y;
        // Horizontal swipe: right = back a day, left = forward.
        if (Math.abs(dx) > 60 && Math.abs(dy) < 50) step(dx > 0 ? -1 : 1);
      }}
    >
      <DateNav date={date} historyDays={historyDays} onChange={onDateChange} />
      {date !== today && (
        <p className="daily-past-note" role="status">
          Viewing a past day — swipe left or tap the date to get back to today.
        </p>
      )}
      {pets.map((pet) => (
        <section key={pet.id} className="daily-all__pet">
          <button
            type="button"
            className="daily-all__pet-header"
            onClick={() => onOpenPet(pet.id)}
          >
            <PetAvatar pet={pet} size={40} />
            <span className="daily-all__pet-name">{pet.name}</span>
            <span className="daily-all__chevron" aria-hidden="true">›</span>
          </button>
          <DailySection
            petId={pet.id}
            date={date}
            onError={onError}
            onMedsChanged={(meds) => onMedsChanged(pet.id, meds)}
          />
        </section>
      ))}
    </div>
  );
}

function DailySection({
  petId,
  date,
  onError,
  onMedsChanged,
}: {
  petId: string;
  date?: string; // defaults to today; past days render read-only
  onError: (msg: string | null) => void;
  onMedsChanged: (meds: Med[]) => void;
}) {
  const [state, setState] = useState<DailyState | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [newItem, setNewItem] = useState('');
  const [newIsCounter, setNewIsCounter] = useState(false);
  const [busy, setBusy] = useState(false);
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
      await saveDailyItems(petId, items);
      load();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not save the list');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="subtle">Loading…</p>;
  if (!state) return null;

  const customItems = state.items.filter((i) => !i.med);
  const doneCount = state.items.filter((i) => state.checks[i.id]).length;

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

      {state.items.length === 0 && (
        <p className="subtle">
          {readOnly
            ? 'Nothing recorded on this day.'
            : 'Nothing on the list — add feeding times, walks, or meds.'}
        </p>
      )}

      {state.items.map((item) => {
        const checkInfo = state.checks[item.id];
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
        if (item.kind === 'counter') {
          const count = checkInfo?.count ?? 0;
          return (
            <div className={`daily-item${count > 0 ? ' daily-item--done' : ''}`} key={item.id}>
              <span className="daily-item__countpill" aria-label={`${item.name}: ${count} today`}>
                {count}
              </span>
              <span className="daily-item__name">
                {item.name}
                {checkInfo && (
                  <span className="subtle daily-item__who">
                    last: {whoAndWhen(checkInfo.by, checkInfo.at)}
                  </span>
                )}
              </span>
              {removeBtn ||
                (!readOnly && (
                  <span className="daily-item__counter-btns">
                    <button
                      type="button"
                      className="btn daily-item__count-btn"
                      aria-label={`Remove one ${item.name}`}
                      disabled={count === 0}
                      onClick={() => void toggle(item, false)}
                    >
                      −
                    </button>
                    <button
                      type="button"
                      className="btn daily-item__count-btn"
                      aria-label={`Add one ${item.name}`}
                      onClick={() => void toggle(item, true)}
                    >
                      +
                    </button>
                  </span>
                ))}
            </div>
          );
        }
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
            setNewIsCounter(false);
            void saveItems([
              ...customItems,
              { name, ...(newIsCounter ? { kind: 'counter' as const } : {}) },
            ]);
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
          <label className="daily__add-kind subtle">
            <input
              type="checkbox"
              checked={newIsCounter}
              onChange={(e) => setNewIsCounter(e.target.checked)}
            />
            Count it (can happen several times a day)
          </label>
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

// Friendly framing for the machine-readable analyze errors — every one of
// these lands the user on the manual form with their upload intact.
function aiFailureNote(message: string): string {
  if (message === 'AI_QUOTA_EXCEEDED')
    return "You've used today's document scans — fill in the details below and they'll save just the same.";
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
      ) : (
        <ul className="doc-list">
          {docs.map((doc) => (
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

  return (
    <li className="doc-item">
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
  onBack,
  onEdit,
}: {
  doc: Doc;
  onBack: () => void;
  onEdit: () => void;
}) {
  const status = statusOf(doc.expiry);
  const blurb = vaccineBlurb(doc.label);
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

        {doc.given && (
          <p className="subtle doc-detail__given">💉 Given {formatDate(doc.given)}</p>
        )}

        {blurb && <p className="doc-detail__blurb">{blurb}</p>}

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

  const allRows = groups.flatMap(g => g.rows);
  const included = allRows.filter(r => r.include);
  const overBudget = included.length > remaining;
  const missingLabel = included.some(r => !r.label.trim());

  const cadenceFor = (label: string) => VACCINE_CADENCES.find((c) => c.match.test(label));

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

    setBusy(true);
    onError(null);
    try {
      if (uploadId) {
        await commitUpload(pet.id, uploadId, records, profileApplied ? profile : undefined);
      } else {
        await createManualRecords(pet.id, records);
      }
      const noun = records.length === 1 ? 'Record added' : `${records.length} records added`;
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

          {allRows.length > remaining && (
            <p className="subtle" style={{ marginTop: '0.75rem' }}>
              Your plan has {remaining} record slot{remaining === 1 ? '' : 's'} left for {pet.name}
              {overBudget ? ` — skip ${included.length - remaining} to save.` : '.'}
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

  function handleMarkGiven(med: Med) {
    hapticSuccess();
    const today = todayYMD();
    const nextDue = addInterval(today, med.interval, med.unit);
    const next = (meds ?? []).map((m) =>
      m.id === med.id ? { ...m, lastGiven: today, nextDue } : m,
    );
    void persist(next, `${med.name} marked as given — next due ${formatDate(nextDue)}`);
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
                onMarkGiven={() => handleMarkGiven(med)}
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
  onMarkGiven,
  onToggleReminders,
  onEdit,
  onDelete,
  onDismiss,
}: {
  med: Med;
  busy: boolean;
  onMarkGiven: () => void;
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
          {med.lastGiven === todayYMD() ? (
            // Already given today — show it plainly instead of an armable
            // button that would advance the schedule a second time.
            <span className="med-given-today">✓ Given today</span>
          ) : (
            <button className="btn med-give" onClick={onMarkGiven} disabled={busy}>
              ✓ Mark as given
            </button>
          )}
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

function ProfileSection({ pet, onEdit }: { pet: Pet; onEdit: () => void }) {
  const hasAny = pet.breed || pet.dob || pet.weight || pet.allergies || pet.behavior ||
    pet.vetName || pet.emergencyContact || pet.microchip || pet.fixed !== undefined || pet.notes;

  if (!hasAny) {
    return (
      <div className="profile-empty">
        <p className="subtle">No health profile yet.</p>
        <button className="btn btn--primary" onClick={onEdit}>Add profile details</button>
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
  onError,
  onNotice,
}: {
  pet: Pet;
  onDone: () => Promise<void>;
  onCancel: () => void;
  onError: (msg: string | null) => void;
  onNotice: (msg: string) => void;
}) {
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

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    onError(null);
    try {
      await updatePet(pet.id, {
        name: pet.name,
        species: pet.species,
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
      });
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
        <p className="profile-form__hint subtle">All fields are optional.</p>

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
          <button className="btn btn--primary" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save profile'}
          </button>
          <button className="btn" type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

// ---- present mode (full-screen swipeable carousel) ----

export function PresentScreen({
  pet,
  docs,
  onExit,
}: {
  pet: Pet;
  docs: Doc[];
  onExit: () => void;
}) {
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
        {docs.map((doc) => {
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
        {docs.length > 1 && (
          <div className="present__dots" aria-hidden="true">
            {docs.map((_, i) => (
              <span key={i} className={`present__dot${i === current ? ' present__dot--active' : ''}`} />
            ))}
          </div>
        )}
        {docs.length > 1 && (
          <span className="present__counter">{current + 1} / {docs.length}</span>
        )}
      </div>
    </div>
  );
}

// ---- settings screen ----
// (REMINDER_DAY_OPTIONS lives in productConfig.ts — must match the server's
// accepted values.)

function SettingsScreen({
  email,
  limits,
  theme,
  onThemeChange,
  onDone,
  onChangePassword,
  onLogout,
  onError,
  onAccountDeleted,
}: {
  email: string;
  limits: Limits;
  theme: Theme;
  onThemeChange: (t: Theme) => void;
  onDone: () => void;
  onChangePassword: () => void;
  onLogout: () => void;
  onError: (msg: string | null) => void;
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

  // Both hand the browser to a Stripe-hosted page; errors keep the user here.
  async function handleCheckout(interval: 'month' | 'year') {
    setBusy(true);
    onError(null);
    try {
      const { url } = await createCheckout(interval);
      window.location.href = url;
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not start checkout');
      setBusy(false);
    }
  }

  async function handlePortal() {
    setBusy(true);
    onError(null);
    try {
      const { url } = await createBillingPortal();
      window.location.href = url;
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      onError(
        msg.includes('no billing account')
          ? "Your plan isn't managed through Stripe — contact support to change it."
          : msg || 'Could not open billing',
      );
      setBusy(false);
    }
  }

  useEffect(() => {
    getSettings()
      .then((s) => setSettings({ ...DEFAULT_SETTINGS, ...s, email: s.email || email }))
      .catch(() => setSettings({ ...DEFAULT_SETTINGS, email }))
      .finally(() => setLoading(false));
  }, [email]);

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
        <span className="screen-nav__title">Settings</span>
      </nav>
      <div className="screen-view__body">
        {loading ? (
          <p className="subtle">Loading…</p>
        ) : (
          <div className="form settings-form">

            <fieldset className="settings-group">
              <legend>Account</legend>
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
            </fieldset>

            <fieldset className="settings-group">
              <legend>Plan</legend>
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
                {isNative ? (
                  // App Store 3.1.1: never steer free users to an external
                  // purchase from the iOS app. Paid users may be told where
                  // their existing subscription is managed (account mgmt).
                  limits.plan === 'paid' ? (
                    <p className="subtle plan-fine-print">
                      Your subscription is managed on the web at petshots.app.
                    </p>
                  ) : null
                ) : limits.plan === 'free' ? (
                  <>
                    <button
                      type="button"
                      className="btn btn--primary"
                      disabled={busy}
                      onClick={() => void handleCheckout('month')}
                    >
                      Upgrade · $5/mo
                    </button>
                    <button
                      type="button"
                      className="btn btn--primary"
                      disabled={busy}
                      onClick={() => void handleCheckout('year')}
                    >
                      $49/yr · 2 months free
                    </button>
                    <p className="subtle plan-fine-print">
                      Paid plan: {PAID_PLAN_LIMITS.maxPets} pets, up to {PAID_PLAN_LIMITS.maxDocs} records per pet,{' '}
                      {PAID_PLAN_LIMITS.maxMeds} medications per pet.
                    </p>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => void handlePortal()}
                  >
                    Manage billing
                  </button>
                )}
              </div>
            </fieldset>

            <FamilySection onError={onError} />

            <fieldset className="settings-group">
              <legend>Appearance</legend>
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
            </fieldset>

            <fieldset className="settings-group">
              <legend>Email</legend>
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
            </fieldset>

            <fieldset className="settings-group settings-group--danger">
              <legend>Danger zone</legend>
              {!deleteOpen ? (
                <div className="settings-row">
                  <span className="settings-row__label">
                    Delete account
                    <span className="subtle settings-row__sub">
                      Permanently removes your pets, records, and account
                    </span>
                  </span>
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
                    medications, and any shared passport links. An active subscription is cancelled.
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
            </fieldset>

            <div className="actions">
              <button className="btn btn--primary" type="button" onClick={onDone} disabled={busy}>
                Done
              </button>
              <span className="subtle settings-save-status" role="status">
                {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'saved' ? 'Saved' : ''}
              </span>
            </div>
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
function FamilySection({ onError }: { onError: (msg: string | null) => void }) {
  const [household, setHousehold] = useState<Household | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null); // invite token
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null); // member sub
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
      <fieldset className="settings-group">
        <legend>Family</legend>
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
      </fieldset>
    );
  }

  const seatsUsed = household.members.length + household.invites.length;
  return (
    <fieldset className="settings-group">
      <legend>Family</legend>
      <p className="subtle">
        Family members see and update your pets' records, meds, and reminders.
        They can't delete pets or manage share links.
      </p>

      {household.members.map((m) => (
        <div className="settings-row" key={m.sub}>
          <span className="settings-row__label">
            {m.email}
            <span className="subtle settings-row__sub">Member since {formatDate(m.joinedAt.slice(0, 10))}</span>
          </span>
          {confirmRemove === m.sub ? (
            <span className="actions">
              <button className="btn btn--danger" type="button" disabled={busy} onClick={() => void handleRemove(m.sub)}>
                Remove
              </button>
              <button className="btn" type="button" disabled={busy} onClick={() => setConfirmRemove(null)}>
                Keep
              </button>
            </span>
          ) : (
            <button className="btn btn--link btn--danger" type="button" onClick={() => setConfirmRemove(m.sub)}>
              Remove…
            </button>
          )}
        </div>
      ))}

      {household.invites.map((i) => (
        <div className="settings-row" key={i.token}>
          <span className="settings-row__label">
            {i.sentTo ? `Invite sent to ${i.sentTo}` : 'Invite link (pending)'}
            <span className="subtle settings-row__sub">Expires {formatDate(i.expiresAt.slice(0, 10))}</span>
          </span>
          <span className="actions">
            <button className="btn" type="button" onClick={() => void handleShare(i.url, i.token)}>
              {copied === i.token ? 'Copied!' : 'Share'}
            </button>
            <button className="btn btn--link btn--danger" type="button" disabled={busy} onClick={() => void handleRevoke(i.token)}>
              Revoke
            </button>
          </span>
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
          {household.maxMembers === 1
            ? 'Your plan includes 1 family member.'
            : `All ${household.maxMembers} member seats on your plan are in use.`}
          {household.maxMembers === 1 && seatsUsed >= 1 ? ' Upgrade for up to 5.' : ''}
        </p>
      )}
    </fieldset>
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

