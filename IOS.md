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

### 6. Universal links (later, optional)

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
