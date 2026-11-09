import { childrenAreStale, getCircle, getPost, markPostViewed } from '@/data/db';
import { applyChildrenEntries, entryContext } from '@/core/sync/entry-handlers';
import { getChildren } from '@/features/post/services/post-relay';

/**
 * Opening a post: mark it seen, and fetch its comments and reactions if
 * what is stored is older than the post itself.
 *
 * Children are never walked — the wall renders from the post row alone —
 * so this is the only thing that fills them. A post nobody has touched
 * since the last open costs no request, which is what
 * `childrenFetchedAt` against `updatedAt` decides.
 *
 * Always renders from what is stored first; this refreshes behind that,
 * and resolves true when it did, so the screen knows to read again.
 * A circle this account has left is only ever read as stored: the relay
 * would refuse the fetch as not-a-member.
 */
export async function openPost(circleId: string, postId: string): Promise<boolean> {
  await markPostViewed(postId, Date.now());

  const post = await getPost(postId);
  if (!post || !childrenAreStale(post)) return false;

  const circle = await getCircle(circleId);
  if (circle?.leftAt != null) return false;

  const ctx = await entryContext(circleId);
  if (!ctx) return false;

  const children = await getChildren(circleId, postId);
  await applyChildrenEntries(ctx, postId, children, Date.now());
  return true;
}
