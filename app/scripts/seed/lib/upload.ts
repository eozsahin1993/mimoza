import type { UploadTarget } from '@/core/services/blob-relay';

/**
 * What uploadBlob (core/services/blob-relay.ts) does through expo-file-system,
 * done with Node's own FormData/Blob instead: a presigned S3 POST, every
 * field in `target.fields` plus the encrypted bytes under `file`.
 */
export async function uploadToPresignedTarget(target: UploadTarget, bytes: Uint8Array): Promise<void> {
  const form = new FormData();
  for (const [key, value] of Object.entries(target.fields)) form.append(key, value);
  form.append('file', new Blob([new Uint8Array(bytes)]), 'blob');

  const response = await fetch(target.url, { method: 'POST', body: form });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Failed to upload a blob: ${response.status} ${body}`);
  }
}

/** Fetches a source photo (Unsplash or similar) as bytes, for encrypting and uploading. */
export async function fetchPhoto(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch photo ${url}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}
