import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { randomUUID } from 'node:crypto';
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';

// One Lambda fronts every route (a tiny router on event.routeKey). Fewer moving
// parts than a function per route, and IAM is identical across them anyway.
//
// requestChecksumCalculation: 'WHEN_REQUIRED' - the AWS SDK now adds a CRC32
// checksum to PutObject by default, which makes presigned PUT URLs require a
// checksum header the browser can't compute at sign time -> S3 returns 403.
// Opting out restores plain SigV4 presigned uploads.
const s3 = new S3Client({
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
const BUCKET = process.env.UPLOADS_BUCKET!;
const MAX_PETS = Number(process.env.MAX_PETS ?? '3');
const MAX_DOCS = Number(process.env.MAX_DOCS ?? '4');
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES ?? String(10 * 1024 * 1024));
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// Per-doc metadata lives JSON-encoded in one key segment (no DB, no x-amz-*
// headers). Adding fields later just extends this object; old keys that hold a
// plain label string still decode (fallback below).
interface DocMeta {
  label: string;
  expiry?: string; // YYYY-MM-DD
}
const encodeMeta = (m: DocMeta): string => encodeURIComponent(JSON.stringify(m));
function decodeMeta(seg: string | undefined): DocMeta {
  const raw = decodeURIComponent(seg ?? '');
  try {
    const m = JSON.parse(raw);
    if (m && typeof m === 'object') {
      return { label: String(m.label ?? ''), expiry: m.expiry ? String(m.expiry) : undefined };
    }
  } catch {
    /* legacy key: the segment is just the label, no JSON */
  }
  return { label: raw };
}
// Accept only a strict YYYY-MM-DD date; ignore anything else.
const cleanExpiry = (v: unknown): string | undefined =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;

const isUuid = (v: string | undefined): v is string =>
  !!v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

const str = (v: unknown, max: number) => String(v ?? '').slice(0, max) || undefined;
const cleanPet = (input: Record<string, unknown>) => ({
  name:              String(input.name ?? '').slice(0, 100),
  species:           String(input.species ?? '').slice(0, 50),
  breed:             str(input.breed, 100),
  dob:               str(input.dob, 10),      // YYYY-MM-DD
  weight:            str(input.weight, 50),
  allergies:         str(input.allergies, 500),
  behavior:          str(input.behavior, 500),
  vetName:           str(input.vetName, 150),
  vetPhone:          str(input.vetPhone, 50),
  emergencyContact:  str(input.emergencyContact, 200),
  microchip:         str(input.microchip, 50),
  fixed:             input.fixed === true ? true : undefined,
  notes:             str(input.notes, 1000),
});

async function readJson<T>(key: string): Promise<T | null> {
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return JSON.parse(await obj.Body!.transformToString()) as T;
  } catch (e) {
    if ((e as { name?: string }).name === 'NoSuchKey') return null;
    throw e;
  }
}

