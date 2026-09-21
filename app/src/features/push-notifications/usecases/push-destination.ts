import { getInviteByPushRoutingId, getPendingJoinRequestByPushRoutingId, getPost } from '@/data/db';
import { circleForRoutingId, decryptPushEntry, type PushData } from '@/features/push-notifications/usecases/handle-push';

export type PushDestination =
  | { screen: 'post'; circleId: string; postId: string }
  | { screen: 'feed'; circleId: string }
  | { screen: 'pending'; requestId: string };

/**
 * Where tapping a notification should land. The circle's feed is the
 * floor — a push that names a post this device already holds refines to
 * that post; one it can't decrypt, or whose post hasn't synced yet, still
 * opens the right circle (whose feed syncs on focus and will surface it).
 * Null only when the routing id resolves to no circle here.
 */
export async function resolvePushDestination(data: PushData): Promise<PushDestination | null> {
  if (!data.pushRoutingId) return null;

  // A join request opens the feed its card sits on; news on your own
  // request opens the pending screen, which finishes the join.
  if (data.kind === 'invite') {
    const invite = await getInviteByPushRoutingId(data.pushRoutingId);
    return invite ? { screen: 'feed', circleId: invite.circleId } : null;
  }
  if (data.kind === 'pending_request') {
    const pending = await getPendingJoinRequestByPushRoutingId(data.pushRoutingId);
    return pending ? { screen: 'pending', requestId: pending.id } : null;
  }

  const circle = await circleForRoutingId(data.pushRoutingId);
  if (!circle) return null;

  const envelope = await decryptPushEntry(circle.id, data);
  const postId = (envelope?.payload as { postId?: unknown } | undefined)?.postId;
  if (typeof postId === 'string' && (await getPost(postId))) {
    return { screen: 'post', circleId: circle.id, postId };
  }
  return { screen: 'feed', circleId: circle.id };
}
