import { and, eq } from 'drizzle-orm';

import { db } from '@/data/db/connection';
import { attachments, outbox, postComments, postReactions, posts } from '@/data/db/schema';
import type { NewAttachment } from '@/data/db/attachments';
import type { NewComment } from '@/data/db/comments';
import type { NewOutboxEntry } from '@/data/db/outbox';
import type { NewPost } from '@/data/db/posts';
import type { NewReaction } from '@/data/db/reactions';

/**
 * A local change and the write that will carry it, in one transaction.
 *
 * Both halves or neither: a local row with no queued write shows
 * something that will never reach anyone, and a queued write with no
 * local row makes the app look like it dropped what was just done. The
 * local half is always the optimistic one — a pending flag or a queued
 * op — which a read adjusts by and the relay's answer replaces.
 */

/** A post this device just made: bytes are already here, so the attachment starts fetched. */
export function queuePost(post: NewPost, attachment: NewAttachment, entry: NewOutboxEntry): void {
  db.transaction((tx) => {
    tx.insert(posts).values(post).onConflictDoNothing().run();
    tx.insert(attachments).values(attachment).onConflictDoNothing().run();
    tx.insert(outbox).values(entry).run();
  });
}

export function queueComment(comment: NewComment, entry: NewOutboxEntry): void {
  db.transaction((tx) => {
    tx.insert(postComments).values({ ...comment, pending: true }).onConflictDoNothing().run();
    tx.insert(outbox).values(entry).run();
  });
}

/** A tap, either direction. The card sums the relay's counts plus adds minus removes. */
export function queueReactionChange(reaction: NewReaction, op: 'add' | 'remove', entry: NewOutboxEntry): void {
  db.transaction((tx) => {
    tx.insert(postReactions)
      .values({ ...reaction, pendingOp: op })
      .onConflictDoUpdate({
        target: [postReactions.postId, postReactions.accountId, postReactions.tag],
        set: { pendingOp: op },
      })
      .run();
    tx.insert(outbox).values(entry).run();
  });
}

/** The row stays: a walk will deliver the relay's own deletion to it. */
export function queuePostDeletion(postId: string, at: number, entry: NewOutboxEntry): void {
  db.transaction((tx) => {
    tx.update(posts).set({ deletedAt: at, caption: '' }).where(eq(posts.id, postId)).run();
    tx.insert(outbox).values(entry).run();
  });
}

export function queueCommentDeletion(commentId: string, at: number, entry: NewOutboxEntry): void {
  db.transaction((tx) => {
    tx.update(postComments).set({ deletedAt: at, body: '' }).where(eq(postComments.id, commentId)).run();
    tx.insert(outbox).values(entry).run();
  });
}

export function queueVisibility(postId: string, inAlbum: boolean, entry: NewOutboxEntry): void {
  db.transaction((tx) => {
    tx.update(posts).set({ inAlbum }).where(eq(posts.id, postId)).run();
    tx.insert(outbox).values(entry).run();
  });
}

/** Drops a failed write and the optimistic row it was carrying. */
export function abandon(seq: number, target?: { commentId?: string; postId?: string; accountId?: string; tag?: string }): void {
  db.transaction((tx) => {
    tx.delete(outbox).where(eq(outbox.seq, seq)).run();
    if (target?.commentId) {
      tx.delete(postComments)
        .where(and(eq(postComments.id, target.commentId), eq(postComments.pending, true)))
        .run();
    }
    if (target?.postId && target.accountId && target.tag) {
      tx.delete(postReactions)
        .where(
          and(
            eq(postReactions.postId, target.postId),
            eq(postReactions.accountId, target.accountId),
            eq(postReactions.tag, target.tag)
          )
        )
        .run();
    }
  });
}
