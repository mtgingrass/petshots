// End-to-end smoke test for Stripe billing + the active-pets downgrade rule.
//
//   node scripts/smoke-billing.mjs <email> <password>
//
// Run with a THROWAWAY user (admin-created). The script signs synthetic webhook
// events itself using the real signing secret from Secrets Manager, so the
// whole paid -> downgrade lifecycle runs against the live API without touching
// a card. Checkout-session creation IS real (test-mode Stripe API).
//
// Needs AWS CLI creds (secretsmanager:GetSecretValue on petshots/stripe +
// s3 rm on the uploads bucket for cleanup). Caller deletes the user afterwards.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHmac } from 'node:crypto';
import { execSync } from 'node:child_process';
import pkg from 'amazon-cognito-identity-js';

const { CognitoUserPool, CognitoUser, AuthenticationDetails } = pkg;

const API = process.env.API_URL ?? 'https://ycg5npcyk8.execute-api.us-east-1.amazonaws.com';
const BUCKET = process.env.UPLOADS_BUCKET ?? 'petshots-uploads';

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
  console.error('usage: node scripts/smoke-billing.mjs <email> <password>');
  process.exit(1);
}

let pass = 0;
let fail = 0;
const check = (cond, label) => {
  console.log(`${cond ? '  ✅' : '  ❌'} ${label}`);
  cond ? pass++ : fail++;
};

function login() {
  const pool = new CognitoUserPool({
    UserPoolId: env.VITE_COGNITO_USER_POOL_ID,
    ClientId: env.VITE_COGNITO_CLIENT_ID,
  });
  const user = new CognitoUser({ Username: email, Pool: pool });
  const details = new AuthenticationDetails({ Username: email, Password: password });
  return new Promise((resolve, reject) => {
    user.authenticateUser(details, {
      onSuccess: (s) => resolve(s.getAccessToken().getJwtToken()),
      onFailure: (e) => reject(e),
    });
  });
}

