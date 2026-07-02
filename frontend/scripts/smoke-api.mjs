// End-to-end smoke test for PetshotsApiStack (multi-pet API).
// Logs in via SRP (the web client's only flow), then exercises the full
// pet + upload loop against the live HTTP API + S3.
//
//   node scripts/smoke-api.mjs <email> <password>
//
// Reads pool/client ids from ../.env. Nothing is persisted; it cleans up after
// itself (deletes every pet it created, which removes their docs/avatars too).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pkg from 'amazon-cognito-identity-js';

const { CognitoUserPool, CognitoUser, AuthenticationDetails } = pkg;

const API = process.env.API_URL ?? 'https://ycg5npcyk8.execute-api.us-east-1.amazonaws.com';
const MAX_PETS = 3;

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
  console.error('usage: node scripts/smoke-api.mjs <email> <password>');
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

  console.log('\n[2] GET /pets starts empty');
  let r = await api(token, 'GET', '/pets');
  check(r.status === 200 && r.body.pets.length === 0, 'no pets yet');

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

  console.log('\n[4b] oversized upload (11 MB) is rejected by the size policy');
  const big = Buffer.alloc(11 * 1024 * 1024, 0x20);
  let bigUp = await uploadDoc(token, petId, 'Too Big', big);
  check(bigUp.putStatus >= 400, `11 MB upload rejected server-side (got ${bigUp.putStatus})`);

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

  console.log('\n[5c] POST /docs/{id}/update-url archives current + presigns new version');
  let upd = await api(token, 'POST', `/pets/${petId}/docs/${renamed.id}/update-url`, {
    filename: 'Rabies_2028.pdf',
    label: 'Rabies 2028',
    contentType: 'application/pdf',
  });
  check(upd.status === 200, `update-url returns 200 (got ${upd.status})`);
  const updPut = await postPolicy(upd.body, PDF, 'application/pdf');
  check(updPut === 204, `new version S3 POST 204 (got ${updPut})`);
  r = await api(token, 'GET', `/pets/${petId}/docs`);
  const updDoc = r.body.docs?.[0];
  check(r.body.docs.length === 1, 'still one doc after update (archive not counted)');
  check(updDoc?.label === 'Rabies 2028', 'label updated to new version');
  let updGet = updDoc ? (await fetch(updDoc.url)).status : 0;
  check(updGet === 200, `new version downloads (${updGet})`);

  console.log('\n[6] fill to doc limit (4) then expect 409 on the 5th');
  await uploadDoc(token, petId, 'Doc 2');
  await uploadDoc(token, petId, 'Doc 3');
  await uploadDoc(token, petId, 'Doc 4');
  let over = await api(token, 'POST', `/pets/${petId}/docs/upload-url`, {
    filename: 'x.pdf',
    label: 'over',
    contentType: 'application/pdf',
  });
  check(over.status === 409, `5th doc rejected with 409 (got ${over.status})`);

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
  await api(token, 'POST', '/pets', { name: 'Kiwi', species: 'other' });
  let overPet = await api(token, 'POST', '/pets', { name: 'One Too Many', species: 'dog' });
  check(overPet.status === 409, `pet #${MAX_PETS + 1} rejected with 409 (got ${overPet.status})`);

  console.log("\n[8b] second pet's docs are isolated");
  r = await api(token, 'GET', `/pets/${p2.body.pet.id}/docs`);
  check(r.status === 200 && r.body.docs.length === 0, "Milo has no docs (Rexy's don't leak)");

  console.log('\n[9] DELETE pet removes it and its docs');
  del = await api(token, 'DELETE', `/pets/${petId}`);
  check(del.status === 204, `pet delete returns 204 (got ${del.status})`);
  r = await api(token, 'GET', '/pets');
  check(!r.body.pets.some((p) => p.id === petId), 'deleted pet gone from list');
  r = await api(token, 'GET', `/pets/${petId}/docs`);
  check(r.body.docs.length === 0, 'deleted pet has no docs left');

  console.log('\n[10] cleanup');
  r = await api(token, 'GET', '/pets');
  for (const p of r.body.pets) await api(token, 'DELETE', `/pets/${p.id}`);
  r = await api(token, 'GET', '/pets');
  check(r.body.pets.length === 0, 'all pets deleted');

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('ERROR:', e.message || e);
  process.exit(1);
});
