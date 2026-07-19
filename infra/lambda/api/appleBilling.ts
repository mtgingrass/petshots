import {
  Environment,
  SignedDataVerifier,
  type JWSTransactionDecodedPayload,
  type ResponseBodyV2DecodedPayload,
} from '@apple/app-store-server-library';
import { APPLE_ROOT_CERTIFICATES } from './appleRoots';

export const APPLE_BUNDLE_ID = 'app.petshots.ios';
export const APPLE_PRODUCT_IDS = new Set([
  'petshots_paid_monthly',
  'petshots_paid_yearly',
]);

function decodePayload(jws: string): Record<string, unknown> {
  const payload = jws.split('.')[1];
  if (!payload) throw new Error('invalid signed Apple payload');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function environmentFrom(value: unknown): Environment {
  if (value === Environment.SANDBOX) return Environment.SANDBOX;
  if (value === Environment.PRODUCTION) return Environment.PRODUCTION;
  throw new Error('unsupported Apple transaction environment');
}

function verifier(environment: Environment, appAppleId = 0): SignedDataVerifier {
  // Online OCSP checks are deliberately disabled. Apple signatures and the
  // complete certificate chain are still verified; this avoids making every
  // purchase dependent on an external network request from Lambda.
  return new SignedDataVerifier(
    APPLE_ROOT_CERTIFICATES,
    false,
    environment,
    APPLE_BUNDLE_ID,
    environment === Environment.PRODUCTION ? appAppleId : undefined,
  );
}

export async function verifyAppleTransaction(jws: string): Promise<JWSTransactionDecodedPayload> {
  const environment = environmentFrom(decodePayload(jws).environment);
  const transaction = await verifier(environment).verifyAndDecodeTransaction(jws);
  if (!transaction.productId || !APPLE_PRODUCT_IDS.has(transaction.productId)) {
    throw new Error('unknown Apple product');
  }
  if (!transaction.transactionId || !transaction.originalTransactionId || !transaction.expiresDate) {
    throw new Error('incomplete Apple subscription transaction');
  }
  return transaction;
}

export async function verifyAppleNotification(jws: string): Promise<ResponseBodyV2DecodedPayload> {
  const untrusted = decodePayload(jws);
  const data = (untrusted.data ?? {}) as Record<string, unknown>;
  const environment = environmentFrom(data.environment);
  const appAppleId = typeof data.appAppleId === 'number' ? data.appAppleId : 0;
  return verifier(environment, appAppleId).verifyAndDecodeNotification(jws);
}

export function transactionIsActive(
  transaction: JWSTransactionDecodedPayload,
  now = Date.now(),
): boolean {
  return !!transaction.expiresDate
    && transaction.expiresDate > now
    && !transaction.revocationDate
    && !transaction.isUpgraded;
}
