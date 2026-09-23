import { and, eq, sql } from 'drizzle-orm';

import { db } from '@/data/db/connection';
import { circleMembers, postReactions, posts } from '@/data/db/schema';

export type Reaction = typeof postReactions.$inferSelect;
export type NewReaction = typeof postReactions.$inferInsert;

/** What a card shows: emoji, how many, and whether you are among them. */
export type ReactionSummary = {
  counts: Record<string, number>;
  total: number;
  iReacted: boolean;
};

/**
 * Replaces a post's reactions with what the children fetch returned.
 * Pending rows survive: they are this device's own, not yet confirmed.
 */
export async function applyReactions(postId: string, reactions: NewReaction[]): Promise<void> {
  await db.delete(postReactions).where(and(eq(postReactions.postId, postId), sql`${postReactions.pendingOp} is null`));
  for (const reaction of reactions) {
    await db
      .insert(postReactions)
      .values({ ...reaction, pendingOp: null })
      .onConflictDoUpdate({
        target: [postReactions.postId, postReactions.accountId, postReactions.tag],
        set: { emoji: reaction.emoji ?? '', keyVersion: reaction.keyVersion ?? null, pendingOp: null },
      });
  }
}

/** A tap, before the relay has answered. */
export async function queueReaction(reaction: NewReaction, op: 'add' | 'remove'): Promise<void> {
  await db
    .insert(postReactions)
    .values({ ...reaction, pendingOp: op })
    .onConflictDoUpdate({
      target: [postReactions.postId, postReactions.accountId, postReactions.tag],
      set: { pendingOp: op },
    });
}

/** Called when the relay confirms, in the same transaction as the post. */
export async function settleReaction(postId: string, accountId: string, tag: string): Promise<void> {
  const [row] = await db
    .select()
    .from(postReactions)
    .where(
      and(
        eq(postReactions.postId, postId),
        eq(postReactions.accountId, accountId),
        eq(postReactions.tag, tag)
      )
    )
    .limit(1);
  if (!row) return;

  if (row.pendingOp === 'remove') {
    await db
      .delete(postReactions)
      .where(
        and(
          eq(postReactions.postId, postId),
          eq(postReactions.accountId, accountId),
          eq(postReactions.tag, tag)
        )
      );
    return;
  }
  await db
    .update(postReactions)
    .set({ pendingOp: null })
    .where(
      and(
        eq(postReactions.postId, postId),
        eq(postReactions.accountId, accountId),
        eq(postReactions.tag, tag)
      )
    );
}

/**
 * The card's reaction state: the relay's counts, adjusted by whatever
 * this device has queued and the relay has not answered yet.
 */
export async function summarise(postId: string, accountId: string): Promise<ReactionSummary> {
  const [post] = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
  if (!post) return { counts: {}, total: 0, iReacted: false };

  const counts: Record<string, number> = JSON.parse(post.reactionCounts);
  let total = Object.values(counts).reduce((sum, n) => sum + n, 0) + post.unnamedReactions;
  let iReacted = post.iReacted;

  const pending = await db
    .select()
    .from(postReactions)
    .where(and(eq(postReactions.postId, postId), eq(postReactions.accountId, accountId)));

  for (const row of pending) {
    if (row.pendingOp === 'add') {
      counts[row.emoji] = (counts[row.emoji] ?? 0) + 1;
      total += 1;
      iReacted = true;
    }
    if (row.pendingOp === 'remove') {
      counts[row.emoji] = Math.max((counts[row.emoji] ?? 0) - 1, 0);
      total = Math.max(total - 1, 0);
      if (counts[row.emoji] === 0) delete counts[row.emoji];
    }
  }
  if (pending.some((row) => row.pendingOp === 'remove') && !pending.some((row) => row.pendingOp === 'add')) {
    iReacted = pending.some((row) => row.pendingOp === null);
  }

  return { counts, total, iReacted };
}

/** Who reacted, for the post screen. Empty until the post is opened. */
export async function listReactors(postId: string): Promise<{ accountId: string; name: string; emoji: string }[]> {
  const rows = await db
    .select({ reaction: postReactions, name: circleMembers.name })
    .from(postReactions)
    .leftJoin(
      circleMembers,
      and(
        eq(circleMembers.circleId, postReactions.circleId),
        eq(circleMembers.accountId, postReactions.accountId)
      )
    )
    .where(and(eq(postReactions.postId, postId), sql`${postReactions.pendingOp} is not 'remove'`));

  return rows.map((row) => ({
    accountId: row.reaction.accountId,
    name: row.name ?? '',
    emoji: row.reaction.emoji,
  }));
}
