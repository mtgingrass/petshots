# Petshots iOS app

The iPhone app is the same React SPA that ships to petshots.app, wrapped in a
native shell with [Capacitor](https://capacitorjs.com). One codebase: every
feature on the web dashboard (multi-pet, records, AI scan, meds, Daily tab,
family, passport, weights, billing) works identically in the app, plus native
extras — APNs push notifications, haptics on check-offs, themed status bar,
splash screen, offline door mode without any service-worker caveats.

## How it's put together

- `frontend/capacitor.config.ts` — app id `app.petshots.ios`, web assets from
  `dist/`. The webview serves the local bundle **as `https://petshots.app`**
  (`server.hostname` + `iosScheme: 'https'`), so the Turnstile site key
  (domain-bound), API Gateway CORS, and the uploads-bucket CORS all accept the
  app with zero server changes.
- `frontend/ios/` — the Xcode project (Swift Package Manager, no CocoaPods).
  Committed to git; regenerate-able with `npx cap add ios` but don't — it has
  hand edits (AppDelegate push callbacks, entitlements).
- `frontend/src/native.ts` — the only bridge layer. Everything in it is a
  no-op on the web build, so web behavior is untouched.
- Push: the Settings toggle registers an APNs device token and stores it via
  the same `POST /push/subscribe` route (`{platform:'ios', token}`); the
  reminder Lambda sends through APNs directly (HTTP/2 + ES256 token auth, no
  new dependencies) alongside web push and email.
- Apple Health: saved walks are mirrored as Walking workouts (duration +
  distance; Apple computes the human's calories/rings). App-local plugin —
  `ios/App/App/HealthPlugin.swift`, registered in `BridgeViewController.swift`
  (Main.storyboard points at that subclass, not `CAPBridgeViewController`;
  Capacitor only auto-discovers packaged plugins). Write-only HealthKit
  entitlement + both `NSHealth*UsageDescription` strings; permission denied =
  silent skip. Called fire-and-forget from the walk-save flow via `native.ts`.
- The service worker is skipped in the app (assets are local already); the
  door cache (offline records) works as-is via localStorage + Cache API.

## Day-to-day dev loop

```bash
cd frontend
npm run build          # tsc + vite → dist/
npx cap sync ios       # copy dist/ into the iOS project + sync plugins
npx cap open ios       # open in Xcode → Run
```

If `xcodebuild` complains about CommandLineTools, either prefix commands with
`DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` or fix it once:

```bash
sudo xcode-select -s /Applications/Xcode.app   # PLACEHOLDER: needs your password
```

## Manual steps (in order — everything below needs Mark)

### 1. Download an iOS simulator runtime (free, ~15 min)

Xcode 26.6 is installed but no iOS runtime is. Xcode → Settings → Components
→ iOS 26.x, or:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -downloadPlatform iOS
```

Then Run in Xcode targets a simulated iPhone. No Apple account needed.

### 2. Run on your real iPhone (free Apple ID)

Xcode → open `frontend/ios/App/App.xcodeproj` → target **App** → Signing &
Capabilities → check "Automatically manage signing" → Team: add your Apple ID
(free "Personal Team" works). Plug in the phone, trust the computer, Run.
Free-team caveats: app expires after 7 days (re-run from Xcode), **push
notifications won't work** (needs the paid program), and you may need to
trust the developer profile on the phone (Settings → General → VPN & Device
Management).

### 3. Apple Developer Program — $99/year (the real gate)

https://developer.apple.com/programs/enroll — needed for TestFlight, the App
Store, and APNs push. **Cost: $99/yr, recurring.** Enroll as an individual
(fine to switch to an LLC later — this overlaps with the open Stripe
LLC-vs-sole-prop decision; an org enrollment needs a D-U-N-S number, so
individual is the fast path).

After enrolling, in Xcode set the Team to the paid team. The bundle ID
`app.petshots.ios` registers automatically with automatic signing.

### 4. APNs push key → Secrets Manager (unlocks iOS push)

The entire code path is already live and skipping gracefully — the reminder
> **✅ DONE 2026-07-10** — secret `petshots/apns` created (key `6479F9744G`,
> team `8ST43C8H2Z`, scoped Sandbox & Production in Apple's portal,
> `environment: production` for TestFlight builds). ReminderFn containers
> recycled so the per-container "no secret" cache can't linger. The `.p8`
> lives in Secrets Manager; the download copy was in `~/Downloads` — keep a
> backup (Apple won't re-issue it) or delete it, Secrets Manager is the
> operative copy. Remaining human steps: toggle push ON in the app on a
> TestFlight build, then expect the next 9:00 UTC reminder as a notification.

Lambda logs `apns secret unavailable — iOS push skipped` daily until this
exists.

1. https://developer.apple.com/account → Certificates, IDs & Profiles →
   **Keys** → **+** → check "Apple Push Notifications service (APNs)" →
   register → **download the `.p8` file** (one-time download!) and note the
   **Key ID**. Your **Team ID** is top-right on the membership page.
2. Make sure the App ID `app.petshots.ios` has the Push Notifications
   capability (Identifiers → app.petshots.ios → check Push Notifications).
3. Create the secret (**cost: +$0.40/mo Secrets Manager**):

```bash
aws secretsmanager create-secret --name petshots/apns --secret-string '{
  "teamId":   "PLACEHOLDER_TEAM_ID",
  "keyId":    "PLACEHOLDER_KEY_ID",
  "bundleId": "app.petshots.ios",
  "environment": "sandbox",
  "privateKey": "-----BEGIN PRIVATE KEY-----\nPLACEHOLDER_P8_CONTENTS\n-----END PRIVATE KEY-----\n"
}'
```

(`privateKey` is the full contents of the `.p8` file with `\n` for newlines.)

**The `environment` field matters**: builds run from Xcode get *sandbox*
device tokens; TestFlight/App Store builds get *production* tokens. Set
`"environment": "sandbox"` while testing from Xcode, then update the secret
to `"environment": "production"` (or delete the field) once you're on
TestFlight. A mismatch shows up as `BadDeviceToken` in the ReminderFn logs
and the stored token gets pruned — re-toggle push in Settings to re-register.

Test: enable the Settings → Push notifications toggle in the app, then invoke
the reminder Lambda with `{"dryRun": true}` — `wouldPush` should count the
device. A real send happens at the next 9:00 UTC cron.

### 5. TestFlight → App Store

1. https://appstoreconnect.apple.com → My Apps → **+** → New App → platform
   iOS, bundle ID `app.petshots.ios`, SKU `petshots-ios`.
2. Xcode → Product → Archive → Distribute App → App Store Connect. First
   archive: bump nothing; later releases: bump `MARKETING_VERSION` /
   `CURRENT_PROJECT_VERSION` in the App target.
3. TestFlight tab → add yourself (and Darya) as internal testers — instant,
   no review.
4. App Store review needs: screenshots (6.7" + 5.5", the Playwright shots at
   iPhone viewport are a starting point), description (no flowery language),
   support URL (petshots.app), **privacy policy URL** (petshots.app/privacy —
   already live), and the App Privacy questionnaire (data collected: email,
   photos/docs the user uploads; not sold, not tracked — no ATT needed since
   there's no tracking).
5. Review guideline note: the app has account deletion in Settings (required
   by Apple — already shipped s18) and sign-up works in-app. Both good.

### 7. Apple In-App Purchase billing via RevenueCat

The paid tier's native rail — Stripe (web) untouched, RevenueCat wraps
StoreKit for the iOS app. `frontend/src/native.ts` has the
configure/getOfferings/purchasePackage/restorePurchases wrappers (no-op
without a real key); backend is `infra/lambda/api/index.ts`'s
`syncRevenueCatEntitlement` + `POST /billing/revenuecat-webhook` +
`POST /billing/revenuecat/sync`, config in
`infra/lambda/shared/config.ts`'s `REVENUECAT` block. Cost: free at this
scale (RevenueCat's free tier goes up to $2.5k/mo tracked revenue).

> **✅ DONE 2026-07-14** — RevenueCat account + "Petshots" project created.
> Entitlement identifier is **`Petshots Pro`** (not `paid` — matched in
> `shared/config.ts`'s `REVENUECAT.ENTITLEMENT_ID`, deployed). App Store
> Connect **In-App Purchase key** (`SubscriptionKey_*.p8` — a distinct key
> type from the general "App Store Connect API" key used for APNs/CI;
> generated under Users and Access → Integrations → **In-App Purchase**,
> role Admin) connected in RevenueCat. RevenueCat Secret API key + a
> webhook (HMAC-signed, pointed at
> `https://ycg5npcyk8.execute-api.us-east-1.amazonaws.com/billing/revenuecat-webhook`)
> both created; both values live in Secrets Manager `petshots/revenuecat`
> (`secretApiKey`, `webhookSigningSecret`). The real iOS app "Petshots (App
> Store)" (bundle `app.petshots.ios`) exists in RevenueCat (distinct from
> the auto-created "Test Store" sandbox app) — its **public** SDK key is in
> `frontend/.env` as `VITE_REVENUECAT_PUBLIC_API_KEY`, built and deployed to
> both web and the iOS project (`cap sync`).

