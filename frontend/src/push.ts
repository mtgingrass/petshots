// Push subscription management for the Settings toggle, two transports:
//  - Web: the browser subscribes against our VAPID public key; the resulting
//    endpoint+keys go to the API, and the reminder Lambda pushes through
//    them. On iOS Safari this only works for the installed (home-screen)
//    PWA — in-browser has no PushManager, reported as 'unsupported'.
//  - Native iOS app (Capacitor): APNs. The device token goes to the same
//    API route with platform:'ios'; the reminder Lambda sends via APNs.
import { config } from './config';
import { subscribePush, unsubscribePush, subscribeApnsPush, unsubscribeApnsPush } from './api';
import { isNative } from './native';
import { PushNotifications } from '@capacitor/push-notifications';

export type PushState = 'on' | 'off' | 'denied' | 'unsupported';

// Native: remember the token this device registered so the toggle reflects
// reality and disable can tell the server which row to remove.
const APNS_TOKEN_KEY = 'petshots.apnsToken';

export function pushSupported(): boolean {
  if (isNative) return true;
  return (
    !!config.vapidPublicKey &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

// iOS Safari that could push if the site were installed to the home screen.
export function iosNeedsInstall(): boolean {
  if (isNative) return false;
  const iOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as { standalone?: boolean }).standalone === true;
  return iOS && !standalone && !('PushManager' in window);
}

// ---- native (APNs via Capacitor) ----

async function getNativePushState(): Promise<PushState> {
  const perms = await PushNotifications.checkPermissions();
  if (perms.receive === 'denied') return 'denied';
  return perms.receive === 'granted' && localStorage.getItem(APNS_TOKEN_KEY) ? 'on' : 'off';
}

// register() resolves before iOS hands back the device token — it arrives
// via the 'registration' event, so bridge it into a promise.
function registerForApnsToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out registering for notifications')), 15_000);
    void PushNotifications.addListener('registration', (token) => {
      clearTimeout(timer);
      resolve(token.value);
    });
    void PushNotifications.addListener('registrationError', (err) => {
      clearTimeout(timer);
      reject(new Error(err.error || 'Could not register for notifications'));
    });
    void PushNotifications.register();
  });
}

async function enableNativePush(): Promise<void> {
  const perms = await PushNotifications.requestPermissions();
  if (perms.receive !== 'granted') throw new Error('PERMISSION_DENIED');
  const token = await registerForApnsToken();
  await subscribeApnsPush(token);
  localStorage.setItem(APNS_TOKEN_KEY, token);
}

async function disableNativePush(): Promise<void> {
  const token = localStorage.getItem(APNS_TOKEN_KEY);
  if (token) await unsubscribeApnsPush(token).catch(() => {}); // server row is best-effort
  localStorage.removeItem(APNS_TOKEN_KEY);
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  // Explicit ArrayBuffer (not ArrayBufferLike) — PushManager's typings demand it.
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function getPushState(): Promise<PushState> {
  if (isNative) return getNativePushState();
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? 'on' : 'off';
}

// Must be called from a user gesture (the toggle click) — iOS requires it.
export async function enablePush(): Promise<void> {
  if (isNative) return enableNativePush();
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('PERMISSION_DENIED');
  const reg =
    (await navigator.serviceWorker.getRegistration()) ??
    (await navigator.serviceWorker.register('/sw.js'));
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey),
  });
  await subscribePush(sub.toJSON());
}

export async function disablePush(): Promise<void> {
  if (isNative) return disableNativePush();
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await unsubscribePush(sub.endpoint).catch(() => {}); // server row is best-effort
  await sub.unsubscribe();
}
