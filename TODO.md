# Petshots TODO

Backlog of ideas, improvements, and "we'll deal with this later" items. **Not the immediate next step** — for that, see CLAUDE.md → *Where we left off* → *Next session — start here*.

Format: `- [ ]` for open, `- [x]` for done. Add date when adding an item.

---

- [x] **Logged-in landing page** (2026-07-02) — DONE: `<Navigate to="/dashboard" replace />` when auth context has an email; logged-in users skip the marketing page entirely.

- [x] **Donation link** (2026-07-02) — DONE: `DONATION_URL` constant in `SiteFooter.tsx`; set it to your Ko-fi URL and the "☕ Buy me a coffee" line appears automatically. Currently empty (hidden) until you have an account set up.

- [x] **Privacy Policy page + footer link** (2026-07-02) — DONE: `/privacy` route (`Privacy.tsx`), plain-English policy, "Privacy Policy" link in SiteFooter.

- [x] ~~**Vaccine record versioning / "Update" action**~~ (2026-07-02) — shipped, then **REMOVED session 12 (2026-07-03)** at Mark's request (simpler flow: delete + re-add). Frontend fully deleted; the API `update-url` route + `_archived/` logic still live in the Lambda — strip next time ApiStack is touched.

- [x] ~~**Stripe GO-LIVE**~~ (2026-07-06) — **LIVE as of s14**: live key in Secrets Manager, live product/prices/webhook provisioned, Lambda cache flushed, checkout verified creating `cs_live_` sessions. Mark's account = founder comp (`{"plan":"paid"}`, no Stripe linkage).

- [ ] **Stripe live-mode loose ends** (2026-07-06) — (a) activate Customer Portal in LIVE mode (Settings → Billing → Customer portal) or "Manage billing" errors for real subscribers; (b) verify the live key pasted into terminal scrollback earlier in s14 was rolled; (c) branding: public business name + statement descriptor → "Petshots" (checkout page currently says "Mark Gingrass"); (d) trim payment methods (drop Klarna/Bank for a $5 sub); (e) optional: one real $5 self-subscription as the true end-to-end test (cancel after via portal; ~44¢ in fees).

- [x] **AI extraction: visit-summary smoke fixture** (2026-07-07) — DONE s17 (2026-07-08): `makeVisitSummaryCert` in `lib-cert-pdf.mjs` (one "Service Date: 5/9/2025" header, three undated "- X Vaccine - 1 Year" lines, a nail-trim decoy) + smoke-ai section asserting every line gets dateGiven=2025-05-09, no fabricated expiry, exact suggestedExpiry. Green vs live.

- [x] **AI extraction: exact-duplicate detection via S3 ETag** (2026-07-07) — DONE s17: analyze compares the tmp object's ETag+Size against current docs before the quota bump → returns `{ duplicate: {id,label,expiry} }`, no model call, no scan consumed. Review screen leads with "exact same file as your X record"; Cancel gets primary styling, Save becomes "Save anyway".

- [ ] **AI extraction: revisit Bedrock Mantle endpoint** (2026-07-07) — RETESTED s17 (2026-07-08), still blocked but the error changed: every Sonnet 4.6 id (`anthropic.claude-sonnet-4-6`, `us.` prefix, dated, `global.`) now 404s "model does not exist" on Mantle — Sonnet 4.6 isn't exposed there — while `anthropic.claude-haiku-4-5` still 403s on entitlement. Legacy `AnthropicBedrock` + `us.anthropic.claude-sonnet-4-6` stays. Re-check when Mantle lists Sonnet 4.6.

- [x] **Downgrade copy softening** (2026-07-06) — DONE s17: over-cap overview message is now "Your plan includes N pets, so X of your pets are read-only — everything stays viewable. Upgrade to unlock →", distinct from the at-cap message.

- [x] **Strip dead `update-url` route from API Lambda** (2026-07-03) — DONE s17: route case + api-stack registration removed, gateway route deleted on deploy, smoke [5c] now asserts the route 404s. `_archived/` listing filters kept (legacy archived objects may exist in S3).

