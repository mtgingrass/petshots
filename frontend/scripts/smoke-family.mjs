// Smoke test for family / household mode, against the live API with TWO
// throwaway users: an owner and a member.
//
//   node scripts/smoke-family.mjs <ownerEmail> <ownerPass> <memberEmail> <memberPass>
//
// Covers: invite lifecycle (create / public preview / cap / revoke), join
// (idempotent re-join, own-invite rejection), the member's merged pet view,
// member write access to household records/meds under the OWNER's caps,
// member-blocked destructive routes (pet delete, passport), member-created
// pets landing in the household, removal cutting access immediately, and the
// reminder Lambda including household pets in a member's email (dry run —
// nothing is sent; needs AWS CLI creds for the invoke).
//
// Cleanup at the end deletes every pet it created and the member's
// settings.json content is never written — the usual post-run user deletion
// (admin-delete-user + s3 rm of both users/{sub}/ prefixes) still applies.
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
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const [ownerEmail, ownerPass, memberEmail, memberPass] = process.argv.slice(2);
if (!memberPass) {
  console.error('usage: node scripts/smoke-family.mjs <ownerEmail> <ownerPass> <memberEmail> <memberPass>');
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

function login(email, password) {
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
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const PDF = Buffer.from('%PDF-1.4\n% family smoke\n', 'utf8');

async function uploadDoc(token, petId, label, expiry) {
  const presign = await api(token, 'POST', `/pets/${petId}/docs/upload-url`, {
    filename: `${label.replace(/\s/g, '_')}.pdf`,
    label,
    expiry,
    contentType: 'application/pdf',
  });
  if (presign.status !== 200) return presign;
  const form = new FormData();
  for (const [k, v] of Object.entries(presign.body.fields)) form.append(k, v);
  form.append('file', new Blob([PDF], { type: 'application/pdf' }));
  const res = await fetch(presign.body.url, { method: 'POST', body: form });
  return { status: presign.status, putStatus: res.status };
}

const ymd = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

async function main() {
  console.log(`API: ${API}`);

  console.log('\n[1] logins');
  const owner = await login(ownerEmail, ownerPass);
  const member = await login(memberEmail, memberPass);
  check(!!owner && !!member, 'both users log in');

  console.log('\n[0] cleanup from any prior run (idempotent)');
  for (const t of [owner, member]) {
    const pre = await api(t, 'GET', '/pets');
    for (const p of pre.body?.pets ?? []) await api(t, 'DELETE', `/pets/${p.id}`);
    await api(t, 'POST', '/household/leave');
    const hh = await api(t, 'GET', '/household');
    for (const m of hh.body?.members ?? []) await api(t, 'DELETE', `/household/members/${m.sub}`);
    for (const i of hh.body?.invites ?? []) await api(t, 'DELETE', `/household/invites/${i.token}`);
  }

  console.log('\n[2] owner seeds a pet with a doc + med');
  const pet = (await api(owner, 'POST', '/pets', { name: 'Waffles', species: 'dog' })).body.pet;
  const up = await uploadDoc(owner, pet.id, 'Rabies', '2027-03-01');
  check(up.putStatus === 204, "owner uploads Rabies doc to Waffles");
  const medsPut = await api(owner, 'PUT', `/pets/${pet.id}/meds`, {
    meds: [{ name: 'Heartworm prevention', interval: 1, unit: 'month', nextDue: ymd(10), remindersEnabled: true }],
  });
  check(medsPut.status === 200, 'owner adds a med');

  console.log('\n[3] household starts empty; invite lifecycle');
  let hh = await api(owner, 'GET', '/household');
  check(hh.status === 200 && hh.body.role === 'owner' && hh.body.members.length === 0, 'owner household empty');
  check(hh.body.maxMembers === 1, `free maxMembers is 1 (got ${hh.body.maxMembers})`);
  const inv = await api(owner, 'POST', '/household/invites');
  check(inv.status === 200 && !!inv.body.token && inv.body.url.includes('/join/'), 'invite created with join url');
  const invToken = inv.body.token;
  const preview = await api(null, 'GET', `/household/invites/${invToken}`);
  check(preview.status === 200 && preview.body.ownerEmail === ownerEmail, 'public invite preview shows owner email');
  const inv2 = await api(owner, 'POST', '/household/invites');
  check(inv2.status === 409 && inv2.body.error === 'MEMBER_LIMIT_REACHED', 'second invite blocked at free cap (pending counts)');
  const fakePreview = await api(null, 'GET', '/household/invites/00000000-0000-4000-8000-000000000000');
  check(fakePreview.status === 404, 'unknown invite token 404s');

  console.log('\n[4] member joins');
  const selfJoin = await api(owner, 'POST', '/household/join', { token: invToken });
  check(selfJoin.status === 409 && selfJoin.body.error === 'OWN_INVITE', "owner can't accept their own invite");
  const join = await api(member, 'POST', '/household/join', { token: invToken });
  check(join.status === 200 && join.body.ownerEmail === ownerEmail, 'member joins the family');
  const rejoin = await api(member, 'POST', '/household/join', { token: invToken });
  check(rejoin.status === 200, 're-clicking the used link is idempotent');
  hh = await api(owner, 'GET', '/household');
  check(
    hh.body.members.length === 1 && hh.body.members[0].email === memberEmail && hh.body.invites.length === 0,
    'owner sees the member; invite consumed',
  );
  const mhh = await api(member, 'GET', '/household');
  check(mhh.body.role === 'member' && mhh.body.ownerEmail === ownerEmail, 'member sees their membership');
  const memberInvite = await api(member, 'POST', '/household/invites');
  check(memberInvite.status === 409, "a member can't create invites of their own");

  console.log("\n[5] member's merged view + household write access");
  let mPets = await api(member, 'GET', '/pets');
  const waffles = mPets.body.pets.find((p) => p.name === 'Waffles');
  check(!!waffles && waffles.household === true, "member sees Waffles flagged household");
  check(mPets.body.family?.role === 'member', 'GET /pets carries family role');
  const mDocs = await api(member, 'GET', `/pets/${pet.id}/docs`);
  check(mDocs.status === 200 && mDocs.body.docs.length === 1, 'member reads household docs');
  const mUp = await uploadDoc(member, pet.id, 'Bordetella', '2026-12-01');
  check(mUp.putStatus === 204, 'member uploads a doc to the household pet');
  const docs2 = await api(owner, 'GET', `/pets/${pet.id}/docs`);
  check(docs2.body.docs.length === 2, 'owner sees the member-added doc');
  const bord = docs2.body.docs.find((d) => d.label === 'Bordetella');
  const mPatch = await api(member, 'PATCH', `/pets/${pet.id}/docs/${bord.id}`, { label: 'Bordetella (kennel cough)' });
  check(mPatch.status === 200, 'member edits a household doc');
  const mMeds = await api(member, 'PUT', `/pets/${pet.id}/meds`, {
    meds: [{ name: 'Heartworm prevention', interval: 1, unit: 'month', nextDue: ymd(0), remindersEnabled: true, lastGiven: ymd(0) }],
  });
  check(mMeds.status === 200, 'member updates household meds (mark as given)');
  const mDocDel = await api(member, 'DELETE', `/pets/${pet.id}/docs/${bord.id}`);
  check(mDocDel.status === 204, 'member deletes a household doc (records are shared-trust)');

  console.log('\n[6] member-blocked destructive routes');
  const petDel = await api(member, 'DELETE', `/pets/${pet.id}`);
  check(petDel.status === 403, 'member cannot delete a household pet');
  const ppCreate = await api(member, 'POST', `/pets/${pet.id}/passport`, {});
  check(ppCreate.status === 403, 'member cannot create a passport');
  const ppDel = await api(member, 'DELETE', `/pets/${pet.id}/passport`);
  check(ppDel.status === 403, 'member cannot revoke a passport');

  console.log('\n[7] member-created pets land in the household');
  const newPet = await api(member, 'POST', '/pets', { name: 'Pancake', species: 'cat' });
  check(newPet.status === 200 && newPet.body.pet.household === true, "member's new pet is flagged household");
  const oPets = await api(owner, 'GET', '/pets');
  check(oPets.body.pets.some((p) => p.name === 'Pancake'), 'owner sees the member-created pet');
  check(oPets.body.pets.length === 2, 'owner pool holds both pets');
  // Owner free cap is 2 pets — the next household create must hit the cap.
  const capPet = await api(member, 'POST', '/pets', { name: 'Toast', species: 'dog' });
  check(capPet.status === 409, "household pool enforces the OWNER's pet cap");

  console.log('\n[8] reminder Lambda includes household pets for the member (dry run)');
  await api(member, 'PUT', '/settings', {
    email: memberEmail,
    remindersEnabled: true,
    reminderDays: [7, 30],
  });
  // Make the med due today so the dry run has something to say to the member.
  const fnName = execSync(
    `aws cloudformation describe-stack-resources --stack-name PetshotsApiStack --query "StackResources[?starts_with(LogicalResourceId,'ReminderFn') && ResourceType=='AWS::Lambda::Function'].PhysicalResourceId" --output text`,
    { encoding: 'utf8' },
  ).trim();
  execSync(
    `aws lambda invoke --function-name ${fnName} --payload '{"dryRun":true}' --cli-binary-format raw-in-base64-out /tmp/family-reminder-out.json`,
    { stdio: 'pipe' },
  );
  const dry = JSON.parse(readFileSync('/tmp/family-reminder-out.json', 'utf8'));
  const memberMail = (dry.wouldSend ?? []).find((w) => w.email === memberEmail);
  check(!!memberMail, 'member would receive a reminder email');
  check(
    !!memberMail && /Waffles/.test(memberMail.body) && /Heartworm/.test(memberMail.body),
    "member's email covers the household pet's med",
  );

  console.log('\n[9] removal cuts access immediately');
  hh = await api(owner, 'GET', '/household');
  const memberSub = hh.body.members[0].sub;
  const rm = await api(owner, 'DELETE', `/household/members/${memberSub}`);
  check(rm.status === 204, 'owner removes the member');
  mPets = await api(member, 'GET', '/pets');
  check(!mPets.body.pets.some((p) => p.name === 'Waffles'), 'member no longer sees household pets');
  // GET docs on an inaccessible pet has always LISTed an empty prefix (200 []);
  // the routes that check pet existence 404. Both prove access is severed.
  const mDocsAfter = await api(member, 'GET', `/pets/${pet.id}/docs`);
  check(mDocsAfter.status === 200 && mDocsAfter.body.docs.length === 0, 'member doc listing comes back empty (same JWT, no wait)');
  const mUpAfter = await api(member, 'POST', `/pets/${pet.id}/docs/upload-url`, {
    filename: 'x.pdf', label: 'X', contentType: 'application/pdf',
  });
  check(mUpAfter.status === 404, 'member upload access is gone');
  const mLeave = await api(member, 'POST', '/household/leave');
  check(mLeave.status === 404, 'leave after removal 404s (no membership left)');

  console.log('\n[10] leave flow (rejoin first)');
  const inv3 = await api(owner, 'POST', '/household/invites');
  const join2 = await api(member, 'POST', '/household/join', { token: inv3.body.token });
  check(join2.status === 200, 'member rejoins on a fresh invite');
  const leave = await api(member, 'POST', '/household/leave');
  check(leave.status === 204, 'member leaves');
  hh = await api(owner, 'GET', '/household');
  check(hh.body.members.length === 0, 'owner household empty again');

  console.log('\n[11] cleanup');
  const oFinal = await api(owner, 'GET', '/pets');
  for (const p of oFinal.body.pets) await api(owner, 'DELETE', `/pets/${p.id}`);
  check((await api(owner, 'GET', '/pets')).body.pets.length === 0, 'owner pets deleted');
  // Wipe the member settings.json so the nightly cron never mails the fake address.
  const memberSettingsWipe = await api(member, 'PUT', '/settings', { email: '', remindersEnabled: false });
  check(memberSettingsWipe.status === 200, 'member reminder settings cleared');

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('ERROR:', e.message || e);
  process.exit(1);
});
