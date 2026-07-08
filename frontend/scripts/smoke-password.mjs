// Smoke test for the two password flows, straight against live Cognito
// (no API Gateway involved — both flows are direct browser↔Cognito calls):
//   1. Change password (Settings → Change password): wrong-current rejected,
//      weak-new rejected, correct change works, old password dies, new one logs in.
//   2. Forgot password (/reset-password): code request succeeds, wrong code is
//      rejected with CodeMismatchException, the password is untouched by a failed
//      confirm, and unknown emails don't leak account existence.
//
//   node scripts/smoke-password.mjs <email> <password>
//
// ⚠️ THROWAWAY USER ONLY, and its email MUST be deliverable without bouncing —
// use the SES mailbox simulator (success+anything@simulator.amazonses.com).
// The forgot-password request makes Cognito send a REAL email via SES; a fake
// domain like @example.com would bounce and damage SES sender reputation.
//
// The emailed code can't be read programmatically, so the confirm step is
// verified via CodeMismatchException (proves ConfirmForgotPassword is wired and
// evaluating codes). Full code round-trip was verified manually once at build time.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pkg from 'amazon-cognito-identity-js';

const { CognitoUserPool, CognitoUser, AuthenticationDetails } = pkg;

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(__dirname, '..', '.env'), 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error('usage: node scripts/smoke-password.mjs <email> <password>');
  process.exit(1);
}
if (!/@simulator\.amazonses\.com$/.test(email)) {
  console.error(
    'Refusing to run: the user email must end in @simulator.amazonses.com\n' +
    '(forgot-password sends real mail; anything else risks an SES bounce).',
  );
  process.exit(1);
}

let pass = 0;
let fail = 0;
const check = (cond, label) => {
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}`);
  cond ? pass++ : fail++;
};

const pool = new CognitoUserPool({
  UserPoolId: env.VITE_COGNITO_USER_POOL_ID,
  ClientId: env.VITE_COGNITO_CLIENT_ID,
});

// SRP login; resolves with the authenticated CognitoUser (needed for changePassword).
function login(username, pw) {
  const user = new CognitoUser({ Username: username, Pool: pool });
  const details = new AuthenticationDetails({ Username: username, Password: pw });
  return new Promise((resolve, reject) => {
    user.authenticateUser(details, {
      onSuccess: () => resolve(user),
      onFailure: (e) => reject(e),
    });
  });
}

const changePassword = (user, oldPw, newPw) =>
  new Promise((resolve, reject) =>
    user.changePassword(oldPw, newPw, (e) => (e ? reject(e) : resolve())),
  );

// Mirrors forgotPassword() in src/auth/cognito.ts.
function forgotPassword(username) {
  const user = new CognitoUser({ Username: username, Pool: pool });
  return new Promise((resolve, reject) => {
    user.forgotPassword({
      inputVerificationCode: (data) => resolve(data),
      onSuccess: (data) => resolve(data),
      onFailure: (e) => reject(e),
    });
  });
}

// Mirrors confirmForgotPassword() in src/auth/cognito.ts.
function confirmForgotPassword(username, code, newPw) {
  const user = new CognitoUser({ Username: username, Pool: pool });
  return new Promise((resolve, reject) => {
    user.confirmPassword(code, newPw, {
      onSuccess: () => resolve(),
      onFailure: (e) => reject(e),
    });
  });
}

const errName = async (promise) => {
  try {
    await promise;
    return null;
  } catch (e) {
    return e?.name ?? 'Error';
  }
};

async function main() {
  const CHANGED = password + 'X1!';

  console.log('\n[1] SRP login with the starting password');
  const user = await login(email, password);
  check(!!user, 'login succeeds');

  console.log('\n[2] change password (the Settings flow)');
  check(
    (await errName(changePassword(user, 'Wrong-current-1!', CHANGED))) === 'NotAuthorizedException',
    'wrong current password → NotAuthorizedException',
  );
  check(
    (await errName(changePassword(user, password, 'weakpass'))) === 'InvalidPasswordException',
    'policy-violating new password → InvalidPasswordException',
  );
  await changePassword(user, password, CHANGED);
  check(true, 'change with correct current password succeeds');

  console.log('\n[3] the change actually took');
  check(
    (await errName(login(email, password))) === 'NotAuthorizedException',
    'old password no longer logs in',
  );
  check(!!(await login(email, CHANGED)), 'new password logs in');

  console.log('\n[4] forgot password (the /reset-password flow)');
  const delivery = await forgotPassword(email);
  const dest = delivery?.CodeDeliveryDetails ?? delivery;
  check(
    dest?.DeliveryMedium === 'EMAIL' || dest?.AttributeName === 'email',
    `reset code sent by email (destination: ${dest?.Destination ?? '?'})`,
  );
  check(
    (await errName(confirmForgotPassword(email, '000000', password + 'Y2!'))) ===
      'CodeMismatchException',
    'wrong code → CodeMismatchException',
  );
  check(
    !!(await login(email, CHANGED)),
    'failed confirm left the password untouched',
  );

  console.log('\n[5] no user enumeration on the request form');
  // preventUserExistenceErrors: unknown emails get a simulated success, so the
  // reset form can't be used to probe which accounts exist.
  const ghost = `success+ghost-${Date.now()}@simulator.amazonses.com`;
  const ghostErr = await errName(forgotPassword(ghost));
  check(
    ghostErr === null,
    `unknown email gets the same success response${ghostErr ? ` (got ${ghostErr})` : ''}`,
  );

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  console.log('(reminder: this suite changes the user password — the throwaway user');
  console.log(` now authenticates with <original>X1!, and cleanup should delete it)`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('ERROR:', e.message || e);
  process.exit(1);
});
