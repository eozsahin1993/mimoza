import {
  AttachmentKinds,
  AttachmentStatuses,
  applyComment,
  applyPost,
  insertAttachment,
  type NewComment,
} from '@/data/db';
import { openContent } from '@/core/crypto/content';
import type { EntryContext } from '@/core/sync/entry-handlers/types';
import { Visibility, type CommentEntry, type Entry } from '@/features/post/services/post-relay';

/** What a post's ciphertext holds. `createdAt` is the author's clock, which is what the wall sorts on. */
type PostContent = {
  caption: string;
  createdAt: number;
  photoHash: string;
};

type CommentContent = { body: string; createdAt: number };

/**
 * Splits the relay's tag counts into emoji this device can name and a
 * total it cannot. A tag is unnameable when it was made with an emoji
 * outside this build's palette; it still counts toward the total, so a
 * newer peer's reaction is never silently lost.
 */
function namedCounts(
  counts: Record<string, number>,
  tags: Record<string, string>
): { byEmoji: Record<string, number>; unnamed: number } {
  const byEmoji: Record<string, number> = {};
  let unnamed = 0;
  for (const [tag, n] of Object.entries(counts)) {
    if (n <= 0) continue;
    const emoji = tags[tag];
    if (emoji) byEmoji[emoji] = n;
    else unnamed += n;
  }
  return { byEmoji, unnamed };
}

/**
 * Decrypts the comments the relay carries on the post row. They are real
 * comments and go into the same table the children fetch fills; the post
 * only remembers which ids to show as its preview.
 *
 * Decrypting is separated from writing because the rows reference the
 * post, which has to exist first.
 */
function decodePreview(ctx: EntryContext, postId: string, preview: CommentEntry[]): NewComment[] {
  const comments: NewComment[] = [];
  for (const comment of preview) {
    const key = ctx.keys[comment.keyVersion];
    const content = comment.ciphertext && key ? openContent<CommentContent>(comment.ciphertext, key) : null;
    if (!comment.deletedAt && !content) {
      console.warn(`Skipping preview comment ${comment.commentId} on ${postId}: no key or failed to decrypt`);
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
  return comments;
}

/**
 * Applies one post from a walk: the relay-owned half wholesale, the
 * decrypted caption once, and the preview comments into their own table.
 *
 * A deleted post arrives with no ciphertext and is still written, so the
 * row that stood in the feed is the one that receives the deletion.
 */
export async function applyPostEntry(ctx: EntryContext, entry: Entry): Promise<void> {
  const key = entry.keyVersion === undefined ? undefined : ctx.keys[entry.keyVersion];
  const content = entry.ciphertext && key ? openContent<PostContent>(entry.ciphertext, key) : null;
  if (!entry.deletedAt && !content) {
    console.warn(`Skipping post ${entry.entryId} in ${ctx.circleId}: no key for version ${entry.keyVersion} or failed to decrypt`);
    return;
  }

  const { byEmoji, unnamed } = namedCounts(entry.reactionCounts ?? {}, ctx.tags);
  const preview = decodePreview(ctx, entry.entryId, entry.recentComments ?? []);

  await applyPost({
    id: entry.entryId,
    circleId: ctx.circleId,
    authorId: entry.authorId,
    caption: content?.caption ?? '',
    createdAt: content?.createdAt ?? entry.receivedAt,
    receivedAt: entry.receivedAt,
    // A post with no visibility yet was never moved, and the album is
    // where one starts.
    inAlbum: entry.visibility !== Visibility.FEED,
    deletedAt: entry.deletedAt ?? null,
    updatedAt: entry.updatedAt ?? entry.receivedAt,
    commentCount: entry.commentCount ?? 0,
    reactionCounts: JSON.stringify(byEmoji),
    unnamedReactions: unnamed,
    recentCommentIds: JSON.stringify(preview.map((comment) => comment.id)),
    iReacted: entry.iReacted ?? false,
    iCommented: entry.iCommented ?? false,
  });

  // After the post: these rows reference it.
  for (const comment of preview) await applyComment(comment);

  // The photo's bytes are fetched later by the download queue; this row
  // is all it needs to go find them. keyVersion is the entry's, not the
  // circle's current one — after a rotation those differ, and the blob
  // was sealed under whichever was current when it was uploaded.
  if (entry.hasBlob && content && entry.keyVersion !== undefined) {
    await insertAttachment({
      circleId: ctx.circleId,
      entryId: entry.entryId,
      kind: AttachmentKinds.POST_PHOTO,
      bytes: null,
      hash: content.photoHash,
      keyVersion: entry.keyVersion,
      status: AttachmentStatuses.PENDING,
      fetchAttempts: 0,
      nextAttemptAt: null,
      createdAt: entry.receivedAt,
    });
  }
}
