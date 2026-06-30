// End-to-end smoke test for PetshotsApiStack.
// Logs in via SRP (the web client's only flow), then exercises the full
// upload loop against the live HTTP API + S3.
//
//   node scripts/smoke-api.mjs <email> <password>
//
// Reads pool/client ids from ../.env. Nothing is persisted; it cleans up after
// itself (deletes the docs + pet.json it created).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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

// upload-url -> direct S3 PUT
async function uploadDoc(token, label) {
  const presign = await api(token, 'POST', '/docs/upload-url', {
    filename: `${label.replace(/\s/g, '_')}.pdf`,
    label,
    contentType: 'application/pdf',
  });
  if (presign.status !== 200) return presign;
  const put = await fetch(presign.body.uploadUrl, {
    method: 'PUT',
    headers: presign.body.requiredHeaders,
    body: PDF,
  });
  let putBody = '';
  if (put.status !== 200) putBody = await put.text();
  return {
    status: presign.status,
    putStatus: put.status,
    key: presign.body.key,
    putBody,
    signedHeaders: new URL(presign.body.uploadUrl).searchParams.get('X-Amz-SignedHeaders'),
    sentHeaders: presign.body.requiredHeaders,
  };
}

async function main() {
  console.log(`API: ${API}`);
  console.log('\n[1] SRP login');
  const token = await login();
  check(!!token, 'got access token');

  console.log('\n[0] cleanup any docs from a prior run (idempotent)');
  let pre = await api(token, 'GET', '/docs');
  for (const d of pre.body?.docs ?? []) await api(token, 'DELETE', `/docs/${d.id}`);

  console.log('\n[2] GET /pet');
  let r = await api(token, 'GET', '/pet');
  check(r.status === 200, 'GET /pet returns 200');

  console.log('\n[3] PUT /pet then GET /pet');
  r = await api(token, 'PUT', '/pet', { name: 'Rex', species: 'dog' });
  check(r.status === 200 && r.body.pet.name === 'Rex', 'pet saved');
  r = await api(token, 'GET', '/pet');
  check(r.status === 200 && r.body.pet?.name === 'Rex', 'pet persisted');

  console.log('\n[4] upload doc #1 (presign -> S3 PUT)');
  let u = await uploadDoc(token, 'Rabies 2026');
  check(u.status === 200 && u.putStatus === 200, `presign 200, S3 PUT ${u.putStatus}`);
  if (u.putStatus !== 200) {
    console.log('    --- S3 PUT diagnostics ---');
    console.log('    SignedHeaders:', u.signedHeaders);
    console.log('    sent headers :', JSON.stringify(u.sentHeaders));
    console.log('    S3 response  :', u.putBody?.replace(/\s+/g, ' ').slice(0, 600));
  }

  console.log('\n[5] GET /docs shows it with label + url');
  r = await api(token, 'GET', '/docs');
  const doc = r.body.docs?.[0];
  check(r.status === 200 && r.body.docs.length === 1, 'one doc listed');
  check(doc?.label === 'Rabies 2026', 'label round-tripped from key');
  let getStatus = doc ? (await fetch(doc.url)).status : 0;
  check(getStatus === 200, `presigned GET url downloads (${getStatus})`);

  console.log('\n[5b] PATCH /docs/{id} renames the label (copy -> new key)');
  let ren = await api(token, 'PATCH', `/docs/${doc.id}`, { label: 'Rabies 2027' });
  check(ren.status === 200, `rename returns 200 (got ${ren.status})`);
  r = await api(token, 'GET', '/docs');
  const renamed = r.body.docs?.[0];
  check(r.body.docs.length === 1 && renamed?.label === 'Rabies 2027', 'label updated, still one doc');
  check(renamed?.id === doc.id, 'docId preserved across rename');
  let renGet = renamed ? (await fetch(renamed.url)).status : 0;
  check(renGet === 200, `renamed doc still downloads (${renGet})`);

  console.log('\n[6] fill to limit (4) then expect 409 on the 5th');
  await uploadDoc(token, 'Doc 2');
  await uploadDoc(token, 'Doc 3');
  await uploadDoc(token, 'Doc 4');
  let over = await api(token, 'POST', '/docs/upload-url', {
    filename: 'x.pdf',
    label: 'over',
    contentType: 'application/pdf',
  });
  check(over.status === 409, `5th doc rejected with 409 (got ${over.status})`);

  console.log('\n[7] DELETE one doc -> back under limit');
  r = await api(token, 'GET', '/docs');
  const delId = r.body.docs[0].id;
  let del = await api(token, 'DELETE', `/docs/${delId}`);
  check(del.status === 204, `delete returns 204 (got ${del.status})`);
  let again = await api(token, 'POST', '/docs/upload-url', {
    filename: 'y.pdf',
    label: 'ok',
    contentType: 'application/pdf',
  });
  check(again.status === 200, `upload-url works again (got ${again.status})`);

  console.log('\n[8] cleanup');
  r = await api(token, 'GET', '/docs');
  for (const d of r.body.docs) await api(token, 'DELETE', `/docs/${d.id}`);
  r = await api(token, 'GET', '/docs');
  check(r.body.docs.length === 0, 'all docs deleted');

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('ERROR:', e.message || e);
  process.exit(1);
});
