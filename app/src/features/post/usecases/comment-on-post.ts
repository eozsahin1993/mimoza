import { getProfile, queueComment, queueCommentDeletion } from '@/data/db';
import { generateUUID } from '@/core/crypto/primitives';
import { drainOutbox } from '@/core/sync/drain-outbox';

/**
 * Writes a comment and queues it. The row is inserted pending, so it
 * shows straight away and is counted on top of the relay's own count
 * until the write lands and replaces both.
 */
export async function commentOnPost(circleId: string, postId: string, body: string): Promise<string> {
  const profile = await getProfile();
  if (!profile) throw new Error('No profile on this device.');

  const commentId = generateUUID();
  const createdAt = Date.now();

  queueComment(
    {
      id: commentId,
      postId,
      circleId,
      authorId: profile.accountId,
      body,
      createdAt,
    },
    {
      circleId,
      op: 'comment',
      postId,
      entryId: commentId,
      plaintext: JSON.stringify({ body, createdAt }),
      createdAt,
    }
  );

  drainOutbox(circleId).catch((err) => console.error('Failed to drain outbox', err));
  return commentId;
}

/**
 * Removes a comment. The relay enforces author-or-admin; this only
 * queues it, and a refusal surfaces through the outbox banner rather
 * than being guessed at here.
 */
export async function deleteComment(circleId: string, postId: string, commentId: string): Promise<void> {
  const at = Date.now();
  queueCommentDeletion(commentId, at, {
    circleId,
    op: 'delete_comment',
    postId,
    entryId: commentId,
    createdAt: at,
  });

  drainOutbox(circleId).catch((err) => console.error('Failed to drain outbox', err));
}