async function api(token, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// Stripe signature scheme: v1 = HMAC-SHA256(whsec, `${t}.${payload}`), with the
// full whsec_... string as the key. Same math stripe-node verifies against.
function signedWebhook(whsec, event, tamper = false) {
  const payload = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', whsec).update(`${t}.${payload}`).digest('hex');
  return fetch(`${API}/billing/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': `t=${t},v1=${tamper ? sig.replace(/^./, '0') : sig}`,
    },
    body: payload,
  });
}

async function uploadDocStatus(token, petId) {
  const presign = await api(token, 'POST', `/pets/${petId}/docs/upload-url`, {
    filename: 'smoke.pdf',
    label: 'Billing smoke',
    contentType: 'application/pdf',
  });
  return presign.status;
}

const med = (name) => ({
  name,
  interval: 1,
  unit: 'month',
  nextDue: '2027-06-15',
  remindersEnabled: false,
});

async function main() {
  console.log(`API: ${API}`);
  const whsec = JSON.parse(
    execSync(
      'aws secretsmanager get-secret-value --secret-id petshots/stripe --query SecretString --output text',
      { encoding: 'utf8' },
    ),
  ).webhookSecret;
  if (!whsec?.startsWith('whsec_')) throw new Error('webhookSecret missing — run setup-stripe.mjs first');

  console.log('\n[1] login + starts free');
  const token = await login();
  const sub = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
  check(!!token, 'got access token');
  const pre = await api(token, 'GET', '/pets');
  for (const p of pre.body?.pets ?? []) await api(token, 'DELETE', `/pets/${p.id}`);
  let r = await api(token, 'GET', '/pets');
  check(r.body.limits?.plan === 'free', 'plan starts free');

  console.log('\n[2] POST /billing/checkout returns a real Stripe test session');
  r = await api(token, 'POST', '/billing/checkout', { interval: 'month' });
  check(r.status === 200 && /checkout\.stripe\.com/.test(r.body?.url ?? ''), `checkout URL (got ${r.status})`);
  r = await api(token, 'POST', '/billing/checkout', { interval: 'year' });
  check(r.status === 200 && /checkout\.stripe\.com/.test(r.body?.url ?? ''), 'yearly checkout URL');
  const noAuth = await fetch(`${API}/billing/checkout`, { method: 'POST' });
  check(noAuth.status === 401, `unauthenticated checkout 401 (got ${noAuth.status})`);

  console.log('\n[3] webhook: signature enforced');
  const customerId = `cus_smoke_${Date.now()}`;
  const completed = {
    type: 'checkout.session.completed',
    data: { object: { object: 'checkout.session', client_reference_id: sub, customer: customerId, subscription: 'sub_smoke' } },
  };
  let res = await signedWebhook(whsec, completed, true);
  check(res.status === 400, `tampered signature rejected 400 (got ${res.status})`);
  r = await api(token, 'GET', '/pets');
  check(r.body.limits?.plan === 'free', 'tampered event did not upgrade the plan');

  console.log('\n[4] checkout.session.completed -> paid');
  res = await signedWebhook(whsec, completed);
  check(res.status === 200, `webhook accepted (got ${res.status})`);
  r = await api(token, 'GET', '/pets');
  check(r.body.limits?.plan === 'paid' && r.body.limits?.maxPets === 10, `plan is paid, maxPets=10 (got ${r.body.limits?.plan}/${r.body.limits?.maxPets})`);

  console.log('\n[5] paid: create 3 pets (over the free cap)');
  const petIds = [];
  for (const name of ['Alpha', 'Bravo', 'Charlie']) {
    const p = await api(token, 'POST', '/pets', { name, species: 'dog' });
    check(p.status === 200, `${name} created`);
    petIds.push(p.body.pet.id);
    await new Promise((s) => setTimeout(s, 1100)); // distinct createdAt seconds
  }
  r = await api(token, 'GET', '/pets');
  check(r.body.pets.every((p) => p.active === true), 'all pets active while paid');

  console.log('\n[6] customer.subscription.deleted -> free again, oldest 2 stay writable');
  res = await signedWebhook(whsec, {
    type: 'customer.subscription.deleted',
    data: { object: { object: 'subscription', id: 'sub_smoke', customer: customerId, status: 'canceled' } },
  });
  check(res.status === 200, 'cancellation webhook accepted');
  r = await api(token, 'GET', '/pets');
  check(r.body.limits?.plan === 'free', 'plan back to free');
  check(r.body.pets.length === 3, 'all 3 pets still listed (nothing hidden)');
  const activeIds = r.body.pets.filter((p) => p.active).map((p) => p.id).sort();
  check(
    activeIds.length === 2 && activeIds.includes(petIds[0]) && activeIds.includes(petIds[1]),
    'oldest 2 pets active, newest read-only',
  );

  console.log('\n[7] writes: active pet accepts docs/meds, read-only pet refuses');
  check((await uploadDocStatus(token, petIds[0])) === 200, 'doc presign on oldest pet 200');
  check((await uploadDocStatus(token, petIds[2])) === 403, 'doc presign on newest pet 403');
  r = await api(token, 'PUT', `/pets/${petIds[0]}/meds`, { meds: [med('Heartworm')] });
  check(r.status === 200, 'med add on active pet 200');
  r = await api(token, 'PUT', `/pets/${petIds[2]}/meds`, { meds: [med('Heartworm')] });
  check(r.status === 403, `med add on read-only pet 403 (got ${r.status})`);

  console.log('\n[8] unknown customer event is ignored safely');
  res = await signedWebhook(whsec, {
    type: 'customer.subscription.deleted',
    data: { object: { object: 'subscription', id: 'sub_x', customer: 'cus_never_seen', status: 'canceled' } },
  });
  check(res.status === 200, 'unknown customer webhook 200 (no-op)');

  console.log('\n[9] cleanup (pets + plan.json + customer mapping; caller deletes the user)');
  for (const id of petIds) await api(token, 'DELETE', `/pets/${id}`);
  execSync(`aws s3 rm s3://${BUCKET}/users/${sub}/plan.json`, { encoding: 'utf8' });
  execSync(`aws s3 rm s3://${BUCKET}/billing/customers/${customerId}.json`, { encoding: 'utf8' });
  check(true, 'cleaned up');

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
