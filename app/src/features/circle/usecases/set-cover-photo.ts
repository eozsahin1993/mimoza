import {
  AttachmentKinds,
  AttachmentStatuses,
  coverEntryId,
  setCover as setCoverLocally,
  upsertAttachment,
} from '@/data/db';
import { encrypt, generateUUID, hashBytes } from '@/core/crypto/primitives';
import { writeCoverFile } from '@/core/photo/photo-cache';
import { BlobPaths, getUploadTarget, uploadBlob } from '@/core/services/blob-relay';
import { getCurrentContentKey } from '@/core/services/keystore/circle-keys';
import { setCover } from '@/features/circle/services/circle-relay';

/**
 * A fresh id every time rather than one key overwritten in place: that
 * is what lets the edge cache a cover forever, and it sidesteps an
 * immutable key's rotation problem, since bytes sealed under one version
 * could never be replaced with bytes under the next.
 *
 * Bytes before the row, like a post — the other order leaves a circle
 * pointing at nothing.
 */
export async function setCoverPhoto(circleId: string, photo: Uint8Array): Promise<string> {
  const current = await getCurrentContentKey(circleId);
  if (!current) throw new Error('No content key on this device.');

  const coverId = generateUUID();
  const entryId = coverEntryId(coverId);
  const hash = hashBytes(photo);

  await uploadBlob(
    await getUploadTarget(circleId, BlobPaths.cover(coverId)),
    encrypt(photo, current.key)
  );
  await setCover(circleId, coverId);

  await upsertAttachment({
    circleId,
    entryId,
    kind: AttachmentKinds.CIRCLE_COVER,
    bytes: photo,
    hash,
    keyVersion: current.version,
    // Chosen here, so there is nothing to download.
    status: AttachmentStatuses.FETCHED,
    fetchAttempts: 0,
    nextAttemptAt: null,
    createdAt: Date.now(),
  });
  await setCoverLocally(circleId, coverId);
  writeCoverFile(circleId, photo, coverId);

  return coverId;
}
