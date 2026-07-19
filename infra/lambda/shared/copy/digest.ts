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
  moodDip: (pet: string) => `${pet}'s mood looked lower than usual this week. Worth a quick check-in?`,
  lowBreakfast: (pet: string, n: number, total: number) =>
    `${pet} only had breakfast logged ${n} of the last ${total} days. Just a missed log, or something to watch?`,
  lowDinner: (pet: string, n: number, total: number) =>
    `${pet} only had dinner logged ${n} of the last ${total} days. Just a missed log, or something to watch?`,
  lowWalk: (pet: string, n: number, total: number) =>
    `${pet}'s walks dropped to ${n} of the last ${total} days. Anything keeping you two inside?`,
  lowGeneric: (pet: string, itemName: string, n: number, total: number) =>
    `${pet}'s ${itemName} was only logged ${n} of the last ${total} days. Worth a look?`,
  /** Replaces the digest's normal "Weight: X" line when the latest entry
   *  predates the digest window by WEIGHTS.STALE_NUDGE_DAYS or more. */
  weightStale: (pet: string, days: number) =>
    `It's been ${days} days since ${pet}'s last weight update. Worth logging one?`,
} as const;

export const digestCopy = {
  subjectSingle: (petName: string) => `🐾 ${petName}'s week at a glance`,
  subjectMulti: `🐾 Your pets' week at a glance`,
  greeting: 'Hi,',
  intro: "Here's the short version of the last 7 days:",
  cta: (url: string) => `See the full week in Petshots: ${url}`,
  ctaButtonLabel: 'Open the weekly recap',
  signoff: 'See you in Petshots,',
  signoffName: 'The Petshots team',
  toggleOff: 'You can turn the weekly digest off in Petshots Settings.',
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
  intro: "Here's the clearest view of the last 30 days:",
  careConsistency: (pct: number) => `Care consistency: ${pct}%`,
  mood: (avg: number, lastMonthAvg: number | null) =>
    `Mood: ${avg.toFixed(1)}/5${lastMonthAvg != null ? ` (last month: ${lastMonthAvg.toFixed(1)})` : ''}`,
  weight: (value: number, unit: string, deltaMonth: number | null) =>
    `Weight: ${value} ${unit}${deltaMonth != null ? ` (${deltaMonth > 0 ? '▲' : '▼'} ${Math.abs(deltaMonth)} ${unit} this month)` : ''}`,
  walks: (count: number, miles: number, kcal: number | null, countLast: number, milesLast: number) =>
    `Walks: ${count} (${miles} mi${kcal ? `, ≈${kcal} kcal` : ''}) — last month: ${countLast} (${milesLast} mi)`,
  cta: (url: string) => `See the full breakdown in Petshots: ${url}`,
  ctaButtonLabel: 'Open the monthly report',
  signoff: 'Thanks for staying on top of it,',
  signoffName: 'The Petshots team',
  onDemandNote: 'You asked Petshots to send this report.',
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
  intro: "Here's the clearest view of the last 7 days:",
  weight: (value: number, unit: string, deltaWeek: number | null) =>
    `Weight: ${value} ${unit}${deltaWeek != null ? ` (${deltaWeek > 0 ? '▲' : '▼'} ${Math.abs(deltaWeek)} ${unit} this week)` : ''}`,
  walks: (count: number, miles: number, kcal: number | null) =>
    `Walks: ${count} (${miles} mi${kcal ? `, ≈${kcal} kcal burned` : ''})`,
  cta: (url: string) => `See the full breakdown in Petshots: ${url}`,
  ctaButtonLabel: 'Open the weekly report',
  signoff: 'See you back in Petshots,',
  signoffName: 'The Petshots team',
  onDemandNote: 'You asked Petshots to send this report.',
  unsubscribeLine: (url: string) => `Unsubscribe from all Petshots email: ${url}`,
} as const;
