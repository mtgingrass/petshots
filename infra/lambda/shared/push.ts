/**
 * Web push (VAPID) + native iOS push (APNs) — shared by the reminder Lambda
 * (daily/weekly/monthly nudges) and the api Lambda (real-time pushes, e.g.
 * "new photo added" to household members). Same "each Lambda bundles its own
 * copy of this source, no runtime sharing" convention as shared/dailyStats.ts
 * — own module-level S3Client, bucket/userPrefix passed as params rather than
 * read from a Lambda-specific global.
 */
import { S3Client, ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import webpush from 'web-push';
import { sign } from 'node:crypto';
import * as http2 from 'node:http2';
import { PUSH } from './config';

const s3 = new S3Client({
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
const sm = new SecretsManagerClient({});
const VAPID_SECRET_NAME = process.env.VAPID_SECRET_NAME ?? 'petshots/vapid';
const APNS_SECRET_NAME = process.env.APNS_SECRET_NAME ?? 'petshots/apns';

async function getJson<T>(bucket: string, key: string): Promise<T | null> {
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return JSON.parse(await obj.Body!.transformToString()) as T;
  } catch (e) {
    if ((e as { name?: string }).name === 'NoSuchKey') return null;
    throw e;
  }
}

// ---- web push ----
// VAPID keys from Secrets Manager, loaded lazily and cached per container. A
// device the push service rejects (404/410 = expired or revoked
// subscription) is deleted so we never keep knocking.
export interface WebPushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
// Native iOS devices store an APNs device token instead of a web endpoint.
export interface ApnsSub {
  platform: 'apns';
  token: string;
}
export type PushSub = WebPushSub | ApnsSub;

let vapidReady: boolean | null = null;
async function ensureVapid(): Promise<boolean> {
  if (vapidReady !== null) return vapidReady;
  try {
    const res = await sm.send(new GetSecretValueCommand({ SecretId: VAPID_SECRET_NAME }));
    const cfg = JSON.parse(res.SecretString!) as {
      publicKey: string;
      privateKey: string;
      subject: string;
    };
    webpush.setVapidDetails(cfg.subject, cfg.publicKey, cfg.privateKey);
    vapidReady = true;
  } catch (e) {
    console.error('vapid secret unavailable — push disabled this run', e);
    vapidReady = false;
  }
  return vapidReady;
}

export async function listPushSubs(
  bucket: string,
  userPrefix: string,
): Promise<{ key: string; sub: PushSub }[]> {
  const list = await s3.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: `${userPrefix}push/` }),
  );
  const out: { key: string; sub: PushSub }[] = [];
  for (const it of list.Contents ?? []) {
    const raw = await getJson<WebPushSub & ApnsSub>(bucket, it.Key!);
    if (!raw) continue;
    if (raw.platform === 'apns' && typeof raw.token === 'string') {
      out.push({ key: it.Key!, sub: { platform: 'apns', token: raw.token } });
    } else if (raw.endpoint && raw.keys?.p256dh && raw.keys?.auth) {
      out.push({ key: it.Key!, sub: { endpoint: raw.endpoint, keys: raw.keys } });
    }
  }
  return out;
}

// ---- native iOS push (APNs, token-based auth) ----
// Config from Secrets Manager `petshots/apns`:
//   { teamId, keyId, privateKey (the .p8 PEM), bundleId, environment? }
// environment: 'sandbox' for dev builds from Xcode, omit/'production' for
// TestFlight + App Store. A missing or incomplete secret just skips iOS
// pushes (logged once per run); web push is unaffected. Setup steps in IOS.md.
interface ApnsConfig {
  teamId: string;
  keyId: string;
  privateKey: string;
  bundleId: string;
  environment?: string;
}
let apnsCfg: ApnsConfig | null | undefined;
async function ensureApns(): Promise<ApnsConfig | null> {
  if (apnsCfg !== undefined) return apnsCfg;
  try {
    const res = await sm.send(new GetSecretValueCommand({ SecretId: APNS_SECRET_NAME }));
    const cfg = JSON.parse(res.SecretString!) as ApnsConfig;
    const complete =
      !!cfg.teamId && !!cfg.keyId && !!cfg.bundleId &&
      typeof cfg.privateKey === 'string' && cfg.privateKey.includes('PRIVATE KEY');
    apnsCfg = complete ? cfg : null;
    if (!apnsCfg) console.log('apns secret incomplete/placeholder — iOS push skipped this run');
  } catch {
    apnsCfg = null;
    console.log('apns secret unavailable — iOS push skipped (expected until Apple Developer setup)');
  }
  return apnsCfg;
}

