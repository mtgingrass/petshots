// Thin promise-based wrappers over amazon-cognito-identity-js.
// The library is callback-based; we wrap each call so pages can use async/await.
// All of this runs in the browser and talks directly to Cognito over HTTPS.
import {
  CognitoUserPool,
  CognitoUser,
  CognitoUserAttribute,
  CognitoUserSession,
  AuthenticationDetails,
  type ISignUpResult,
} from 'amazon-cognito-identity-js';
import { config } from '../config';

export const userPool = new CognitoUserPool({
  UserPoolId: config.userPoolId,
  ClientId: config.clientId,
});

// Register a new user. Cognito emails them a verification code (auto-verify is on).
// The Turnstile token is passed as clientMetadata, which the PreSignUp Lambda
// trigger reads and verifies with Cloudflare before allowing the signup.
export function signUp(
  email: string,
  password: string,
  captchaToken: string,
): Promise<ISignUpResult> {
  return new Promise((resolve, reject) => {
    const attributes = [new CognitoUserAttribute({ Name: 'email', Value: email })];
    userPool.signUp(
      email,
      password,
      attributes,
      [],
      (err, result) => {
        if (err || !result) return reject(err ?? new Error('signUp returned no result'));
        resolve(result);
      },
      { turnstileToken: captchaToken },
    );
  });
}

// Confirm a new account with the emailed code.
export function confirmSignUp(email: string, code: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const user = new CognitoUser({ Username: email, Pool: userPool });
    user.confirmRegistration(code, true, (err) => (err ? reject(err) : resolve()));
  });
}

// Re-send the verification code if it expired or was lost.
export function resendConfirmationCode(email: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const user = new CognitoUser({ Username: email, Pool: userPool });
    user.resendConfirmationCode((err) => (err ? reject(err) : resolve()));
  });
}

// Sign in. authenticateUser uses SRP under the hood — matches the user pool
// client config (authFlows: { userSrp: true }); the password never crosses the wire.
export function signIn(email: string, password: string): Promise<CognitoUserSession> {
  return new Promise((resolve, reject) => {
    const user = new CognitoUser({ Username: email, Pool: userPool });
    const details = new AuthenticationDetails({ Username: email, Password: password });
    user.authenticateUser(details, {
      onSuccess: (session) => resolve(session),
      onFailure: (err) => reject(err),
    });
  });
}

// Clear the current user's tokens from local storage.
export function signOut(): void {
  userPool.getCurrentUser()?.signOut();
}

// Resolve the current valid session, or null if none / expired.
// getSession also refreshes tokens automatically when possible.
export function getSession(): Promise<CognitoUserSession | null> {
  return new Promise((resolve) => {
    const user = userPool.getCurrentUser();
    if (!user) return resolve(null);
    user.getSession((err: Error | null, session: CognitoUserSession | null) => {
      if (err || !session || !session.isValid()) return resolve(null);
      resolve(session);
    });
  });
}

// The access token (JWT) for the current session, or null. This is what the
// API's Cognito authorizer validates; getSession refreshes it if needed.
export async function getAccessToken(): Promise<string | null> {
  const session = await getSession();
  return session ? session.getAccessToken().getJwtToken() : null;
}
