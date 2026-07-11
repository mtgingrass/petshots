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
  introWithItems: "Here's your Petshots reminder:",
  introCelebrationOnly: 'A little celebration from Petshots:',
  /** Same two intros, without the trailing colon — used as the HTML email's <h1>. */
  emailTitleReminder: "Here's your Petshots reminder",
  emailTitleCelebration: 'A little celebration from Petshots',
  signoff: '— The Petshots team',
  manageReminders: "Manage reminders in Settings or on each pet's Meds tab.",
  unsubscribeLine: (url: string) => `Unsubscribe from all Petshots email: ${url}`,

  ctaWithMeds: (url: string) => `Mark meds as given and keep records up to date: ${url}`,
  ctaDocsOnly: (url: string) => `Keep records up to date: ${url}`,
  ctaButtonLabel: 'Open Petshots →',

  /** Free-plan upgrade nudge — shown to non-paid users on every reminder email. */
  upgradeLine: (maxPets: number, url: string) =>
    `Free plan covers ${maxPets} pets. Upgrade for unlimited pets & records: ${url}`,
  upgradeLineHtml: (maxPets: number, url: string) =>
    `Free plan covers ${maxPets} pets. <a href="${url}" style="color:#6c5ce7;font-weight:600;">Upgrade for unlimited pets &amp; records →</a>`,

  sectionTitles: {
    overdue: '⚠️ Overdue',
    today: '📅 Due today',
    upcoming: 'Coming up',
  },

  // ---- per-item lines (vaccine docs) ----
  docOverdue: (pet: string, label: string, formattedExpiry: string, overdueDays: number) =>
    `${pet}'s ${label} — expired ${formattedExpiry} (${overdueDays} day${overdueDays === 1 ? '' : 's'} overdue)`,
  docToday: (pet: string, label: string) => `${pet}'s ${label} — expires today`,
  docUpcoming: (pet: string, label: string, formattedExpiry: string, when: string) =>
    `${pet}'s ${label} — expires ${formattedExpiry} (${when})`,

  // ---- per-item lines (medications) ----
  medOverdue: (pet: string, name: string, formattedDue: string, overdueDays: number) =>
    `${pet}'s ${name} — ${overdueDays} day${overdueDays === 1 ? '' : 's'} overdue (was due ${formattedDue})`,
  medToday: (pet: string, name: string) => `${pet}'s ${name} — due today`,
  medUpcoming: (pet: string, name: string, formattedDue: string, when: string) =>
    `${pet}'s ${name} — due ${formattedDue} (${when})`,

  birthdayLine: (pet: string, age: number) =>
    age >= 1 ? `🎂 ${pet} turns ${age} today — happy birthday!` : `🎂 It's ${pet}'s birthday today — happy birthday!`,

  // ---- subject line variants ----
  subjectBirthdaySingle: (pet: string, age: number) =>
    age >= 1 ? `🎂 ${pet} turns ${age} today!` : `🎂 Happy birthday, ${pet}!`,
  subjectBirthdayMulti: (count: number) => `🎂 ${count} Petshots birthdays today!`,
  subjectOverdueSingleDoc: (pet: string, label: string, overdueDays: number) =>
    `⚠️ ${pet}'s ${label} is ${overdueDays} day${overdueDays === 1 ? '' : 's'} overdue`,
  subjectOverdueSingleMed: (pet: string, name: string, overdueDays: number) =>
    `⚠️ ${pet}'s ${name} is ${overdueDays} day${overdueDays === 1 ? '' : 's'} overdue`,
  subjectOverdueMulti: (count: number) => `⚠️ Petshots: ${count} overdue reminder${count !== 1 ? 's' : ''}`,
  subjectTodaySingleDoc: (pet: string, label: string) => `Reminder: ${pet}'s ${label} expires today`,
  subjectTodaySingleMed: (pet: string, name: string) => `Reminder: ${pet}'s ${name} is due today`,
  subjectTodayMulti: (count: number) => `Petshots: ${count} reminder${count !== 1 ? 's' : ''} due today`,
  subjectUpcomingSingleMed: (pet: string, name: string, days: number) =>
    `Reminder: ${pet}'s ${name} is due in ${days} day${days !== 1 ? 's' : ''}`,
  subjectUpcomingSingleDoc: (pet: string, label: string, days: number) =>
    `Reminder: ${pet}'s ${label} expires in ${days} day${days !== 1 ? 's' : ''}`,
  subjectUpcomingDocsOnly: (count: number) => `Petshots: ${count} vaccine records expiring soon`,
  subjectUpcomingMedsOnly: (count: number) => `Petshots: ${count} medications due soon`,
  subjectUpcomingMixed: (count: number) => `Petshots: ${count} pet care reminders`,
} as const;
