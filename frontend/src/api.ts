// Client for PetshotsApiStack's HTTP API. Every call attaches the Cognito access
// token as a Bearer header; the API Gateway authorizer verifies it before the
// Lambda runs. File bytes go browser->S3 directly via presigned URLs - they
// never pass through this API.
import { config } from './config';
import { getAccessToken } from './auth/cognito';
import { compressImage } from './utils/compressImage';

const COMPRESSIBLE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export interface Pet {
  id: string;
  name: string;
  species: string;
  avatarUrl?: string;
  passportToken?: string;
  passportExpiry?: string; // YYYY-MM-DD
  // optional health profile fields
  breed?: string;
  dob?: string;         // YYYY-MM-DD
  weight?: string;
  allergies?: string;
  behavior?: string;
  vetName?: string;
  vetPhone?: string;
  emergencyContact?: string;
  microchip?: string;
  fixed?: boolean;
  notes?: string;
}

export interface PassportDoc {
  id: string;
  label: string;
  expiry?: string;
  filename: string;
  url: string;
}

export interface PassportData {
  pet: Omit<Pet, 'id' | 'passportToken' | 'passportExpiry'>;
  docs: PassportDoc[];
  expiresAt?: string;
}

export interface Doc {
  id: string;
  label: string;
  expiry?: string; // YYYY-MM-DD, the vaccine's expiration date (optional)
  filename: string;
  size: number;
  uploadedAt: string;
  url: string; // short-lived presigned GET URL
}

export const MAX_PETS = 3;
export const MAX_DOCS = 4;

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new Error('Your session has expired. Please log in again.');

  const res = await fetch(config.apiBaseUrl + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return undefined as T;
  const data = res.headers.get('content-type')?.includes('json')
    ? await res.json()
    : null;
  if (!res.ok) {
    throw new Error(data?.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

// Presigned POST helper: every signed field first, then the file LAST - S3
// ignores form fields that appear after the file part. Don't set Content-Type;
// the browser adds the multipart boundary itself. S3 enforces the policy's
// size limit (content-length-range) server-side.
async function postToS3(presign: { url: string; fields: Record<string, string> }, file: File) {
  const form = new FormData();
  for (const [k, v] of Object.entries(presign.fields)) form.append(k, v);
  form.append('file', file);
  const res = await fetch(presign.url, { method: 'POST', body: form });
  // S3 returns 204 on success; a 403 here usually means the file exceeded the
  // policy's size limit.
  if (!res.ok) throw new Error(`Upload to storage failed (${res.status})`);
}

// ---- pets ----

export function listPets(): Promise<{ pets: Pet[] }> {
  return request('GET', '/pets');
}

export function createPet(name: string, species: string): Promise<{ pet: Pet }> {
  return request('POST', '/pets', { name, species });
}

export function updatePet(id: string, fields: Omit<Pet, 'id' | 'avatarUrl'>): Promise<{ pet: Pet }> {
  return request('PUT', `/pets/${id}`, fields);
}

export function deletePet(id: string): Promise<void> {
  return request('DELETE', `/pets/${id}`);
}

export async function uploadAvatar(petId: string, file: File): Promise<void> {
  const toUpload = COMPRESSIBLE_TYPES.has(file.type) ? await compressImage(file) : file;
  const presign = await request<{ url: string; fields: Record<string, string> }>(
    'POST',
    `/pets/${petId}/avatar/upload-url`,
    { contentType: toUpload.type },
  );
  await postToS3(presign, toUpload);
}

// ---- documents (per pet) ----

export function listDocs(petId: string): Promise<{ docs: Doc[] }> {
  return request('GET', `/pets/${petId}/docs`);
}

export function updateDoc(
  petId: string,
  id: string,
  label: string,
  expiry?: string,
): Promise<{ ok: true }> {
  return request('PATCH', `/pets/${petId}/docs/${id}`, { label, expiry: expiry || undefined });
}

export function deleteDoc(petId: string, id: string): Promise<void> {
  return request('DELETE', `/pets/${petId}/docs/${id}`);
}

export async function updateDocVersion(
  petId: string,
  id: string,
  file: File,
  label: string,
  expiry?: string,
): Promise<void> {
  const presign = await request<{ url: string; fields: Record<string, string> }>(
    'POST',
    `/pets/${petId}/docs/${id}/update-url`,
    { filename: file.name, label, expiry: expiry || undefined, contentType: file.type || 'application/octet-stream' },
  );
  await postToS3(presign, file);
}

// ---- passport ----

export function createPassport(
  petId: string,
  expiry?: string,
): Promise<{ token: string; url: string; expiresAt?: string }> {
  return request('POST', `/pets/${petId}/passport`, { expiry: expiry || undefined });
}

export function revokePassport(petId: string): Promise<void> {
  return request('DELETE', `/pets/${petId}/passport`);
}

export async function fetchPassport(token: string): Promise<PassportData> {
  const res = await fetch(config.apiBaseUrl + `/passport/${token}`);
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error ?? `Failed to load passport (${res.status})`);
  }
  return res.json() as Promise<PassportData>;
}

export async function uploadDoc(
  petId: string,
  file: File,
  label: string,
  expiry?: string,
): Promise<void> {
  const presign = await request<{
    url: string;
    fields: Record<string, string>;
    key: string;
  }>('POST', `/pets/${petId}/docs/upload-url`, {
    filename: file.name,
    label,
    expiry: expiry || undefined,
    contentType: file.type || 'application/octet-stream',
  });
  await postToS3(presign, file);
}
