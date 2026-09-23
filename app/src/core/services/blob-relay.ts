import { File, Paths, UploadType } from 'expo-file-system';

import { generateUUID } from '@/core/crypto/primitives';
import { authorizedFetch, describeError } from '@/core/services/relay';
import { BlobAlreadyExistsError, NetworkUnreachableError, RateLimitedError } from '@/core/services/relay-errors';

/**
 * Encrypted bytes: photos, covers and member pictures. Shared by every
 * feature that has some, because one queue and one backoff serve all
 * three.
 *
 * Every key is written once and never overwritten — a changed cover or
 * picture is a new id — so the edge caches them indefinitely. The relay
 * only ever hands out a presigned target or a signed URL; the bytes go
 * straight to and from storage.
 */

export type UploadTarget = {
  url: string;
  fields: Record<string, string>;
};

/** Where a blob lives, as the rest of the relay's path after the circle. */
export const BlobPaths = {
  photo: (postId: string) => postId,
  cover: (coverId: string) => `cover/${coverId}`,
  /** Uploading an avatar names only the picture; the relay stamps whose it is. */
  uploadAvatar: (avatarId: string) => `avatar/${avatarId}`,
  avatar: (accountId: string, avatarId: string) => `avatar/${accountId}/${avatarId}`,
};

/**
 * A presigned target for one blob. Single-use: the first upload wins, so
 * `BlobAlreadyExistsError` on a retry means the earlier attempt actually
 * landed, and the caller should treat it as done rather than as failure.
 */
export async function getUploadTarget(circleId: string, path: string): Promise<UploadTarget> {
  const response = await authorizedFetch(`/v1/circles/${circleId}/blobs/${path}/upload-target`, { method: 'POST' });
  if (response.status === 409) throw new BlobAlreadyExistsError();
  if (response.status === 429) throw new RateLimitedError();
  if (!response.ok) throw new Error(await describeError(response, 'getting an upload target'));
  return (await response.json()) as UploadTarget;
}

/**
 * The bytes, through the signed URL the relay hands back. Null when
 * nothing was ever uploaded there, which is ordinary — a circle with no
 * cover, a member with no picture.
 */
export async function getBlob(circleId: string, path: string): Promise<Uint8Array | null> {
  const response = await authorizedFetch(`/v1/circles/${circleId}/blobs/${path}`);
  if (response.status === 404) return null;
  if (response.status === 429) throw new RateLimitedError();
  if (!response.ok) throw new Error(await describeError(response, 'reading a blob'));

  const { url } = (await response.json()) as { url: string };
  const bytes = await fetch(url).catch(() => {
    throw new NetworkUnreachableError();
  });
  if (bytes.status === 404) return null;
  if (!bytes.ok) throw new Error(`Failed to download a blob: ${bytes.status}`);
  return new Uint8Array(await bytes.arrayBuffer());
}

/** Straight to storage through the presigned target, never through the relay. */
export async function uploadBlob(target: UploadTarget, bytes: Uint8Array): Promise<void> {
  const file = new File(Paths.cache, `upload-${generateUUID()}`);
  file.create({ overwrite: true });
  file.write(bytes);
  try {
    const result = await file
      .upload(target.url, { uploadType: UploadType.MULTIPART, fieldName: 'file', parameters: target.fields })
      .catch(() => {
        throw new NetworkUnreachableError();
      });
    // A status, unlike a rejection, means storage answered and refused.
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`Failed to upload a blob: ${result.status} ${result.body}`);
    }
  } finally {
    file.delete();
  }
}
