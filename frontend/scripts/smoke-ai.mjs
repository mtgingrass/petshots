// End-to-end smoke test for the AI document-extraction flow
// (analyze-upload-url -> analyze -> commit) against the live API + Bedrock.
//
//   node scripts/smoke-ai.mjs <email> <password>
//
// Run with a THROWAWAY user (admin-created) and delete it afterwards.
// Needs AWS CLI creds (s3 read/write on the uploads bucket) for the quota and
// read-only-pet setup, which write users/{sub}/*.json directly.
// Makes 2 real Claude Haiku calls (~$0.01/run).
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import pkg from 'amazon-cognito-identity-js';
import { CERT, makeMultiVaccineCert, makeNonVaccinePdf } from './lib-cert-pdf.mjs';

const { CognitoUserPool, CognitoUser, AuthenticationDetails } = pkg;

const API = process.env.API_URL ?? 'https://ycg5npcyk8.execute-api.us-east-1.amazonaws.com';
const BUCKET = process.env.UPLOADS_BUCKET ?? 'petshots-uploads';
const MAX_DOCS = 4; // free-tier cap (the smoke user has no plan.json)

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
  console.error('usage: node scripts/smoke-ai.mjs <email> <password>');
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

async function s3Post(presign, bytes, mimeType) {
  const form = new FormData();
  for (const [k, v] of Object.entries(presign.fields)) form.append(k, v);
  form.append('file', new Blob([bytes], { type: mimeType }));
  const res = await fetch(presign.url, { method: 'POST', body: form });
  return res.status;
}

// Write a small JSON object straight to the uploads bucket (operator-style),
// used to simulate quota exhaustion and a plan-limits override.
function s3PutJson(key, obj) {
  const f = join(tmpdir(), `smoke-ai-${Date.now()}.json`);
  writeFileSync(f, JSON.stringify(obj));
  execSync(`aws s3 cp "${f}" "s3://${BUCKET}/${key}" --content-type application/json`, {
    stdio: 'pipe',
  });
  unlinkSync(f);
}
function s3Rm(pathArg, recursive = false) {
  try {
    execSync(`aws s3 rm "s3://${BUCKET}/${pathArg}"${recursive ? ' --recursive' : ''}`, {
      stdio: 'pipe',
    });
  } catch {
    /* already gone */
  }
}

// ---- test run ----

const token = await login();
const sub = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
console.log(`\nSmoke-testing AI extraction as ${email} (${sub}) against ${API}\n`);

