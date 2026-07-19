/**
 * ============================================================================
 * REMINDER EMAIL COPY — every sentence the daily vaccine/med reminder email
 * can say, in one place.
 * ============================================================================
 *
 * This is the "what it says" layer. `infra/lambda/reminder/index.ts` is the
 * "how it's built and sent" layer — it decides WHICH of these lines apply
 * (which urgency tier, which subject variant) but never spells out English
 * itself. Edit wording here, then the usual deploy recipe ships it:
 *   1. cd infra && npm run build     -> typecheck
 *   2. npx cdk diff PetshotsApiStack -> only ReminderFn's code should change
 *   3. npx cdk deploy PetshotsApiStack
 *
 * Every function here is a pure string template — no S3/SES/date-math. The
 * same phrase functions serve both the plain-text and HTML email bodies;
 * callers pass already-escaped values when building the HTML version (pet
 * names, doc labels, and med names are user input).
 */

export const reminderCopy = {
  greeting: 'Hi,',
  introWithItems: "A few pet-care items need your attention:",
  introCelebrationOnly: 'A little celebration from Petshots:',
  /** Same two intros, without the trailing colon — used as the HTML email's <h1>. */
  emailTitleReminder: 'What needs attention today',
  emailTitleCelebration: 'A little celebration for your pets',
  signoff: 'Thanks for keeping up with them,',
  signoffName: 'The Petshots team',
  manageReminders: 'You can change reminder timing in Petshots Settings.',
  unsubscribeLine: (url: string) => `Unsubscribe from all Petshots email: ${url}`,

  ctaWithMeds: (url: string) => `Open Petshots and mark anything done: ${url}`,
  ctaDocsOnly: (url: string) => `Open Petshots and review the latest records: ${url}`,
  ctaButtonLabel: 'Open Petshots',

  /** Free-plan upgrade nudge — shown to non-paid users on every reminder email. */
  upgradeLine: (maxPets: number, url: string) =>
    `Free plan covers ${maxPets} pets. Upgrade for more pets, records, and family seats: ${url}`,
  upgradeLineHtml: (maxPets: number, url: string) =>
    `Free plan covers ${maxPets} pets. <a href="${url}" style="color:#1f3b36;font-weight:700;">See plan options on Petshots</a>.`,

  sectionTitles: {
    overdue: '⚠️ Overdue',
    today: '📅 Due today',
    upcoming: 'Coming up soon',
  },

  // ---- per-item lines (vaccine docs) ----
  docOverdue: (pet: string, label: string, formattedExpiry: string, overdueDays: number) =>
    `${pet}'s ${label} expired ${formattedExpiry} (${overdueDays} day${overdueDays === 1 ? '' : 's'} overdue)`,
  docToday: (pet: string, label: string) => `${pet}'s ${label} expires today`,
  docUpcoming: (pet: string, label: string, formattedExpiry: string, when: string) =>
    `${pet}'s ${label} expires ${formattedExpiry} (${when})`,

  // ---- per-item lines (medications) ----
  medOverdue: (pet: string, name: string, formattedDue: string, overdueDays: number) =>
    `${pet}'s ${name} is ${overdueDays} day${overdueDays === 1 ? '' : 's'} overdue (was due ${formattedDue})`,
  medToday: (pet: string, name: string) => `${pet}'s ${name} is due today`,
  medUpcoming: (pet: string, name: string, formattedDue: string, when: string) =>
    `${pet}'s ${name} is due ${formattedDue} (${when})`,

  birthdayLine: (pet: string, age: number) =>
    age >= 1 ? `🎂 ${pet} turns ${age} today. Happy birthday.` : `🎂 It's ${pet}'s birthday today. Happy birthday.`,

  // ---- subject line variants ----
  subjectBirthdaySingle: (pet: string, age: number) =>
    age >= 1 ? `🎂 ${pet} turns ${age} today` : `🎂 Happy birthday, ${pet}`,
  subjectBirthdayMulti: (count: number) => `🎂 ${count} Petshots birthdays today`,
  subjectOverdueSingleDoc: (pet: string, label: string, overdueDays: number) =>
    `⚠️ ${pet}'s ${label} is overdue`,
  subjectOverdueSingleMed: (pet: string, name: string, overdueDays: number) =>
    `⚠️ ${pet}'s ${name} is overdue`,
  subjectOverdueMulti: (count: number) => `⚠️ ${count} pet care item${count !== 1 ? 's' : ''} overdue`,
  subjectTodaySingleDoc: (pet: string, label: string) => `${pet}'s ${label} expires today`,
  subjectTodaySingleMed: (pet: string, name: string) => `${pet}'s ${name} is due today`,
  subjectTodayMulti: (count: number) => `${count} pet care item${count !== 1 ? 's' : ''} due today`,
  subjectUpcomingSingleMed: (pet: string, name: string, days: number) =>
    `${pet}'s ${name} is due soon`,
  subjectUpcomingSingleDoc: (pet: string, label: string, days: number) =>
    `${pet}'s ${label} expires soon`,
  subjectUpcomingDocsOnly: (count: number) => `${count} vaccine record${count !== 1 ? 's' : ''} expiring soon`,
  subjectUpcomingMedsOnly: (count: number) => `${count} medication reminder${count !== 1 ? 's' : ''} coming up`,
  subjectUpcomingMixed: (count: number) => `${count} pet care reminder${count !== 1 ? 's' : ''} coming up`,
} as const;
