// One-time (idempotent, re-runnable) Stripe provisioning for Petshots billing.
//
//   node scripts/setup-stripe.mjs
//
// Prereqs: the Secrets Manager secret `petshots/stripe` exists with at least
// {"secretKey":"sk_test_..."} (or sk_live_ when going live). This script then:
//   1. ensures product `petshots-paid` exists
//   2. ensures prices $5/mo + $49/yr exist (lookup_keys petshots_monthly/_yearly)
//   3. ensures a webhook endpoint for the live API exists (checkout + subscription
//      events) — the signing secret is only revealed at creation, so a stale
//      "pending" placeholder in the AWS secret forces a delete + recreate
//   4. writes price ids + webhook secret back into the AWS secret
//
// Going live later: update secretKey in the AWS secret to sk_live_, re-run this
// (live mode has its own products/prices/webhooks), redeploy nothing — the
// Lambda reads the secret at cold start (force new containers by any deploy).
//
// Needs AWS CLI creds (secretsmanager get/update on petshots/stripe).
import { execSync } from 'node:child_process';

const SECRET_NAME = 'petshots/stripe';
const API_URL = process.env.API_URL ?? 'https://ycg5npcyk8.execute-api.us-east-1.amazonaws.com';
const WEBHOOK_URL = `${API_URL}/billing/webhook`;
const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
];

function readAwsSecret() {
  const out = execSync(
    `aws secretsmanager get-secret-value --secret-id ${SECRET_NAME} --query SecretString --output text`,
    { encoding: 'utf8' },
  );
  return JSON.parse(out);
}

function writeAwsSecret(obj) {
  const payload = JSON.stringify(obj).replace(/'/g, `'\\''`);
  execSync(
    `aws secretsmanager update-secret --secret-id ${SECRET_NAME} --secret-string '${payload}'`,
    { encoding: 'utf8' },
  );
}

let stripeKey;
async function stripe(method, path, params) {
  const res = await fetch(`https://api.stripe.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${stripeKey}`,
      ...(params ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: params ? new URLSearchParams(params) : undefined,
  });
  const body = await res.json();
  if (!res.ok && res.status !== 404) {
    throw new Error(`Stripe ${method} ${path} -> ${res.status}: ${body.error?.message}`);
  }
  return { status: res.status, body };
}

async function main() {
  const secret = readAwsSecret();
  stripeKey = secret.secretKey;
  if (!/^(sk|rk)_/.test(stripeKey ?? '')) throw new Error('secretKey missing from AWS secret');
  const mode = /^(sk|rk)_live_/.test(stripeKey) ? 'LIVE' : 'test';
  console.log(`Stripe mode: ${mode}`);

  // 1. product (custom id makes this a natural idempotency key)
  let product = await stripe('GET', '/v1/products/petshots-paid');
  if (product.status === 404) {
    product = await stripe('POST', '/v1/products', {
      id: 'petshots-paid',
      name: 'Petshots Paid',
      description: 'Up to 10 pets, 20 records and 20 medications per pet.',
    });
    console.log('created product petshots-paid');
  } else {
    console.log('product petshots-paid exists');
  }

  // 2. prices (lookup_keys are Stripe's idempotency handle for prices)
  const wanted = [
    { lookup_key: 'petshots_monthly', unit_amount: '500', interval: 'month' },
    { lookup_key: 'petshots_yearly', unit_amount: '4900', interval: 'year' },
  ];
  const priceIds = {};
  const existing = await stripe(
    'GET',
    `/v1/prices?lookup_keys[]=petshots_monthly&lookup_keys[]=petshots_yearly&limit=10`,
  );
  for (const w of wanted) {
    const found = existing.body.data?.find((p) => p.lookup_key === w.lookup_key && p.active);
    if (found) {
      priceIds[w.lookup_key] = found.id;
      console.log(`price ${w.lookup_key} exists (${found.id})`);
    } else {
      const created = await stripe('POST', '/v1/prices', {
        product: 'petshots-paid',
        lookup_key: w.lookup_key,
        currency: 'usd',
        unit_amount: w.unit_amount,
        'recurring[interval]': w.interval,
      });
      priceIds[w.lookup_key] = created.body.id;
      console.log(`created price ${w.lookup_key} (${created.body.id})`);
    }
  }

  // 3. webhook endpoint — signing secret only appears in the create response
  const endpoints = await stripe('GET', '/v1/webhook_endpoints?limit=100');
  let endpoint = endpoints.body.data?.find((e) => e.url === WEBHOOK_URL);
  let webhookSecret = secret.webhookSecret;
  if (endpoint && (!webhookSecret || webhookSecret === 'pending')) {
    // exists but we never captured its secret — recreate to get one
    await stripe('DELETE', `/v1/webhook_endpoints/${endpoint.id}`);
    endpoint = null;
    console.log('recreating webhook endpoint to capture its signing secret');
  }
  if (!endpoint) {
    const params = { url: WEBHOOK_URL };
    WEBHOOK_EVENTS.forEach((e, i) => (params[`enabled_events[${i}]`] = e));
    const created = await stripe('POST', '/v1/webhook_endpoints', params);
    webhookSecret = created.body.secret;
    console.log(`created webhook endpoint (${created.body.id})`);
  } else {
    console.log(`webhook endpoint exists (${endpoint.id})`);
  }

  // 4. persist everything the Lambda needs
  writeAwsSecret({
    ...secret,
    webhookSecret,
    priceMonthly: priceIds.petshots_monthly,
    priceYearly: priceIds.petshots_yearly,
  });
  console.log(`AWS secret ${SECRET_NAME} updated (prices + webhook secret)`);
  console.log('\nDone. Billing routes are ready once the ApiStack is deployed.');
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
