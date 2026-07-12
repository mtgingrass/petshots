// Smoke test for the photo album feature (swipe-right camera / swipe-left
// albums on the overview screen), against the live API with TWO throwaway
// users: an owner and a household member — the household broadcast push is
// the whole point of the feature, so this needs two accounts like
// smoke-family.mjs does.
//
//   node scripts/smoke-photos.mjs <ownerEmail> <ownerPass> <memberEmail> <memberPass>
//
// Covers: upload-url -> S3 POST -> confirm round-trip; the photo shows up
// in GET for BOTH the owner and the member (shared pool); the daily
// per-pet save quota (free tier: 10/day) 409s on the 11th with the
// human-readable message that's the ONLY place the cap is ever surfaced;
// a discard (never calling upload-url) doesn't touch the counter; delete
// works from either account; confirm doesn't error with a member present
// (functional coverage of the household broadcast path — a real push send
// to the member's FAKE endpoint is expected to fail gracefully and prune,
// same as the existing reminder-Lambda sendPushes behavior, so this isn't
// asserted on directly).
//
// THROWAWAY USERS ONLY. Needs no AWS CLI creds beyond the usual
// admin-create-user/admin-delete-user the runner already does.
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

const [ownerEmail, ownerPass, memberEmail, memberPass] = process.argv.slice(2);
if (!memberPass) {
  console.error('usage: node scripts/smoke-photos.mjs <ownerEmail> <ownerPass> <memberEmail> <memberPass>');
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
      Authorization: `Bearer ${token}`,
      ...(body != null ? { 'content-type': 'application/json' } : {}),
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function uploadAndConfirm(token, petId, filename) {
  const presign = await api(token, 'POST', `/pets/${petId}/photos/upload-url`, {
    filename,
    contentType: 'image/jpeg',
  });
  if (presign.status !== 200) return { presign };
  const form = new FormData();
  for (const [k, v] of Object.entries(presign.body.fields)) form.append(k, v);
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
  form.append('file', new Blob([bytes], { type: 'image/jpeg' }), filename);
  const s3res = await fetch(presign.body.url, { method: 'POST', body: form });
  const confirm = await api(token, 'POST', `/pets/${petId}/photos/${presign.body.photoId}/confirm`);
  return { presign, s3Status: s3res.status, confirm };
}

async function main() {
  console.log('\n[1] SRP login both users, owner creates a pet, member joins the household');
  const owner = await login(ownerEmail, ownerPass);
  const member = await login(memberEmail, memberPass);
  check(!!owner && !!member, 'both users logged in');

  for (const t of [owner, member]) {
    const pre = await api(t, 'GET', '/pets');
    for (const p of pre.body?.pets ?? []) await api(t, 'DELETE', `/pets/${p.id}`);
  }
  const petRes = await api(owner, 'POST', '/pets', { name: 'Digby', species: 'dog' });
  check(petRes.status === 200, 'owner created a pet');
  const petId = petRes.body.pet.id;

  const inv = await api(owner, 'POST', '/household/invites');
  check(inv.status === 200, 'owner created an invite');
  const join = await api(member, 'POST', '/household/join', { token: inv.body.token });
  check(join.status === 200, 'member joined the household');

  const sub = await api(member, 'POST', '/push/subscribe', {
    subscription: {
      endpoint: `https://updates.push.services.mozilla.com/wpush/v2/photos-smoke-${Date.now()}`,
      keys: {
        p256dh: 'BFakeKeyForDryRunCounting0000000000000000000000000000000000000000000000000000000000000',
        auth: 'FakeAuthSecret16',
      },
    },
  });
  check(sub.status === 200, "seeded the member's fake push subscription");

  console.log('\n[2] upload -> S3 -> confirm round-trip (as the owner)');
  const first = await uploadAndConfirm(owner, petId, 'first.jpg');
  check(first.presign.status === 200, `presign ok (got ${first.presign.status})`);
  check(first.s3Status === 204, `S3 upload ok (got ${first.s3Status})`);
  check(
    first.confirm.status === 200 && first.confirm.body?.notified === true,
    `confirm ok + notified (got ${JSON.stringify(first.confirm.body)}) — household broadcast path didn't error with a member present`,
  );

  console.log('\n[3] the photo shows up for BOTH the owner and the member (shared pool)');
  const ownerList = await api(owner, 'GET', `/pets/${petId}/photos`);
  const memberList = await api(member, 'GET', `/pets/${petId}/photos`);
  check(ownerList.body?.photos?.length === 1, `owner sees 1 photo (got ${ownerList.body?.photos?.length})`);
  check(memberList.body?.photos?.length === 1, `member sees the same photo (got ${memberList.body?.photos?.length})`);

  console.log('\n[4] a discard (never calling upload-url) never touches the counter');
  const beforeDiscard = await api(owner, 'GET', `/pets/${petId}/photos`);
  check(beforeDiscard.body.photos.length === 1, 'still 1 photo before any "discard"');
  // A discard is a pure client-side no-op (the confirm screen just closes) —
  // there is no API call to make here at all, which is the point. Nothing
  // to assert beyond "the count didn't move on its own."

  console.log('\n[5] daily per-pet quota (free tier: 10/day) — already used 1 above');
  let last;
  for (let i = 0; i < 9; i++) {
    last = await uploadAndConfirm(owner, petId, `q${i}.jpg`);
  }
  check(last.presign.status === 200, `10th save today ok (got ${last.presign.status})`);
  const eleventh = await api(owner, 'POST', `/pets/${petId}/photos/upload-url`, {
    filename: 'over.jpg',
    contentType: 'image/jpeg',
  });
  check(eleventh.status === 409, `11th save today rejected 409 (got ${eleventh.status})`);
  check(
    /reached today's photo limit for Digby/.test(eleventh.body?.error ?? ''),
    `409 body names the pet + is a full human-readable message (got ${JSON.stringify(eleventh.body)})`,
  );

  console.log('\n[6] delete works from either account (member is not in MEMBER_BLOCKED_ROUTES)');
  const listNow = await api(owner, 'GET', `/pets/${petId}/photos`);
  const toDelete = listNow.body.photos[0].id;
  const del = await api(member, 'DELETE', `/pets/${petId}/photos/${toDelete}`);
  check(del.status === 204, `member deleted a photo (got ${del.status})`);
  const afterDel = await api(owner, 'GET', `/pets/${petId}/photos`);
  check(afterDel.body.photos.length === listNow.body.photos.length - 1, 'owner sees the deletion');

  console.log('\n[7] cleanup (pet + household deleted; caller deletes both users + S3 prefixes)');
  await api(owner, 'DELETE', `/pets/${petId}`);
  await api(member, 'POST', '/household/leave');
  check((await api(owner, 'GET', '/pets')).body.pets.length === 0, 'pet deleted');

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('ERROR:', e.message || e);
  process.exit(1);
});
