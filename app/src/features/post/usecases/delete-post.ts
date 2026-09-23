import { queuePostDeletion } from '@/data/db';
import { deletePhotoFile } from '@/core/photo/photo-cache';
import { drainOutbox } from '@/core/sync/drain-outbox';

/**
 * Removes a photo from the circle, for everyone. The relay enforces
 * author-or-admin, so this queues it and lets a refusal surface through
 * the outbox rather than second-guessing the rule locally.
 *
 * What it cannot do is unsend: every member's device may already hold
 * the decrypted bytes. It removes the photo going forward, which is what
 * deleting means here.
 */
export async function deletePost(circleId: string, postId: string): Promise<void> {
  const at = Date.now();
  queuePostDeletion(postId, at, { circleId, op: 'delete_post', postId, createdAt: at });
  deletePhotoFile(circleId, postId);

  drainOutbox(circleId).catch((err) => console.error('Failed to drain outbox', err));
}
