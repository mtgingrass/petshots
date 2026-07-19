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
import type { Theme } from './utils/theme';
import { APPLE_IAP } from './productConfig';

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

// App-local iOS plugin (frontend/ios/App/App/BackgroundWalkPlugin.swift) —
// replaces @capacitor/geolocation for NATIVE walk tracking so a walk keeps
// recording distance while the phone is locked/backgrounded (that plugin has
// no way to set CLLocationManager.allowsBackgroundLocationUpdates). Web still
// uses @capacitor/geolocation directly in useWalkTracker — browsers have no
// background-location capability, so there's nothing for this plugin to do
// there; every wrapper below is a no-op on web.
interface BackgroundWalkPlugin {
  requestAlways(): Promise<{ status: 'always' | 'whenInUse' | 'denied' }>;
  start(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  end(): Promise<{ distanceMeters: number }>;
  snapshot(): Promise<{ distanceMeters: number }>;
}
const BackgroundWalk = registerPlugin<BackgroundWalkPlugin>('BackgroundWalk');

// Requests location permission, escalating to "Always" if only "When In Use"
// is granted so far (the plugin handles both round-trips through iOS's
// permission UI). Never throws — a denial just means background tracking
// silently degrades to foreground-only, same as before this feature existed.
export async function requestAlwaysLocation(): Promise<'always' | 'whenInUse' | 'denied'> {
  if (!isNative) return 'denied';
  try {
    return (await BackgroundWalk.requestAlways()).status;
  } catch {
    return 'denied';
  }
}

export async function backgroundWalkStart(): Promise<void> {
  if (!isNative) return;
  await BackgroundWalk.start();
}
export async function backgroundWalkPause(): Promise<void> {
  if (!isNative) return;
  await BackgroundWalk.pause();
}
export async function backgroundWalkResume(): Promise<void> {
  if (!isNative) return;
  await BackgroundWalk.resume();
}
// Resolves the final GPS-truth distance and stops tracking. Also used as the
// "stop everything" call for Cancel/Discard, where the distance is ignored.
export async function backgroundWalkEnd(): Promise<number> {
  if (!isNative) return 0;
  return (await BackgroundWalk.end()).distanceMeters;
}
// Polled once a second while a walk is active (see useWalkTracker) so the
// displayed distance catches up the instant the app returns to the
// foreground, without needing a separate appStateChange listener.
export async function backgroundWalkSnapshot(): Promise<number> {
  if (!isNative) return 0;
  return (await BackgroundWalk.snapshot()).distanceMeters;
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

export interface StoreKitProduct {
  identifier: string;
  displayName: string;
  description: string;
  displayPrice: string;
}

interface StoreKitBillingPlugin {
  getProducts(): Promise<{ products: StoreKitProduct[] }>;
  purchase(options: {
    productId: string;
    appAccountToken: string;
  }): Promise<{ signedTransaction?: string; cancelled?: boolean; pending?: boolean }>;
  currentEntitlements(): Promise<{ signedTransactions: string[] }>;
  restore(): Promise<{ signedTransactions: string[] }>;
}

const StoreKitBilling = registerPlugin<StoreKitBillingPlugin>('StoreKitBilling');

export interface PaidOfferingPackages {
  monthly: StoreKitProduct | null;
  annual: StoreKitProduct | null;
  warning?: string;
}

// Product metadata and localized prices come straight from StoreKit/App Store
// Connect. There is no intermediary SDK, dashboard, API key, or offering.
export async function getPaidOfferingPackages(): Promise<PaidOfferingPackages> {
  if (!isNative) throw new Error('App Store billing is only available in the iOS app.');
  try {
    const { products } = await StoreKitBilling.getProducts();
    const monthly = products.find((product) => product.identifier === APPLE_IAP.MONTHLY_PRODUCT_ID) ?? null;
    const annual = products.find((product) => product.identifier === APPLE_IAP.ANNUAL_PRODUCT_ID) ?? null;
    if (!monthly && !annual) {
      throw new Error('No subscriptions are available from the App Store for this build.');
    }
    const missing = [!monthly && 'monthly', !annual && 'annual'].filter(Boolean);
    return {
      monthly,
      annual,
      ...(missing.length ? { warning: `The ${missing.join(' and ')} plan is temporarily unavailable.` } : {}),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown App Store error';
    throw new Error(detail.startsWith('App Store') || detail.startsWith('No subscriptions')
      ? detail
      : `App Store plans could not be loaded. ${detail}`);
  }
}

export async function purchaseStoreKitProduct(
  appAccountToken: string,
  product: StoreKitProduct,
): Promise<{ signedTransaction?: string; cancelled?: boolean; pending?: boolean }> {
  if (!isNative) throw new Error('App Store billing is only available in the iOS app.');
  return StoreKitBilling.purchase({ productId: product.identifier, appAccountToken });
}

// AppStore.sync() is intentionally called only behind this explicit action.
export async function restoreStoreKitPurchases(): Promise<string[]> {
  if (!isNative) throw new Error('App Store billing is only available in the iOS app.');
  return (await StoreKitBilling.restore()).signedTransactions;
}

// Reads StoreKit's locally/currently known entitlements without showing UI or
// forcing AppStore.sync(). Used at launch so renewals repair server state even
// if App Store Server Notifications have not been configured yet.
export async function getCurrentStoreKitEntitlements(): Promise<string[]> {
  if (!isNative) return [];
  return (await StoreKitBilling.currentEntitlements()).signedTransactions;
}
