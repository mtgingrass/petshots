// Client for PetshotsApiStack's HTTP API. Every call attaches the Cognito access
// token as a Bearer header; the API Gateway authorizer verifies it before the
// Lambda runs. File bytes go browser->S3 directly via a presigned URL - they
// never pass through this API.
import { config } from './config';
import { getAccessToken } from './auth/cognito';

export interface Pet {
  name: string;
  species: string;
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

export function getPet(): Promise<{ pet: Pet | null }> {
  return request('GET', '/pet');
}

export function savePet(pet: Pet): Promise<{ pet: Pet }> {
  return request('PUT', '/pet', pet);
}

export function listDocs(): Promise<{ docs: Doc[] }> {
  return request('GET', '/docs');
}

export function updateDoc(id: string, label: string, expiry?: string): Promise<{ ok: true }> {
  return request('PATCH', `/docs/${id}`, { label, expiry: expiry || undefined });
}

export function deleteDoc(id: string): Promise<void> {
  return request('DELETE', `/docs/${id}`);
}

// Two-step upload: ask the API for a presigned PUT URL, then send the bytes
// straight to S3 with exactly the headers the API signed.
export async function uploadDoc(file: File, label: string, expiry?: string): Promise<void> {
  const { uploadUrl, requiredHeaders } = await request<{
    uploadUrl: string;
    key: string;
    requiredHeaders: Record<string, string>;
  }>('POST', '/docs/upload-url', {
    filename: file.name,
    label,
    expiry: expiry || undefined,
    contentType: file.type || 'application/octet-stream',
  });

  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: requiredHeaders,
    body: file,
  });
  if (!put.ok) throw new Error(`Upload to storage failed (${put.status})`);
}