- [x] **Medication reminders — monthly heartworm/flea** (2026-07-03) — **DONE session 13 (2026-07-06)**: Meds tab per pet (presets + custom, per-med reminder toggle, mark-as-given), `meds.json` per pet, ReminderFn extended (due-day + weekly-overdue emails), smoke-tested 60/60 + 29/29. See CLAUDE.md session 13 notes.

- [x] **Meds on overview + passport** (2026-07-06) — DONE s17: pet pin rings/status lines + overview notices now include med status (dashboard loads meds per pet alongside docs); Meds tab shows a red count badge for due/overdue meds; the public passport gets a Medications card (name + cadence + next due + last given, dismissed meds hidden) and docs show their given dates.

- [x] **Pet birthday email** (2026-07-03) — DONE s17: ReminderFn sends "🎂 Smokey turns 3 today!" when a pet's dob matches today (UTC; Feb-29 celebrates Feb 28 off-leap-years). Gated on the vaccine-reminders consent toggle — no opt-in, no mail. Rides the same daily email when reminders are also due.

- [ ] **Reminder email polish + expiry-date nudge** (2026-07-03) — deep links, pet name in subject, nudge at upload when no expiry set ("we can't remind you without a date"), and decide whether reminders should be ON by default for new signups (currently off = zero touchpoints unless they find Settings).

- [x] **Consider "Upgrade" hook at the 3-pet limit message** (2026-07-03) — already shipped in s14 (upgrade CTA in the pet-limit message); checked off during s17 housekeeping.

---

## New backlog added 2026-07-07

- [x] **Dismiss/ignore overdue meds** (2026-07-07) — DONE s17: ⋯ menu "Stop tracking" sets `dismissed: true` (+ reminders off); the med stays listed with a muted "Not tracked" pill and "Kept for your records" line, Mark-as-given/reminder controls hidden, and every due-surface skips it (Meds banner, overview pins/notices, passport, reminder email). "Resume tracking" undoes it (reminders stay off until re-enabled deliberately).

- [x] **"▶ Present" → "▶ Present Rabies Shots"** (2026-07-07) — DONE same day: button label updated in `PetDetailScreen`.

- [x] **Rename "Share" tab → "Passport"** (2026-07-07) — DONE s17: tab renamed (component now `PassportTabSection`). Passport audit: the page already showed the full profile card (breed/age/weight/fixed/microchip/allergies/behavior/notes/vet/vet phone/emergency contact); what was missing — meds and given dates — was added (see "Meds on overview + passport").

- [x] **Social share button for passport** (2026-07-07) — DONE same day: "Share passport ↗" button uses Web Share API with prewritten post text ("[PetName]'s shot records are always up to date — view them anytime with Petshots 🐾"), clipboard fallback on desktop. Instagram-story image export still open as a stretch goal.

- [x] **Light/dark mode toggle on main screens** (2026-07-07) — DONE same day: ☀️/🌙 icon button in the dashboard header and public `SiteHeader`. Settings toggle kept too.

- [ ] **"Did I feed the dog?" quick-log** (2026-07-07) — per-pet daily feeding log. A simple "Fed this morning ✓" / "Fed this evening ✓" button on the pet overview that records a timestamp. Shared-household problem: Mark fed him, partner thinks Mark didn't (or vice versa). The log shows "Fed at 7:42am by Mark" so everyone knows. Data model: `users/{sub}/pets/{petId}/feeding.json` — array of `{ts, meal: 'morning'|'evening'|'night'}` entries, keep last 7 days. Display: banner/badge on the pet card in the overview. This is a daily engagement hook (not just once-a-year certs). Server side is trivial; the UX is the whole product. **Feeds directly into item #7 (family sharing).**

