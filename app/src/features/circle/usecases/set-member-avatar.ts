import {
  AttachmentKinds,
  AttachmentStatuses,
  avatarEntryId,
  listCircles,
  setMemberAvatar as setMemberAvatarLocally,
  upsertAttachment,
} from '@/data/db';
import { encrypt, generateUUID, hashBytes } from '@/core/crypto/primitives';
import { BlobPaths, getUploadTarget, uploadBlob } from '@/core/services/blob-relay';
import { getCurrentContentKey } from '@/core/services/keystore/circle-keys';
import { patchMembership } from '@/features/circle/services/circle-relay';

/**
 * A fresh id every time, same reasoning as setCoverPhoto: content-addressed,
 * so a changed picture is a new id rather than bytes rewritten in place.
 * The relay refuses a stale keyVersion (a rewrap landed between reading
 * the key and this write), which surfaces as a normal thrown error here.
 */
export async function setMemberAvatar(circleId: string, accountId: string, photo: Uint8Array): Promise<void> {
  const current = await getCurrentContentKey(circleId);
  if (!current) throw new Error('No content key on this device.');

  const avatarId = generateUUID();
  const entryId = avatarEntryId(accountId, avatarId);

  await uploadBlob(await getUploadTarget(circleId, BlobPaths.uploadAvatar(avatarId)), encrypt(photo, current.key));
  await patchMembership(circleId, accountId, { avatarId, keyVersion: current.version });

  await upsertAttachment({
    circleId,
    entryId,
    kind: AttachmentKinds.MEMBER_AVATAR,
    bytes: photo,
    hash: hashBytes(photo),
    keyVersion: current.version,
    // Chosen here, so there is nothing to download.
    status: AttachmentStatuses.FETCHED,
    fetchAttempts: 0,
    nextAttemptAt: null,
    createdAt: Date.now(),
  });
  await setMemberAvatarLocally(circleId, accountId, avatarId, current.version);
}

/**
 * A picture is sealed per circle under that circle's own key, so a fresh
 * one means a fresh upload+patch per circle rather than one shared write
 * anywhere — this fans that out, one circle's failure never stopping the
 * rest. Best-effort like notifyCircleBestEffort: whoever called this
 * already saved the picture locally, and a circle that didn't get the
 * word yet will next time this runs.
 */
export async function syncOwnAvatarBestEffort(accountId: string, photo: Uint8Array): Promise<void> {
  for (const circle of await listCircles()) {
    await setMemberAvatar(circle.id, accountId, photo).catch((err) =>
      console.error(`Failed to update the avatar in circle ${circle.id}`, err)
    );
  }
}
