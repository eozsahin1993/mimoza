import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

import { db } from '@/data/db/connection';
import { circleMembers, postComments } from '@/data/db/schema';

export type Comment = typeof postComments.$inferSelect;
export type NewComment = typeof postComments.$inferInsert;
export type CommentWithAuthor = Comment & { authorName: string };

/**
 * Comments arrive three ways: the preview the relay carries on every
 * post, the children fetch when a post is opened, and this device's own,
 * written pending beside their outbox row.
 */
export async function applyComment(comment: NewComment): Promise<void> {
  await db
    .insert(postComments)
    .values(comment)
    .onConflictDoUpdate({
      target: postComments.id,
      set: {
        body: comment.body ?? '',
        deletedAt: comment.deletedAt ?? null,
        // Confirmed by the relay, so it is no longer only ours.
        pending: false,
      },
    });
}

export async function insertPendingComment(comment: NewComment): Promise<void> {
  await db.insert(postComments).values({ ...comment, pending: true }).onConflictDoNothing();
}

/** Replaces a post's comments with what the relay just returned. */
export async function applyChildren(postId: string, comments: NewComment[]): Promise<void> {
  await db.delete(postComments).where(and(eq(postComments.postId, postId), eq(postComments.pending, false)));
  for (const comment of comments) await applyComment(comment);
}

export async function listComments(postId: string): Promise<CommentWithAuthor[]> {
  const rows = await db
    .select({ comment: postComments, name: circleMembers.name })
    .from(postComments)
    .leftJoin(
      circleMembers,
      and(
        eq(circleMembers.circleId, postComments.circleId),
        eq(circleMembers.accountId, postComments.authorId)
      )
    )
    .where(and(eq(postComments.postId, postId), isNull(postComments.deletedAt)))
    .orderBy(asc(postComments.createdAt));

  return rows.map((row) => ({ ...row.comment, authorName: row.name ?? '' }));
}

/** The preview on a card: the comments the relay named on the post row, minus any since deleted. */
export async function getComments(commentIds: string[]): Promise<CommentWithAuthor[]> {
  if (commentIds.length === 0) return [];
  const rows = await db
    .select({ comment: postComments, name: circleMembers.name })
    .from(postComments)
    .leftJoin(
      circleMembers,
      and(
        eq(circleMembers.circleId, postComments.circleId),
        eq(circleMembers.accountId, postComments.authorId)
      )
    )
    .where(and(inArray(postComments.id, commentIds), isNull(postComments.deletedAt)))
    .orderBy(asc(postComments.createdAt));

  return rows.map((row) => ({ ...row.comment, authorName: row.name ?? '' }));
}

export async function markCommentDeleted(commentId: string, at: number): Promise<void> {
  await db.update(postComments).set({ deletedAt: at, body: '' }).where(eq(postComments.id, commentId));
}

export async function dropPendingComment(commentId: string): Promise<void> {
  await db.delete(postComments).where(and(eq(postComments.id, commentId), eq(postComments.pending, true)));
}
