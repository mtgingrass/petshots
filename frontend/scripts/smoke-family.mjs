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

// ReminderFn does due-day math in UTC — meds meant to trigger the dry-run
// reminder must be seeded with the UTC date, or evening-ET runs flake
// (same gotcha smoke-digest hit in s20).
const utcYmd = (offset) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
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

  console.log('\n[3b] emailed invite (revoke the link one first to free the seat)');
  await api(owner, 'DELETE', `/household/invites/${invToken}`);
  // SES mailbox simulator: the send is REAL, the address never bounces.
  const simAddr = `success+fam-invite-${Date.now()}@simulator.amazonses.com`;
  const emailedInv = await api(owner, 'POST', '/household/invites', { email: simAddr });
  check(
    emailedInv.status === 200 && emailedInv.body.sentTo === simAddr && emailedInv.body.emailDelivered === true,
    'invite emailed via SES (sentTo + delivered)',
  );
  let hhEmailed = await api(owner, 'GET', '/household');
  check(hhEmailed.body.invites[0]?.sentTo === simAddr, 'pending list shows who it was sent to');
  const badEmail = await api(owner, 'POST', '/household/invites', { email: 'not-an-email' });
  check(badEmail.status === 400, 'malformed email rejected');
  // Daily invite-email cap: pre-fill today's counter, expect the send refused
  // (invite still created as a working link) — then reset the counter.
  const invObj = JSON.parse(
    execSync(`aws s3 cp s3://petshots-uploads/invites/${emailedInv.body.token}.json -`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  );
  const ownerSubId = invObj.ownerSub;
  const capDate = new Date().toISOString().slice(0, 10);
  execSync(
    `echo '{"date":"${capDate}","count":10}' | aws s3 cp - s3://petshots-uploads/users/${ownerSubId}/invite-emails.json --content-type application/json`,
    { stdio: 'pipe' },
  );
  await api(owner, 'DELETE', `/household/invites/${emailedInv.body.token}`);
  const cappedInv = await api(owner, 'POST', '/household/invites', { email: simAddr });
  check(
    cappedInv.status === 200 && cappedInv.body.emailDelivered === false,
    'daily email cap refuses the send but keeps the link working',
  );
  execSync(`aws s3 rm s3://petshots-uploads/users/${ownerSubId}/invite-emails.json`, { stdio: 'pipe' });
  await api(owner, 'DELETE', `/household/invites/${cappedInv.body.token}`);
  // Swap back to a plain link invite for the join flow below.
  await api(owner, 'DELETE', `/household/invites/${emailedInv.body.token}`);
  const relink = await api(owner, 'POST', '/household/invites');
  check(relink.status === 200, 'link invite recreated for the join flow');
  const joinToken = relink.body.token;
  const fakePreview = await api(null, 'GET', '/household/invites/00000000-0000-4000-8000-000000000000');
  check(fakePreview.status === 404, 'unknown invite token 404s');

  console.log('\n[4] member joins');
  const selfJoin = await api(owner, 'POST', '/household/join', { token: joinToken });
  check(selfJoin.status === 409 && selfJoin.body.error === 'OWN_INVITE', "owner can't accept their own invite");
  const join = await api(member, 'POST', '/household/join', { token: joinToken });
  check(join.status === 200 && join.body.ownerEmail === ownerEmail, 'member joins the family');
  const rejoin = await api(member, 'POST', '/household/join', { token: joinToken });
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
  // Two meds on purpose: Heartworm (LOCAL today) drives the daily-list
  // check-off tests in [8b]; Flea & tick (UTC today) deterministically fires
  // in the ReminderFn dry run regardless of wall-clock (UTC math).
  const mMeds = await api(member, 'PUT', `/pets/${pet.id}/meds`, {
    meds: [
      { name: 'Heartworm prevention', interval: 1, unit: 'month', nextDue: ymd(0), remindersEnabled: true, lastGiven: ymd(0) },
      { name: 'Flea & tick prevention', interval: 1, unit: 'month', nextDue: utcYmd(0), remindersEnabled: true },
    ],
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
    `aws cloudformation list-stack-resources --stack-name PetshotsApiStack --query "StackResourceSummaries[?starts_with(LogicalResourceId,'ReminderFn') && ResourceType=='AWS::Lambda::Function'].PhysicalResourceId" --output text`,
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
    !!memberMail && /Waffles/.test(memberMail.body) && /Flea & tick/.test(memberMail.body),
    "member's email covers the household pet's med",
  );

  console.log('\n[8b] daily checklist: shared, attributed, med-integrated');
  const today = ymd(0);
  let daily = await api(owner, 'GET', `/pets/${pet.id}/daily?date=${today}`);
  check(daily.status === 200, 'GET daily works');
  const names = daily.body.items.map((i) => i.name);
  check(
    names.includes('Breakfast') && names.includes('Dinner') && names.includes('Walk'),
    'preset items present (Breakfast, Dinner, Walk)',
  );
  // Counter presets were removed from the product (s26) — but the API still
  // honors legacy lists that stored counter items, so seed one like a
  // pre-removal list and keep the count-semantics coverage below.
  check(!daily.body.items.some((i) => i.kind === 'counter'), 'no counter preset ships anymore');
  const seeded = await api(owner, 'PUT', `/pets/${pet.id}/daily/items`, {
    items: [
      ...daily.body.items
        .filter((i) => !i.id.startsWith('med:'))
        .map(({ id, name, kind }) => ({ id, name, ...(kind ? { kind } : {}) })),
      { name: '💩 Poop', kind: 'counter' },
    ],
  });
  const poop = seeded.body.items.find((i) => i.kind === 'counter');
  check(!!poop && /Poop/.test(poop.name), 'legacy counter item accepted via PUT items');
  const medItem = daily.body.items.find(
    (i) => i.id.startsWith('med:') && i.name === 'Heartworm prevention',
  );
  check(!!medItem, 'due med appears on the daily list');
  // Reads are plan-gated history now (free = 2 weeks): far past → HISTORY_LIMIT,
  // future days still a plain 400.
  const badDate = await api(owner, 'GET', `/pets/${pet.id}/daily?date=1999-01-01`);
  check(badDate.status === 403 && badDate.body.error === 'HISTORY_LIMIT',
    'far-past date blocked by plan history window');
  const futureDate = await api(owner, 'GET', `/pets/${pet.id}/daily?date=2099-01-01`);
  check(futureDate.status === 400, 'future date rejected');

  const breakfast = daily.body.items.find((i) => i.name === 'Breakfast');
  const ownerCheck = await api(owner, 'POST', `/pets/${pet.id}/daily/check`, {
    date: today, itemId: breakfast.id, checked: true,
  });
  check(ownerCheck.status === 200 && ownerCheck.body.checks[breakfast.id]?.by === ownerEmail,
    'owner check-off stamped with owner email');

  daily = await api(member, 'GET', `/pets/${pet.id}/daily?date=${today}`);
  check(daily.body.checks[breakfast.id]?.by === ownerEmail,
    "member sees WHO checked Breakfast (owner)");
  // Re-checking by someone else never steals attribution (first checker wins).
  await api(member, 'POST', `/pets/${pet.id}/daily/check`, { date: today, itemId: breakfast.id, checked: true });
  daily = await api(member, 'GET', `/pets/${pet.id}/daily?date=${today}`);
  check(daily.body.checks[breakfast.id]?.by === ownerEmail, 'attribution survives a duplicate check');

  const medCheck = await api(member, 'POST', `/pets/${pet.id}/daily/check`, {
    date: today, itemId: medItem.id, checked: true,
  });
  check(medCheck.status === 200 && medCheck.body.checks[medItem.id]?.by === memberEmail,
    'member med check-off stamped with member email');
  let medsNow = await api(owner, 'GET', `/pets/${pet.id}/meds`);
  const hw = medsNow.body.meds.find((m) => `med:${m.id}` === medItem.id);
  check(hw.lastGiven === today && hw.nextDue > today,
    `med check-off marked as given + advanced (nextDue ${hw.nextDue})`);
  daily = await api(owner, 'GET', `/pets/${pet.id}/daily?date=${today}`);
  check(daily.body.items.some((i) => i.id === medItem.id),
    'given med stays visible (checked) on the daily list');

  const medUncheck = await api(member, 'POST', `/pets/${pet.id}/daily/check`, {
    date: today, itemId: medItem.id, checked: false,
  });
  check(medUncheck.status === 200 && !medUncheck.body.checks[medItem.id], 'med uncheck clears the entry');
  medsNow = await api(owner, 'GET', `/pets/${pet.id}/meds`);
  const hw2 = medsNow.body.meds.find((m) => `med:${m.id}` === medItem.id);
  check(hw2.nextDue === today, 'med uncheck restores the prior schedule');

  // Counter semantics: increments tally with last-actor attribution; a
  // decrement restores the previous increment's attribution.
  const c1 = await api(owner, 'POST', `/pets/${pet.id}/daily/check`, { date: today, itemId: poop.id, checked: true });
  check(c1.body.checks[poop.id]?.count === 1 && c1.body.checks[poop.id]?.by === ownerEmail,
    'counter +1 by owner (count 1)');
  const c2 = await api(member, 'POST', `/pets/${pet.id}/daily/check`, { date: today, itemId: poop.id, checked: true });
  check(c2.body.checks[poop.id]?.count === 2 && c2.body.checks[poop.id]?.by === memberEmail,
    'counter +1 by member (count 2, last actor shown)');
  const c3 = await api(member, 'POST', `/pets/${pet.id}/daily/check`, { date: today, itemId: poop.id, checked: false });
  check(c3.body.checks[poop.id]?.count === 1 && c3.body.checks[poop.id]?.by === ownerEmail,
    'counter -1 restores prior count + attribution');

  const putItems = await api(owner, 'PUT', `/pets/${pet.id}/daily/items`, {
    items: [...daily.body.items.filter((i) => !i.id.startsWith('med:')), { name: 'Evening walk' }],
  });
  check(putItems.status === 200 && putItems.body.items.length === 5, 'owner adds a custom item');
  daily = await api(member, 'GET', `/pets/${pet.id}/daily?date=${today}`);
  check(daily.body.items.some((i) => i.name === 'Evening walk'), 'member sees the new item');
  check(daily.body.checks[breakfast.id]?.by === ownerEmail, 'attribution survives the items edit');
  const ghostCheck = await api(member, 'POST', `/pets/${pet.id}/daily/check`, {
    date: today, itemId: 'no-such-item', checked: true,
  });
  check(ghostCheck.status === 404, 'unknown item 404s');

  console.log('\n[8b2] items history: removals tombstone — past days keep the list they had');
  const yesterday = ymd(-1);
  const dinner = daily.body.items.find((i) => i.name === 'Dinner');
  const yCheck = await api(owner, 'POST', `/pets/${pet.id}/daily/check`, {
    date: yesterday, itemId: dinner.id, checked: true,
  });
  check(yCheck.status === 200, 'preset checked for yesterday (existed then)');
  const evening = daily.body.items.find((i) => i.name === 'Evening walk');
  const yGhost = await api(owner, 'POST', `/pets/${pet.id}/daily/check`, {
    date: yesterday, itemId: evening.id, checked: true,
  });
  check(yGhost.status === 404, "item added today can't be checked for yesterday (not on that day's list)");
  const remove = await api(owner, 'PUT', `/pets/${pet.id}/daily/items`, {
    items: daily.body.items
      .filter((i) => !i.id.startsWith('med:') && i.id !== dinner.id)
      .map(({ id, name, kind }) => ({ id, name, ...(kind ? { kind } : {}) })),
    date: today,
  });
  check(
    remove.status === 200 && !remove.body.items.some((i) => i.id === dinner.id),
    'removal accepted; response omits the removed item',
  );
  let dToday = await api(member, 'GET', `/pets/${pet.id}/daily?date=${today}`);
  check(!dToday.body.items.some((i) => i.id === dinner.id), "removed item gone from today's list");
  const dYest = await api(member, 'GET', `/pets/${pet.id}/daily?date=${yesterday}`);
  check(dYest.body.items.some((i) => i.id === dinner.id), "yesterday's list still shows the removed item");
  check(dYest.body.checks[dinner.id]?.by === ownerEmail, "yesterday's check-off + attribution retained");
  check(!dYest.body.items.some((i) => i.id === evening.id), "yesterday's list omits the item added today");
  const deadCheck = await api(owner, 'POST', `/pets/${pet.id}/daily/check`, {
    date: today, itemId: dinner.id, checked: true,
  });
  check(deadCheck.status === 404, 'removed item is not checkable today');

  console.log('\n[8c] daily mood: first press attributed, override re-attributes');
  const m1 = await api(owner, 'POST', `/pets/${pet.id}/daily/mood`, { date: today, value: 4 });
  check(m1.status === 200 && m1.body.mood.value === 4 && m1.body.mood.by === ownerEmail,
    'owner sets mood 4, attributed to owner');
  const m2 = await api(member, 'POST', `/pets/${pet.id}/daily/mood`, { date: today, value: 4 });
  check(m2.body.mood.by === ownerEmail, 'same-value press keeps the first attribution');
  const m3 = await api(member, 'POST', `/pets/${pet.id}/daily/mood`, { date: today, value: 2 });
  check(m3.body.mood.value === 2 && m3.body.mood.by === memberEmail,
    'different value overrides and re-attributes');
  daily = await api(owner, 'GET', `/pets/${pet.id}/daily?date=${today}`);
  check(daily.body.mood?.value === 2 && daily.body.mood?.by === memberEmail,
    'owner sees the member-set mood');
  const mBad = await api(owner, 'POST', `/pets/${pet.id}/daily/mood`, { date: today, value: 9 });
  check(mBad.status === 400, 'out-of-range mood rejected');

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
