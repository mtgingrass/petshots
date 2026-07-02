import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import type { PreSignUpTriggerEvent } from 'aws-lambda';

// Cognito PreSignUp trigger: verify the Cloudflare Turnstile token the SPA
// collected before letting a self-service signup through. Blocks scripted/bot
// account creation - the protection layer we need before SES leaves sandbox.
const sm = new SecretsManagerClient({});
let cachedSecret: string | undefined;

async function turnstileSecret(): Promise<string> {
  if (cachedSecret) return cachedSecret;
  const res = await sm.send(
    new GetSecretValueCommand({ SecretId: process.env.TURNSTILE_SECRET_ARN! }),
  );
  cachedSecret = res.SecretString!;
  return cachedSecret;
}

export const handler = async (
  event: PreSignUpTriggerEvent,
): Promise<PreSignUpTriggerEvent> => {
  // Only gate genuine self-service signups. Admin-created users (our CLI scripts)
  // and federated logins skip the captcha.
  if (event.triggerSource !== 'PreSignUp_SignUp') return event;

  const token = event.request.clientMetadata?.turnstileToken;
  if (!token) throw new Error('Captcha verification required.');

  const secret = await turnstileSecret();
  const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: new URLSearchParams({ secret, response: token }),
  });
  const data = (await resp.json()) as { success: boolean; 'error-codes'?: string[] };

  if (!data.success) {
    console.warn('turnstile verification failed', data['error-codes']);
    throw new Error('Captcha verification failed. Please try again.');
  }

  // Returning the event unmodified lets Cognito continue (email code, etc.).
  return event;
};
