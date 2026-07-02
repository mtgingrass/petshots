# Petshots TODO

Backlog of ideas, improvements, and "we'll deal with this later" items. **Not the immediate next step** — for that, see CLAUDE.md → *Where we left off* → *Next session — start here*.

Format: `- [ ]` for open, `- [x]` for done. Add date when adding an item.

---

- [x] **Logged-in landing page** (2026-07-02) — DONE: `<Navigate to="/dashboard" replace />` when auth context has an email; logged-in users skip the marketing page entirely.

- [x] **Donation link** (2026-07-02) — DONE: `DONATION_URL` constant in `SiteFooter.tsx`; set it to your Ko-fi URL and the "☕ Buy me a coffee" line appears automatically. Currently empty (hidden) until you have an account set up.

- [x] **Privacy Policy page + footer link** (2026-07-02) — DONE: `/privacy` route (`Privacy.tsx`), plain-English policy, "Privacy Policy" link in SiteFooter.

- [x] **Vaccine record versioning / "Update" action** (2026-07-02) — DONE: ⋯ menu now has **Edit label / date**, **Update record**, and **Delete**. "Update" archives the current file to `_archived/{timestamp}/…` (preserved in S3 forever), then presigns a new upload slot under the same docId. Archived copies are filtered from the doc listing and don't count toward the 4-doc limit. 34/34 smoke green.