// Provider JWT (ES256), cached and reissued after 45 min — Apple wants
// tokens refreshed between 20 and 60 minutes.
let apnsJwtCache: { jwt: string; iat: number } | null = null;
function apnsJwt(cfg: ApnsConfig): string {
  const now = Math.floor(Date.now() / 1000);
  if (apnsJwtCache && now - apnsJwtCache.iat < 45 * 60) return apnsJwtCache.jwt;
  const b64u = (s: string) => Buffer.from(s).toString('base64url');
  const unsigned = `${b64u(JSON.stringify({ alg: 'ES256', kid: cfg.keyId }))}.${b64u(
    JSON.stringify({ iss: cfg.teamId, iat: now }),
  )}`;
  // JWT ES256 wants the raw r||s signature, not ASN.1 DER.
  const sig = sign('sha256', Buffer.from(unsigned), {
    key: cfg.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  apnsJwtCache = { jwt: `${unsigned}.${sig.toString('base64url')}`, iat: now };
  return apnsJwtCache.jwt;
}

// One HTTP/2 POST per device token. Volume is a handful of devices per call,
// so a connection per send is fine.
function apnsSend(
  cfg: ApnsConfig,
  deviceToken: string,
  payload: unknown,
): Promise<{ status: number; reason?: string }> {
  return new Promise((resolve, reject) => {
    const host =
      cfg.environment === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
    const client = http2.connect(`https://${host}`);
    client.on('error', reject);
    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      authorization: `bearer ${apnsJwt(cfg)}`,
      'apns-topic': cfg.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor(Date.now() / 1000) + PUSH.APNS_EXPIRY_SECONDS),
    });
    req.setTimeout(10_000, () => {
      client.close();
      reject(new Error('apns timeout'));
    });
    let status = 0;
    let body = '';
    req.on('response', (headers) => {
      status = Number(headers[':status'] ?? 0);
    });
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      client.close();
      let reason: string | undefined;
      try {
        reason = (JSON.parse(body) as { reason?: string }).reason;
      } catch {
        /* empty body on success */
      }
      resolve({ status, reason });
    });
    req.on('error', (e) => {
      client.close();
      reject(e);
    });
    req.end(JSON.stringify(payload));
  });
}

export async function sendPushes(
  bucket: string,
  userPrefix: string,
  title: string,
  body: string,
  appUrl: string,
): Promise<number> {
  const subs = await listPushSubs(bucket, userPrefix);
  let sent = 0;
  for (const { key, sub } of subs) {
    // Native iOS device → APNs. Dead tokens (410 Unregistered, or 400
    // BadDeviceToken from an env mismatch/uninstall) are pruned like
    // expired web-push endpoints.
    if ('token' in sub) {
      const cfg = await ensureApns();
      if (!cfg) continue;
      try {
        const res = await apnsSend(cfg, sub.token, {
          aps: { alert: { title, body }, sound: 'default' },
          url: '/dashboard',
        });
        if (res.status === 200) {
          sent++;
        } else if (
          res.status === 410 ||
          (res.status === 400 && res.reason === 'BadDeviceToken')
        ) {
          await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
          console.log(`pruned dead APNs token ${key}`);
        } else {
          console.error(`apns push to ${key} failed: ${res.status} ${res.reason ?? ''}`);
        }
      } catch (e) {
        console.error(`apns push to ${key} failed`, e);
      }
      continue;
    }
    if (!(await ensureVapid())) continue;
    try {
      await webpush.sendNotification(
        sub as webpush.PushSubscription,
        JSON.stringify({ title, body, url: `${appUrl}/dashboard` }),
        { TTL: PUSH.WEB_PUSH_TTL_SECONDS },
      );
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) {
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        console.log(`pruned expired push subscription ${key}`);
      } else {
        console.error(`push to ${key} failed`, e);
      }
    }
  }
  return sent;
}
