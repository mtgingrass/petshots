// Smoke test for the weekly digest email (ReminderFn, Sundays): seeds a pet
// with checklist activity, mood, a given med, and weigh-ins, then dry-run
// invokes the deployed Lambda with forceDigest and asserts the composed email.
//
//   node scripts/smoke-digest.mjs <email> <password>
//
// THROWAWAY USER ONLY. Needs AWS CLI creds (lambda invoke + CFN describe).
// Cleans up its pets; the runner deletes the user + S3 prefix afterwards
// (this script writes settings.json with the fake email — cleanup matters).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';
import pkg from 'amazon-cognito-identity-js';

const { CognitoUserPool, CognitoUser, AuthenticationDetails } = pkg;
const API = process.env.API_URL ?? 'https://ycg5npcyk8.execute-api.us-east-1.amazonaws.com';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(__dirname, '..', '.env'), 'utf8')
    .split('\n').filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const [email, password] = process.argv.slice(2);
if (!password) {
  console.error('usage: node scripts/smoke-digest.mjs <email> <password>');
  process.exit(1);
}

let pass = 0, fail = 0;
const check = (c, l) => { console.log(`${c ? '  ✅' : '  ❌'} ${l}`); c ? pass++ : fail++; };

const pool = new CognitoUserPool({ UserPoolId: env.VITE_COGNITO_USER_POOL_ID, ClientId: env.VITE_COGNITO_CLIENT_ID });
const login = () => new Promise((res, rej) => {
  const u = new CognitoUser({ Username: email, Pool: pool });
  u.authenticateUser(new AuthenticationDetails({ Username: email, Password: password }), {
    onSuccess: (s) => res(s.getAccessToken().getJwtToken()), onFailure: rej,
  });
});
const api = async (t, m, p, b) => {
  const r = await fetch(API + p, { method: m, headers: { Authorization: `Bearer ${t}`, ...(b ? { 'content-type': 'application/json' } : {}) }, body: b ? JSON.stringify(b) : undefined });
  const x = await r.text();
  return { status: r.status, body: x ? JSON.parse(x) : null };
};
const ymd = (o) => { const d = new Date(); d.setDate(d.getDate() + o); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

function invokeDryRun() {
  const fn = execSync(
    `aws cloudformation list-stack-resources --stack-name PetshotsApiStack --query "StackResourceSummaries[?starts_with(LogicalResourceId,'ReminderFn') && ResourceType=='AWS::Lambda::Function'].PhysicalResourceId" --output text`,
    { encoding: 'utf8' },
  ).trim();
  execSync(
    `aws lambda invoke --function-name ${fn} --payload '{"dryRun":true,"forceDigest":true}' --cli-binary-format raw-in-base64-out /tmp/digest-smoke-out.json`,
    { stdio: 'pipe' },
  );
  return JSON.parse(readFileSync('/tmp/digest-smoke-out.json', 'utf8'));
}

async function main() {
  console.log('\n[1] seed a week of activity');
  const token = await login();
  const pre = await api(token, 'GET', '/pets');
  for (const p of pre.body?.pets ?? []) await api(token, 'DELETE', `/pets/${p.id}`);
  const pet = (await api(token, 'POST', '/pets', { name: 'Digby', species: 'dog' })).body.pet;
  const today = ymd(0);
  // Checklist: breakfast today, a mood, a given daily med, weigh-ins.
  await api(token, 'PUT', `/pets/${pet.id}/meds`, {
    meds: [{ name: 'Insulin', interval: 1, unit: 'day', nextDue: today, remindersEnabled: false }],
  });
  const daily = await api(token, 'GET', `/pets/${pet.id}/daily?date=${today}`);
  const breakfast = daily.body.items.find((i) => i.name === 'Breakfast');
  const medItem = daily.body.items.find((i) => i.id.startsWith('med:'));
  await api(token, 'POST', `/pets/${pet.id}/daily/check`, { date: today, itemId: breakfast.id, checked: true });
  await api(token, 'POST', `/pets/${pet.id}/daily/check`, { date: today, itemId: medItem.id, checked: true });
  await api(token, 'POST', `/pets/${pet.id}/daily/mood`, { date: today, value: 4 });
  await api(token, 'POST', `/pets/${pet.id}/weights`, { date: ymd(-5), weight: 80, unit: 'lb' });
  await api(token, 'POST', `/pets/${pet.id}/weights`, { date: today, weight: 79, unit: 'lb' });
  await api(token, 'PUT', '/settings', { email, remindersEnabled: true, reminderDays: [7], weeklyDigest: true });
  // A reminder-enabled med due today makes a reminder email compose, and a
  // fake push subscription makes the dry run report a would-push for it.
  // Bravecto's nextDue must be TODAY IN UTC, not local: ReminderFn computes
  // due-day math on the UTC calendar, so seeding the local date after 8 PM
  // Eastern lands the med at day -1 (matches no trigger) and the reminder
  // email — and its would-push — never composes. (Bit us, 2026-07-08 ~10 PM.)
  const utcToday = new Date().toISOString().slice(0, 10);
  await api(token, 'PUT', `/pets/${pet.id}/meds`, {
    meds: [
      { name: 'Insulin', interval: 1, unit: 'day', nextDue: today, remindersEnabled: false },
      { name: 'Bravecto', interval: 12, unit: 'week', nextDue: utcToday, remindersEnabled: true },
    ],
  });
  await api(token, 'POST', '/push/subscribe', {
    subscription: {
      endpoint: `https://updates.push.services.mozilla.com/wpush/v2/digest-smoke-${Date.now()}`,
      keys: { p256dh: 'BFakeKeyForDryRunCounting0000000000000000000000000000000000000000000000000000000000000', auth: 'FakeAuthSecret16' },
    },
  });
  check(true, 'seeded checklist + mood + med + weights + settings + push sub');

  console.log('\n[2] forceDigest dry run composes the digest');
  let dry = invokeDryRun();
  let digest = (dry.wouldSend ?? []).find((w) => w.email === email && /week at a glance/.test(w.subject));
  check(!!digest, `digest email present (subject: ${digest?.subject})`);
  check(!!digest && /Digby/.test(digest.subject), 'subject names the pet');
  const body = digest?.body ?? '';
  check(/🙂/.test(body) && /good/.test(body), 'mood strip + label included');
  check(/Breakfast ×1/.test(body), 'feeding count included');
  check(/Meds given: 1/.test(body), 'meds-given count included');
  // Only 1 of the digest's 7-day window has any Daily activity (the pet was
  // just created) — the low-completion "we noticed" nudge deliberately
  // requires most of the window to be tracked first, so it must stay silent
  // here rather than telling a brand-new pet "you only logged breakfast 1 of
  // the last 7 days."
  check(!/We noticed Digby/.test(body), 'no false low-completion nudge for a brand-new pet');
  check(/79 lb/.test(body) && /▼ 1 lb/.test(body), 'weight + weekly delta included');
  check(/unsubscribe/i.test(body), 'unsubscribe link included');
  const push = (dry.wouldPush ?? []).find((w) => w.email === email);
  check(!!push && push.devices === 1, `reminder would also push to 1 device (got ${JSON.stringify(push)})`);

  console.log('\n[2b] weight staleness nudge — second pet with only a 40-day-old weight');
  const stalePet = (await api(token, 'POST', '/pets', { name: 'Rusty', species: 'dog' })).body.pet;
  await api(token, 'POST', `/pets/${stalePet.id}/weights`, { date: ymd(-40), weight: 55, unit: 'lb' });
  dry = invokeDryRun();
  digest = (dry.wouldSend ?? []).find((w) => w.email === email && /at a glance/.test(w.subject));
  check(!!digest && /Rusty/.test(digest.body), 'second pet included in the same digest');
  check(
    !!digest && /It's been 40 days since Rusty's last weight update/.test(digest.body),
    'weight-stale nudge line included',
  );
  check(!!digest && !/Rusty[\s\S]{0,80}Weight: 55/.test(digest.body), 'no normal Weight: line for the stale pet');

  console.log('\n[3] digest toggle off suppresses it');
  await api(token, 'PUT', '/settings', { email, remindersEnabled: true, reminderDays: [7], weeklyDigest: false });
  dry = invokeDryRun();
  digest = (dry.wouldSend ?? []).find((w) => w.email === email && /week at a glance/.test(w.subject));
  check(!digest, 'no digest when weeklyDigest is false');

  console.log('\n[4] no digest without reminder consent');
  await api(token, 'PUT', '/settings', { email, remindersEnabled: false, reminderDays: [7], weeklyDigest: true });
  dry = invokeDryRun();
  digest = (dry.wouldSend ?? []).find((w) => w.email === email && /week at a glance/.test(w.subject));
  check(!digest, 'no digest when reminders are off');

  console.log('\n[5] cleanup');
  await api(token, 'PUT', '/settings', { email: '', remindersEnabled: false, reminderDays: [] });
  await api(token, 'DELETE', `/pets/${pet.id}`);
  await api(token, 'DELETE', `/pets/${stalePet.id}`);
  check((await api(token, 'GET', '/pets')).body.pets.length === 0, 'pets deleted, settings email cleared');

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('ERROR:', e.message || e); process.exit(1); });
