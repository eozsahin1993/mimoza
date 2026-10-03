import { deleteCircle, dropOutbox } from '@/data/db';
import { deleteCirclePhotoFiles } from '@/core/photo/photo-cache';
import { deleteCircleKeys } from '@/core/services/keystore/circle-keys';

/**
 * Removes every trace of a circle from this device: the outbox (not
 * cascaded), the rows (which take the roster, posts, attachments and
 * comments), the decrypted photo files, then the keys.
 *
 * Keys last because a crash after destroying those would leave a circle
 * that still renders and can never sync again; photo files orphaned by a
 * crash sit in the cache directory, which the OS reclaims.
 *
 * Only an explicit deletion ends here: removing an archive from this
 * phone, or the last member's leave, which deletes the circle. Leaving
 * and being removed both keep the rows as a read-only archive — see
 * `archiveCircleLocally`.
 */
export async function purgeCircleLocally(circleId: string): Promise<void> {
  await dropOutbox(circleId);
  await deleteCircle(circleId);
  deleteCirclePhotoFiles(circleId);
  await deleteCircleKeys(circleId);
}
