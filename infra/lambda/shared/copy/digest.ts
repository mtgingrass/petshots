/**
 * Weekly digest copy — the Sunday "week at a glance" summary email built by
 * infra/lambda/reminder/index.ts. See copy/reminder.ts's header for the
 * deploy recipe; same rule applies here.
 */

/**
 * Short, gentle "we noticed" lines — at most one per pet per digest (see
 * DIGEST.MOOD_DIP_THRESHOLD / LOW_COMPLETION_MISSED_DAYS in config.ts for the
 * triggering thresholds). Deliberately template-based, not AI-generated: the
 * three built-in presets get natural, specific phrasing; anything else (a
 * user's own custom checklist item — Daily items aren't a fixed list) falls
 * back to lowGeneric. Keep every line short — this is a nudge, not a report.
 */
export const digestInsightCopy = {
  moodDip: (pet: string) => `We noticed ${pet}'s mood was lower than usual this week — everything okay?`,
  lowBreakfast: (pet: string, n: number, total: number) =>
    `We noticed ${pet} only had breakfast logged ${n} of the last ${total} days — forgot to log it, or is ${pet} eating less?`,
  lowDinner: (pet: string, n: number, total: number) =>
    `We noticed ${pet} only had dinner logged ${n} of the last ${total} days — forgot to log it, or is ${pet} feeling off?`,
  lowWalk: (pet: string, n: number, total: number) =>
    `We noticed ${pet}'s walks dropped to ${n} of the last ${total} days — anything keeping you two inside?`,
  lowGeneric: (pet: string, itemName: string, n: number, total: number) =>
    `We noticed ${pet}'s ${itemName} was only logged ${n} of the last ${total} days — just a logging gap, or worth a check-in?`,
  /** Replaces the digest's normal "Weight: X" line when the latest entry
   *  predates the digest window by WEIGHTS.STALE_NUDGE_DAYS or more. */
  weightStale: (pet: string, days: number) =>
    `It's been ${days} days since ${pet}'s last weight update — worth logging one?`,
} as const;

export const digestCopy = {
  subjectSingle: (petName: string) => `🐾 ${petName}'s week at a glance`,
  subjectMulti: `🐾 Your pets' week at a glance`,
  greeting: 'Hi,',
  intro: "Here's how the last 7 days went:",
  cta: (url: string) => `Keep it up: ${url}`,
  signoff: '— The Petshots team',
  toggleOff: 'Turn the weekly digest off in Settings.',
  unsubscribeLine: (url: string) => `Unsubscribe from all Petshots email: ${url}`,
} as const;

/**
 * Monthly report — a paid-plan perk, sent once a month (config.ts's
 * DIGEST.MONTHLY_REPORT_*) and also available on demand from the Trends tab
 * ("send me this report" — see api Lambda's POST /trends/send). Same
 * consistency-%/mood/checklist content as GET /trends, in email form.
 */
export const monthlyReportCopy = {
  subjectSingle: (petName: string) => `🐾 ${petName}'s month at a glance`,
  subjectMulti: `🐾 Your pets' month at a glance`,
  greeting: 'Hi,',
  intro: "Here's how the last 30 days went:",
  careConsistency: (pct: number) => `Care consistency: ${pct}%`,
  mood: (avg: number, lastMonthAvg: number | null) =>
    `Mood: ${avg.toFixed(1)}/5${lastMonthAvg != null ? ` (last month: ${lastMonthAvg.toFixed(1)})` : ''}`,
  weight: (value: number, unit: string, deltaMonth: number | null) =>
    `Weight: ${value} ${unit}${deltaMonth != null ? ` (${deltaMonth > 0 ? '▲' : '▼'} ${Math.abs(deltaMonth)} ${unit} this month)` : ''}`,
  cta: (url: string) => `See the full breakdown: ${url}`,
  signoff: '— The Petshots team',
  onDemandNote: 'You requested this report from the Trends tab.',
  unsubscribeLine: (url: string) => `Unsubscribe from all Petshots email: ${url}`,
} as const;

/**
 * Weekly report — the on-demand ("email me this report") counterpart to
 * monthlyReportCopy, available on every plan. NOT the same email as the
 * existing Sunday vaccine/med digest (digestCopy above) — that one stays
 * as-is; this is the Trends-tab-in-email-form version, only sent when a
 * user explicitly asks for it (there's no proactive weekly send of this
 * one, unlike the monthly report — see CLAUDE.md for why).
 */
export const weeklyReportCopy = {
  subjectSingle: (petName: string) => `🐾 ${petName}'s week at a glance`,
  subjectMulti: `🐾 Your pets' week at a glance`,
  greeting: 'Hi,',
  intro: "Here's how the last 7 days went:",
  weight: (value: number, unit: string, deltaWeek: number | null) =>
    `Weight: ${value} ${unit}${deltaWeek != null ? ` (${deltaWeek > 0 ? '▲' : '▼'} ${Math.abs(deltaWeek)} ${unit} this week)` : ''}`,
  cta: (url: string) => `See the full breakdown: ${url}`,
  signoff: '— The Petshots team',
  onDemandNote: 'You requested this report from the Trends tab.',
  unsubscribeLine: (url: string) => `Unsubscribe from all Petshots email: ${url}`,
} as const;
