// End-to-end smoke test for the reminder Lambda's medication + vaccine logic.
// Seeds a user with meds at crafted offsets from today, then invokes the
// deployed ReminderFn with { dryRun: true } (returns would-send emails instead
// of sending) and asserts exactly the right reminders fire.
//
//   node scripts/smoke-reminder.mjs <email> <password>
//
// Run with a THROWAWAY user (admin-created) and delete it + its S3 prefix
// afterwards: the seeded settings.json contains the email, and the real
// nightly cron would otherwise try to send to it.
//
// Needs AWS CLI creds (lambda:InvokeFunction + cloudformation:ListStackResources
// + s3 read/write on the uploads bucket — the script writes users/{sub}/plan.json
// to mark the throwaway user paid, since six meds on one pet exceeds the free
// 4-med cap, then removes it to assert over-cap grandfathering).
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import pkg from 'amazon-cognito-identity-js';

const { CognitoUserPool, CognitoUser, AuthenticationDetails } = pkg;

const API = process.env.API_URL ?? 'https://ycg5npcyk8.execute-api.us-east-1.amazonaws.com';
const STACK = 'PetshotsApiStack';
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
  console.error('usage: node scripts/smoke-reminder.mjs <email> <password>');
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

// The Lambda runs in UTC, so "today" must be the current UTC date — a script
// run at 9pm Eastern is already "tomorrow" in UTC and would be off by one.
const now = new Date();
const utcToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
function daysFromToday(n) {
  const d = new Date(utcToday);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function resolveReminderFn() {
  const out = execSync(
    `aws cloudformation list-stack-resources --stack-name ${STACK} ` +
      `--query "StackResourceSummaries[?ResourceType=='AWS::Lambda::Function' && starts_with(LogicalResourceId, 'ReminderFn')].PhysicalResourceId" --output text`,
    { encoding: 'utf8' },
  ).trim();
  if (!out) throw new Error('could not resolve ReminderFn physical id');
  return out;
}

function invokeDryRun(fnName) {
  const outfile = join(tmpdir(), `reminder-dryrun-${Date.now()}.json`);
  execSync(
    `aws lambda invoke --function-name ${fnName} --cli-binary-format raw-in-base64-out ` +
      `--payload '{"dryRun":true}' ${outfile}`,
    { encoding: 'utf8' },
  );
  const res = JSON.parse(readFileSync(outfile, 'utf8'));
  unlinkSync(outfile);
  return res;
}

async function uploadDoc(token, petId, label, expiry) {
  const presign = await api(token, 'POST', `/pets/${petId}/docs/upload-url`, {
    filename: `${label.replace(/\s/g, '_')}.pdf`,
    label,
    expiry,
    contentType: 'application/pdf',
  });
  if (presign.status !== 200) throw new Error(`presign failed: ${presign.status}`);
  const form = new FormData();
  for (const [k, v] of Object.entries(presign.body.fields)) form.append(k, v);
  form.append('file', new Blob([Buffer.from('%PDF-1.4\n% smoke\n')], { type: 'application/pdf' }));
  const res = await fetch(presign.body.url, { method: 'POST', body: form });
  if (res.status !== 204) throw new Error(`S3 POST failed: ${res.status}`);
}

function mine(dryRunResult) {
  const entries = (dryRunResult.wouldSend ?? []).filter((w) => w.email === email);
  return entries.length === 1 ? entries[0] : entries.length === 0 ? null : entries;
}

async function main() {
  console.log(`API: ${API}`);
  const fnName = resolveReminderFn();
  console.log(`ReminderFn: ${fnName}`);
  console.log(`UTC today: ${daysFromToday(0)}`);

  console.log('\n[1] SRP login + mark user paid + seed pet');
  const token = await login();
  check(!!token, 'got access token');
  // plan.json is operator/billing-written (no API route can touch it); the
  // seed needs the paid med cap. Removed with the user's S3 prefix at cleanup.
  const sub = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
  const planFile = join(tmpdir(), `plan-${Date.now()}.json`);
  writeFileSync(planFile, JSON.stringify({ plan: 'paid' }));
  execSync(`aws s3 cp ${planFile} s3://${BUCKET}/users/${sub}/plan.json`, { encoding: 'utf8' });
  unlinkSync(planFile);
  check(true, 'plan.json written (paid)');
  const pre = await api(token, 'GET', '/pets');
  for (const p of pre.body?.pets ?? []) await api(token, 'DELETE', `/pets/${p.id}`);
  const petRes = await api(token, 'POST', '/pets', { name: 'Smokey', species: 'dog' });
  check(petRes.status === 200, 'pet created');
  const petId = petRes.body.pet.id;

  console.log('\n[2] seed: vaccine toggle OFF, six meds at crafted offsets, one expiring doc');
  let r = await api(token, 'PUT', '/settings', {
    email,
    remindersEnabled: false, // vaccine reminders OFF — meds must fire anyway
    reminderDays: [7, 30],
    marketingOptIn: false,
  });
  check(r.status === 200, 'settings saved (vaccine reminders off)');

  const med = (name, offset, remindersEnabled = true) => ({
    name,
    interval: 1,
    unit: 'month',
    nextDue: daysFromToday(offset),
    remindersEnabled,
  });
  r = await api(token, 'PUT', `/pets/${petId}/meds`, {
    meds: [
      med('DueTodayMed', 0),          // fires (due day)
      med('OverdueSevenMed', -7),     // fires (weekly overdue nag)
      med('OverdueFourteenMed', -14), // fires (weekly overdue nag)
      med('OverdueThreeMed', -3),     // silent (between weekly nags)
      med('DueTomorrowMed', 1),       // silent (not due yet)
      med('MutedMed', 0, false),      // silent (reminders off for this med)
      { ...med('DismissedMed', 0), dismissed: true }, // silent ("stop tracking")
    ],
  });
  check(r.status === 200 && r.body.meds.length === 7, 'seven meds saved (paid cap)');
  check(r.body.meds.find((m) => m.name === 'DismissedMed')?.dismissed === true, 'dismissed flag stored');

  console.log('\n[2b] downgrade to free: over-cap meds grandfathered (edit ok, growth blocked)');
  execSync(`aws s3 rm s3://${BUCKET}/users/${sub}/plan.json`, { encoding: 'utf8' });
  const limitsAfter = await api(token, 'GET', '/pets');
  check(limitsAfter.body?.limits?.plan === 'free', 'limits report free after plan.json removed');
  r = await api(token, 'PUT', `/pets/${petId}/meds`, { meds: r.body.meds });
  check(r.status === 200 && r.body.meds.length === 7, 're-saving 7 meds allowed over the 4-med free cap');
  const grow = await api(token, 'PUT', `/pets/${petId}/meds`, {
    meds: [...r.body.meds, med('OneTooMany', 3)],
  });
  check(grow.status === 400, `growing past current count rejected 400 (got ${grow.status})`);

  await uploadDoc(token, petId, 'Rabies SmokeVax', daysFromToday(7)); // in reminderDays window
  check(true, 'doc uploaded (expires in 7 days)');

  console.log('\n[3] dry run: meds fire on their own; vaccine stays gated off');
  let dry = invokeDryRun(fnName);
  check(dry?.dryRun === true, 'dry run returned without sending');
  let msg = mine(dry);
  check(!!msg && !Array.isArray(msg), 'exactly one email for this user');
  if (msg && !Array.isArray(msg)) {
    check(msg.subject === 'Petshots: 3 medications due', `subject "${msg.subject}"`);
    for (const name of ['DueTodayMed', 'OverdueSevenMed', 'OverdueFourteenMed']) {
      check(msg.body.includes(name), `${name} in body`);
    }
    for (const name of ['OverdueThreeMed', 'DueTomorrowMed', 'MutedMed', 'DismissedMed', 'Rabies SmokeVax']) {
      check(!msg.body.includes(name), `${name} NOT in body`);
    }
    check(msg.body.includes("Smokey's DueTodayMed — due today"), 'due-today phrasing');
    check(msg.body.includes("Smokey's OverdueSevenMed — 7 days overdue"), 'overdue phrasing');
  }

  console.log('\n[4] dry run: vaccine toggle ON adds the expiring doc');
  r = await api(token, 'PUT', '/settings', {
    email,
    remindersEnabled: true,
    reminderDays: [7, 30],
    marketingOptIn: false,
  });
  check(r.status === 200, 'settings saved (vaccine reminders on)');
  dry = invokeDryRun(fnName);
  msg = mine(dry);
  check(!!msg && !Array.isArray(msg), 'exactly one email for this user');
  if (msg && !Array.isArray(msg)) {
    check(msg.subject === 'Petshots: 4 pet care reminders', `subject "${msg.subject}"`);
    check(msg.body.includes('Rabies SmokeVax'), 'expiring doc now in body');
    check(msg.body.includes('Medications due:'), 'meds section present');
    check(msg.body.includes('Vaccine records expiring:'), 'vaccine section present');
  }

  console.log('\n[5] dry run: single due med gets the specific subject');
  r = await api(token, 'PUT', '/settings', {
    email, remindersEnabled: false, reminderDays: [7, 30], marketingOptIn: false,
  });
  r = await api(token, 'PUT', `/pets/${petId}/meds`, { meds: [med('Heartworm prevention', 0)] });
  check(r.status === 200, 'meds replaced with single due-today med');
  dry = invokeDryRun(fnName);
  msg = mine(dry);
  check(!!msg && !Array.isArray(msg), 'exactly one email for this user');
  if (msg && !Array.isArray(msg)) {
    check(
      msg.subject === "Reminder: Smokey's Heartworm prevention is due today",
      `subject "${msg.subject}"`,
    );
  }

  console.log('\n[6] dry run: nothing due -> no email at all');
  r = await api(token, 'PUT', `/pets/${petId}/meds`, { meds: [med('Heartworm prevention', 5)] });
  check(r.status === 200, 'med pushed 5 days out');
  dry = invokeDryRun(fnName);
  check(mine(dry) === null, 'no email for this user when nothing is due');

  console.log('\n[6b] birthday email rides the vaccine-reminder consent');
  // Remove the expiring doc first so a reminders-on dry run isolates the birthday.
  const docsRes = await api(token, 'GET', `/pets/${petId}/docs`);
  for (const d of docsRes.body?.docs ?? []) await api(token, 'DELETE', `/pets/${petId}/docs/${d.id}`);
  const todayStr = daysFromToday(0);
  const dob = `${Number(todayStr.slice(0, 4)) - 3}${todayStr.slice(4)}`;
  r = await api(token, 'PUT', `/pets/${petId}`, { name: 'Smokey', species: 'dog', dob });
  check(r.status === 200, `dob set so today is the birthday (${dob})`);
  dry = invokeDryRun(fnName);
  check(mine(dry) === null, 'reminders off -> no birthday email');
  r = await api(token, 'PUT', '/settings', {
    email, remindersEnabled: true, reminderDays: [7, 30], marketingOptIn: false,
  });
  check(r.status === 200, 'vaccine reminders turned on');
  dry = invokeDryRun(fnName);
  msg = mine(dry);
  check(!!msg && !Array.isArray(msg), 'birthday email would send');
  if (msg && !Array.isArray(msg)) {
    check(msg.subject === '🎂 Smokey turns 3 today!', `subject "${msg.subject}"`);
    check(msg.body.includes('happy birthday'), 'birthday line in body');
    check(!msg.body.includes('Medications due'), 'no med section in a birthday-only email');
  }

  console.log('\n[7] cleanup (pets deleted; caller must delete the user + S3 prefix)');
  await api(token, 'DELETE', `/pets/${petId}`);
  r = await api(token, 'GET', '/pets');
  check(r.body.pets.length === 0, 'pets deleted');

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('ERROR:', e.message || e);
  process.exit(1);
});
