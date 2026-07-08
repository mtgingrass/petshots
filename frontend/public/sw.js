// Petshots service worker — conservative by design.
//
// Strategy:
//  - Navigations: network-first, falling back to the last cached index.html
//    only when offline. The network copy always wins, so a deploy can never
//    be masked by this worker.
//  - /assets/*: cache-first. Vite content-hashes these filenames, so a cached
//    entry is immutable by construction.
//  - Everything else (API on execute-api.*, presigned S3 URLs): untouched.
//
// Bump CACHE_VERSION to force old caches to be dropped on activate.
// Keep in sync with the asset-precache cache name in main.tsx.
const CACHE_VERSION = 'petshots-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) =>
        cache.addAll(['/', '/manifest.json', '/icon-192.png', '/favicon.svg']),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            // Only reap our own versioned caches — petshots-door-v1 (door
            // mode's offline doc store, owned by doorCache.ts) must survive
            // service-worker updates.
            .filter((k) => k.startsWith('petshots-v') && k !== CACHE_VERSION)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // API + S3 pass through
  if (event.request.method !== 'GET') return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          // Keep the offline fallback fresh with every successful navigation.
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ??
          fetch(event.request).then((res) => {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
            return res;
          }),
      ),
    );
  }
});
