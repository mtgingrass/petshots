# Petshots TODO

Backlog of ideas, improvements, and "we'll deal with this later" items. **Not the immediate next step** — for that, see CLAUDE.md → *Where we left off* → *Next session — start here*.

Format: `- [ ]` for open, `- [x]` for done. Add date when adding an item.

---

- [x] **Logged-in landing page** (2026-07-02) — DONE: `<Navigate to="/dashboard" replace />` when auth context has an email; logged-in users skip the marketing page entirely.

- [x] **Donation link** (2026-07-02) — DONE: `DONATION_URL` constant in `SiteFooter.tsx`; set it to your Ko-fi URL and the "☕ Buy me a coffee" line appears automatically. Currently empty (hidden) until you have an account set up.

- [x] **Privacy Policy page + footer link** (2026-07-02) — DONE: `/privacy` route (`Privacy.tsx`), plain-English policy, "Privacy Policy" link in SiteFooter.

- [x] ~~**Vaccine record versioning / "Update" action**~~ (2026-07-02) — shipped, then **REMOVED session 12 (2026-07-03)** at Mark's request (simpler flow: delete + re-add). Frontend fully deleted; the API `update-url` route + `_archived/` logic still live in the Lambda — strip next time ApiStack is touched.

- [ ] **Strip dead `update-url` route from API Lambda** (2026-07-03) — leftover from the removed Update-record feature. Harmless (authed) but dead code. Remove route + archive logic + smoke test section [5c] together, redeploy ApiStack.

- [x] **Medication reminders — monthly heartworm/flea** (2026-07-03) — **DONE session 13 (2026-07-06)**: Meds tab per pet (presets + custom, per-med reminder toggle, mark-as-given), `meds.json` per pet, ReminderFn extended (due-day + weekly-overdue emails), smoke-tested 60/60 + 29/29. See CLAUDE.md session 13 notes.

- [ ] **Meds on overview + passport** (2026-07-06) — meds are invisible outside the pet's Meds tab: pet pin status rings, overview notices, and the public passport page ignore them. Passport especially — boarding facilities want the med list + dosing schedule. Also consider a count/dot badge on the Meds tab itself.

- [ ] **Pet birthday email** (2026-07-03) — "Ollie turns 7 🎂" via ReminderFn; DOB already a profile field. Weekend-sized, pure warmth.

- [ ] **Reminder email polish + expiry-date nudge** (2026-07-03) — deep links, pet name in subject, nudge at upload when no expiry set ("we can't remind you without a date"), and decide whether reminders should be ON by default for new signups (currently off = zero touchpoints unless they find Settings).

- [ ] **Consider "Upgrade" hook at the 3-pet limit message** (2026-07-03) — the limit message that shipped today is where the paid tier naturally slots in once Stripe exists.
