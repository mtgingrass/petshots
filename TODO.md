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

- [ ] **AI extraction: exact-duplicate detection via S3 ETag** (2026-07-07) — a byte-identical re-upload currently only gets the label-based "already has a record like this" hint on the review screen. Compare the tmp object's ETag against existing docs' ETags at analyze time (both listings already fetched) → lead the review screen with "same file as your Rabies record" + prominent Cancel, and skip the Claude call. ~20 min; decided to ship without it.

- [ ] **AI extraction: revisit Bedrock Mantle endpoint** (2026-07-07) — the Lambda uses the legacy `AnthropicBedrock` client + `us.anthropic.claude-haiku-4-5-20251001-v1:0` inference profile because the Mantle (Messages-API) endpoint returned 403 "not available for this account" even after the marketplace agreement went ACTIVE. Retry `AnthropicBedrockMantle` + `anthropic.claude-haiku-4-5` later (BEDROCK_MODEL_ID env var + client class in `infra/lambda/api/index.ts`); entitlement may just need time to propagate.

- [ ] **Downgrade copy softening** (2026-07-06) — over-cap (lapsed) users see "You're at the 2-pet limit" + read-only notes; consider "Your plan includes 2 pets — upgrade to add more" phrasing distinct from at-cap free users.

- [ ] **Strip dead `update-url` route from API Lambda** (2026-07-03) — leftover from the removed Update-record feature. Harmless (authed) but dead code. Remove route + archive logic + smoke test section [5c] together, redeploy ApiStack.

- [x] **Medication reminders — monthly heartworm/flea** (2026-07-03) — **DONE session 13 (2026-07-06)**: Meds tab per pet (presets + custom, per-med reminder toggle, mark-as-given), `meds.json` per pet, ReminderFn extended (due-day + weekly-overdue emails), smoke-tested 60/60 + 29/29. See CLAUDE.md session 13 notes.

- [ ] **Meds on overview + passport** (2026-07-06) — meds are invisible outside the pet's Meds tab: pet pin status rings, overview notices, and the public passport page ignore them. Passport especially — boarding facilities want the med list + dosing schedule. Also consider a count/dot badge on the Meds tab itself.

- [ ] **Pet birthday email** (2026-07-03) — "Ollie turns 7 🎂" via ReminderFn; DOB already a profile field. Weekend-sized, pure warmth.

- [ ] **Reminder email polish + expiry-date nudge** (2026-07-03) — deep links, pet name in subject, nudge at upload when no expiry set ("we can't remind you without a date"), and decide whether reminders should be ON by default for new signups (currently off = zero touchpoints unless they find Settings).

- [ ] **Consider "Upgrade" hook at the 3-pet limit message** (2026-07-03) — the limit message that shipped today is where the paid tier naturally slots in once Stripe exists.
