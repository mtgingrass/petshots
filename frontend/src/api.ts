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

// Two-step upload: ask the API for a presigned POST policy, then send the file
// straight to S3 as multipart/form-data. S3 enforces the policy's size limit
// (content-length-range), so an oversized file is rejected server-side.
export async function uploadDoc(file: File, label: string, expiry?: string): Promise<void> {
  const { url, fields } = await request<{
    url: string;
    fields: Record<string, string>;
    key: string;
  }>('POST', '/docs/upload-url', {
    filename: file.name,
    label,
    expiry: expiry || undefined,
    contentType: file.type || 'application/octet-stream',
  });

  // Every signed field first, then the file LAST - S3 ignores form fields that
  // appear after the file part. Don't set Content-Type; the browser adds the
  // multipart boundary itself.
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('file', file);

  const res = await fetch(url, { method: 'POST', body: form });
  // S3 returns 204 on success; a 403 here usually means the file exceeded the
  // policy's size limit.
  if (!res.ok) throw new Error(`Upload to storage failed (${res.status})`);
}
