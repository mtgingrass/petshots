// End-to-end smoke test for PetshotsApiStack (multi-pet API).
// Logs in via SRP (the web client's only flow), then exercises the full
// pet + upload loop against the live HTTP API + S3.
//
//   node scripts/smoke-api.mjs <email> <password> [--delete-account]
//
// Reads pool/client ids from ../.env. Nothing is persisted; it cleans up after
// itself (deletes every pet it created, which removes their docs/avatars too).
//
// --delete-account: ONLY for a THROWAWAY user. Ends the run by calling
// DELETE /account and verifying (via AWS CLI) that the Cognito user, the
// users/{sub}/ S3 prefix, and any passport objects are all gone — which also
// replaces the usual manual post-run cleanup.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';
import pkg from 'amazon-cognito-identity-js';

const { CognitoUserPool, CognitoUser, AuthenticationDetails } = pkg;

const API = process.env.API_URL ?? 'https://ycg5npcyk8.execute-api.us-east-1.amazonaws.com';
const BUCKET = process.env.UPLOADS_BUCKET ?? 'petshots-uploads';
const MAX_PETS = 2; // free-tier cap (the smoke user has no plan.json)

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

const deleteAccountFlag = process.argv.includes('--delete-account');
const [email, password] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!email || !password) {
  console.error('usage: node scripts/smoke-api.mjs <email> <password> [--delete-account]');
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

const PDF = Buffer.from('%PDF-1.4\n% smoke test\n', 'utf8');
// Tiny valid PNG (1x1 transparent pixel).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

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

// Presigned POST policy: append every signed field, then the file last.
async function postPolicy(presign, bytes, type) {
  const form = new FormData();
  for (const [k, v] of Object.entries(presign.fields)) form.append(k, v);
  form.append('file', new Blob([bytes], { type }));
  const res = await fetch(presign.url, { method: 'POST', body: form });
  return res.status;
}

// upload-url -> direct S3 POST
async function uploadDoc(token, petId, label, bytes = PDF) {
  const presign = await api(token, 'POST', `/pets/${petId}/docs/upload-url`, {
    filename: `${label.replace(/\s/g, '_')}.pdf`,
    label,
    contentType: 'application/pdf',
  });
  if (presign.status !== 200) return presign;
  const putStatus = await postPolicy(presign.body, bytes, 'application/pdf');
  return { status: presign.status, putStatus, key: presign.body.key };
}

async function main() {
  console.log(`API: ${API}`);
  console.log('\n[1] SRP login');
  const token = await login();
  check(!!token, 'got access token');

  console.log('\n[0] cleanup any pets from a prior run (idempotent)');
  let pre = await api(token, 'GET', '/pets');
  for (const p of pre.body?.pets ?? []) await api(token, 'DELETE', `/pets/${p.id}`);

  console.log('\n[2] GET /pets starts empty + returns free-tier limits');
  let r = await api(token, 'GET', '/pets');
  check(r.status === 200 && r.body.pets.length === 0, 'no pets yet');
  check(
    r.body.limits?.plan === 'free' && r.body.limits?.maxPets === MAX_PETS,
    `limits returned (plan=${r.body.limits?.plan}, maxPets=${r.body.limits?.maxPets})`,
  );
  // Caps move with the env vars in api-stack.ts — the tests below fill to
  // whatever the server reports rather than hardcoding a number.
  const MAX_DOCS = r.body.limits?.maxDocs;
  const MAX_MEDS = r.body.limits?.maxMeds;
  check(
    Number.isInteger(MAX_DOCS) && MAX_DOCS >= 1 && Number.isInteger(MAX_MEDS) && MAX_MEDS >= 1,
    `free maxDocs=${MAX_DOCS}, maxMeds=${MAX_MEDS}`,
  );

  console.log('\n[3] POST /pets then GET /pets');
  r = await api(token, 'POST', '/pets', { name: 'Rex', species: 'dog' });
  check(r.status === 200 && r.body.pet.name === 'Rex' && r.body.pet.id, 'pet created');
  const petId = r.body.pet.id;
  r = await api(token, 'GET', '/pets');
  check(r.status === 200 && r.body.pets[0]?.name === 'Rex', 'pet persisted');

  console.log('\n[3b] PUT /pets/{id} renames');
  r = await api(token, 'PUT', `/pets/${petId}`, { name: 'Rexy', species: 'dog' });
  check(r.status === 200 && r.body.pet.name === 'Rexy', 'pet renamed');

  console.log('\n[3c] avatar upload -> GET /pets returns avatarUrl');
  let av = await api(token, 'POST', `/pets/${petId}/avatar/upload-url`, {
    contentType: 'image/png',
  });
  check(av.status === 200, `avatar presign 200 (got ${av.status})`);
  let avPut = await postPolicy(av.body, PNG, 'image/png');
  check(avPut === 204, `avatar S3 POST 204 (got ${avPut})`);
  r = await api(token, 'GET', '/pets');
  const withAvatar = r.body.pets.find((p) => p.id === petId);
  check(!!withAvatar?.avatarUrl, 'avatarUrl present');
  let avGet = withAvatar?.avatarUrl ? (await fetch(withAvatar.avatarUrl)).status : 0;
  check(avGet === 200, `avatar downloads (${avGet})`);
  let badAv = await api(token, 'POST', `/pets/${petId}/avatar/upload-url`, {
    contentType: 'application/pdf',
  });
  check(badAv.status === 400, `non-image avatar rejected (got ${badAv.status})`);

  console.log('\n[4] upload doc #1 (presigned POST policy -> S3)');
  let u = await uploadDoc(token, petId, 'Rabies 2026');
  check(u.status === 200 && u.putStatus === 204, `presign 200, S3 POST ${u.putStatus}`);

  console.log('\n[4b] oversized upload (21 MB) is rejected by the size policy');
  // Limit is MAX_FILE_BYTES = 20 MB (raised from 10 MB in session 11).
  const big = Buffer.alloc(21 * 1024 * 1024, 0x20);
  let bigUp = await uploadDoc(token, petId, 'Too Big', big);
  check(bigUp.putStatus >= 400, `21 MB upload rejected server-side (got ${bigUp.putStatus})`);

  console.log('\n[5] GET docs shows it with label + url');
  r = await api(token, 'GET', `/pets/${petId}/docs`);
  const doc = r.body.docs?.[0];
  check(r.status === 200 && r.body.docs.length === 1, 'one doc listed');
  check(doc?.label === 'Rabies 2026', 'label round-tripped from key');
  let getStatus = doc ? (await fetch(doc.url)).status : 0;
  check(getStatus === 200, `presigned GET url downloads (${getStatus})`);

  console.log('\n[5b] PATCH doc renames the label (copy -> new key)');
  let ren = await api(token, 'PATCH', `/pets/${petId}/docs/${doc.id}`, { label: 'Rabies 2027' });
  check(ren.status === 200, `rename returns 200 (got ${ren.status})`);
  r = await api(token, 'GET', `/pets/${petId}/docs`);
  const renamed = r.body.docs?.[0];
  check(r.body.docs.length === 1 && renamed?.label === 'Rabies 2027', 'label updated, still one doc');
  check(renamed?.id === doc.id, 'docId preserved across rename');
  let renGet = renamed ? (await fetch(renamed.url)).status : 0;
  check(renGet === 200, `renamed doc still downloads (${renGet})`);

  console.log('\n[5c] removed update-url route stays gone');
  let upd = await api(token, 'POST', `/pets/${petId}/docs/${renamed.id}/update-url`, {
    filename: 'Rabies_2028.pdf',
    label: 'Rabies 2028',
    contentType: 'application/pdf',
  });
  check(upd.status === 404, `update-url returns 404 (got ${upd.status})`);

  console.log(`\n[6] fill to doc limit (${MAX_DOCS}) then expect 409 on the next`);
  for (let i = 2; i <= MAX_DOCS; i++) await uploadDoc(token, petId, `Doc ${i}`);
  let over = await api(token, 'POST', `/pets/${petId}/docs/upload-url`, {
    filename: 'x.pdf',
    label: 'over',
    contentType: 'application/pdf',
  });
  check(over.status === 409, `doc #${MAX_DOCS + 1} rejected with 409 (got ${over.status})`);

  console.log('\n[7] DELETE one doc -> back under limit');
  r = await api(token, 'GET', `/pets/${petId}/docs`);
  const delId = r.body.docs[0].id;
  let del = await api(token, 'DELETE', `/pets/${petId}/docs/${delId}`);
  check(del.status === 204, `delete returns 204 (got ${del.status})`);
  let again = await api(token, 'POST', `/pets/${petId}/docs/upload-url`, {
    filename: 'y.pdf',
    label: 'ok',
    contentType: 'application/pdf',
  });
  check(again.status === 200, `upload-url works again (got ${again.status})`);

  console.log(`\n[8] fill to pet limit (${MAX_PETS}) then expect 409`);
  let p2 = await api(token, 'POST', '/pets', { name: 'Milo', species: 'cat' });
  check(p2.status === 200, 'second pet created');
  let overPet = await api(token, 'POST', '/pets', { name: 'One Too Many', species: 'dog' });
  check(overPet.status === 409, `pet #${MAX_PETS + 1} rejected with 409 (got ${overPet.status})`);

  console.log("\n[8b] second pet's docs are isolated");
  r = await api(token, 'GET', `/pets/${p2.body.pet.id}/docs`);
  check(r.status === 200 && r.body.docs.length === 0, "Milo has no docs (Rexy's don't leak)");

  console.log('\n[8c] medications: empty list, save, round-trip, defaults');
  r = await api(token, 'GET', `/pets/${petId}/meds`);
  check(r.status === 200 && Array.isArray(r.body.meds) && r.body.meds.length === 0, 'meds start empty');

  const medId = crypto.randomUUID();
  const goodMeds = [
    { id: medId, name: 'Heartworm prevention', interval: 1, unit: 'month', nextDue: '2027-01-15', remindersEnabled: true, lastGiven: '2026-12-15' },
    { name: '  Bravecto  ', interval: 12, unit: 'week', nextDue: '2026-01-01' }, // no id, no remindersEnabled, untrimmed name
    { name: 'Old antibiotic', interval: 1, unit: 'day', nextDue: '2026-01-01', dismissed: true }, // "stop tracking"
  ];
  r = await api(token, 'PUT', `/pets/${petId}/meds`, { meds: goodMeds });
  check(r.status === 200 && r.body.meds.length === 3, `PUT meds 200 (got ${r.status})`);
  check(r.body.meds[0].id === medId, 'client-supplied uuid preserved');
  check(/^[0-9a-f-]{36}$/.test(r.body.meds[1].id ?? ''), 'missing id generated server-side');
  check(r.body.meds[1].remindersEnabled === true, 'remindersEnabled defaults to true');
  check(r.body.meds[1].name === 'Bravecto', 'name trimmed');
  check(r.body.meds[0].lastGiven === '2026-12-15', 'lastGiven round-trips');
  check(r.body.meds[2].dismissed === true && r.body.meds[1].dismissed === undefined, 'dismissed flag round-trips (and stays absent elsewhere)');
  r = await api(token, 'GET', `/pets/${petId}/meds`);
  check(r.status === 200 && r.body.meds.length === 3 && r.body.meds[0].name === 'Heartworm prevention', 'meds persisted');
  check(r.body.meds[2].dismissed === true, 'dismissed persisted');
  // Drop the dismissed helper so the bad-input section's counts stay simple.
  r = await api(token, 'PUT', `/pets/${petId}/meds`, { meds: r.body.meds.slice(0, 2) });
  check(r.status === 200 && r.body.meds.length === 2, 'dismissed med removed again');

  console.log('\n[8d] medications: validation rejects bad input');
  const base = { name: 'X', interval: 1, unit: 'month', nextDue: '2027-01-15' };
  const badCases = [
    ['non-array meds', { meds: 'nope' }],
    ['empty name', { meds: [{ ...base, name: '   ' }] }],
    ['bad unit', { meds: [{ ...base, unit: 'year' }] }],
    ['zero interval', { meds: [{ ...base, interval: 0 }] }],
    ['fractional interval', { meds: [{ ...base, interval: 1.5 }] }],
    ['interval over unit max (25 months)', { meds: [{ ...base, interval: 25 }] }],
    ['interval as string', { meds: [{ ...base, interval: '1' }] }],
    ['missing nextDue', { meds: [{ ...base, nextDue: undefined }] }],
    ['impossible date (Feb 30)', { meds: [{ ...base, nextDue: '2027-02-30' }] }],
    ['non-ISO date', { meds: [{ ...base, nextDue: '06/15/2027' }] }],
    ['bad lastGiven', { meds: [{ ...base, lastGiven: '2026-13-01' }] }],
    [`${MAX_MEDS + 1} meds over free limit`, { meds: Array.from({ length: MAX_MEDS + 1 }, (_, i) => ({ ...base, name: `Med ${i}` })) }],
  ];
  for (const [label, body] of badCases) {
    const res = await api(token, 'PUT', `/pets/${petId}/meds`, body);
    check(res.status === 400, `${label} rejected 400 (got ${res.status})`);
  }
  r = await api(token, 'GET', `/pets/${petId}/meds`);
  check(r.body.meds.length === 2, 'failed PUTs did not overwrite stored meds');

  console.log('\n[8e] medications: duplicate ids deduped, authz boundaries');
  r = await api(token, 'PUT', `/pets/${petId}/meds`, {
    meds: [
      { id: medId, name: 'A', interval: 1, unit: 'day', nextDue: '2027-01-15' },
      { id: medId, name: 'B', interval: 1, unit: 'day', nextDue: '2027-01-15' },
    ],
  });
  check(r.status === 200 && new Set(r.body.meds.map((m) => m.id)).size === 2, 'duplicate med ids regenerated');
  const ghostPet = crypto.randomUUID();
  r = await api(token, 'PUT', `/pets/${ghostPet}/meds`, { meds: [] });
  check(r.status === 404, `PUT meds on nonexistent pet 404 (got ${r.status})`);
  r = await api(token, 'GET', `/pets/${p2.body.pet.id}/meds`);
  check(r.status === 200 && r.body.meds.length === 0, "Milo has no meds (Rexy's don't leak)");
  const noAuth = await fetch(`${API}/pets/${petId}/meds`);
  check(noAuth.status === 401, `unauthenticated meds GET 401 (got ${noAuth.status})`);

  console.log('\n[8f] weight log: add, same-date replace, profile sync, delete');
  r = await api(token, 'GET', `/pets/${petId}/weights`);
  check(r.status === 200 && r.body.entries.length === 0, 'weights start empty');
  r = await api(token, 'POST', `/pets/${petId}/weights`, { date: '2026-06-01', weight: 80, unit: 'lb' });
  check(r.status === 200 && r.body.entries.length === 1, 'historical weight logged');
  const wToday = new Date().toISOString().slice(0, 10);
  r = await api(token, 'POST', `/pets/${petId}/weights`, { date: wToday, weight: 83.5, unit: 'lb' });
  check(r.body.entries.length === 2 && r.body.entries[1].weight === 83.5, 'today logged, sorted by date');
  check(!!r.body.entries[1].by && !!r.body.entries[1].at, 'entry attributed (by + at)');
  r = await api(token, 'POST', `/pets/${petId}/weights`, { date: wToday, weight: 83, unit: 'lb' });
  check(r.body.entries.length === 2 && r.body.entries[1].weight === 83, 'same-date log replaces (typo fix)');
  let petCheck = await api(token, 'GET', '/pets');
  check(
    petCheck.body.pets.find((p) => p.id === petId)?.weight === '83 lb',
    "latest entry synced to the profile's display weight",
  );
  r = await api(token, 'POST', `/pets/${petId}/weights`, { date: '2030-01-01', weight: 80, unit: 'lb' });
  check(r.status === 400, 'future date rejected');
  r = await api(token, 'POST', `/pets/${petId}/weights`, { date: wToday, weight: -3, unit: 'lb' });
  check(r.status === 400, 'negative weight rejected');
  r = await api(token, 'DELETE', `/pets/${petId}/weights/${wToday}`);
  check(r.status === 200 && r.body.entries.length === 1, 'entry deleted');
  petCheck = await api(token, 'GET', '/pets');
  check(
    petCheck.body.pets.find((p) => p.id === petId)?.weight === '80 lb',
    'profile weight falls back to newest remaining entry',
  );
  r = await api(token, 'DELETE', `/pets/${petId}/weights/2020-01-01`);
  check(r.status === 404, 'deleting a missing date 404s');

  console.log('\n[8g] public roadmap + authed voting');
  const pubRoadmap = await fetch(`${API}/roadmap`);
  const roadmapBody = await pubRoadmap.json();
  check(
    pubRoadmap.status === 200 && Array.isArray(roadmapBody.items) && roadmapBody.items.length > 0,
    `public roadmap lists items (${roadmapBody.items?.length})`,
  );
  const rItem = roadmapBody.items[0];
  check(typeof rItem.votes === 'number', 'items carry vote counts');
  const unauthVote = await fetch(`${API}/roadmap/vote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ itemId: rItem.id }),
  });
  check(unauthVote.status === 401, `unauthenticated vote 401 (got ${unauthVote.status})`);
  let v = await api(token, 'POST', '/roadmap/vote', { itemId: rItem.id });
  check(v.status === 200 && v.body.voted === true && v.body.votes === rItem.votes + 1, 'vote lands (+1)');
  r = await api(token, 'GET', '/roadmap/votes');
  check(r.body.voted.includes(rItem.id), 'my-votes reflects it');
  v = await api(token, 'POST', '/roadmap/vote', { itemId: rItem.id });
  check(v.body.voted === false && v.body.votes === rItem.votes, 'toggle removes the vote');
  v = await api(token, 'POST', '/roadmap/vote', { itemId: 'no-such-item' });
  check(v.status === 404, 'unknown item 404s');

  console.log('\n[8h] push subscription routes');
  const fakeSub = {
    endpoint: `https://updates.push.example.com/wpush/v2/smoke-${Date.now()}`,
    keys: { p256dh: 'BFakeP256dhKeyForSmokeTestingPurposesOnly000000000000000000000000000000000000000000000', auth: 'FakeAuthSecret16' },
  };
  r = await api(token, 'POST', '/push/subscribe', { subscription: fakeSub });
  check(r.status === 200, 'valid subscription stored');
  r = await api(token, 'POST', '/push/subscribe', { subscription: { endpoint: 'http://not-https', keys: {} } });
  check(r.status === 400, 'malformed subscription rejected');
  r = await api(token, 'POST', '/push/unsubscribe', { endpoint: fakeSub.endpoint });
  check(r.status === 204, 'unsubscribe removes it');

  console.log('\n[9] DELETE pet removes it and its docs');
  del = await api(token, 'DELETE', `/pets/${petId}`);
  check(del.status === 204, `pet delete returns 204 (got ${del.status})`);
  r = await api(token, 'GET', '/pets');
  check(!r.body.pets.some((p) => p.id === petId), 'deleted pet gone from list');
  r = await api(token, 'GET', `/pets/${petId}/docs`);
  check(r.body.docs.length === 0, 'deleted pet has no docs left');
  r = await api(token, 'GET', `/pets/${petId}/meds`);
  check(r.body.meds.length === 0, 'deleted pet has no meds left (meds.json cascaded)');

  console.log('\n[9b] deleting a pet revokes its passport (no orphaned public link)');
  r = await api(token, 'POST', '/pets', { name: 'Passporter', species: 'cat' });
  check(r.status === 200, 'pet created');
  const ppPetId = r.body.pet.id;
  r = await api(token, 'POST', `/pets/${ppPetId}/passport`, {});
  check(r.status === 200 && !!r.body.token, 'passport created');
  const petPassportToken = r.body.token;
  r = await api(token, 'DELETE', `/pets/${ppPetId}`);
  check(r.status === 204, 'pet deleted');
  const pubPassport = await fetch(`${API}/passport/${petPassportToken}`);
  const pubBody = await pubPassport.json();
  // 'passport not found' = token object deleted with the pet; 'pet not found'
  // would mean the token object survived as an orphan (the pre-fix behavior).
  check(
    pubPassport.status === 404 && pubBody.error === 'passport not found',
    `passport object gone with the pet (got ${pubPassport.status} "${pubBody.error}")`,
  );

  console.log('\n[10] cleanup');
  r = await api(token, 'GET', '/pets');
  for (const p of r.body.pets) await api(token, 'DELETE', `/pets/${p.id}`);
  r = await api(token, 'GET', '/pets');
  check(r.body.pets.length === 0, 'all pets deleted');

  if (deleteAccountFlag) {
    console.log('\n[11] DELETE /account wipes S3 + passports + the Cognito user');
    const sub = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;

    // Seed the shapes account deletion must clean up: a pet with a doc, a
    // live passport token (bucket-root object), and settings.json.
    const petR = await api(token, 'POST', '/pets', { name: 'DeleteMe', species: 'dog' });
    check(petR.status === 200, 'seed pet created');
    const delPetId = petR.body.pet.id;
    const seedUp = await uploadDoc(token, delPetId, 'Rabies DeleteAccount');
    check(seedUp.putStatus === 204, 'seed doc uploaded');
    const pp = await api(token, 'POST', `/pets/${delPetId}/passport`, {});
    check(pp.status === 200 && !!pp.body.token, 'seed passport created');
    const ppToken = pp.body.token;
    await api(token, 'PUT', '/settings', {
      email, remindersEnabled: false, reminderDays: [7, 30], marketingOptIn: false,
    });

    const delAcct = await api(token, 'DELETE', '/account');
    check(delAcct.status === 204, `DELETE /account returns 204 (got ${delAcct.status})`);

    let userGone = false;
    try {
      execSync(
        `aws cognito-idp admin-get-user --user-pool-id ${env.VITE_COGNITO_USER_POOL_ID} --username ${sub}`,
        { stdio: 'pipe' },
      );
    } catch { userGone = true; }
    check(userGone, 'Cognito user deleted');

    let prefixEmpty = false;
    try {
      const out = execSync(`aws s3 ls s3://${BUCKET}/users/${sub}/ --recursive`, {
        encoding: 'utf8', stdio: 'pipe',
      });
      prefixEmpty = out.trim() === '';
    } catch { prefixEmpty = true; } // aws s3 ls exits nonzero on an empty prefix
    check(prefixEmpty, `users/${sub}/ prefix empty`);

    let passportGone = false;
    try {
      execSync(`aws s3api head-object --bucket ${BUCKET} --key passports/${ppToken}.json`, {
        stdio: 'pipe',
      });
    } catch { passportGone = true; }
    check(passportGone, 'passport token object deleted from bucket root');
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('ERROR:', e.message || e);
  process.exit(1);
});
