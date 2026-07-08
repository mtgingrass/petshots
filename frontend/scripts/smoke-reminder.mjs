// End-to-end smoke test for the reminder Lambda's medication + vaccine logic.
// Seeds a user with meds/docs at crafted offsets from today, then invokes the
// deployed ReminderFn with { dryRun: true } (returns would-send emails instead
// of sending) and asserts exactly the right reminders fire.
//
//   node scripts/smoke-reminder.mjs <email> <password>
//
// Run with a THROWAWAY user (admin-created) and delete it + its S3 prefix
// afterwards: the seeded settings.json contains the email, and the real
// nightly cron would otherwise try to send to it.
//
// Reminder cadence under test (see infra/lambda/reminder/index.ts):
//   - Vaccines: fire on the user's chosen milestone days, PLUS a forced
//     "final countdown" at 3 and 1 days before expiry, PLUS the expiry day
//     itself. Once overdue: weekly for the first 30 days, then monthly.
//   - Meds: fire on the due day, then the same weekly-then-monthly overdue
//     cadence, plus (for meds due weekly or less often) a single "due in 3
//     days" heads-up — short-cycle (daily) meds skip that heads-up.
//
// Needs AWS CLI creds (lambda:InvokeFunction + cloudformation:ListStackResources
// + s3 read/write on the uploads bucket — the script writes users/{sub}/plan.json
// to mark the throwaway user paid for the 10-med seed, then removes it to
// assert over-cap grandfathering).
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
  // seed needs the paid med cap (10 meds > free cap of 4). Removed with the
  // user's S3 prefix at cleanup.
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

  console.log('\n[2] seed: vaccine toggle OFF, ten meds covering every med trigger, isolate meds');
  let r = await api(token, 'PUT', '/settings', {
    email,
    remindersEnabled: false, // vaccine reminders OFF — meds must fire anyway
    reminderDays: [7, 30],
    marketingOptIn: false,
  });
  check(r.status === 200, 'settings saved (vaccine reminders off)');

  const med = (name, offset, unit = 'month', extra = {}) => ({
    name,
    interval: 1,
    unit,
    nextDue: daysFromToday(offset),
    remindersEnabled: true,
    ...extra,
  });
  const meds = [
    med('DueTodayMed', 0),                        // fires: due today
    med('OverdueSevenMed', -7),                    // fires: weekly overdue nag
    med('OverdueThreeMed', -3),                     // silent: between weekly nags
    med('OverdueSixtyMed', -60),                    // fires: tapered to monthly past 30 days
    med('OverdueThirtyFiveMed', -35),               // silent: between taper ticks
    med('DueSoonWeeklyMed', 3, 'week'),             // fires: 3-day heads-up (weekly-cadence med)
    med('DueSoonDailyMed', 3, 'day'),               // silent: daily meds skip the heads-up
    med('DueTomorrowMed', 1),                       // silent: not due yet, not the 3-day mark
    med('MutedMed', 0, 'month', { remindersEnabled: false }), // silent: reminders off for this med
    med('DismissedMed', 0, 'month', { dismissed: true }),     // silent: "stop tracking"
  ];
  r = await api(token, 'PUT', `/pets/${petId}/meds`, { meds });
  check(r.status === 200 && r.body.meds.length === 10, 'ten meds saved (paid cap)');
  check(r.body.meds.find((m) => m.name === 'DismissedMed')?.dismissed === true, 'dismissed flag stored');

  console.log('\n[2b] downgrade to free: over-cap meds grandfathered (edit ok, growth blocked)');
  execSync(`aws s3 rm s3://${BUCKET}/users/${sub}/plan.json`, { encoding: 'utf8' });
  const limitsAfter = await api(token, 'GET', '/pets');
  check(limitsAfter.body?.limits?.plan === 'free', 'limits report free after plan.json removed');
  r = await api(token, 'PUT', `/pets/${petId}/meds`, { meds: r.body.meds });
  check(r.status === 200 && r.body.meds.length === 10, 're-saving 10 meds allowed over the 4-med free cap');
  const grow = await api(token, 'PUT', `/pets/${petId}/meds`, {
    meds: [...r.body.meds, med('OneTooMany', 3)],
  });
  check(grow.status === 400, `growing past current count rejected 400 (got ${grow.status})`);

  console.log('\n[3] dry run: meds fire per the new due/heads-up/overdue-taper rules');
  let dry = invokeDryRun(fnName);
  check(dry?.dryRun === true, 'dry run returned without sending');
  let msg = mine(dry);
  check(!!msg && !Array.isArray(msg), 'exactly one email for this user');
  if (msg && !Array.isArray(msg)) {
    check(msg.subject === '⚠️ Petshots: 2 overdue reminders', `subject "${msg.subject}"`);
    for (const name of ['DueTodayMed', 'OverdueSevenMed', 'OverdueSixtyMed', 'DueSoonWeeklyMed']) {
      check(msg.body.includes(name), `${name} in body (should fire)`);
    }
    for (const name of [
      'OverdueThreeMed', 'OverdueThirtyFiveMed', 'DueSoonDailyMed',
      'DueTomorrowMed', 'MutedMed', 'DismissedMed',
    ]) {
      check(!msg.body.includes(name), `${name} NOT in body (should stay silent)`);
    }
    check(msg.body.includes('⚠️ Overdue:'), 'overdue section header present');
    check(msg.body.includes('📅 Due today:'), 'due-today section header present');
    check(msg.body.includes('Coming up:'), 'coming-up section header present');
    check(msg.body.includes("Smokey's DueTodayMed — due today"), 'due-today phrasing');
    check(msg.body.includes("Smokey's OverdueSevenMed — 7 days overdue"), 'weekly-overdue phrasing');
    check(msg.body.includes("Smokey's OverdueSixtyMed — 60 days overdue"), 'tapered-monthly-overdue phrasing');
    check(msg.body.includes("Smokey's DueSoonWeeklyMed — due") && msg.body.includes('(in 3 days)'), '3-day heads-up phrasing');
    check(msg.body.includes('/unsubscribe?u='), 'unsubscribe link in footer');
  }

  console.log('\n[4] seed: vaccine toggle ON, eight docs covering every vaccine trigger, meds cleared');
  r = await api(token, 'PUT', `/pets/${petId}/meds`, { meds: [] });
  check(r.status === 200 && r.body.meds.length === 0, 'meds cleared to isolate the doc assertions');
  r = await api(token, 'PUT', '/settings', {
    email,
    remindersEnabled: true,
    reminderDays: [7, 30],
    marketingOptIn: false,
  });
  check(r.status === 200, 'settings saved (vaccine reminders on)');

  await uploadDoc(token, petId, 'VaxOverdueSixty', daysFromToday(-60));   // fires: tapered monthly
  await uploadDoc(token, petId, 'VaxOverdueThirtyFive', daysFromToday(-35)); // silent: between taper ticks
  await uploadDoc(token, petId, 'VaxOverdueSeven', daysFromToday(-7));    // fires: weekly overdue nag
  await uploadDoc(token, petId, 'VaxOverdueThree', daysFromToday(-3));    // silent: between weekly nags
  await uploadDoc(token, petId, 'VaxDueToday', daysFromToday(0));         // fires: expiry day
  await uploadDoc(token, petId, 'VaxFinalOne', daysFromToday(1));         // fires: forced final countdown
  await uploadDoc(token, petId, 'VaxUpcomingFive', daysFromToday(5));     // silent: not a milestone or countdown day
  await uploadDoc(token, petId, 'VaxMilestoneSeven', daysFromToday(7));   // fires: user's reminderDays milestone
  check(true, 'eight docs uploaded at crafted offsets');

  console.log('\n[5] dry run: docs fire per the new milestone/final-countdown/overdue-taper rules');
  dry = invokeDryRun(fnName);
  msg = mine(dry);
  check(!!msg && !Array.isArray(msg), 'exactly one email for this user');
  if (msg && !Array.isArray(msg)) {
    check(msg.subject === '⚠️ Petshots: 2 overdue reminders', `subject "${msg.subject}"`);
    for (const name of ['VaxOverdueSixty', 'VaxOverdueSeven', 'VaxDueToday', 'VaxFinalOne', 'VaxMilestoneSeven']) {
      check(msg.body.includes(name), `${name} in body (should fire)`);
    }
    for (const name of ['VaxOverdueThirtyFive', 'VaxOverdueThree', 'VaxUpcomingFive']) {
      check(!msg.body.includes(name), `${name} NOT in body (should stay silent)`);
    }
    check(msg.body.includes("VaxOverdueSixty — expired") && msg.body.includes('60 days overdue'), 'tapered-monthly-overdue doc phrasing');
    check(msg.body.includes("VaxOverdueSeven — expired") && msg.body.includes('7 days overdue'), 'weekly-overdue doc phrasing');
    check(msg.body.includes("VaxDueToday — expires today"), 'due-today doc phrasing');
    check(msg.body.includes('(tomorrow)'), 'final-countdown doc (1 day) phrasing');
    check(msg.body.includes('(in 7 days)'), 'user-milestone doc (7 days) phrasing');
  }

  console.log('\n[6] cleanup docs + reset meds for the remaining single-item subject tests');
  const docsRes0 = await api(token, 'GET', `/pets/${petId}/docs`);
  for (const d of docsRes0.body?.docs ?? []) await api(token, 'DELETE', `/pets/${petId}/docs/${d.id}`);
  r = await api(token, 'PUT', '/settings', {
    email, remindersEnabled: false, reminderDays: [7, 30], marketingOptIn: false,
  });

  console.log('\n[7] dry run: single due-today med gets the specific subject');
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

  console.log('\n[8] dry run: single overdue med gets the "N days overdue" subject');
  r = await api(token, 'PUT', `/pets/${petId}/meds`, { meds: [med('Heartworm prevention', -14)] });
  check(r.status === 200, 'meds replaced with single 14-day-overdue med');
  dry = invokeDryRun(fnName);
  msg = mine(dry);
  check(!!msg && !Array.isArray(msg), 'exactly one email for this user');
  if (msg && !Array.isArray(msg)) {
    check(
      msg.subject === "⚠️ Smokey's Heartworm prevention is 14 days overdue",
      `subject "${msg.subject}"`,
    );
  }

  console.log('\n[8b] emailOptOut master switch + unsubToken + public unsubscribe route');
  // The overdue med from [8] is still seeded, so email WOULD fire without the switch.
  r = await api(token, 'PUT', '/settings', {
    email, remindersEnabled: false, reminderDays: [7, 30], marketingOptIn: false,
    emailOptOut: true,
  });
  check(r.status === 200 && r.body.emailOptOut === true, 'settings saved with emailOptOut on');
  check(typeof r.body.unsubToken === 'string' && r.body.unsubToken.length > 0, 'server minted an unsubToken');
  const mintedToken = r.body.unsubToken;
  dry = invokeDryRun(fnName);
  check(mine(dry) === null, 'opted-out user gets NO email even with a med overdue');

  r = await api(token, 'PUT', '/settings', {
    email, remindersEnabled: false, reminderDays: [7, 30], marketingOptIn: false,
    emailOptOut: false,
  });
  check(r.status === 200 && r.body.emailOptOut === false, 'emailOptOut off again');
  check(r.body.unsubToken === mintedToken, 'unsubToken stable across saves (server-managed)');

  // Legacy-user path: strip the token from settings.json directly in S3; the
  // reminder Lambda must mint + persist one (needs its S3 write grant) and
  // still send, with the fresh token in the footer.
  const settingsFile = join(tmpdir(), `settings-${Date.now()}.json`);
  execSync(`aws s3 cp s3://${BUCKET}/users/${sub}/settings.json ${settingsFile}`, { encoding: 'utf8' });
  const legacy = JSON.parse(readFileSync(settingsFile, 'utf8'));
  delete legacy.unsubToken;
  delete legacy.emailOptOut;
  writeFileSync(settingsFile, JSON.stringify(legacy));
  execSync(`aws s3 cp ${settingsFile} s3://${BUCKET}/users/${sub}/settings.json`, { encoding: 'utf8' });
  dry = invokeDryRun(fnName);
  msg = mine(dry);
  check(!!msg && !Array.isArray(msg), 'email still sends for a legacy user without a token');
  execSync(`aws s3 cp s3://${BUCKET}/users/${sub}/settings.json ${settingsFile}`, { encoding: 'utf8' });
  const backfilled = JSON.parse(readFileSync(settingsFile, 'utf8'));
  unlinkSync(settingsFile);
  check(typeof backfilled.unsubToken === 'string' && backfilled.unsubToken.length > 0, 'Lambda backfilled a fresh unsubToken into settings.json');
  if (msg && !Array.isArray(msg)) {
    check(msg.body.includes(`/unsubscribe?u=${sub}&t=${backfilled.unsubToken}`), "footer carries this user's exact unsubscribe link");
  }

  const unsubPost = (body) => fetch(`${API}/unsubscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let pubRes = await unsubPost({ sub, token: randomUUID() });
  check(pubRes.status === 404, `wrong token rejected 404 (got ${pubRes.status})`);
  pubRes = await unsubPost({ sub: randomUUID(), token: backfilled.unsubToken });
  check(pubRes.status === 404, `unknown sub rejected 404 (got ${pubRes.status})`);
  pubRes = await unsubPost({ sub, token: backfilled.unsubToken });
  check(pubRes.status === 200, `correct token accepted 200 (got ${pubRes.status})`);
  dry = invokeDryRun(fnName);
  check(mine(dry) === null, 'unsubscribed via the public link -> no email');
  r = await api(token, 'PUT', '/settings', {
    email, remindersEnabled: false, reminderDays: [7, 30], marketingOptIn: false,
    emailOptOut: false,
  });
  check(r.status === 200 && r.body.emailOptOut === false, 'opt-out cleared for the remaining sections');

  console.log('\n[9] dry run: nothing due -> no email at all');
  r = await api(token, 'PUT', `/pets/${petId}/meds`, { meds: [med('Heartworm prevention', 5)] });
  check(r.status === 200, 'med pushed 5 days out (not the 3-day mark)');
  dry = invokeDryRun(fnName);
  check(mine(dry) === null, 'no email for this user when nothing is due');

  console.log('\n[10] birthday email rides the vaccine-reminder consent');
  r = await api(token, 'PUT', `/pets/${petId}/meds`, { meds: [] });
  check(r.status === 200 && r.body.meds.length === 0, 'meds cleared to isolate the birthday');
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
    check(!msg.body.includes('Overdue:') && !msg.body.includes('Due today:'), 'no reminder sections in a birthday-only email');
  }

  console.log('\n[11] cleanup (pets deleted; caller must delete the user + S3 prefix)');
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
