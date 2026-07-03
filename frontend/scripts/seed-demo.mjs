// Seed a throwaway account with demo pets/docs for visual verification.
// Usage: node scripts/seed-demo.mjs <email> <password>
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
      onFailure: reject,
    });
  });
}

const PDF = Buffer.from('%PDF-1.4\n% demo\n', 'utf8');
// 4x4 orange PNG so the avatar/lightbox shows something visible.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFElEQVR42mP8z8Dwn4GBgYGJgQIAACQABv/RaZcAAAAASUVORK5CYII=',
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

async function postPolicy(presign, bytes, type) {
  const form = new FormData();
  for (const [k, v] of Object.entries(presign.fields)) form.append(k, v);
  form.append('file', new Blob([bytes], { type }));
  return (await fetch(presign.url, { method: 'POST', body: form })).status;
}

async function uploadDoc(token, petId, label, expiry) {
  const presign = await api(token, 'POST', `/pets/${petId}/docs/upload-url`, {
    filename: `${label.replace(/\s/g, '_')}.pdf`,
    label,
    expiry,
    contentType: 'application/pdf',
  });
  await postPolicy(presign.body, PDF, 'application/pdf');
}

const token = await login();

// idempotent: wipe prior pets
const pre = await api(token, 'GET', '/pets');
for (const p of pre.body?.pets ?? []) await api(token, 'DELETE', `/pets/${p.id}`);

// Pet 1: dog with photo, overdue + current docs
let r = await api(token, 'POST', '/pets', { name: 'Ollie', species: 'dog' });
const dog = r.body.pet.id;
const av = await api(token, 'POST', `/pets/${dog}/avatar/upload-url`, { contentType: 'image/png' });
await postPolicy(av.body, PNG, 'image/png');
await api(token, 'PUT', `/pets/${dog}`, {
  name: 'Ollie', species: 'dog', breed: 'Golden Retriever', allergies: 'Chicken',
});
await uploadDoc(token, dog, 'Rabies', '2026-05-01'); // overdue
await uploadDoc(token, dog, 'DHPP', '2027-06-15'); // current

// Pet 2: cat, no photo, due-soon doc
r = await api(token, 'POST', '/pets', { name: 'Miso', species: 'cat' });
await uploadDoc(token, r.body.pet.id, 'Rabies', '2026-07-20'); // due soon

console.log('seeded: Ollie (dog, photo, overdue+current), Miso (cat, due-soon)');
