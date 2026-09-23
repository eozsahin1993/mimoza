import { applyChildren, applyReactions, markChildrenFetched, type NewComment, type NewReaction } from '@/data/db';
import { openContent } from '@/core/crypto/content';
import type { EntryContext } from '@/core/sync/entry-handlers/types';
import type { CommentEntry, ReactionEntry } from '@/features/post/services/post-relay';

type CommentContent = { body: string; createdAt: number };
type ReactionContent = { emoji: string };

/**
 * Applies everything hanging off one post, fetched when it is opened.
 *
 * Both lists replace what was there, minus this device's own pending
 * rows — those are settled by the write that queued them, not by a
 * fetch that may predate it. `childrenFetchedAt` is what decides whether
 * opening the post again needs a call at all.
 */
export async function applyChildrenEntries(
  ctx: EntryContext,
  postId: string,
  children: { comments: CommentEntry[]; reactions: ReactionEntry[] },
  now: number
): Promise<void> {
  const comments: NewComment[] = [];
  for (const comment of children.comments) {
    const key = ctx.keys[comment.keyVersion];
    const content = comment.ciphertext && key ? openContent<CommentContent>(comment.ciphertext, key) : null;
    if (!comment.deletedAt && !content) {
      console.warn(`Skipping comment ${comment.commentId} on ${postId}: no key or failed to decrypt`);
      continue;
    }
    comments.push({
      id: comment.commentId,
      postId,
      circleId: ctx.circleId,
      authorId: comment.authorId,
      parentCommentId: comment.parentCommentId ?? null,
      body: content?.body ?? '',
      createdAt: content?.createdAt ?? comment.receivedAt,
      deletedAt: comment.deletedAt ?? null,
    });
  }

  // The emoji comes out of the reaction's own ciphertext, which is
  // authoritative — the tag table only names the eight in the palette,
  // and only under key versions this device holds. Falling back to it
  // keeps a row nameable when the ciphertext is missing or unreadable.
  const reactions: NewReaction[] = children.reactions.map((reaction) => {
    const key = ctx.keys[reaction.keyVersion];
    const content = reaction.ciphertext && key ? openContent<ReactionContent>(reaction.ciphertext, key) : null;
    return {
      postId,
      circleId: ctx.circleId,
      accountId: reaction.accountId,
      tag: reaction.tag,
      emoji: content?.emoji ?? ctx.tags[reaction.tag] ?? '',
      keyVersion: reaction.keyVersion,
      createdAt: reaction.receivedAt,
    };
  });

  await applyChildren(postId, comments);
  await applyReactions(postId, reactions);
  await markChildrenFetched(postId, now);
}
