import type { Pet, Doc, Med } from '../api';
import { NOTICES } from '../productConfig';

// ---- types ----

export type NoticeType =
  | 'overdue'
  | 'duesoon-critical'
  | 'duesoon-warning'
  | 'duesoon-headsup'
  | 'med-overdue'
  | 'med-due'
  | 'birthday-today'
  | 'birthday-soon'
  | 'dob-nudge';

export interface Notice {
  id: string;
  type: NoticeType;
  petId: string;
  petName: string;
  message: string;
  priority: number;       // lower = shown first
  resetAfterDays: number; // how long a dismissal lasts; 0 = session-only
}

// ---- thresholds ----
// Values live in productConfig.ts (NOTICES) — edit them there. The
// resetAfterDays per notice type below is UX texture and stays local.

const { CRITICAL_DAYS, WARNING_DAYS, HEADSUP_DAYS, BIRTHDAY_DAYS, DOB_NUDGE_DAYS } = NOTICES;
export const MAX_NOTICES = NOTICES.MAX_NOTICES;

// ---- date helpers ----

function todayMidnight(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysUntil(dateStr: string): number {
  const d = new Date(`${dateStr}T00:00:00`);
  return Math.round((d.getTime() - todayMidnight().getTime()) / 86_400_000);
}

// Returns days until the pet's next birthday (0 = today, 1 = tomorrow, …).
// Always returns a non-negative number — uses next-year date if this year's has passed.
function daysUntilBirthday(dob: string): number {
  const t = todayMidnight();
  const birth = new Date(`${dob}T00:00:00`);
  const thisYear = new Date(t.getFullYear(), birth.getMonth(), birth.getDate());
  const nextYear = new Date(t.getFullYear() + 1, birth.getMonth(), birth.getDate());
  const days = Math.round((thisYear.getTime() - t.getTime()) / 86_400_000);
  return days >= 0 ? days : Math.round((nextYear.getTime() - t.getTime()) / 86_400_000);
}

function humanDays(days: number): string {
  if (days === 0)   return 'today';
  if (days === 1)   return 'tomorrow';
  if (days === -1)  return 'yesterday';
  if (days < 0)     return `${Math.abs(days)} days ago`;
  if (days <= 6)    return `in ${days} days`;
  if (days <= 13)   return 'in about a week';
  if (days <= 20)   return 'in about 2 weeks';
  if (days <= 45)   return 'in about a month';
  if (days <= 75)   return 'in about 6 weeks';
  return `in about ${Math.round(days / 30)} months`;
}

// ---- dismissal (localStorage) ----

const DISMISS_PREFIX = 'petshots.notice.dismissed.';

export function isDismissed(notice: Notice): boolean {
  const raw = localStorage.getItem(DISMISS_PREFIX + notice.id);
  if (!raw) return false;
  if (notice.resetAfterDays <= 0) return false; // never stays dismissed
  const daysSince = (Date.now() - Number(raw)) / 86_400_000;
  return daysSince < notice.resetAfterDays;
}

export function dismissNotice(notice: Notice): void {
  localStorage.setItem(DISMISS_PREFIX + notice.id, String(Date.now()));
}

// Which pet-detail surface a notice should deep-link to when tapped.
// Med notices land on DAILY, not Meds: any med with nextDue <= today is a row
// on the Daily list, and checking it off there IS marking it given — the Meds
// tab is schedule management, not the place you act on "due today".
export function noticeTab(type: NoticeType): 'records' | 'meds' | 'profile' | 'daily' {
  if (type === 'med-overdue' || type === 'med-due') return 'daily';
  if (type.startsWith('birthday') || type === 'dob-nudge') return 'profile';
  return 'records';
}

// ---- compute ----

export function computeNotices(
  pets: Pet[],
  allDocs: Record<string, Doc[]>,
  allMeds: Record<string, Med[]> = {},
): Notice[] {
  const notices: Notice[] = [];
  const year = new Date().getFullYear();
  let dobNudgeCount = 0; // at most one dob-nudge shown at a time

  for (const pet of pets) {
    const docs = allDocs[pet.id] ?? [];

    // --- medications (dismissed = "stop tracking", never surfaces) ---
    for (const med of allMeds[pet.id] ?? []) {
      if (med.dismissed === true || !med.nextDue) continue;
      const days = daysUntil(med.nextDue);
      if (days < 0) {
        const when = days === -1 ? 'yesterday' : `${Math.abs(days)} days ago`;
        notices.push({
          id: `med-overdue-${med.id}-${med.nextDue}`,
          type: 'med-overdue',
          petId: pet.id,
          petName: pet.name,
          message: `💊 ${pet.name}'s ${med.name} was due ${when}.`,
          priority: 0,
          resetAfterDays: 1,
        });
      } else if (days === 0) {
        notices.push({
          id: `med-due-${med.id}-${med.nextDue}`,
          type: 'med-due',
          petId: pet.id,
          petName: pet.name,
          message: `💊 ${pet.name}'s ${med.name} is due today.`,
          priority: 1,
          resetAfterDays: 1,
        });
      }
    }

    // --- vaccine / record expiry ---
    for (const doc of docs) {
      if (!doc.expiry) continue;
      const days = daysUntil(doc.expiry);

      if (days < 0) {
        // Overdue — always surfaced regardless of remindersEnabled (this is status, not a reminder)
        const when = days === -1 ? 'yesterday' : `${Math.abs(days)} days ago`;
        notices.push({
          id: `overdue-${doc.id}-${doc.expiry}`,
          type: 'overdue',
          petId: pet.id,
          petName: pet.name,
          message: `${pet.name}'s ${doc.label} expired ${when}.`,
          priority: 0,
          resetAfterDays: 1, // re-surfaces daily — they need to act
        });

      } else if (days <= CRITICAL_DAYS && doc.remindersEnabled !== false) {
        const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
        notices.push({
          id: `duesoon-critical-${doc.id}-${doc.expiry}`,
          type: 'duesoon-critical',
          petId: pet.id,
          petName: pet.name,
          message: `${pet.name}'s ${doc.label} expires ${when}.`,
          priority: 1,
          resetAfterDays: 1, // re-surfaces daily while critical
        });

      } else if (days <= WARNING_DAYS && doc.remindersEnabled !== false) {
        notices.push({
          id: `duesoon-warning-${doc.id}-${doc.expiry}`,
          type: 'duesoon-warning',
          petId: pet.id,
          petName: pet.name,
          message: `${pet.name}'s ${doc.label} is due ${humanDays(days)}.`,
          priority: 2,
          resetAfterDays: 7, // dismiss for a week, then resurface
        });

      } else if (days <= HEADSUP_DAYS && doc.remindersEnabled !== false) {
        notices.push({
          id: `duesoon-headsup-${doc.id}-${doc.expiry}`,
          type: 'duesoon-headsup',
          petId: pet.id,
          petName: pet.name,
          message: `Heads up — ${pet.name}'s ${doc.label} is due ${humanDays(days)}.`,
          priority: 3,
          resetAfterDays: 14,
        });
      }
    }

    // --- birthday ---
    if (pet.dob) {
      const days = daysUntilBirthday(pet.dob);
      if (days === 0) {
        notices.push({
          // Separate ID from birthday-soon so dismissing "in 14 days" doesn't hide "today"
          id: `birthday-today-${pet.id}-${year}`,
          type: 'birthday-today',
          petId: pet.id,
          petName: pet.name,
          message: `🎂 Today is ${pet.name}'s birthday!`,
          priority: 4,
          resetAfterDays: 1, // gone tomorrow
        });
      } else if (days <= BIRTHDAY_DAYS) {
        notices.push({
          id: `birthday-soon-${pet.id}-${year}`,
          type: 'birthday-soon',
          petId: pet.id,
          petName: pet.name,
          message: `🎂 ${pet.name}'s birthday is ${humanDays(days)}.`,
          priority: 5,
          resetAfterDays: 7, // resurfaces weekly while in the window
        });
      }
    } else if (docs.length > 0 && dobNudgeCount === 0) {
      // Only nudge once per dashboard load (lowest priority, one pet at a time)
      dobNudgeCount++;
      notices.push({
        id: `dob-nudge-${pet.id}`,
        type: 'dob-nudge',
        petId: pet.id,
        petName: pet.name,
        message: `Add ${pet.name}'s date of birth to get birthday reminders.`,
        priority: 10,
        resetAfterDays: DOB_NUDGE_DAYS,
      });
    }
  }

  // Most urgent first; within same priority, alphabetical by pet name
  notices.sort((a, b) =>
    a.priority !== b.priority
      ? a.priority - b.priority
      : a.petName.localeCompare(b.petName),
  );

  return notices;
}