> **✅ DONE 2026-07-14** — both subscriptions created under Features →
> **Subscriptions** (group "Petshots Paid"): `petshots_paid_monthly` (1
> month) and `petshots_paid_yearly` (1 year), both **Ready to Submit**.
> Pricing, localization (Display Name/Description), and Review Screenshot
> all set. Two gotchas hit along the way, worth remembering: (1) the Review
> Screenshot uploader rejected every valid device-size **PNG** we tried
> (1179×2556, 1284×2778, 1290×2796 — all correct per Apple's own
> screenshot-specs page) with "the dimensions of one or more screenshots are
> wrong" — converting the same image to **JPEG** fixed it immediately
> (`sips -s format jpeg -s formatOptions 90 -s dpiWidth 72 -s dpiHeight 72
> in.png --out out.jpg`), so this uploader appears to reject PNG outright,
> unrelated to actual pixel dimensions. (2) Both subscriptions stayed stuck
> on "Missing Metadata" even with everything above filled in — the real
> blocker was the **Subscription Group's own App Store Localization**
> (Subscriptions page → above the Level 1/2 table → Add App Store
> Localization → Subscription Group Display Name, set to "Petshots"), a
> separate, easy-to-miss field from each individual plan's own localization.

> **✅ DONE 2026-07-14** — Product Catalog wired up: both products
> (`petshots_paid_monthly`, `petshots_paid_yearly`, App: "Petshots (App
> Store)" — not the auto-created "Test Store" demo app/products, which are
> a different, unrelated leftover from onboarding) attached to the
> `Petshots Pro` entitlement. Offering **`petshots`** created (not
> `default` — that identifier was already taken by RevenueCat's onboarding
> demo offering) with Monthly/Annual packages, marked **current**. The
> app never reads an offering by name, only `offerings.current`, so the
> actual identifier is documentation only — matched in `shared/config.ts`.

