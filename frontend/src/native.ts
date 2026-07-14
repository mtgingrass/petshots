// Native (Capacitor/iOS) integration layer. Every export here is a safe
// no-op on the web build, so the rest of the app can call these without
// platform checks scattering everywhere. Plugin modules are imported
// statically — Capacitor plugins ship web fallbacks and tree-shake fine —
// but nothing runs unless isNative is true.
import { Capacitor, registerPlugin } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import { SplashScreen } from '@capacitor/splash-screen';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { PushNotifications } from '@capacitor/push-notifications';
import { App } from '@capacitor/app';
import { Purchases, type PurchasesPackage } from '@revenuecat/purchases-capacitor';
import type { Theme } from './utils/theme';
import { config } from './config';

export const isNative = Capacitor.isNativePlatform();

// Called once from main.tsx before render.
export function initNative(theme: Theme) {
  if (!isNative) return;
  // CSS hook: lets native-only rules (bottom tab bar on an iPad-width
  // viewport, hidden desktop chrome) apply regardless of media queries.
  document.documentElement.dataset.native = 'true';
  void syncStatusBar(theme);
  void SplashScreen.hide();
  // Tapping a reminder notification deep-links into the app. The url comes
  // from the APNs payload the reminder Lambda sends (defaults to /dashboard).
  void PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
    const url = (action.notification.data as { url?: string } | undefined)?.url;
    if (typeof url === 'string' && url.startsWith('/')) window.location.assign(url);
  });
}

// Keep the native status bar matching the app theme; applyTheme() calls this.
export async function syncStatusBar(theme: Theme) {
  if (!isNative) return;
  try {
    // Style.Dark = light text (for our dark bg), Style.Light = dark text.
    await StatusBar.setStyle({ style: theme === 'light' ? Style.Light : Style.Dark });
  } catch {
    /* not fatal */
  }
}

// Light tap feedback for check-offs and toggles. No-op on web.
export function hapticTap() {
  if (!isNative) return;
  void Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
}

// Success feedback for completed actions (med given, record saved).
export function hapticSuccess() {
  if (!isNative) return;
  void Haptics.notification({ type: NotificationType.Success }).catch(() => {});
}

// Warning feedback for destructive confirms (delete pet/account).
export function hapticWarning() {
  if (!isNative) return;
  void Haptics.notification({ type: NotificationType.Warning }).catch(() => {});
}

// App-local iOS plugin (frontend/ios/App/App/HealthPlugin.swift) — no web
// implementation exists, so every call is guarded by isNative.
interface HealthPlugin {
  saveWalkWorkout(options: {
    startedAtMs: number;
    endedAtMs: number;
    distanceMeters: number;
  }): Promise<{ saved: boolean; reason?: string }>;
}
const Health = registerPlugin<HealthPlugin>('Health');

// Mirror a just-saved walk into Apple Health as a Walking workout, so Apple
// credits the human's activity rings/calories with its own models (why we
// don't estimate human kcal ourselves). Best-effort: the walk is already in
// our API by the time this runs, and a denied Health permission or any
// HealthKit failure must never surface as a walk-save error.
export function saveWalkToAppleHealth(startedAtMs: number, endedAtMs: number, distanceMeters: number) {
  if (!isNative) return;
  void Health.saveWalkWorkout({ startedAtMs, endedAtMs, distanceMeters }).catch(() => {});
}

// version = CFBundleShortVersionString ("1.0"), build = CFBundleVersion
// ("3") — set from MARKETING_VERSION/CURRENT_PROJECT_VERSION in the Xcode
// project (App.xcodeproj/project.pbxproj), bumped there when Mark archives
// a new TestFlight build. null on web — there's no build number for a site
// that's always the latest deploy. Shown in Settings → Account so a
// TestFlight tester (or Mark) can confirm which build they're running.
export async function getAppVersion(): Promise<{ version: string; build: string } | null> {
  if (!isNative) return null;
  try {
    const info = await App.getInfo();
    return { version: info.version, build: info.build };
  } catch {
    return null;
  }
}

export type { PurchasesPackage };

// Apple In-App Purchase billing (iOS app only, via RevenueCat) — the paid
// tier's native rail alongside Stripe on the web. app_user_id is always the
// Cognito sub, so the backend webhook/sync route can write plan.json without
// a reverse-mapping step. No-ops without a real public API key (e.g. before
// the RevenueCat dashboard is set up) so nothing crashes; the purchase
// buttons in Settings simply won't offer packages until it's configured.
let revenueCatConfigured = false;
export async function configureRevenueCat(appUserId: string) {
  if (!isNative || !config.revenueCatPublicApiKey || revenueCatConfigured) return;
  try {
    await Purchases.configure({ apiKey: config.revenueCatPublicApiKey, appUserID: appUserId });
    revenueCatConfigured = true;
  } catch {
    /* not fatal — purchase buttons just won't offer packages */
  }
}

// The monthly/annual packages from the dashboard-configured "default"
// offering, or null if not configured yet / offline / not native.
export async function getPaidOfferingPackages(): Promise<{
  monthly: PurchasesPackage | null;
  annual: PurchasesPackage | null;
} | null> {
  if (!isNative || !revenueCatConfigured) return null;
  try {
    const offerings = await Purchases.getOfferings();
    const current = offerings.current;
    if (!current) return null;
    return { monthly: current.monthly, annual: current.annual };
  } catch {
    return null;
  }
}

// Lets Apple's purchase sheet run; throws on failure (including user
// cancellation) so the caller's existing busy/error handling shows it,
// same pattern as the web's handleCheckout.
export async function purchaseRevenueCatPackage(pkg: PurchasesPackage): Promise<void> {
  await Purchases.purchasePackage({ aPackage: pkg });
}

// Required by App Store review for any app selling non-consumable/
// subscription IAP. Throws on failure, same as purchaseRevenueCatPackage.
export async function restoreRevenueCatPurchases(): Promise<void> {
  await Purchases.restorePurchases();
}
