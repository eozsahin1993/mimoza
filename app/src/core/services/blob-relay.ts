import { File, Paths, UploadType } from 'expo-file-system';

import { generateUUID } from '@/core/crypto/primitives';
import { authorizedFetch, describeError, reachableFromThisDevice } from '@/core/services/relay';
import { BlobAlreadyExistsError, NetworkUnreachableError, RateLimitedError } from '@/core/services/relay-errors';

/**
 * Photos, covers and profile pictures. Shared by every feature that has
 * some, because one queue and one backoff serve all three — though not
 * all are encrypted: a post or a cover is ciphertext the relay cannot
 * read, but a profile picture is stored as uploaded (see docs/RELAY_DESIGN.md).
 * This module only ever moves bytes; what they mean is the caller's.
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
  /** A member's current profile picture, signed for anyone who shares a circle with them. */
  picture: (accountId: string, pictureId: string) => `picture/${accountId}/${pictureId}`,
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

/** The same thing, for the one blob that is not under a circle: this account's own picture. */
export async function getProfilePictureUploadTarget(pictureId: string): Promise<UploadTarget> {
  const response = await authorizedFetch(`/v1/account/picture/${pictureId}/upload-target`, { method: 'POST' });
  if (response.status === 409) throw new BlobAlreadyExistsError();
  if (response.status === 429) throw new RateLimitedError();
  if (!response.ok) throw new Error(await describeError(response, 'getting an upload target'));
  return (await response.json()) as UploadTarget;
}

/**
 * The bytes behind a signed URL — the second half of `getBlob`, broken
 * out for the two responses that already carry a signed URL inline (an
 * invite preview, a pending join request) and so never need the first
 * half, a relay round trip just to ask for one.
 */
async function downloadSigned(url: string): Promise<Uint8Array | null> {
  const bytes = await fetch(reachableFromThisDevice(url)).catch(() => {
    throw new NetworkUnreachableError();
  });
  if (bytes.status === 404) return null;
  if (!bytes.ok) throw new Error(`Failed to download a blob: ${bytes.status}`);
  return new Uint8Array(await bytes.arrayBuffer());
}

/**
 * The bytes behind an already-signed URL — an invite preview and a
 * pending request both carry one inline, since whoever fetches either is
 * going to look at the picture right there; see downloadSigned's doc
 * comment. Never cache or persist this URL: it is good for an hour, and
 * is only ever meant to be used immediately after the call that handed
 * it over, not stored for a later, possibly much later, retry.
 */
export async function getBlobFromSignedUrl(url: string): Promise<Uint8Array | null> {
  return downloadSigned(url);
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
  return downloadSigned(url);
}

/** Straight to storage through the presigned target, never through the relay. */
export async function uploadBlob(target: UploadTarget, bytes: Uint8Array): Promise<void> {
  const file = new File(Paths.cache, `upload-${generateUUID()}`);
  file.create({ overwrite: true });
  file.write(bytes);
  try {
    const result = await file
      .upload(reachableFromThisDevice(target.url), { uploadType: UploadType.MULTIPART, fieldName: 'file', parameters: target.fields })
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
