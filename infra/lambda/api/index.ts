import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
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
const MAX_DOCS = Number(process.env.MAX_DOCS ?? '4');
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES ?? String(10 * 1024 * 1024));

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

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  // The Cognito JWT authorizer already verified the token; we just read claims.
  // sub is the stable per-user id we scope every S3 key to - a user can never
  // name a key outside their own prefix, so authz is the prefix itself.
  const sub = event.requestContext.authorizer?.jwt?.claims?.sub as string | undefined;
  if (!sub) return json(401, { error: 'unauthorized' });

  const userPrefix = `users/${sub}`;
  const petKey = `${userPrefix}/pet.json`;
  const docsPrefix = `${userPrefix}/docs/`;

  try {
    switch (event.routeKey) {
      // ---- pet metadata (stored as a small JSON object, no DB for v1) ----
      case 'GET /pet': {
        try {
          const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: petKey }));
          const body = await obj.Body!.transformToString();
          return json(200, { pet: JSON.parse(body) });
        } catch (e) {
          if ((e as { name?: string }).name === 'NoSuchKey') return json(200, { pet: null });
          throw e;
        }
      }

      case 'PUT /pet': {
        const input = JSON.parse(event.body ?? '{}');
        const pet = {
          name: String(input.name ?? '').slice(0, 100),
          species: String(input.species ?? '').slice(0, 50),
        };
        if (!pet.name) return json(400, { error: 'name required' });
        await s3.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: petKey,
            Body: JSON.stringify(pet),
            ContentType: 'application/json',
          }),
        );
        return json(200, { pet });
      }

      // ---- documents ----
      case 'GET /docs': {
        const list = await s3.send(
          new ListObjectsV2Command({ Bucket: BUCKET, Prefix: docsPrefix }),
        );
        const docs = await Promise.all(
          (list.Contents ?? []).map(async (it) => {
            const key = it.Key!;
            // key shape: users/{sub}/docs/{docId}/{encodeURIComponent(label)}/{filename}
            // Label lives in the key (not S3 metadata) so the browser PUT carries
            // no x-amz-* headers and can't trip S3's "unsigned header" rejection.
            const parts = key.split('/');
            const meta = decodeMeta(parts[4]);
            // Short-lived GET URL so the browser opens the PDF straight from S3.
            const url = await getSignedUrl(
              s3,
              new GetObjectCommand({ Bucket: BUCKET, Key: key }),
              { expiresIn: 3600 },
            );
            return {
              id: parts[3],
              label: meta.label,
              expiry: meta.expiry,
              filename: parts.slice(5).join('/'),
              size: it.Size,
              uploadedAt: it.LastModified,
              url,
            };
          }),
        );
        return json(200, { docs });
      }

      case 'POST /docs/upload-url': {
        const input = JSON.parse(event.body ?? '{}');
        const filename = String(input.filename ?? '')
          .replace(/[^\w.\- ]/g, '_')
          .slice(0, 200);
        const label = String(input.label ?? '').slice(0, 200);
        const expiry = cleanExpiry(input.expiry);
        const contentType = String(input.contentType ?? 'application/octet-stream');
        if (!filename) return json(400, { error: 'filename required' });

        // Enforce the MVP limit before handing out an upload URL.
        const list = await s3.send(
          new ListObjectsV2Command({ Bucket: BUCKET, Prefix: docsPrefix }),
        );
        if ((list.KeyCount ?? 0) >= MAX_DOCS) {
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

      case 'PATCH /docs/{id}': {
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
        const oldKey = list.Contents?.[0]?.Key;
        if (!oldKey) return json(404, { error: 'not found' });

        const filename = oldKey.split('/').slice(5).join('/');
        const newKey = `${prefix}${encodeMeta({ label: newLabel, expiry: newExpiry })}/${filename}`;
        if (newKey === oldKey) return json(200, { ok: true });

        // CopySource must be a URL-encoded bucket/key, but with '/' preserved as
        // path separators (encodeURIComponent would turn them into %2F).
        const copySource = `${BUCKET}/${encodeURIComponent(oldKey).replace(/%2F/g, '/')}`;
        await s3.send(new CopyObjectCommand({ Bucket: BUCKET, Key: newKey, CopySource: copySource }));
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: oldKey }));
        return json(200, { ok: true });
      }

      case 'DELETE /docs/{id}': {
        const id = event.pathParameters?.id;
        if (!id) return json(400, { error: 'id required' });
        const prefix = `${docsPrefix}${id}/`;
        const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
        await Promise.all(
          (list.Contents ?? []).map((it) =>
            s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: it.Key! })),
          ),
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
