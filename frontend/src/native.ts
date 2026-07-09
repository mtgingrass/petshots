// Native (Capacitor/iOS) integration layer. Every export here is a safe
// no-op on the web build, so the rest of the app can call these without
// platform checks scattering everywhere. Plugin modules are imported
// statically — Capacitor plugins ship web fallbacks and tree-shake fine —
// but nothing runs unless isNative is true.
import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import { SplashScreen } from '@capacitor/splash-screen';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { PushNotifications } from '@capacitor/push-notifications';
import type { Theme } from './utils/theme';

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
