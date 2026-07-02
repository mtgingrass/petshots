// One-time migration to the multi-pet S3 layout (session 10, 2026-07-02).
//
//   users/{sub}/pet.json        -> users/{sub}/pets/{petId}/pet.json
//   users/{sub}/docs/...        -> users/{sub}/pets/{petId}/docs/...
//
// Copies server-side, verifies the copy landed, then deletes the legacy keys.
// Idempotent: users without a legacy pet.json are skipped.
//
//   node scripts/migrate-multipet.mjs [--dry-run]
import {
  S3Client,
  ListObjectsV2Command,
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';

const BUCKET = 'petshots-uploads';
const DRY = process.argv.includes('--dry-run');
const s3 = new S3Client({});

const copySource = (key) => `${BUCKET}/${encodeURIComponent(key).replace(/%2F/g, '/')}`;

async function listAll(prefix) {
  const keys = [];
  let token;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }),
    );
    keys.push(...(res.Contents ?? []).map((it) => it.Key));
    token = res.NextContinuationToken;
  } while (token);
  return keys;
}

const all = await listAll('users/');
const subs = [...new Set(all.map((k) => k.split('/')[1]))];

for (const sub of subs) {
  const legacyPet = `users/${sub}/pet.json`;
  if (!all.includes(legacyPet)) {
    console.log(`skip ${sub}: no legacy pet.json`);
    continue;
  }
  const petId = randomUUID();
  const moves = [[legacyPet, `users/${sub}/pets/${petId}/pet.json`]];
  for (const k of all.filter((k) => k.startsWith(`users/${sub}/docs/`))) {
    moves.push([k, `users/${sub}/pets/${petId}/docs/${k.slice(`users/${sub}/docs/`.length)}`]);
  }

  console.log(`\n${sub} -> pet ${petId} (${moves.length} objects)`);
  for (const [from, to] of moves) {
    console.log(`  ${DRY ? '[dry] ' : ''}${from}\n    -> ${to}`);
    if (DRY) continue;
    await s3.send(new CopyObjectCommand({ Bucket: BUCKET, Key: to, CopySource: copySource(from) }));
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: to })); // throws if the copy didn't land
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: from }));
  }
}
console.log(DRY ? '\ndry run complete - nothing changed' : '\nmigration complete');