// ---- public passport (no JWT required) ----
async function handlePublicPassport(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const token = event.pathParameters?.token;
  if (!token || !isUuid(token)) return json(400, { error: 'invalid token' });

  const passportRecord = await readJson<{ userId: string; petId: string; expiry?: string }>(
    `passports/${token}.json`,
  );
  if (!passportRecord) return json(404, { error: 'passport not found' });

  if (passportRecord.expiry) {
    const exp = new Date(`${passportRecord.expiry}T00:00:00`);
    exp.setDate(exp.getDate() + 1); // expired after end-of-day on the expiry date
    if (exp < new Date()) return json(410, { error: 'passport has expired' });
  }

  const { userId, petId } = passportRecord;
  const petKey = `users/${userId}/pets/${petId}/pet.json`;
  const pet = await readJson<Record<string, unknown>>(petKey);
  if (!pet) return json(404, { error: 'pet not found' });

  // Presign avatar if it exists.
  const avatarKey = `users/${userId}/pets/${petId}/avatar`;
  let avatarUrl: string | undefined;
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: avatarKey }));
    avatarUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: BUCKET, Key: avatarKey }),
      { expiresIn: 3600 },
    );
  } catch { /* no avatar */ }

  // List and presign all current docs.
  const docsPrefix = `users/${userId}/pets/${petId}/docs/`;
  const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: docsPrefix }));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const statusRank = (expiry?: string) => {
    if (!expiry) return 3;
    const d = new Date(`${expiry}T00:00:00`);
    const days = Math.round((d.getTime() - today.getTime()) / 86_400_000);
    return days < 0 ? 0 : days <= 30 ? 1 : 2;
  };
  const docs = await Promise.all(
    (list.Contents ?? []).filter((it) => !it.Key!.includes('/_archived/')).map(async (it) => {
      const key = it.Key!;
      const parts = key.split('/');
      const meta = decodeMeta(parts[6]);
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: BUCKET, Key: key }),
        { expiresIn: 3600 },
      );
      return { id: parts[5], label: meta.label, expiry: meta.expiry, filename: parts.slice(7).join('/'), url };
    }),
  );
  docs.sort((a, b) => statusRank(a.expiry) - statusRank(b.expiry) || (a.expiry ?? '').localeCompare(b.expiry ?? ''));

  return json(200, {
    pet: {
      name: pet.name, species: pet.species, breed: pet.breed, dob: pet.dob,
      weight: pet.weight, allergies: pet.allergies, behavior: pet.behavior,
      vetName: pet.vetName, vetPhone: pet.vetPhone, emergencyContact: pet.emergencyContact,
      microchip: pet.microchip, fixed: pet.fixed, notes: pet.notes, avatarUrl,
    },
    docs,
    expiresAt: passportRecord.expiry,
  });
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  // Public routes handled before auth check.
  if (event.routeKey === 'GET /passport/{token}') {
    try { return await handlePublicPassport(event); }
    catch (e) { console.error('passport error', e); return json(500, { error: 'internal error' }); }
  }

  // The Cognito JWT authorizer already verified the token; we just read claims.
  // sub is the stable per-user id we scope every S3 key to - a user can never
  // name a key outside their own prefix, so authz is the prefix itself.
  const sub = event.requestContext.authorizer?.jwt?.claims?.sub as string | undefined;
  if (!sub) return json(401, { error: 'unauthorized' });

  const petsPrefix = `users/${sub}/pets/`;

  // Pet-scoped routes carry {petId}; validate the shape before it touches a key.
  const petId = event.pathParameters?.petId;
  if (event.routeKey.includes('{petId}') && !isUuid(petId)) {
    return json(400, { error: 'invalid pet id' });
  }
  const petPrefix = `${petsPrefix}${petId}/`;
  const petKey = `${petPrefix}pet.json`;
  const avatarKey = `${petPrefix}avatar`;
  const docsPrefix = `${petPrefix}docs/`;

  try {
    switch (event.routeKey) {
      // ---- pets (each a small JSON object under its own prefix, no DB) ----
      case 'GET /pets': {
        // One LIST covers everything under pets/: pet.json keys identify the
        // pets, an `avatar` key marks a photo. Doc keys in the result are ignored.
        const list = await s3.send(
          new ListObjectsV2Command({ Bucket: BUCKET, Prefix: petsPrefix }),
        );
        const keys = (list.Contents ?? []).map((it) => it.Key!);
        const ids = keys
          .filter((k) => k.endsWith('/pet.json'))
          .map((k) => k.slice(petsPrefix.length).split('/')[0]);
        const pets = await Promise.all(
          ids.map(async (id) => {
            const pet = await readJson<{ name: string; species: string }>(
              `${petsPrefix}${id}/pet.json`,
            );
            const hasAvatar = keys.includes(`${petsPrefix}${id}/avatar`);
            const avatarUrl = hasAvatar
              ? await getSignedUrl(
                  s3,
                  new GetObjectCommand({ Bucket: BUCKET, Key: `${petsPrefix}${id}/avatar` }),
                  { expiresIn: 3600 },
                )
              : undefined;
            return { id, ...pet, avatarUrl };
          }),
        );
        // Stable order so the switcher doesn't shuffle between loads.
        pets.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
        return json(200, { pets });
      }

      case 'POST /pets': {
        const pet = cleanPet(JSON.parse(event.body ?? '{}'));
        if (!pet.name) return json(400, { error: 'name required' });
        const list = await s3.send(
          new ListObjectsV2Command({ Bucket: BUCKET, Prefix: petsPrefix }),
        );
        const count = (list.Contents ?? []).filter((it) => it.Key!.endsWith('/pet.json')).length;
        if (count >= MAX_PETS) {
          return json(409, { error: `limit of ${MAX_PETS} pets reached` });
        }
        const id = randomUUID();
        await s3.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: `${petsPrefix}${id}/pet.json`,
            Body: JSON.stringify(pet),
            ContentType: 'application/json',
          }),
        );
        return json(200, { pet: { id, ...pet } });
      }

      case 'PUT /pets/{petId}': {
        const pet = cleanPet(JSON.parse(event.body ?? '{}'));
        if (!pet.name) return json(400, { error: 'name required' });
        // Update only - creating here would sidestep the POST /pets limit.
        const existing = await readJson<Record<string, unknown>>(petKey);
        if (existing === null) return json(404, { error: 'not found' });
        // Passport fields are managed by separate endpoints; preserve them across profile edits.
        await s3.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: petKey,
            Body: JSON.stringify({
              ...pet,
              passportToken: existing.passportToken,
              passportExpiry: existing.passportExpiry,
            }),
            ContentType: 'application/json',
          }),
        );
        return json(200, { pet: { id: petId, ...pet } });
      }

      case 'DELETE /pets/{petId}': {
        // Removes the whole pet: pet.json, avatar, and every doc under it.
        const list = await s3.send(
          new ListObjectsV2Command({ Bucket: BUCKET, Prefix: petPrefix }),
        );
        await Promise.all(
          (list.Contents ?? []).map((it) =>
            s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: it.Key! })),
          ),
        );
        return { statusCode: 204 };
      }

      case 'POST /pets/{petId}/avatar/upload-url': {
        const input = JSON.parse(event.body ?? '{}');
        const contentType = String(input.contentType ?? '');
        if (!AVATAR_TYPES.includes(contentType)) {
          return json(400, { error: 'avatar must be a JPEG, PNG, or WebP image' });
        }
        if ((await readJson(petKey)) === null) return json(404, { error: 'not found' });
        // Fixed key: a new photo overwrites the old one, so there's nothing to
        // clean up and it never counts against the doc limit.
        const { url, fields } = await createPresignedPost(s3, {
          Bucket: BUCKET,
          Key: avatarKey,
          Conditions: [
            ['content-length-range', 1, MAX_AVATAR_BYTES],
            ['eq', '$Content-Type', contentType],
          ],
          Fields: { 'Content-Type': contentType },
          Expires: 300,
        });
        return json(200, { url, fields });
      }

      // ---- documents (per pet) ----
      case 'GET /pets/{petId}/docs': {
        const list = await s3.send(
          new ListObjectsV2Command({ Bucket: BUCKET, Prefix: docsPrefix }),
        );
        // Archived versions live under …/docs/{id}/_archived/… — exclude them
        // from the listing so only the current version of each record shows.
        const docs = await Promise.all(
          (list.Contents ?? []).filter((it) => !it.Key!.includes('/_archived/')).map(async (it) => {
            const key = it.Key!;
            // key shape: users/{sub}/pets/{petId}/docs/{docId}/{encodeMeta}/{filename}
            // Label lives in the key (not S3 metadata) so the browser upload carries
            // no x-amz-* headers and can't trip S3's "unsigned header" rejection.
            const parts = key.split('/');
            const meta = decodeMeta(parts[6]);
            // Short-lived GET URL so the browser opens the PDF straight from S3.
            const url = await getSignedUrl(
              s3,
              new GetObjectCommand({ Bucket: BUCKET, Key: key }),
              { expiresIn: 3600 },
            );
            return {
              id: parts[5],
              label: meta.label,
              expiry: meta.expiry,
              filename: parts.slice(7).join('/'),
              size: it.Size,
              uploadedAt: it.LastModified,
              url,
            };
          }),
        );
        return json(200, { docs });
      }

      case 'POST /pets/{petId}/docs/upload-url': {
        const input = JSON.parse(event.body ?? '{}');
        const filename = String(input.filename ?? '')
          .replace(/[^\w.\- ]/g, '_')
          .slice(0, 200);
        const label = String(input.label ?? '').slice(0, 200);
        const expiry = cleanExpiry(input.expiry);
        const contentType = String(input.contentType ?? 'application/octet-stream');
        if (!filename) return json(400, { error: 'filename required' });
        if ((await readJson(petKey)) === null) return json(404, { error: 'not found' });

        // Enforce the per-pet limit before handing out an upload URL.
        // Count only current (non-archived) docs so archived versions don't
        // inflate the count and block uploads.
        const list = await s3.send(
          new ListObjectsV2Command({ Bucket: BUCKET, Prefix: docsPrefix }),
        );
        const currentDocs = (list.Contents ?? []).filter(
          (it) => !it.Key!.includes('/_archived/'),
        );
        if (currentDocs.length >= MAX_DOCS) {
          return json(409, { error: `limit of ${MAX_DOCS} documents reached` });
        }

        const docId = randomUUID();
        // Label is encoded into the key (own path segment) rather than stored as
        // x-amz-meta-*. Fall back to the filename if no label was given (avoids an
        // empty key segment).
        const safeLabel = label || filename;
        const key = `${docsPrefix}${docId}/${encodeMeta({ label: safeLabel, expiry })}/${filename}`;

        // Presigned POST (not PUT): the signed policy carries conditions that S3
        // enforces itself. content-length-range rejects an oversized upload
        // server-side, so the browser's size check is no longer the only guard.
        // The client posts these `fields` (file LAST) as multipart/form-data.
        const { url, fields } = await createPresignedPost(s3, {
          Bucket: BUCKET,
          Key: key,
          Conditions: [
            ['content-length-range', 1, MAX_FILE_BYTES],
            ['eq', '$Content-Type', contentType],
          ],
          Fields: { 'Content-Type': contentType },
          Expires: 300,
        });
        return json(200, { url, fields, key });
      }

      case 'PATCH /pets/{petId}/docs/{id}': {
        // Edit = change label and/or expiry, which live in the key -> S3 has no
        // rename, so copy the object to a new key and delete the old one. docId +
        // filename are preserved; only the metadata path segment changes.
        const id = event.pathParameters?.id;
        if (!id) return json(400, { error: 'id required' });
        const input = JSON.parse(event.body ?? '{}');
        const newLabel = String(input.label ?? '').slice(0, 200);
        if (!newLabel) return json(400, { error: 'label required' });
        const newExpiry = cleanExpiry(input.expiry);

        const prefix = `${docsPrefix}${id}/`;
        const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
        // Skip archived versions — rename applies only to the current file.
        const oldKey = list.Contents?.find((it) => !it.Key!.includes('/_archived/'))?.Key;
        if (!oldKey) return json(404, { error: 'not found' });

        const filename = oldKey.split('/').slice(7).join('/');
        const newKey = `${prefix}${encodeMeta({ label: newLabel, expiry: newExpiry })}/${filename}`;
        if (newKey === oldKey) return json(200, { ok: true });

        // CopySource must be a URL-encoded bucket/key, but with '/' preserved as
        // path separators (encodeURIComponent would turn them into %2F).
        const copySource = `${BUCKET}/${encodeURIComponent(oldKey).replace(/%2F/g, '/')}`;
        await s3.send(new CopyObjectCommand({ Bucket: BUCKET, Key: newKey, CopySource: copySource }));
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: oldKey }));
        return json(200, { ok: true });
      }

      case 'POST /pets/{petId}/docs/{id}/update-url': {
        // "Update" = renew the cert. Archives the current file under a versioned
        // sub-key so the history is preserved, then returns a presigned POST for
        // the new upload. The docId stays the same, preserving the record's slot
        // in the list.
        const id = event.pathParameters?.id;
        if (!id) return json(400, { error: 'id required' });
        const input = JSON.parse(event.body ?? '{}');
        const filename = String(input.filename ?? '')
          .replace(/[^\w.\- ]/g, '_')
          .slice(0, 200);
        const label = String(input.label ?? '').slice(0, 200);
        const expiry = cleanExpiry(input.expiry);
        const contentType = String(input.contentType ?? 'application/octet-stream');
        if (!filename) return json(400, { error: 'filename required' });
        if ((await readJson(petKey)) === null) return json(404, { error: 'not found' });

        const prefix = `${docsPrefix}${id}/`;
        const existing = await s3.send(
          new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }),
        );
        const currentKey = existing.Contents?.find(
          (it) => !it.Key!.includes('/_archived/'),
        )?.Key;
        if (!currentKey) return json(404, { error: 'document not found' });

        // Copy current -> _archived/{timestamp}/… before presigning the new slot.
        // The old file is preserved even if the upload never completes.
        const archiveKey = `${prefix}_archived/${Date.now()}/${currentKey.slice(prefix.length)}`;
        const copySource = `${BUCKET}/${encodeURIComponent(currentKey).replace(/%2F/g, '/')}`;
        await s3.send(
          new CopyObjectCommand({ Bucket: BUCKET, Key: archiveKey, CopySource: copySource }),
        );
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: currentKey }));

        const safeLabel = label || filename;
        const newKey = `${prefix}${encodeMeta({ label: safeLabel, expiry })}/${filename}`;
        const { url, fields } = await createPresignedPost(s3, {
          Bucket: BUCKET,
          Key: newKey,
          Conditions: [
            ['content-length-range', 1, MAX_FILE_BYTES],
            ['eq', '$Content-Type', contentType],
          ],
          Fields: { 'Content-Type': contentType },
          Expires: 300,
        });
        return json(200, { url, fields, key: newKey });
      }

      case 'DELETE /pets/{petId}/docs/{id}': {
        const id = event.pathParameters?.id;
        if (!id) return json(400, { error: 'id required' });
        const prefix = `${docsPrefix}${id}/`;
        const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
        // Deletes everything under the prefix: current file + all archived versions.
        await Promise.all(
          (list.Contents ?? []).map((it) =>
            s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: it.Key! })),
          ),
        );
        return { statusCode: 204 };
      }

      // ---- user settings ----

      case 'GET /settings': {
        const settings = await readJson<Record<string, unknown>>(`users/${sub}/settings.json`);
        return json(200, settings ?? { remindersEnabled: false, reminderDays: [7, 30] });
      }

      case 'PUT /settings': {
        const input = JSON.parse(event.body ?? '{}');
        const validDays = [1, 3, 7, 14, 30, 60];
        const settings = {
          email: typeof input.email === 'string' ? input.email.slice(0, 254) : '',
          remindersEnabled: input.remindersEnabled === true,
          reminderDays: Array.isArray(input.reminderDays)
            ? (input.reminderDays as unknown[]).filter(
                (d): d is number => typeof d === 'number' && validDays.includes(d),
              )
            : [7, 30],
        };
        await s3.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: `users/${sub}/settings.json`,
            Body: JSON.stringify(settings),
            ContentType: 'application/json',
          }),
        );
        return json(200, settings);
      }

      // ---- passport management ----

      case 'POST /pets/{petId}/passport': {
        const existing = await readJson<Record<string, unknown>>(petKey);
        if (!existing) return json(404, { error: 'not found' });
        const input = JSON.parse(event.body ?? '{}');
        const expiry = cleanExpiry(input.expiry);

        // Revoke the old token before issuing a new one.
        const oldToken = existing.passportToken as string | undefined;
        if (oldToken) {
          await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: `passports/${oldToken}.json` }));
        }

        const token = randomUUID();
        await s3.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: `passports/${token}.json`,
            Body: JSON.stringify({ userId: sub, petId, expiry }),
            ContentType: 'application/json',
          }),
        );
        await s3.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: petKey,
            Body: JSON.stringify({ ...existing, passportToken: token, passportExpiry: expiry }),
            ContentType: 'application/json',
          }),
        );
        return json(200, { token, url: `https://petshots.app/p/${token}`, expiresAt: expiry });
      }

      case 'DELETE /pets/{petId}/passport': {
        const existing = await readJson<Record<string, unknown>>(petKey);
        if (!existing) return json(404, { error: 'not found' });
        const token = existing.passportToken as string | undefined;
        if (!token) return json(404, { error: 'no active passport' });
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: `passports/${token}.json` }));
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { passportToken: _t, passportExpiry: _e, ...rest } = existing;
        await s3.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: petKey,
            Body: JSON.stringify(rest),
            ContentType: 'application/json',
          }),
        );
        return { statusCode: 204 };
      }

      default:
        return json(404, { error: 'not found' });
    }
  } catch (e) {
    console.error('handler error', e);
    return json(500, { error: 'internal error' });
  }
};
