import { deleteCircle } from '@/data/db';
import { deleteCirclePhotoFiles } from '@/core/photo/photo-cache';
import { deleteCircleKeys } from '@/core/services/keystore/circle-keys';

/**
 * Removes every trace of a circle from this device: rows (which take the
 * roster, posts, attachments, comments and anything queued), the
 * decrypted photo files, then the keys.
 *
 * Keys last because a crash after destroying those would leave a circle
 * that still renders and can never sync again; photo files orphaned by a
 * crash sit in the cache directory, which the OS reclaims.
 *
 * Not what leaving does — that keeps the rows as a local archive. This
 * is for a circle that is genuinely gone: deleted for everyone, or this
 * account erased.
 */
export async function purgeCircleLocally(circleId: string): Promise<void> {
  await deleteCircle(circleId);
  deleteCirclePhotoFiles(circleId);
  await deleteCircleKeys(circleId);
}
