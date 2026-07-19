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

Xcode → open `frontend/ios/App/App.xcodeproj` → target **Petshots** → Signing &
Capabilities → check "Automatically manage signing" → Team: add your Apple ID
(free "Personal Team" works). Plug in the phone, trust the computer, Run.
Free-team caveats: app expires after 7 days (re-run from Xcode), **push
notifications won't work** (needs the paid program), and you may need to
trust the developer profile on the phone (Settings → General → VPN & Device
Management).

### 3. Apple Developer Program — $99/year (the real gate)

https://developer.apple.com/programs/enroll — needed for TestFlight, the App
Store, and APNs push. **Cost: $99/yr, recurring.** Enroll as an individual
(fine to switch to an LLC later; an org enrollment needs a D-U-N-S number, so
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

### 7. Apple In-App Purchase billing with StoreKit 2

The paid tier is sold only through the iOS app. The local
`StoreKitBillingPlugin.swift` loads the products, presents Apple's purchase
sheet, returns Apple's signed transaction, and restores current entitlements.
There is no billing SDK, account, API key, or intermediary dashboard.

The API endpoint `POST /billing/apple/sync` verifies Apple's JWS certificate
chain, bundle ID, product ID, expiration, and `appAccountToken` before granting
paid limits. App Store Server Notifications V2 can be configured at
`https://ycg5npcyk8.execute-api.us-east-1.amazonaws.com/billing/apple-webhook`;
that endpoint verifies Apple's outer notification and inner transaction. See
`PAYMENTS.md` for the complete data shape and threat model.

Both subscriptions already exist in App Store Connect under subscription group
"Petshots Paid": `petshots_paid_monthly` (one month) and
`petshots_paid_yearly` (one year). Pricing and localization live only in App
Store Connect. The group itself also needs an App Store Localization; without
it, products can remain in "Missing Metadata" even when their individual
localizations are complete. The review screenshot uploader accepted JPEG when
it rejected equivalent PNG files.

Remaining device verification:

1. Archive a fresh signed build and install it through TestFlight or Xcode.
2. With a sandbox Apple account, confirm both localized prices render, buy a
   plan, and verify `plan.json` contains an active `billing.apple` rail.
3. Toggle the owner-only Free/Paid tester switch and confirm the free tier
   exposes only two pets without deleting the others.
4. Confirm Restore Purchases reactivates the plan and a sandbox expiration
   returns the account to free. If products are empty, check App Store Connect
   metadata, Paid Apps agreement, tax, and banking—not application credentials.

#### Password AutoFill

The login form uses `autocomplete="username"` + `current-password`, but that is
not enough inside a Capacitor WKWebView. `App.entitlements` now declares
`webcredentials:petshots.app`, and
`frontend/public/.well-known/apple-app-site-association` links the domain to
`8ST43C8H2Z.app.petshots.ios`. `FrontendStack` forces the extensionless file's
response Content-Type to JSON. Deploy the frontend file + FrontendStack, then
install a newly signed build; iOS performs the association check at install.

### 8. Universal links (later, optional)

So `https://petshots.app/p/{token}` and `/join/{token}` open the app when
installed: host `/.well-known/apple-app-site-association` (JSON, served by
the frontend bucket/CloudFront) + add the Associated Domains capability
(`applinks:petshots.app`) in Xcode. Deferred — plain https links work fine
meanwhile (they open Safari, which is where logged-out invitees land anyway).

### 9. Background location for walk tracking

Walk tracking was foreground-only through session 34 — locking the screen or
switching apps stopped `@capacitor/geolocation`'s `watchPosition` fixes from
arriving (a real walk logged 0.05mi instead of ~1mi because the phone was in
a pocket). `@capacitor/geolocation` has no way to set iOS's
`CLLocationManager.allowsBackgroundLocationUpdates`, so a small app-local
Swift plugin was added instead — same precedent as `HealthPlugin.swift`
(Capacitor's official plugin doesn't expose the capability this needs).

**Scope, deliberately (Mark, 2026-07-15): survive backgrounding/locking/app-
switching, NOT a force-quit.** No persisted state, no relaunch-on-location-
event handling — if the app is actually killed mid-walk, the walk is still
lost, same as before. Web is unaffected and unchanged — browsers have no
background-location capability at all, foreground-only there is permanent.

- `frontend/ios/App/App/BackgroundWalkPlugin.swift` — owns a single
  `CLLocationManager` for the whole walk (registered in
  `BridgeViewController.swift`, wrapped in `frontend/src/native.ts` as
  `BackgroundWalk`). Methods: `requestAlways()` (handles both round-trips
  through iOS's permission UI — When-In-Use first, then the Always upgrade),
  `start()`/`pause()`/`resume()`/`end()`, `snapshot()`. Distance accumulates
  natively (great-circle distance + a >3m jitter filter that MUST MATCH the
  JS `haversineMeters` filter in `Dashboard.tsx`'s `useWalkTracker`).
- `useWalkTracker` (`Dashboard.tsx`) branches on `isNative`: native calls the
  plugin at every state transition instead of touching
  `Geolocation.watchPosition`; the existing 1-second tick effect polls
  `backgroundWalkSnapshot()` on native so the displayed distance catches up
  the instant the app returns to the foreground — no separate
  `appStateChange` listener needed.
- **Bug found on the first real-device test (2026-07-15): distance/pace
  never moved at all, even walking in the foreground.** Root cause: Capacitor
  runs plugin methods on a background dispatch queue by default, but
  `CLLocationManager` needs an active run loop to reliably start updates and
  deliver delegate callbacks — in practice, the main thread. Every method in
  `BackgroundWalkPlugin.swift` now wraps its body in
  `DispatchQueue.main.async` (creation, permission requests, start/stop, and
  the resolve calls). Fixed and compiles clean; **still needs the next
  real-device walk to confirm** — this exact bug means the plugin was never
  actually verified working at all until this fix goes on a device.
- `Info.plist` gained `UIBackgroundModes: [location]` — a plain array key,
  **not an entitlement or an Apple Developer Portal capability** (unlike
  HealthKit/APNs), so no dashboard/provisioning steps were needed.
  `NSLocationAlwaysAndWhenInUseUsageDescription` already existed (added
  alongside the original walk feature, unused until now).
- New Swift files need a **manual project.pbxproj entry** to be compiled —
  Xcode's project format here uses explicit `PBXBuildFile`/`PBXFileReference`
  entries (not the newer file-system-synchronized groups), so a new `.swift`
  file dropped in the directory alone won't build until it's wired into
  `project.pbxproj` (done here by hand, mirroring `HealthPlugin.swift`'s
  entries) — remember this next time a new native file is added.

## What was verified without an Apple account

- `xcodebuild` compile against the iOS simulator SDK (no signing) — green,
  including the new `BackgroundWalkPlugin.swift`.
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
- **Background location tracking (section 9)** — 100% native/client code,
  can't be simulated or smoke-tested. Needs a real outdoor walk: start
  tracking, lock the screen or switch apps for a few minutes while actually
  walking, return to the app, confirm distance caught up correctly; also
  confirm ending/discarding a walk actually stops updates (battery/privacy
  correctness). Needs a fresh `cap sync ios` + Xcode rebuild + TestFlight
  archive first — nothing above has touched a device yet.
