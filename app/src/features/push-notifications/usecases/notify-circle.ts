import { bytesToHex } from '@noble/curves/utils.js';

import { getCircleMembers, getCommentAuthors, getPost, hasOtherReaction } from '@/data/db';
import { verifyLogEntry } from '@/core/sync/log-entry';
import { PushCategories, type PushCategory } from '@/features/push-notifications/usecases/push-categories';
import { derivePushFanoutToken } from '@/core/crypto/push';
import { getCircleIdentity, getCurrentContentKey } from '@/core/services/keystore/circle-keys';
import { sendPush } from '@/core/services/push-relay';

/**
 * Asks the relay to notify a circle about an entry that was just
 * appended.
 *
 * `payload` is the entry's own ciphertext, forwarded untouched: the relay
 * cannot read it, and the receiving device decrypts and writes the
 * notification text itself. A post reaches everyone; a reaction or a
 * comment is scoped down to who's actually involved (see
 * `reactionRecipients`/`commentRecipients`) — recipient scoping happens
 * here, once, rather than in each usecase that enqueues an entry.
 */
export async function notifyCircle(
  circleId: string,
  category: PushCategory,
  keyVersion: number,
  payload: Uint8Array,
): Promise<void> {
  const identity = await getCircleIdentity(circleId);
  const current = await getCurrentContentKey(circleId);
  if (!identity || !current) return;

  const members = await getCircleMembers(circleId);
  // Your devices share one routing id, so excluding it silences all of
  // them — which is what you want for something you just posted.
  const ownPublicKey = bytesToHex(identity.publicKey);
  let recipients = members.filter((member) => member.identityPublicKey !== ownPublicKey && member.pushRoutingId !== '');

  if (category === PushCategories.reaction) {
    const interested = await reactionRecipients(payload, current.key, ownPublicKey);
    recipients = recipients.filter((member) => interested.has(member.identityPublicKey));
  } else if (category === PushCategories.comment) {
    const interested = await commentRecipients(payload, current.key);
    recipients = recipients.filter((member) => interested.has(member.identityPublicKey));
  }

  const routingIds = recipients.map((member) => member.pushRoutingId);
  if (routingIds.length === 0) return;

  // Shuffled: sending in roster order would leak the roster's ordering
  // across posts, which is stable and therefore correlatable.
  await sendPush(shuffle(routingIds), derivePushFanoutToken(current.key), category, keyVersion, payload);
}

/**
 * Who a reaction should notify: the post's author, and only on the
 * reactor's first active emoji on that post — a toggle-off (`reacted:
 * false`) or a second emoji added to a post already reacted to notifies
 * nobody (see `hasOtherReaction`). No identifiable post (deleted, or a
 * payload this device can't make sense of) notifies nobody rather than
 * falling back to everyone.
 */
async function reactionRecipients(payload: Uint8Array, contentKey: Uint8Array, reactorPublicKey: string): Promise<Set<string>> {
  const envelope = verifyLogEntry(payload, contentKey);
  const record = envelope?.payload as { postId?: unknown; emoji?: unknown; reacted?: unknown } | undefined;
  const { postId, emoji, reacted } = record ?? {};
  if (typeof postId !== 'string' || typeof emoji !== 'string' || reacted !== true) return new Set();
  if (await hasOtherReaction(postId, reactorPublicKey, emoji)) return new Set();

  const author = (await getPost(postId))?.authorPublicKey;
  return author ? new Set([author]) : new Set();
}

/**
 * Who a comment should notify: the post's author, plus everyone who has
 * already commented on it — a thread's participants, not the whole
 * circle. A post's first comment reaches only its author; the set grows
 * as people join in. Whoever just wrote this comment is always excluded
 * upstream (`recipients` never includes `ownPublicKey`), even if they've
 * commented before and would otherwise be in this set.
 */
async function commentRecipients(payload: Uint8Array, contentKey: Uint8Array): Promise<Set<string>> {
  const envelope = verifyLogEntry(payload, contentKey);
  const postId = (envelope?.payload as { postId?: unknown } | undefined)?.postId;
  if (typeof postId !== 'string') return new Set();

  const [post, priorCommenters] = await Promise.all([getPost(postId), getCommentAuthors(postId)]);
  const interested = new Set(priorCommenters);
  if (post) interested.add(post.authorPublicKey);
  return interested;
}

/**
 * Best-effort wrapper — a notification that doesn't go out must never fail
 * the post that triggered it. Fire without awaiting.
 */
export function notifyCircleBestEffort(
  circleId: string,
  category: PushCategory,
  keyVersion: number,
  payload: Uint8Array,
): void {
  notifyCircle(circleId, category, keyVersion, payload).catch((err) => console.error('Failed to notify circle', err));
}

function shuffle<T>(items: T[]): T[] {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const swap = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
  }
  return shuffled;
}
