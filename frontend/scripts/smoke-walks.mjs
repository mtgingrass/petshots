// Smoke test for walk tracking + achievements, against the live API with a
// single throwaway user — a walk can cover multiple pets (e.g. walking two
// dogs together), so this creates two pets to exercise that.
//
//   node scripts/smoke-walks.mjs <email> <password>
//
// Covers: POST /walks validates petIds against the caller's own pool and
// startedAt<=endedAt; a saved walk auto-checks the Daily "Walk" preset for
// EVERY pet on it; GET /achievements reflects the walk (count + miles,
// rounded from the raw meters sent); DELETE /walks/{id} removes it and the
// achievement numbers drop back to zero. Badges: cats get no walk cards
// (care-streak + photos only); walk/mile badges earn from the first walk;
// a perfect Daily day earns care-streak badges; earned badges PERSIST after
// the walk that earned them is deleted (trophy semantics, badges.json).
//
// THROWAWAY USER ONLY.
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
if (!password) {
  console.error('usage: node scripts/smoke-walks.mjs <email> <password>');
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

function login() {
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

async function main() {
  console.log('\n[1] SRP login + seed a dog and a cat (free tier caps at 2 pets)');
  const token = await login();
  check(!!token, 'got access token');
  const pre = await api(token, 'GET', '/pets');
  for (const p of pre.body?.pets ?? []) await api(token, 'DELETE', `/pets/${p.id}`);
  const rex = (await api(token, 'POST', '/pets', { name: 'Rex', species: 'dog' })).body.pet;
  const cat = (await api(token, 'POST', '/pets', { name: 'Whiskers', species: 'cat' })).body.pet;
  check(!!rex && !!cat, 'dog + cat created');

  console.log('\n[1b] card layout by species + everything starts locked');
  const ach0 = await api(token, 'GET', '/achievements');
  const rexCards0 = ach0.body.pets.find((p) => p.petId === rex.id)?.cards ?? [];
  const catCards0 = ach0.body.pets.find((p) => p.petId === cat.id)?.cards ?? [];
  check(
    rexCards0.map((c) => c.id).join(',') === 'walks-week,distance-week,photo-days-week,care-streak',
    `dog gets 4 cards incl walks (got ${rexCards0.map((c) => c.id).join(',')})`,
  );
  check(
    catCards0.map((c) => c.id).join(',') === 'care-streak,photo-days-week',
    `cat gets NO walk cards (got ${catCards0.map((c) => c.id).join(',')})`,
  );
  check(
    rexCards0.every((c) => Array.isArray(c.badges) && c.badges.length === 4),
    'every card carries a 4-badge ladder',
  );
  check(
    rexCards0.flatMap((c) => c.badges).every((b) => b.earnedAt === null),
    'fresh pet: all badges locked',
  );
  const trends0 = await api(token, 'GET', '/trends?view=week&offset=0');
  const catTrend0 = trends0.body?.pets?.find((p) => p.petId === cat.id);
  const rexTrend0 = trends0.body?.pets?.find((p) => p.petId === rex.id);
  check(catTrend0?.walks === null, `trends: cat walks is null (got ${JSON.stringify(catTrend0?.walks)})`);
  check(
    rexTrend0?.walks?.count === 0 && rexTrend0?.walks?.miles === 0,
    `trends: dog with no walks shows 0/0 (got ${JSON.stringify(rexTrend0?.walks)})`,
  );

  // Swap the cat for a second dog — the multi-pet walk sections below need
  // two dogs, and the free tier allows only 2 pets at once.
  await api(token, 'DELETE', `/pets/${cat.id}`);
  const fido = (await api(token, 'POST', '/pets', { name: 'Fido', species: 'dog' })).body.pet;
  check(!!fido, 'cat swapped for second dog');

  // Rex gets a logged weight (30 kg) so his walks get a kcal estimate; Fido
  // deliberately gets none — no weight, no estimate.
  const wgt = await api(token, 'POST', `/pets/${rex.id}/weights`, {
    date: new Date().toISOString().slice(0, 10),
    weight: 30,
    unit: 'kg',
  });
  check(wgt.status === 200, `Rex weight logged (got ${wgt.status})`);

  console.log('\n[2] validation: empty petIds, endedAt before startedAt, foreign petId');
  const now = new Date();
  const noPets = await api(token, 'POST', '/walks', {
    petIds: [],
    startedAt: now.toISOString(),
    endedAt: now.toISOString(),
    distanceMeters: 100,
  });
  check(noPets.status === 400, `empty petIds rejected 400 (got ${noPets.status})`);

  const backwards = await api(token, 'POST', '/walks', {
    petIds: [rex.id],
    startedAt: now.toISOString(),
    endedAt: new Date(now.getTime() - 60_000).toISOString(),
    distanceMeters: 100,
  });
  check(backwards.status === 400, `endedAt before startedAt rejected 400 (got ${backwards.status})`);

  const foreignOnly = await api(token, 'POST', '/walks', {
    petIds: ['00000000-0000-4000-8000-000000000000'],
    startedAt: now.toISOString(),
    endedAt: now.toISOString(),
    distanceMeters: 100,
  });
  check(foreignOnly.status === 404, `walk with only an unknown petId rejected 404 (got ${foreignOnly.status})`);

  console.log('\n[3] a real 2.5-mile, two-pet walk');
  const startedAt = new Date(now.getTime() - 20 * 60_000).toISOString();
  const endedAt = now.toISOString();
  const distanceMeters = 1609.344 * 2.5;
  const walk = await api(token, 'POST', '/walks', {
    petIds: [rex.id, fido.id, '00000000-0000-4000-8000-000000000000'], // one bogus id mixed in
    startedAt,
    endedAt,
    distanceMeters,
  });
  check(walk.status === 200, `walk saved (got ${walk.status})`);
  check(
    walk.body?.walk?.petIds?.length === 2 && walk.body.walk.petIds.includes(rex.id) && walk.body.walk.petIds.includes(fido.id),
    'bogus petId silently dropped, both real pets kept',
  );
  check(walk.body?.walk?.by === email, `walk attributed to the caller (got ${walk.body?.walk?.by})`);
  // kcal estimate: 0.8 kcal/kg/km × 30 kg × (2.5 mi = 4.02336 km) = 96.56 → 97
  check(
    walk.body?.kcalByPet?.[rex.id] === 97,
    `save response: Rex ≈97 kcal (got ${walk.body?.kcalByPet?.[rex.id]})`,
  );
  check(
    walk.body?.kcalByPet?.[fido.id] === undefined,
    'save response: no estimate for weightless Fido',
  );

  const list = await api(token, 'GET', '/walks');
  check(list.body.walks.length === 1, 'GET /walks lists it');
  check(list.body.walks[0].by === email, 'attribution survives the round-trip');
  check(list.body.walks[0].kcalByPet?.[rex.id] === 97, 'GET /walks carries the same kcal estimate');

  console.log('\n[3b] trends week view picks up the walk; solo account has no leaderboard');
  const trends = await api(token, 'GET', '/trends?view=week&offset=0');
  const rexTrend = trends.body?.pets?.find((p) => p.petId === rex.id);
  const fidoTrend = trends.body?.pets?.find((p) => p.petId === fido.id);
  check(
    rexTrend?.walks?.count === 1 && rexTrend?.walks?.miles === 2.5,
    `trends shows 1 walk / 2.5 mi for Rex (got ${JSON.stringify(rexTrend?.walks)})`,
  );
  check(rexTrend?.walks?.kcal === 97, `trends week kcal ≈97 for Rex (got ${rexTrend?.walks?.kcal})`);
  check(fidoTrend?.walks?.kcal === null, `trends week kcal null for weightless Fido (got ${fidoTrend?.walks?.kcal})`);

  console.log('\n[4] ending the walk auto-checked the Daily "Walk" preset for both pets');
  const today = endedAt.slice(0, 10);
  const dailyRex = await api(token, 'GET', `/pets/${rex.id}/daily?date=${today}`);
  const dailyFido = await api(token, 'GET', `/pets/${fido.id}/daily?date=${today}`);
  check(!!dailyRex.body?.checks?.['preset-walk'], "Rex's Daily Walk item checked");
  check(!!dailyFido.body?.checks?.['preset-walk'], "Fido's Daily Walk item checked");

  const achForBoard = await api(token, 'GET', '/achievements');
  check(achForBoard.body.leaderboard === null, 'solo account: leaderboard is null');

  console.log('\n[5] GET /achievements reflects the walk + first badges earn');
  // Complete Rex's Daily list for today (walk was auto-checked by [3/4];
  // breakfast + dinner make the day perfect -> care-streak badge territory).
  await api(token, 'POST', `/pets/${rex.id}/daily/check`, { date: today, itemId: 'preset-breakfast' });
  await api(token, 'POST', `/pets/${rex.id}/daily/check`, { date: today, itemId: 'preset-dinner' });
  const ach = await api(token, 'GET', '/achievements');
  const rexCards = ach.body.pets.find((p) => p.petId === rex.id)?.cards ?? [];
  const walksCard = rexCards.find((c) => c.id === 'walks-week');
  const distCard = rexCards.find((c) => c.id === 'distance-week');
  const careCard = rexCards.find((c) => c.id === 'care-streak');
  check(walksCard?.value === '1', `walks-week = 1 (got ${walksCard?.value})`);
  check(distCard?.value === '2.5', `distance-week = 2.5 miles (got ${distCard?.value})`);
  const badge = (card, id) => card?.badges.find((b) => b.id === id);
  check(!!badge(walksCard, 'walk-first')?.earnedAt, 'First Steps (first walk) earned');
  check(badge(walksCard, 'walk-week-count')?.earnedAt === null, 'Hat Trick (3/week) still locked after 1 walk');
  check(!!badge(distCard, 'miles-first')?.earnedAt, 'First Mile earned (2.5 mi > 1)');
  check(badge(distCard, 'miles-club')?.earnedAt === null, '10-Mile Club still locked');
  check(careCard?.value === '1', `care-streak = 1 after a perfect day (got ${careCard?.value})`);
  check(!!badge(careCard, 'care-day')?.earnedAt, 'Perfect Day badge earned');
  check(badge(careCard, 'care-streak-short')?.earnedAt === null, 'Three in a Row still locked');
  const fidoCare = ach.body.pets
    .find((p) => p.petId === fido.id)
    ?.cards.find((c) => c.id === 'care-streak');
  check(fidoCare?.value === '0', `Fido (meals unchecked) has no care streak (got ${fidoCare?.value})`);

  console.log('\n[6] DELETE /walks/{id}: numbers drop to zero but trophies persist');
  const del = await api(token, 'DELETE', `/walks/${walk.body.walk.id}`);
  check(del.status === 204, `delete ok (got ${del.status})`);
  const ach2 = await api(token, 'GET', '/achievements');
  const rexCards2 = ach2.body.pets.find((p) => p.petId === rex.id)?.cards ?? [];
  check(rexCards2.find((c) => c.id === 'walks-week')?.value === '0', 'walks-week back to 0');
  check(rexCards2.find((c) => c.id === 'distance-week')?.value === '0.0', 'distance-week back to 0.0');
  check(
    !!badge(rexCards2.find((c) => c.id === 'walks-week'), 'walk-first')?.earnedAt,
    'First Steps STILL earned after the walk was deleted (badges never un-earn)',
  );
  check(
    !!badge(rexCards2.find((c) => c.id === 'distance-week'), 'miles-first')?.earnedAt,
    'First Mile STILL earned too',
  );

  console.log('\n[7] cleanup');
  await api(token, 'DELETE', `/pets/${rex.id}`);
  await api(token, 'DELETE', `/pets/${fido.id}`);
  check((await api(token, 'GET', '/pets')).body.pets.length === 0, 'pets deleted');

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('ERROR:', e.message || e);
  process.exit(1);
});
