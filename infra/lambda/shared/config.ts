/**
 * ============================================================================
 * PETSHOTS PRODUCT CONFIG — BACKEND SOURCE OF TRUTH
 * ============================================================================
 *
 * Every product-tunable number for the backend lives in this one file. It is:
 *   - bundled into BOTH Lambdas (api + reminder) by esbuild, and
 *   - imported by infra/lib/api-stack.ts at `cdk synth` time,
 * so the Lambda environment variables and the in-code fallbacks come from the
 * same constants — they cannot drift apart.
 *
 * HOW TO CHANGE A VALUE
 *   1. Edit the constant below (read its comment first — units are in the name).
 *   2. cd infra && npm run build              -> typecheck
 *   3. npx cdk diff PetshotsApiStack          -> ONLY your change should appear
 *   4. npx cdk deploy PetshotsApiStack
 *   5. Run the smoke suites (the /smoke-test skill, or see CLAUDE.md).
 *
 * Values marked "MUST MATCH" have a frontend twin in
 * frontend/src/productConfig.ts — change both files in the same deploy
 * (frontend deploy recipe is in that file's header).
 *
 * Deliberately NOT in this file (plumbing, not product): secret names, S3 key
 * layouts, CORS origins, APNs protocol details (priority/JWT refresh), the
 * Bedrock extraction prompt/schema, and MIME allow-lists. Those live next to
 * the code that uses them.
 */

/**
 * FREE-TIER LIMITS
 * Caps for accounts with no plan.json (or plan: 'free'). Limits gate CREATION
 * only — a user who ends up over a cap (downgrade) keeps everything and can
 * view/edit/delete; they just can't add more. A per-user plan.json may carry
 * `limits` overrides for comps.
 */
export const LIMITS_FREE = {
  /** Pets per account. Example: 2 means the third POST /pets returns 409. */
  MAX_PETS: 2,
  /** Vaccine/doc records per pet. */
  MAX_DOCS: 8,
  /** Medications per pet. */
  MAX_MEDS: 4,
  /** Family members besides the owner (pending invites count as seats). */
  MAX_MEMBERS: 1,
  /** AI document scans per user per day (bounds worst-case Bedrock spend). */
  MAX_AI_SCANS_PER_DAY: 10,
} as const;

/**
 * PAID-TIER LIMITS ($5/mo / $49/yr via Stripe).
 * MUST MATCH `PAID_PLAN_LIMITS` in frontend/src/productConfig.ts
 * (the plan card's fine print shows these numbers).
 */
export const LIMITS_PAID = {
  MAX_PETS: 10,
  MAX_DOCS: 999,
  MAX_MEDS: 20,
  MAX_MEMBERS: 5,
  MAX_AI_SCANS_PER_DAY: 50,
} as const;

/**
 * UPLOADS & PRESIGNED URLS
 */
export const UPLOADS = {
  /**
   * Hard cap on document uploads, enforced by S3 itself via the presigned
   * POST policy's content-length-range — a bigger file is rejected before it
   * costs anything. MUST MATCH UPLOADS.MAX_FILE_BYTES in
   * frontend/src/productConfig.ts (the client pre-check + error toast).
   */
  MAX_FILE_BYTES: 20 * 1024 * 1024, // 20 MB
  /** Pet photo cap (images only; the client compresses to ~300 KB anyway). */
  MAX_AVATAR_BYTES: 5 * 1024 * 1024, // 5 MB
  /**
   * Largest file the AI scan accepts. Bedrock InvokeModel caps the request
   * body at 25 MB and base64 inflates by 4/3, so ~15 MB is the practical
   * ceiling — larger uploads fall back to manual entry (never rejected).
   */
  MAX_AI_FILE_BYTES: 15 * 1024 * 1024, // 15 MB
  /** How long a presigned upload (POST policy) stays valid. */
  UPLOAD_URL_TTL_SECONDS: 300, // 5 minutes
  /** How long a presigned download/view link stays valid. */
  DOWNLOAD_URL_TTL_SECONDS: 3600, // 1 hour
  /**
   * S3 lifecycle: AI-extraction uploads sit in tmp/ until the user confirms
   * the review screen; anything abandoned is swept after this many days.
   */
  TMP_EXPIRY_DAYS: 1,
} as const;

