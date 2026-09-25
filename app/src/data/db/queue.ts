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

/**
 * A tap, either direction. Toggling again before the first tap has sent
 * cancels it rather than queuing a second op to race it: settleReaction
 * (reactions.ts) confirms whatever the row's pendingOp currently says,
 * not the op its own entry actually carried, so two in flight at once
 * lets the first one's confirmation delete or clear a row a second,
 * unsent tap has since repurposed. Nothing has reached the relay while
 * an entry is still queued, so cancelling it needs no write of its own —
 * the row just reverts to what it was before that entry existed.
 */
export function queueReactionChange(reaction: NewReaction, op: 'add' | 'remove', entry: NewOutboxEntry): void {
  db.transaction((tx) => {
    const queued = tx
      .select({ seq: outbox.seq, op: outbox.op })
      .from(outbox)
      .where(and(eq(outbox.postId, reaction.postId), eq(outbox.entryId, reaction.tag), eq(outbox.status, 'queued')))
      .all();

    if (queued.length > 0) {
      for (const row of queued) tx.delete(outbox).where(eq(outbox.seq, row.seq)).run();
      const target = and(
        eq(postReactions.postId, reaction.postId),
        eq(postReactions.accountId, reaction.accountId),
        eq(postReactions.tag, reaction.tag)
      );
      // Cancelling a queued add leaves never-reacted; cancelling a
      // queued remove leaves the confirmed reaction it was queued
      // against, so the row stays rather than being deleted.
      if (queued.some((row) => row.op === 'reaction')) {
        tx.delete(postReactions).where(target).run();
      } else {
        tx.update(postReactions).set({ pendingOp: null }).where(target).run();
      }
      return;
    }

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
