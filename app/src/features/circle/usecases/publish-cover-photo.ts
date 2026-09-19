import { encrypt, generateUUID, hashBytes, sign } from '@/core/crypto/primitives';
import { deriveAuthorityKeypair } from '@/core/crypto/identity';
import { deriveCoverPhotoUploadMessage } from '@/core/crypto/signed-messages';
import { deriveWriteToken } from '@/features/circle/crypto';
import { getCircle, updateCirclePicture } from '@/data/db';
import { buildAndEncryptLogEntry, EntryTypes } from '@/core/sync/log-entry';
import { getCircleIdentity, getCurrentContentKey } from '@/core/services/keystore/circle-keys';
import { getMasterSeed } from '@/core/services/keystore/master-seed';
import { writeCoverFile } from '@/core/photo/photo-cache';
import { appendEntry } from '@/core/services/log-relay';
import { getCoverPhotoUploadTarget, uploadBlob } from '@/core/services/blob-relay';

/**
 * Uploads a cover and records it in the log. Two relay calls, not one:
 * `getCoverPhotoUploadTarget` is dual-gated (write token *and* an
 * authority signature, since the object it points at is a fixed,
 * always-overwritable key with no per-upload existence check — see
 * services/relay.ts), then a `cover_photo_set` meta entry carrying
 * `photoHash` tells synced devices to refetch it.
 *
 * Separate from `setCoverPhoto` so circle creation can call it without
 * importing the admin check, which drags the whole pull-log graph in.
 * Callers must have established the caller may do this.
 */
export async function publishCoverPhoto(circleId: string, photo: Uint8Array): Promise<void> {
  const circle = await getCircle(circleId);
  if (!circle) throw new Error('No local circle row for this id.');

  const masterSeed = await getMasterSeed();
  if (!masterSeed) throw new Error('No master seed on this device.');
  const identity = await getCircleIdentity(circleId);
  if (!identity) throw new Error('No circle identity on this device.');
  const current = await getCurrentContentKey(circleId);
  if (!current) throw new Error('No content key on this device.');

  const authorityKeypair = deriveAuthorityKeypair(masterSeed, circleId);
  const writeToken = deriveWriteToken(current.key);

  const signature = sign(deriveCoverPhotoUploadMessage(circle.syncId), authorityKeypair.secretKey);
  const target = await getCoverPhotoUploadTarget(circle.syncId, writeToken, authorityKeypair.publicKey, signature);
  await uploadBlob(target, encrypt(photo, current.key));

  const photoHash = hashBytes(photo);
  const entry = buildAndEncryptLogEntry(EntryTypes.COVER_PHOTO_SET, { photoHash, keyVersion: current.version }, identity, current.key);
  await appendEntry(circle.syncId, 'meta', generateUUID(), entry, current.version, writeToken, identity.publicKey);

  await updateCirclePicture(circleId, photo, photoHash);
  writeCoverFile(circleId, photo, photoHash);
}
