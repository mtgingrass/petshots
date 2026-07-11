# Petshots TODO

Backlog of ideas, improvements, and "we'll deal with this later" items. **Not the immediate next step** — for that, see CLAUDE.md → *Where we left off* → *Next session — start here*.

Format: `- [ ]` for open, `- [x]` for done. Add date when adding an item. Completed items get deleted, not archived — history lives in `git log`.

## Inbox
(empty)

## Marketing
- [ ] Write App Store listing copy (2026-07-10)
- [ ] Get screenshots of the app in use with representative data, for App Store review (2026-07-10)
- [ ] Push to Apple App Store once TestFlight testers are through (2026-07-10)

## Open backlog
- [ ] **Stripe live-mode loose ends** (2026-07-06) — activate Customer Portal in LIVE mode; verify the live key pasted into terminal scrollback in s14 was rolled; branding → "Petshots" on checkout; trim payment methods; optional real $5 self-subscription as end-to-end test.
- [ ] **Reminder email polish — remaining pieces** (2026-07-03, HTML body + upgrade nudge shipped 2026-07-11) — still open: deep links, nudge at upload when no expiry set, decide default opt-in for new signups.
- [ ] **iOS: Apple-side manual steps** (2026-07-08) — see `IOS.md`.
- [ ] **Config centralization follow-ups** (2026-07-09) — notice `resetAfterDays`/priority in `utils/notices.ts`, med custom-interval clamp, MIME allow-lists, S3/API CORS maxAge, APNs protocol details, Bedrock `max_tokens`. Also: meds.json/settings.json PUTs are still last-write-wins — adopt the ETag-guarded pattern (`putJsonGuarded`) when next touched.
- [ ] **iOS v2 ideas** (2026-07-08) — universal links for `/p/{token}` + `/join/{token}`, home-screen widget, "scan record" App Shortcut.
- [ ] **Family mode v2** (2026-07-08, v1 shipped) — member passport creation; per-member notification preferences; meds whole-list PUT is last-write-wins if two members edit simultaneously. (Merge/transfer picker killed per Mark 2026-07-08.)
- [ ] **Trends tab visual QA** (2026-07-11) — charts (mood/weight sparklines, GaugeDial ring, PercentBar) + the "Email week/month" send buttons, all in `frontend/src/components/TrendsCharts.tsx` + `TrendsAllScreen` in Dashboard.tsx. Never visually verified in a browser this entire session (Chrome extension wasn't connected, four attempts) — Mark is checking on phone/Xcode.
- [ ] **Desktop nav is a repositioned mobile tab bar, not a real desktop design** (2026-07-11) — desktop web had NO way to reach Daily/Passports/Trends at all; went through three passes: un-hid the mobile bottom bar on desktop first, moved it to a fixed top strip (Mark: bottom was "too hidden"), then moved it again to sit between the header and page content, scrolling with the page (Mark wanted it below the logo/MG/share row, not above). Final version: `<TabBar>` renders in the JSX right after `<header>` inside `<main>` now (was a sibling after `</main>`), `position:static` on desktop so it just sits in normal document flow; mobile/native keep `position:fixed` and are unaffected since fixed elements don't care about DOM position. Works and is correctly placed, but still the mobile component's own styling (icon-over-label items, full-bleed width, not sticky while scrolling) — doesn't match the desktop panel/frame look the rest of the UI has. Revisit as an integrated header nav once someone can see it rendered.
- [ ] **Confirm the `.page` centering fix actually worked** (2026-07-11) — found via Mark's screenshots: on a wide-enough desktop window (reproducible regardless of fullscreen — confirmed, not just a fullscreen-transition glitch), page content rendered small and pinned top-left instead of centered. Root-caused to `#root`'s flex `align-items: stretch` default not reliably centering `.page`'s `max-width:720px` + `margin:0 auto`; fixed with `align-self: center` scoped to `.page` only (deliberately NOT `#root`'s `align-items`, which would've broken `.site-footer`'s full-width top border). Deployed but not yet visually reconfirmed.
- [ ] **Monthly report email doesn't cover household/family pets** (2026-07-11) — `runMonthlyReport` in reminder/index.ts only reads the pool owner's own pets, unlike the main reminder scan and weekly digest (which both resolve `memberOf.json` for shared household pets). Deliberately deferred for v1 scope; extend if a family-plan paid user asks why their household pets are missing from the monthly email.
- [ ] **AI-generated digest insights for custom items** (2026-07-11) — the weekly/monthly "we noticed" nudge is plain templates today (breakfast/dinner/walk get natural phrasing, anything else falls back to generic wording). Daily items can be ANY name a user types, so generic phrasing may feel flat once custom items are common. Revisit with Bedrock only if that turns out to matter — adds real cost/latency to ReminderFn, not free.
- [ ] **Suggested-events dropdown for custom Daily items** (2026-07-11) — when adding a custom checklist item, offer a dropdown of common suggestions (litter box, training, grooming, vet visit, etc.) instead of pure free text. Two wins: easier UX, and structured metadata on which custom events are actually common — useful for both product decisions and digest copy (see AI-generated-insights item above).
- [ ] **Password-reset email copy** (2026-07-08) — Cognito's shared verification template makes reset emails say "Verify your new account." Fix via neutral copy or a CustomMessage Lambda trigger branching on `CustomMessage_ForgotPassword`. Cosmetic.
- [ ] **"Did I feed the dog?" quick-log** (2026-07-07) — per-pet feeding log (`feeding.json`, last 7 days) so household members can see who fed the pet and when. Feeds into family sharing.
- [ ] **Signup notification email** (2026-07-07) — `PostConfirmation_ConfirmSignUp` trigger emails mark.gingrass@gmail.com on real signups (same pattern as the PreSignUp Turnstile trigger).
- [ ] **Basic product metrics/monitoring** (2026-07-07) — DAU/WAU, signup→first-pet/first-doc conversion, AI-scan usage vs cap, free→paid conversion, churn, SES send/bounce rate, passport view rate. Start cheap (CloudWatch custom metrics or a scheduled tally Lambda).
- [ ] **Snooze option for overdue/due-soon notices** (2026-07-07) — currently only ✕ dismiss with a fixed resurface schedule (`utils/notices.ts`); Mark wants a user-facing snooze choice instead.

## Completed