/**
 * REMINDER EMAILS (the daily ReminderFn run)
 * ------------------------------------------
 * How the pieces combine for a VACCINE record with an expiry date:
 *
 *   upcoming  -> fires on any day the user picked in Settings
 *                (DEFAULT_REMINDER_DAYS until they choose), PLUS the forced
 *                FINAL_COUNTDOWN_DAYS so the last-mile warning never depends
 *                on which milestones they picked.
 *   day 0     -> always fires (expiry day itself).
 *   overdue   -> every OVERDUE_WEEKLY_INTERVAL_DAYS for the first
 *                OVERDUE_WEEKLY_WINDOW_DAYS, then every
 *                OVERDUE_MONTHLY_INTERVAL_DAYS — nags taper off instead of
 *                emailing forever. Example: expired Jan 1 -> emails Jan 8,
 *                15, 22, 29, then ~monthly (day 60, 90, ...).
 *
 * MEDICATIONS: fire on the due day, then the same overdue taper; meds with a
 * cadence of MED_HEADSUP_MIN_INTERVAL_DAYS or longer also get a single
 * heads-up MED_HEADSUP_DAYS before (meaningless for daily meds, so skipped).
 *
 * Per-record/per-med reminder toggles are absolute opt-outs — they suppress
 * even the forced countdown. settings.emailOptOut sits above everything.
 */
export const REMINDERS = {
  /**
   * Days-before-expiry milestones for users who never saved Settings.
   * MUST MATCH DEFAULT_REMINDER_DAYS in frontend/src/productConfig.ts.
   */
  DEFAULT_REMINDER_DAYS: [7, 30] as readonly number[],
  /**
   * The only days-before values a user may pick in Settings (PUT /settings
   * drops anything else). MUST MATCH REMINDER_DAY_OPTIONS in
   * frontend/src/productConfig.ts (the Settings chips).
   */
  VALID_REMINDER_DAYS: [1, 3, 7, 14, 30, 60] as readonly number[],
  /** Forced "final countdown" days — fire even if the user didn't pick them. */
  FINAL_COUNTDOWN_DAYS: [3, 1] as readonly number[],
  /** Overdue taper: weekly nags for this many days past expiry... */
  OVERDUE_WEEKLY_WINDOW_DAYS: 30,
  OVERDUE_WEEKLY_INTERVAL_DAYS: 7,
  /** ...then this interval forever after. */
  OVERDUE_MONTHLY_INTERVAL_DAYS: 30,
  /**
   * Med heads-up: "due in 3 days" advance notice. MUST MATCH the med
   * due-soon lookahead (MED_LOOKAHEAD_MAX_DAYS) in
   * frontend/src/productConfig.ts so email and dashboard pills agree.
   */
  MED_HEADSUP_DAYS: 3,
  /** No heads-up for meds cycling faster than this (daily insulin etc.). */
  MED_HEADSUP_MIN_INTERVAL_DAYS: 7,
  /**
   * A record uploaded ALREADY overdue may sit between taper ticks and get no
   * email for weeks — so the first daily scan after the object appears fires
   * a one-time nag. Object age under this window is true on exactly one run.
   */
  FIRST_SCAN_OVERDUE_WINDOW_MS: 24 * 60 * 60 * 1000, // 24 hours
  /**
   * When the daily run fires (EventBridge cron, UTC).
   * 9:00 UTC = 5 AM Eastern in summer, 4 AM in winter.
   */
  CRON_HOUR_UTC: 9,
  CRON_MINUTE: 0,
} as const;

/**
 * WEEKLY DIGEST (separate Sunday email: mood strip, checklist tallies, meds
 * given, weight delta). Only sends when the week held actual activity.
 */
export const DIGEST = {
  /** UTC weekday the digest goes out. 0 = Sunday, 1 = Monday, ... 6 = Saturday. */
  DAY_UTC: 0,
  /** How many days back the digest summarizes. Keep <= DAILY.LOG_RETENTION_DAYS
   *  or the digest would need to read the archive (it doesn't). */
  LOOKBACK_DAYS: 7,
} as const;

/**
 * PUSH NOTIFICATIONS (sent alongside reminder emails, never the digest)
 */
export const PUSH = {
  /** How long an undelivered web push waits at the push service before
   *  expiring — the reminder is stale news by the next daily run anyway. */
  WEB_PUSH_TTL_SECONDS: 12 * 3600, // 12 hours
  /** Same idea for native iOS (APNs apns-expiration header). */
  APNS_EXPIRY_SECONDS: 12 * 3600, // 12 hours
} as const;

/**
 * DAILY TAB (per-pet care checklist + mood)
 */
