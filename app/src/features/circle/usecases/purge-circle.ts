import { deleteCircle } from '@/data/db';
import { deleteCirclePhotoFiles } from '@/core/photo/photo-cache';
import { deleteCircleKeys } from '@/core/services/keystore/circle-keys';
import { unregisterPushForCircleInvites } from '@/features/invite/usecases/invite-push';

/**
 * Removes every trace of a circle from this device: rows (which take the
 * roster, posts, attachments, comments and anything queued), the decrypted
 * photo files, then the keys.
 *
 * Keys last because a crash after destroying those would leave a circle
 * that still renders and can never sync again; photo files orphaned by a
 * crash sit in the cache directory, which the OS reclaims.
 *
 * Its own module rather than living beside `leaveCircle`, which is the
 * other caller: `member-removed.ts` needs it too, and reaching into
 * leave-circle from an entry handler closes a cycle through
 * pull-log → entry-handlers → back again. Nothing here imports the sync
 * layer, so nothing can.
 */
export async function purgeCircleLocally(circleId: string): Promise<void> {
  // Before the rows: the invite rows are what name its push routings.
  await unregisterPushForCircleInvites(circleId);
  await deleteCircle(circleId);
  deleteCirclePhotoFiles(circleId);
  await deleteCircleKeys(circleId);
}
