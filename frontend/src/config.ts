// Cognito configuration, read from Vite env vars.
// VITE_* vars are inlined into the browser bundle at build time. These are
// public client identifiers (not secrets) — the SPA talks straight to Cognito.

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

export const config = {
  region: required('VITE_AWS_REGION', import.meta.env.VITE_AWS_REGION),
  userPoolId: required('VITE_COGNITO_USER_POOL_ID', import.meta.env.VITE_COGNITO_USER_POOL_ID),
  clientId: required('VITE_COGNITO_CLIENT_ID', import.meta.env.VITE_COGNITO_CLIENT_ID),
  // Base URL of PetshotsApiStack's HTTP API (no trailing slash). Not a secret.
  apiBaseUrl: required('VITE_API_BASE_URL', import.meta.env.VITE_API_BASE_URL),
  // Cloudflare Turnstile site key (public). Currently the always-pass TEST key.
  turnstileSiteKey: required('VITE_TURNSTILE_SITE_KEY', import.meta.env.VITE_TURNSTILE_SITE_KEY),
};
