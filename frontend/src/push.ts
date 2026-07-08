// Web Push subscription management for the Settings toggle. The browser
// subscribes against our VAPID public key; the resulting endpoint+keys go to
// the API, and the reminder Lambda pushes through them. On iOS this only
// works for the installed (home-screen) PWA — Safari in-browser has no
// PushManager, which getPushState reports as 'unsupported'.
import { config } from './config';
import { subscribePush, unsubscribePush } from './api';

export type PushState = 'on' | 'off' | 'denied' | 'unsupported';

export function pushSupported(): boolean {
  return (
    !!config.vapidPublicKey &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

// iOS Safari that could push if the site were installed to the home screen.
export function iosNeedsInstall(): boolean {
  const iOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as { standalone?: boolean }).standalone === true;
  return iOS && !standalone && !('PushManager' in window);
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
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? 'on' : 'off';
}

// Must be called from a user gesture (the toggle click) — iOS requires it.
export async function enablePush(): Promise<void> {
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
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await unsubscribePush(sub.endpoint).catch(() => {}); // server row is best-effort
  await sub.unsubscribe();
}
