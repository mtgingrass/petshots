# App Store Submission Pack — Petshots iOS

Everything needed to fill out App Store Connect, in paste-ready form. The
Apple-side account/signing/TestFlight runbook lives in [IOS.md](./IOS.md) —
do that first (Developer Program → APNs key → archive/upload). This file
covers the store listing and review.

Screenshots: captured at 1320×2868 (6.9", the only required size) in
`~/Desktop/petshots-appstore/`. Retake any time with
`node frontend/scripts/appstore-shots.mjs demo@petshots.app <password>`
(plus `appstore-retake.mjs` for the overview/public-passport variants).
The app is iPhone-only (`TARGETED_DEVICE_FAMILY = 1`), so no iPad
screenshots are needed.

## App Information

| Field | Value |
|---|---|
| Name | Petshots |
| Subtitle | Pet vaccine records & sharing |
| Bundle ID | app.petshots.ios |
| SKU | petshots-ios-1 |
| Primary category | Lifestyle |
| Secondary category | Productivity |
| Age rating | 4+ (answer "No" to everything in the questionnaire) |
| Price | Free |
| Support URL | https://petshots.app/support |
| Marketing URL | https://petshots.app |
| Privacy Policy URL | https://petshots.app/privacy |
| Copyright | © 2026 Mark Gingrass |
| Version | 1.0 |

## Promotional text (170 chars max, editable without review)

> Proof of shots, in seconds — at the groomer, boarding, daycare, or the dog
> bar. Scan a record once and it's always in your pocket.

## Description

```
Stop scrambling for shot records at the door. Petshots keeps your pet's
vaccination records on your phone and shows the right certificate in
seconds — at the groomer, boarding, daycare, or the dog bar.

SCAN A RECORD, DONE
Photograph a vaccine certificate and Petshots reads it for you: vaccine
names, dates given, expiry dates. Review, save, done.

KNOW WHAT'S DUE
Every record gets a live status — current, due soon, or overdue — and
you get a reminder before anything expires.

SHARE A PET PASSPORT
Create a link or QR code your groomer, sitter, or boarding facility can
open without an account. Revoke it any time.

BUILT FOR THE WHOLE FAMILY
Invite a family member: same pets, same records, same daily checklist.
See that the dog really was fed this morning — and who checked it off.

DAILY CARE, TOGETHER
Feeding, walks, meds, mood — a shared checklist that resets each day,
with automatic entries for medications that are due.

WORKS AT THE DOOR, EVEN OFFLINE
Your records are cached on your phone, so proof of rabies vaccination
shows even with zero bars inside a metal building.

MEDICATION REMINDERS
Heartworm, flea & tick, or daily meds — set a schedule, mark as given,
get reminded.

Free for up to 2 pets. Your records stay private: no ads, no analytics,
no selling data.
```

## Keywords (100 chars max)

```
pet,vaccine,records,rabies,vaccination,dog,cat,groomer,boarding,daycare,reminders,passport,vet
```

## App Review Information

- **Demo account**: `demo@petshots.app` — password is in Claude memory
  (`reference_demo_account.md`); paste it into the review notes field in
  App Store Connect. NEVER commit it to this file (public repo).
- **Review notes** (paste-ready):

```
Petshots stores pet vaccination records and shares them with groomers and
boarding facilities. A demo account with two pets and realistic records is
provided above.

Things reviewers may want context on:
- The Passport tab generates a shareable link + QR code. Opening it shows a
  public read-only page (no account needed) — that is the intended feature:
  the pet owner shows the QR to front-desk staff.
- A paid tier exists on our website. The iOS app does not sell, price, or
  link to any purchase; every feature shown works on the free tier.
- Push notifications deliver vaccine/medication reminders; enabling them is
  optional and the app is fully functional without them.
- Account deletion is self-service: Settings → Danger zone → Delete account.
- The app works offline: records are cached on device and available from
  the login screen even with no connectivity.
```

## App Privacy (nutrition labels)

Declare "Data collected", all **linked to identity**, all for **App
Functionality** only. Answer **No** to tracking.

| Data type | What it is |
|---|---|
| Contact Info → Email Address | Account sign-in (Cognito) |
| User Content → Photos or Videos | Pet photos + photographed records |
| User Content → Other User Content | Record labels/dates, pet profiles, notes, checklists |
| Identifiers → User ID | Cognito user id |

Everything else: not collected. There are no analytics, no ads, no
third-party tracking (matches the privacy policy). If the upload wizard
flags ITMS-91053 (privacy manifest), add a `PrivacyInfo.xcprivacy` in
Xcode declaring UserDefaults access, reason code CA92.1 — the Capacitor 8
SPM packages ship their own manifests, so this likely won't come up.

## Compliance already handled in the repo

- `ITSAppUsesNonExemptEncryption = false` in Info.plist (HTTPS-only ⇒
  exempt; no export-compliance question on every upload).
- `NSCameraUsageDescription` + `NSPhotoLibraryUsageDescription` in
  Info.plist (file inputs offer "Take Photo" — missing strings would
  crash on tap = instant rejection).
- iPhone-only (`TARGETED_DEVICE_FAMILY = 1` in both build configs).
- Guideline 3.1.1 (payments): the native build hides ALL purchase
  surfaces — Stripe checkout/portal buttons (s23), the overview
  "Upgrade for more →" / "Upgrade to unlock →" links, and the plan-card
  web pointer for free users (this session, gated on `isNative`). Paid
  users see only "Your subscription is managed on the web" (allowed
  account management). Never re-introduce purchase links/pricing in
  native code paths without switching to StoreKit IAP.
- Guideline 5.1.1(v) (account deletion): in-app, Settings → Danger zone.
- Privacy policy at /privacy updated for Stripe, push tokens, AI
  extraction, and in-app deletion.

## Guideline 4.2 ("minimum functionality" / web-wrapper) defense

The app is NOT a remote website in a shell — cite these if asked:
- The web bundle ships INSIDE the app (`cap sync` copies dist/ into the
  binary); it renders with no network and does not load petshots.app.
- Offline door mode: records cached on device, presentable with zero
  connectivity — a capability the website cannot offer.
- Native APNs push notifications (reminders).
- Native camera capture, share sheet, haptics on interactions, status-bar
  theming, splash screen, safe-area-native layout.
- iOS-native interface: bottom tab bar, segmented controls, large titles,
  sheet/push transitions (session 23 pass).

## Submission order (Mark's side, after IOS.md §3–4)

1. App Store Connect → My Apps → "+" → New App (iOS, name Petshots,
   bundle id app.petshots.ios, SKU petshots-ios-1, English US).
2. Xcode: Product → Archive (Any iOS Device) → Distribute → App Store
   Connect. Signing: automatic, with your Developer Program team.
   NOTE: switch the `petshots/apns` secret to `environment: production`
   for TestFlight/App Store builds (IOS.md §4) or push silently dies.
3. TestFlight: install on your phone, verify login, camera scan, push,
   passport QR, offline mode. Add Darya as internal tester.
4. Fill App Information + Pricing (Free) + App Privacy from this file.
5. Version page: upload the 5 screenshots from ~/Desktop/petshots-appstore,
   paste promotional text/description/keywords, set the URLs, add the
   demo account + review notes, enable manual release.
6. Submit for review. First reviews typically take 24–48h.
```
