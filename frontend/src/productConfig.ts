/**
 * ============================================================================
 * PETSHOTS PRODUCT CONFIG — FRONTEND
 * ============================================================================
 *
 * Every product-tunable number for the SPA lives in this one file (deployment
 * wiring — Cognito ids, API URL — stays in config.ts; don't mix them up).
 *
 * HOW TO CHANGE A VALUE
 *   1. Edit the constant below (read its comment first — units are in the name).
 *   2. cd frontend && npm run build           -> typecheck + bundle
 *   3. aws s3 sync dist/ s3://petshots-frontend --delete
 *   4. aws cloudfront create-invalidation --distribution-id E132NGTOIUI26J --paths '/*'
 *   5. (native app) npx cap sync ios + rebuild in Xcode, or the app drifts
 *      behind the web bundle.
 *
 * Values marked "MUST MATCH" have a backend twin in
 * infra/lambda/shared/config.ts — change both files in the same deploy.
 * The backend is authoritative for anything it enforces (limits arrive at
 * runtime via GET /pets); the constants here cover pre-fetch defaults,
 * client-side pre-checks, and display copy.
 */

/** UPLOADS — client-side pre-checks (the server enforces its own copies). */
export const UPLOADS = {
  /**
   * Largest document the picker accepts. MUST MATCH UPLOADS.MAX_FILE_BYTES
   * in infra/lambda/shared/config.ts (the S3 POST policy rejects anything
   * bigger server-side; this check just fails fast with a friendly toast).
   */
  MAX_FILE_BYTES: 20 * 1024 * 1024, // 20 MB
  /** Pet photo cap. MUST MATCH backend UPLOADS.MAX_AVATAR_BYTES. The client
   *  compresses to ~300 KB before upload anyway, so this rarely bites. */
  MAX_AVATAR_BYTES: 5 * 1024 * 1024, // 5 MB
} as const;

/** DASHBOARD STATUS BADGES */
export const DASHBOARD = {
  /** Vaccine records within this many days of expiry show the amber
   *  "due soon" state (pins, pills, summary banner). */
  DUE_SOON_DAYS: 30,
  /**
   * Med due-soon lookahead cap. The effective window per med is
   * min(MED_LOOKAHEAD_MAX_DAYS, intervalDays - 1) so a daily med only alarms
   * on its actual due day instead of flipping amber the moment it's given.
   * MUST MATCH REMINDERS.MED_HEADSUP_DAYS in infra/lambda/shared/config.ts
   * so the dashboard pill and the heads-up email agree.
   */
  MED_LOOKAHEAD_MAX_DAYS: 3,
} as const;

/**
 * OVERVIEW NOTICE STRIP (the dismissible banners above "Your Pets").
 * Windows are days-until-expiry bands; how long a dismissal lasts per band
 * (resetAfterDays) is set alongside the notice-building code in
 * utils/notices.ts — it's UX texture, not a product number.
 */
export const NOTICES = {
  /** <= this many days: urgent band, re-surfaces daily even if dismissed. */
  CRITICAL_DAYS: 7,
  /** Up to this many days: warning band, re-surfaces after 7 days. */
  WARNING_DAYS: 30,
  /** Up to this many days: heads-up band, re-surfaces after 14 days. */
  HEADSUP_DAYS: 60,
  /** Show the birthday notice within this many days of the big day. */
  BIRTHDAY_DAYS: 14,
  /** Re-nudge about a missing date of birth after this many days. */
  DOB_NUDGE_DAYS: 90,
  /** Most notices shown at once (highest priority wins). */
  MAX_NOTICES: 4,
} as const;

/**
 * REMINDER SETTINGS UI.
 * The values users can pick MUST MATCH REMINDERS.VALID_REMINDER_DAYS in
 * infra/lambda/shared/config.ts — the server drops anything else on save.
 */
export const REMINDER_DAY_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: '1 day before' },
  { value: 3, label: '3 days before' },
  { value: 7, label: '1 week before' },
  { value: 14, label: '2 weeks before' },
  { value: 30, label: '1 month before' },
  { value: 60, label: '2 months before' },
];

/** Milestones assumed before the user saves Settings. MUST MATCH
 *  REMINDERS.DEFAULT_REMINDER_DAYS in infra/lambda/shared/config.ts. */
export const DEFAULT_REMINDER_DAYS: readonly number[] = [7, 30];

/**
 * PLAN LIMITS FOR DISPLAY. The server is the enforcer and sends real limits
 * with GET /pets; these cover the moment before that response arrives
 * (free-tier values) and the plan card's paid fine print.
 * MUST MATCH LIMITS_FREE / LIMITS_PAID in infra/lambda/shared/config.ts.
 */
export const FREE_PLAN_LIMITS = { maxPets: 2, maxDocs: 8, maxMeds: 4, maxMembers: 1 } as const;
export const PAID_PLAN_LIMITS = { maxPets: 10, maxDocs: 999, maxMeds: 20 } as const;

/**
 * TYPICAL BOOSTER CADENCES — tap-to-fill expiry suggestions on the AI review
 * screen when the document printed neither a date nor a duration. Never
 * auto-applied: protocols genuinely vary (1yr vs 3yr rabies), the user picks.
 */
export const VACCINE_CADENCES: {
  match: RegExp;
  label: string;
  options: { text: string; months: number }[];
}[] = [
  { match: /rabies/i, label: 'Rabies', options: [{ text: '1 year', months: 12 }, { text: '3 years', months: 36 }] },
  { match: /dhpp|da2pp|dapp|distemper|parvo/i, label: 'DHPP', options: [{ text: '1 year', months: 12 }, { text: '3 years', months: 36 }] },
  { match: /bordetella|kennel cough/i, label: 'Bordetella', options: [{ text: '6 months', months: 6 }, { text: '1 year', months: 12 }] },
  { match: /lepto/i, label: 'Leptospirosis', options: [{ text: '1 year', months: 12 }] },
  { match: /lyme/i, label: 'Lyme', options: [{ text: '1 year', months: 12 }] },
  { match: /influenza|canine.?flu/i, label: 'Influenza', options: [{ text: '1 year', months: 12 }] },
  { match: /fvrcp|rhinotracheitis|calici/i, label: 'FVRCP', options: [{ text: '1 year', months: 12 }, { text: '3 years', months: 36 }] },
  { match: /felv|feline.?leukemia/i, label: 'FeLV', options: [{ text: '1 year', months: 12 }] },
];
