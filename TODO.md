# Petshots TODO

Backlog of ideas, improvements, and "we'll deal with this later" items. **Not the immediate next step** — for that, see CLAUDE.md → *Where we left off* → *Next session — start here*.

Format: `- [ ]` for open, `- [x]` for done. Add date when adding an item.

---

- [x] **Logged-in landing page** (2026-07-02) — DONE: `<Navigate to="/dashboard" replace />` when auth context has an email; logged-in users skip the marketing page entirely.

- [x] **Donation link** (2026-07-02) — DONE: `DONATION_URL` constant in `SiteFooter.tsx`; set it to your Ko-fi URL and the "☕ Buy me a coffee" line appears automatically. Currently empty (hidden) until you have an account set up.

- [x] **Privacy Policy page + footer link** (2026-07-02) — DONE: `/privacy` route (`Privacy.tsx`), plain-English policy, "Privacy Policy" link in SiteFooter.

- [x] ~~**Vaccine record versioning / "Update" action**~~ (2026-07-02) — shipped, then **REMOVED session 12 (2026-07-03)** at Mark's request (simpler flow: delete + re-add). Frontend fully deleted; the API `update-url` route + `_archived/` logic still live in the Lambda — strip next time ApiStack is touched.

- [ ] **Strip dead `update-url` route from API Lambda** (2026-07-03) — leftover from the removed Update-record feature. Harmless (authed) but dead code. Remove route + archive logic + smoke test section [5c] together, redeploy ApiStack.

- [ ] **Medication reminders — monthly heartworm/flea** (2026-07-03) — the #1 retention hook (12×/yr touchpoints vs 2/yr today). See `docs/retention-and-revenue-brainstorm.md`. Extends existing ReminderFn/SES pipeline; `meds.json` per pet + "mark as given".

- [ ] **Pet birthday email** (2026-07-03) — "Ollie turns 7 🎂" via ReminderFn; DOB already a profile field. Weekend-sized, pure warmth.

- [ ] **Reminder email polish + expiry-date nudge** (2026-07-03) — deep links, pet name in subject, nudge at upload when no expiry set ("we can't remind you without a date"), and decide whether reminders should be ON by default for new signups (currently off = zero touchpoints unless they find Settings).

- [ ] **Consider "Upgrade" hook at the 3-pet limit message** (2026-07-03) — the limit message that shipped today is where the paid tier naturally slots in once Stripe exists.