const cleanup = { petIds: [], wroteQuota: false, wrotePlan: false };
try {
  // -- setup: one pet --
  console.log('pet setup:');
  const petRes = await api(token, 'POST', '/pets', { name: 'ScanPet', species: 'dog' });
  check(petRes.status === 200, 'create pet');
  const petId = petRes.body.pet.id;
  cleanup.petIds.push(petId);

  // -- temp upload round trip --
  console.log('\ntemp upload:');
  const certPdf = makeMultiVaccineCert();
  const pre1 = await api(token, 'POST', `/pets/${petId}/docs/analyze-upload-url`, {
    filename: 'multi-cert.pdf',
    contentType: 'application/pdf',
  });
  check(pre1.status === 200 && pre1.body.uploadId && pre1.body.url, 'analyze-upload-url presigns');
  const up1 = await s3Post(pre1.body, certPdf, 'application/pdf');
  check(up1 === 204, 'cert PDF uploads to tmp slot');

  // -- analyze: the real Bedrock call --
  console.log('\nanalyze (Claude Haiku via Bedrock):');
  const an1 = await api(token, 'POST', `/pets/${petId}/docs/analyze`, {
    uploadId: pre1.body.uploadId,
  });
  check(an1.status === 200, `analyze returns 200 (got ${an1.status}: ${JSON.stringify(an1.body)})`);
  const ex = an1.body?.extraction ?? {};
  check(ex.isPetHealthDocument === true, 'recognized as a pet health document');
  check(typeof an1.body?.scansRemaining === 'number', 'scansRemaining reported');
  const found = (name) =>
    (ex.vaccines ?? []).find((v) => v.name.toLowerCase().includes(name.toLowerCase()));
  const rabies = found('rabies');
  const dhpp = found('dhpp') ?? found('distemper');
  const bord = found('bordetella');
  check((ex.vaccines ?? []).length === 3, `found 3 vaccines (got ${(ex.vaccines ?? []).length})`);
  check(!!rabies, 'found Rabies');
  check(rabies?.dateGiven === '2025-07-01' && rabies?.expiry === '2028-07-01', 'Rabies dates exact');
  check(!!dhpp && dhpp.expiry === '2026-07-01', 'found DHPP with expiry');
  check(!!bord && bord.dateGiven === '2025-01-15' && bord.expiry === '2026-01-15', 'Bordetella dates exact');
  check((ex.pet?.breed ?? '').toLowerCase().includes('golden'), 'breed extracted');
  check(ex.pet?.birthday === CERT.dob, 'birthday extracted');
  check(ex.pet?.microchip === CERT.microchip, 'microchip extracted');
  check((ex.vet?.name ?? '').includes('Chen'), 'vet name extracted');

  // -- commit: one upload becomes three records + profile fill --
  console.log('\ncommit (multi-record + profile):');
  const records = CERT.vaccines.map((v) => ({
    label: v.name,
    given: v.given,
    expiry: v.expiry,
    remindersEnabled: true,
  }));
  const com1 = await api(token, 'POST', `/pets/${petId}/docs/commit`, {
    uploadId: pre1.body.uploadId,
    records,
    profile: { breed: CERT.breed, dob: CERT.dob, vetName: `${CERT.vet} — ${CERT.clinic}`, vetPhone: CERT.phone },
  });
  check(com1.status === 200 && com1.body.docs?.length === 3, 'commit created 3 records');

  const docs1 = await api(token, 'GET', `/pets/${petId}/docs`);
  check(docs1.body.docs.length === 3, 'GET docs shows 3 records');
  const rabiesDoc = docs1.body.docs.find((d) => d.label === 'Rabies');
  check(
    rabiesDoc?.expiry === '2028-07-01' && rabiesDoc?.given === '2025-07-01',
    'record meta carries expiry AND given date',
  );
  check(docs1.body.docs.every((d) => d.filename === 'multi-cert.pdf'), 'all records share the uploaded file');

  const pets1 = await api(token, 'GET', '/pets');
  const scanPet = pets1.body.pets.find((p) => p.id === petId);
  check(scanPet?.breed === CERT.breed && scanPet?.dob === CERT.dob, 'profile fields merged into pet');
  check(scanPet?.vetPhone === CERT.phone, 'vet phone merged into pet');

  // -- PATCH keeps the given date (regression: meta rebuild used to drop it) --
  console.log('\nedit keeps given date:');
  const patch = await api(token, 'PATCH', `/pets/${petId}/docs/${rabiesDoc.id}`, {
    label: 'Rabies (3-year)',
    expiry: '2028-07-01',
  });
  check(patch.status === 200, 'rename record');
  const docs2 = await api(token, 'GET', `/pets/${petId}/docs`);
  const renamed = docs2.body.docs.find((d) => d.id === rabiesDoc.id);
  check(renamed?.label === 'Rabies (3-year)' && renamed?.given === '2025-07-01', 'given survives rename');

  // -- edge: temp object is consumed by commit --
  console.log('\nedge cases:');
  const reuse = await api(token, 'POST', `/pets/${petId}/docs/commit`, {
    uploadId: pre1.body.uploadId,
    records: [{ label: 'x' }],
  });
  check(reuse.status === 404, 'reusing a committed uploadId -> 404');

  const probe = await api(token, 'POST', `/pets/${petId}/docs/analyze`, {
    uploadId: '00000000-0000-4000-8000-000000000000',
  });
  check(probe.status === 404, 'unknown uploadId -> 404');

  // -- edge: unsupported file type does NOT consume a scan --
  const preTxt = await api(token, 'POST', `/pets/${petId}/docs/analyze-upload-url`, {
    filename: 'notes.txt',
    contentType: 'text/plain',
  });
  await s3Post(preTxt.body, Buffer.from('just some notes'), 'text/plain');
  const anTxt = await api(token, 'POST', `/pets/${petId}/docs/analyze`, {
    uploadId: preTxt.body.uploadId,
  });
  check(anTxt.status === 415 && anTxt.body.error === 'UNSUPPORTED_TYPE_FOR_AI', 'txt file -> 415');

  // -- edge: non-vaccine document --
  const pre2 = await api(token, 'POST', `/pets/${petId}/docs/analyze-upload-url`, {
    filename: 'groceries.pdf',
    contentType: 'application/pdf',
  });
  await s3Post(pre2.body, makeNonVaccinePdf(), 'application/pdf');
  const an2 = await api(token, 'POST', `/pets/${petId}/docs/analyze`, {
    uploadId: pre2.body.uploadId,
  });
  check(an2.status === 200, 'non-vaccine PDF still analyzes');
  check(
    an2.body?.extraction?.isPetHealthDocument === false &&
      (an2.body?.extraction?.vaccines ?? []).length === 0,
    'grocery list -> not a pet health document, no vaccines',
  );

  // -- edge: doc cap (3 committed + 2 would exceed the 4-doc free cap) --
  const over = await api(token, 'POST', `/pets/${petId}/docs/commit`, {
    uploadId: pre2.body.uploadId,
    records: [{ label: 'One' }, { label: 'Two' }],
  });
  check(over.status === 409, 'commit past the doc cap -> 409');

  // -- edge: strict date validation (Feb 30 parses in V8, must still reject) --
  const badDate = await api(token, 'POST', `/pets/${petId}/docs/commit`, {
    uploadId: pre2.body.uploadId,
    records: [{ label: 'Bad', expiry: '2027-02-30' }],
  });
  check(badDate.status === 400, 'Feb 30 expiry -> 400');
  const badGiven = await api(token, 'POST', `/pets/${petId}/docs/commit`, {
    uploadId: pre2.body.uploadId,
    records: [{ label: 'Bad', given: 'not-a-date' }],
  });
  check(badGiven.status === 400, 'malformed given date -> 400');

  // -- fill the cap, then the presign route refuses --
  const fill = await api(token, 'POST', `/pets/${petId}/docs/commit`, {
    uploadId: pre2.body.uploadId,
    records: [{ label: 'Grocery list, honorary vaccine' }],
  });
  check(fill.status === 200, 'manual single-record commit (the fallback path)');
  const atCap = await api(token, 'POST', `/pets/${petId}/docs/analyze-upload-url`, {
    filename: 'x.pdf',
    contentType: 'application/pdf',
  });
  check(atCap.status === 409, 'analyze-upload-url at doc cap -> 409');

  // -- edge: daily scan quota --
  s3PutJson(`users/${sub}/ai-usage.json`, {
    date: new Date().toISOString().slice(0, 10),
    count: 999,
  });
  cleanup.wroteQuota = true;
  // Need a pet with a free slot to get an upload in: use a second pet.
  const pet2Res = await api(token, 'POST', '/pets', { name: 'QuotaPet', species: 'cat' });
  const pet2 = pet2Res.body.pet.id;
  cleanup.petIds.push(pet2);
  const preQ = await api(token, 'POST', `/pets/${pet2}/docs/analyze-upload-url`, {
    filename: 'q.pdf',
    contentType: 'application/pdf',
  });
  await s3Post(preQ.body, certPdf, 'application/pdf');
  const anQ = await api(token, 'POST', `/pets/${pet2}/docs/analyze`, { uploadId: preQ.body.uploadId });
  check(anQ.status === 429 && anQ.body.error === 'AI_QUOTA_EXCEEDED', 'exhausted quota -> 429');
  s3Rm(`users/${sub}/ai-usage.json`);
  cleanup.wroteQuota = false;

  // -- edge: read-only (over-cap) pet refuses the whole flow --
  s3PutJson(`users/${sub}/plan.json`, { plan: 'free', limits: { maxPets: 1 } });
  cleanup.wrotePlan = true;
  // ScanPet is older -> stays active; QuotaPet (newer) goes read-only.
  const preRO = await api(token, 'POST', `/pets/${pet2}/docs/analyze-upload-url`, {
    filename: 'ro.pdf',
    contentType: 'application/pdf',
  });
  check(
    preRO.status === 403 && /read-only/i.test(preRO.body.error ?? ''),
    'read-only pet -> 403 on analyze-upload-url',
  );
  s3Rm(`users/${sub}/plan.json`);
  cleanup.wrotePlan = false;
} finally {
  // -- cleanup: pets (cascades docs), tmp prefix, any override files --
  console.log('\ncleanup:');
  for (const id of cleanup.petIds) {
    await api(token, 'DELETE', `/pets/${id}`).catch(() => {});
  }
  if (cleanup.wroteQuota) s3Rm(`users/${sub}/ai-usage.json`);
  if (cleanup.wrotePlan) s3Rm(`users/${sub}/plan.json`);
  s3Rm(`tmp/${sub}/`, true);
  console.log('  🧹 pets deleted, tmp/ prefix cleared, override files removed');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
