import { getProfile, listReactors, queueReactionChange, summarise, type ReactionSummary } from '@/data/db';
import { reactionTag, reactionTagKey } from '@/core/crypto/reaction-tags';
import { getCircleKeyMap, getCurrentContentKey } from '@/core/services/keystore/circle-keys';
import { drainOutbox } from '@/core/sync/drain-outbox';

/**
 * Adds or removes one of this account's reactions. A member may hold
 * several at once, so a tap toggles that emoji alone rather than
 * replacing whatever was there.
 *
 * The tag is what the relay counts by. It never rotates, so removing a
 * reaction made long ago derives the same one — the row carries it
 * anyway, which is what the drain sends.
 */
export async function toggleReaction(circleId: string, postId: string, emoji: string): Promise<void> {
  const profile = await getProfile();
  if (!profile) throw new Error('No profile on this device.');
  const current = await getCurrentContentKey(circleId);
  if (!current) throw new Error('No content key on this device.');
  const tagKey = reactionTagKey(circleId, (await getCircleKeyMap(circleId)) ?? {});
  if (!tagKey) throw new Error('No reaction key for this circle on this device.');

  const op = (await holds(postId, profile.accountId, emoji)) ? 'remove' : 'add';
  const tag = reactionTag(emoji, tagKey);
  const createdAt = Date.now();

  queueReactionChange(
    { postId, circleId, accountId: profile.accountId, tag, emoji, keyVersion: current.version, createdAt },
    op,
    {
      circleId,
      op: op === 'add' ? 'reaction' : 'unreact',
      postId,
      // The tag, so the drain removes exactly the one that was tapped.
      entryId: tag,
      plaintext: JSON.stringify({ emoji }),
      createdAt,
    }
  );

  drainOutbox(circleId).catch((err) => console.error('Failed to drain outbox', err));
}

/**
 * Whether this account already holds that emoji on the post, pending
 * rows included. Only ever asked where the children have been fetched —
 * the wall shows a filled state, not which emoji, so it never gets here.
 */
async function holds(postId: string, accountId: string, emoji: string): Promise<boolean> {
  const reactors = await listReactors(postId);
  return reactors.some((reactor) => reactor.accountId === accountId && reactor.emoji === emoji);
}

/** What the card shows: the relay's counts, adjusted by whatever is still queued. */
export async function getReactions(postId: string): Promise<ReactionSummary> {
  const profile = await getProfile();
  if (!profile) return { counts: {}, total: 0, iReacted: false };
  return summarise(postId, profile.accountId);
}
