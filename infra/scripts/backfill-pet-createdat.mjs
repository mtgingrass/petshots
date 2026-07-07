// One-time backfill: stamp createdAt on every pet.json that lacks it, using
// the earliest LastModified of any object under the pet's prefix (oldest doc,
// avatar, or the pet.json itself) as the creation-time proxy. Pets created
// after 2026-07-06 are stamped at creation by the API and are skipped here.
//
//   node scripts/backfill-pet-createdat.mjs [--dry-run]
//
// Why it matters: the active-pets downgrade rule ranks pets oldest-first by
// createdAt; unstamped pets tiebreak on pet id, which is random.
import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const BUCKET = process.env.UPLOADS_BUCKET ?? 'petshots-uploads';
const dryRun = process.argv.includes('--dry-run');
const s3 = new S3Client({});

async function listAll(prefix) {
  const out = [];
  let token;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }),
    );
    out.push(...(res.Contents ?? []));
    token = res.NextContinuationToken;
  } while (token);
  return out;
}

const objects = await listAll('users/');
const petJsons = objects.filter((o) => /^users\/[^/]+\/pets\/[^/]+\/pet\.json$/.test(o.Key));
console.log(`${petJsons.length} pets found${dryRun ? ' (dry run)' : ''}`);

let stamped = 0;
for (const obj of petJsons) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: obj.Key }));
  const pet = JSON.parse(await res.Body.transformToString());
  if (pet.createdAt) {
    console.log(`  skip  ${pet.name} — already stamped (${pet.createdAt})`);
    continue;
  }
  const petPrefix = obj.Key.slice(0, -'pet.json'.length);
  const earliest = objects
    .filter((o) => o.Key.startsWith(petPrefix))
    .reduce((min, o) => (o.LastModified < min ? o.LastModified : min), obj.LastModified);
  const createdAt = earliest.toISOString();
  console.log(`  stamp ${pet.name} <- ${createdAt} (${obj.Key})`);
  if (!dryRun) {
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: obj.Key,
        Body: JSON.stringify({ ...pet, createdAt }),
        ContentType: 'application/json',
      }),
    );
  }
  stamped++;
}
console.log(`${dryRun ? 'would stamp' : 'stamped'} ${stamped} pets`);