Remaining:

1. **Test**: sandbox Apple ID purchase, on-device or in Xcode → confirm
   `plan.json` flips (via the sync call immediately, via the webhook shortly
   after) → confirm Restore Purchases works on a fresh install. Needs a
   Sandbox tester (App Store Connect → Users and Access → Sandbox).
2. A fresh TestFlight archive is needed regardless to pick up the RevenueCat
   SDK + the new Settings → Account purchase UI — nothing above ships to
   real devices until Mark archives one.

### 8. Universal links (later, optional)

So `https://petshots.app/p/{token}` and `/join/{token}` open the app when
installed: host `/.well-known/apple-app-site-association` (JSON, served by
the frontend bucket/CloudFront) + add the Associated Domains capability
(`applinks:petshots.app`) in Xcode. Deferred — plain https links work fine
meanwhile (they open Safari, which is where logged-out invitees land anyway).

## What was verified without an Apple account

- `xcodebuild` compile against the iOS simulator SDK (no signing) — green.
- Web bundle typechecks + builds with all native code paths in place.
- Web behavior unchanged (everything is gated on `Capacitor.isNativePlatform()`).
- API + reminder Lambda changes deployed and smoke-tested (`smoke-api`,
  `smoke-digest` cover subscribe/unsubscribe both shapes).

## What could NOT be machine-verified (needs a human + hardware)

- Real push round-trip (needs paid program + APNs key + physical iPhone).
- Camera/photo picker inside the WKWebView file input (should just work —
  WKWebView presents the native picker — but eyeball it).
- Turnstile widget rendering under the `capacitor://` → `https://petshots.app`
  hostname mapping (expected to pass since the origin matches the site key's
  domain; if it balks, add a `localhost` domain to the Turnstile widget in
  the Cloudflare dashboard as a fallback).
- Face ID / biometric app lock: not built. Candidate for v2 of the app
  (plugin: `capacitor-native-biometric`), noted in TODO.md.
