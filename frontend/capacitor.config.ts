import type { CapacitorConfig } from '@capacitor/cli';

// iOS app shell around the same SPA that ships to petshots.app.
// The bundle is built by Vite into dist/ and copied into the app by
// `npx cap sync ios` — the native app serves it locally (works offline).
const config: CapacitorConfig = {
  appId: 'app.petshots.ios',
  appName: 'Petshots',
  webDir: 'dist',
  server: {
    // Serve the local bundle AS https://petshots.app: the WKWebView origin
    // then matches the real site, so the Turnstile site key (domain-bound),
    // API Gateway CORS, and the uploads-bucket CORS all accept the app
    // without any server-side changes. Requests to this hostname are
    // intercepted and served from the local bundle.
    hostname: 'petshots.app',
    iosScheme: 'https',
  },
  ios: {
    // Let the webview extend under the status bar / home indicator; the CSS
    // already handles env(safe-area-inset-*) from the PWA work.
    contentInset: 'never',
  },
  plugins: {
    // Required because iosScheme is 'https': WKWebView registers Capacitor's
    // local-asset handler for the ENTIRE https scheme (any host, not just
    // `hostname` above), so unpatched fetch/XHR calls to the API Gateway/
    // Cognito/S3 hosts get routed at the local bundle and fail with a
    // generic "Load failed" TypeError. Enabling CapacitorHttp patches
    // fetch/XHR to detect non-local-origin requests and send them through
    // native networking instead — same-origin (petshots.app) requests are
    // untouched and still resolve from the bundled files.
    CapacitorHttp: {
      enabled: true,
    },
    PushNotifications: {
      // Show reminder notifications even while the app is foregrounded.
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    SplashScreen: {
      launchShowDuration: 800,
      launchAutoHide: true,
      backgroundColor: '#0f1220',
      showSpinner: false,
    },
  },
};

export default config;