export const DAILY = {
  /** Max custom checklist items per pet ("Edit list" add cap). */
  MAX_ITEMS: 20,
  /** Max increments per counter item per day (the 💩 tally cap). */
  MAX_COUNTER_PER_DAY: 30,
  /**
   * Days of check/mood history kept in daily.json; older days roll into
   * append-only daily-archive/{YYYY-MM}.json (never deleted — future
   * "health trends" reports read from there). Must stay >= DIGEST.LOOKBACK_DAYS.
   */
  LOG_RETENTION_DAYS: 14,
  /**
   * Check-offs are keyed by the CLIENT's local date; accept dates within this
   * window of server time — enough for any timezone, too tight to backfill
   * or forge history. Applies to WRITES (check/mood); reads may look further
   * back — see HISTORY_DAYS_* below.
   */
  DATE_WINDOW_MS: 2.5 * 86_400_000, // ±2.5 days
  /**
   * How far back GET /pets/{petId}/daily accepts a date (the Daily tab's
   * swipe-back / date-dropdown history), by plan. Free = the in-file
   * LOG_RETENTION_DAYS window; paid reads reach into daily-archive/
   * (append-only, never deleted). Household pets follow the owner's plan.
   * plan.json `limits.dailyHistoryDays` can override per user. The frontend
   * fallback (DEFAULT_LIMITS in frontend/src/api.ts) MUST MATCH the free value.
   */
  HISTORY_DAYS_FREE: 14, // keep == LOG_RETENTION_DAYS (free never reads the archive)
  HISTORY_DAYS_PAID: 365,
} as const;

/** WEIGHT LOG */
export const WEIGHTS = {
  /** Entries kept per pet (one per date; oldest beyond this are rejected). */
  MAX_ENTRIES: 500,
} as const;

/** MEDICATIONS */
export const MEDS = {
  /**
   * Longest allowed interval per cadence unit ("every N days/weeks/months").
   * day: 365 = up to yearly, week: 52 = up to yearly, month: 24 = up to 2 years.
   */
  UNIT_MAX: { day: 365, week: 52, month: 24 },
} as const;

/** FAMILY / HOUSEHOLD */
export const FAMILY = {
  /** How long a join-invite link works before expiring. */
  INVITE_TTL_MS: 7 * 24 * 60 * 60 * 1000, // 7 days
  /**
   * Emailed invites per user per day. The seat cap already limits LIVE
   * invites, but create-with-email -> revoke -> repeat would otherwise loop
   * unlimited SES sends to arbitrary addresses. Over the cap, the invite
   * link still works — only the email send is refused.
   */
  MAX_INVITE_EMAILS_PER_DAY: 10,
} as const;

/** AI DOCUMENT EXTRACTION (Bedrock) */
export const AI = {
  /**
   * Cross-region inference-profile id (the bare Mantle alias 403s for this
   * account — see CLAUDE.md session 15/17 notes before changing).
   */
  BEDROCK_MODEL_ID: 'us.anthropic.claude-sonnet-4-6',
  /**
   * The Bedrock call must finish (or fail) before API Gateway's hard ~30s
   * integration cap so the client always gets a real response it can fall
   * back from. Keep a few seconds under INFRA.API_TIMEOUT_SECONDS.
   */
  CLIENT_TIMEOUT_MS: 23_000,
  /** Most vaccine rows honored from a single scanned document. */
  MAX_VACCINES_PER_EXTRACTION: 12,
} as const;

/** EMAIL / LINKS (fallbacks — the stack sets matching env vars where needed) */
export const EMAIL = {
  /** SES sender. Must be a verified identity on the petshots.app domain. */
  FROM_EMAIL: 'no-reply@petshots.app',
  /** Base URL used in email links and Stripe redirects. */
  APP_URL: 'https://petshots.app',
} as const;

/**
 * LAMBDA SIZING (cost/performance, not features — but tunable)
 */
export const INFRA = {
  /**
   * API Lambda: 1024 MB / 29s exists for the AI-extraction routes
   * (base64-encoding a multi-MB upload needs the memory, the Bedrock vision
   * call needs the time; HTTP API caps integrations at 30s regardless).
   * Normal routes finish in <100 ms, so the memory bump costs ~nothing.
   */
  API_MEMORY_MB: 1024,
  API_TIMEOUT_SECONDS: 29,
  /** Reminder Lambda: scans every user sequentially once a day. */
  REMINDER_MEMORY_MB: 256,
  REMINDER_TIMEOUT_MINUTES: 5,
} as const;
