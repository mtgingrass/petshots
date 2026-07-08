import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { AuthProvider } from './auth/AuthContext'
import { applyTheme, getSavedTheme } from './utils/theme'

// Apply saved theme before first paint to avoid flash.
applyTheme(getSavedTheme());

// PWA: offline fallback + install support. Prod only — a worker on
// localhost:5173 would cache dev-server output and confuse hot reload.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').then(async () => {
      // The worker doesn't control this very first page load, so its
      // fetch handler never sees the hashed /assets/* files — and a user who
      // visited exactly once would get a blank page offline (door mode's
      // worst case). Push this page's own bundles into the cache directly.
      try {
        const cache = await caches.open('petshots-v1');
        const assets = [
          ...document.querySelectorAll<HTMLScriptElement>('script[src]'),
          ...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
        ]
          .map((el) => ('src' in el ? el.src : el.href))
          .filter((u) => new URL(u).origin === location.origin);
        await cache.addAll(assets);
      } catch {
        // best-effort — the fetch handler still caches assets on later visits
      }
    });
  });
}

// BrowserRouter gives clean URLs (/dashboard, not /#/dashboard). CloudFront is
// already configured to rewrite 403/404 -> /index.html, so deep links work.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)