- [ ] **Family / household sharing** (2026-07-07) — multiple people in the same household need write access to the same pet. Currently each Cognito user owns their own pets at their own S3 prefix — there is no cross-user access. Design options: (a) **invite-based join**: owner sends invite code → invitee's account gets read or read+write on specific pets (adds a `shared/{sub}/pets/{petId}` pointer + server-side authz check); (b) **shared household account**: one Cognito account, shared credentials (simple but no per-person attribution); (c) **org/household entity**: a new `household/{hid}/` S3 prefix that multiple users belong to (cleanest long-term, biggest lift). The feeding log (#6) is the killer feature that makes option (a) worth building — "Mark fed him at 7am" only makes sense if Mark and his partner have separate logins. Estimate: option (a) is a sprint; option (c) is a project.

- [x] **Onboarding: "Get set up" checklist card** (2026-07-07) — DONE s17 as designed: dismissible card on the overview (`OnboardingChecklist` in Dashboard.tsx); Add-pet/Scan-record/Reminders tick from real state (pets, docs, `remindersEnabled` fetched once), each deep-links; Add-to-Home-Screen shows only on mobile when not standalone, expands inline iOS/Android steps, and checks off when tapped (localStorage `petshots.onboarding.homescreen`). Dismiss-forever via localStorage `petshots.onboarding.dismissed`; auto-hides once all visible items are done.

- [ ] **Signup notification email** (2026-07-07) — Mark asked how to find out when people sign up; no visibility today beyond manually listing Cognito users. Add a `PostConfirmation_ConfirmSignUp` Lambda trigger on the User Pool (same pattern as the existing PreSignUp Turnstile trigger) that emails `mark.gingrass@gmail.com` via SES (already wired, prod access live) with the new user's email + timestamp — fires only on real, confirmed signups, not abandoned ones. Cost ~$0 at this volume.

- [ ] **Basic product metrics/monitoring** (2026-07-07) — beyond signups, worth tracking as the app grows: daily/weekly active users, signup→first-pet-added conversion, signup→first-doc-uploaded conversion, AI-scan usage vs daily cap (quota-exhaustion rate), free→paid conversion rate, churn/cancellation rate (from Stripe webhook events), reminder email send volume + bounce/complaint rate (SES sending stats), passport link creation + view rate. No dashboard exists yet — options range from cheap (CloudWatch custom metrics emitted from the Lambda, a scheduled Lambda that tallies S3 prefixes and emails/logs a weekly digest) to heavier (a real analytics tool). Start cheap; revisit if the app grows enough to justify a dashboard.

- [ ] **Snooze option for overdue/due-soon notices** (2026-07-07) — the dashboard notice popups ("Bordetella expired 59 days ago") only have an ✕ dismiss; per `frontend/src/utils/notices.ts`, dismissal already auto-resurfaces on a fixed per-type schedule (`resetAfterDays`: overdue/critical = 1 day, warning = 7 days, headsup = 14 days) — by design, since overdue is "status, not a reminder." Mark wants a user-facing **snooze** choice (e.g. "remind me in a day" vs "a week") instead of the current fixed, non-configurable schedule. Open question: is this a per-click choice (small UI — a dropdown/two buttons next to ✕) or a per-notice-type default in Settings? Design TBD.

- [ ] **Explore a test/staging environment separate from prod** (2026-07-07) — Mark wants to look into standing up a non-production environment so infra/feature changes aren't tested directly against the live account/data. Options to research: (a) a second CDK app deployment (`PetshotsAuthStack-staging`, etc., via a CDK context var / separate `cdk.json` env, or a `stage` prop threaded through all stacks) into the same AWS account with distinct resource names; (b) a fully separate AWS account (AWS Organizations + account-per-environment, cleanest isolation, more setup); (c) lighter-weight: keep prod-only but rely more on the existing smoke-test scripts (`smoke-api.mjs`, `smoke-ai.mjs`, `smoke-billing.mjs`, `smoke-reminder.mjs`) which already use throwaway users against live. Tradeoffs: cost (a second Aurora/Cognito/CloudFront footprint isn't free, though most of the stack scales to ~$0 idle), domain/DNS for a staging subdomain, data seeding, and keeping CDK stacks parameterized by environment. Mark is researching this himself; revisit once he has a direction.
