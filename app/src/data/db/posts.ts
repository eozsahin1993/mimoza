import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';

import { db } from '@/data/db/connection';
import { posts } from '@/data/db/schema';

export type Post = typeof posts.$inferSelect;
export type NewPost = typeof posts.$inferInsert;

/**
 * Applies what a sync said about a post. The relay-owned half is
 * replaced wholesale; the local half — when it was last viewed, when its
 * children were last fetched — is this device's and is left alone.
 */
export async function applyPost(post: NewPost): Promise<void> {
  await db
    .insert(posts)
    .values(post)
    .onConflictDoUpdate({
      target: posts.id,
      set: {
        caption: post.caption ?? '',
        inAlbum: post.inAlbum ?? true,
        deletedAt: post.deletedAt ?? null,
        updatedAt: post.updatedAt ?? 0,
        commentCount: post.commentCount ?? 0,
        reactionCounts: post.reactionCounts ?? '{}',
        unnamedReactions: post.unnamedReactions ?? 0,
        recentCommentIds: post.recentCommentIds ?? '[]',
        iReacted: post.iReacted ?? false,
        iCommented: post.iCommented ?? false,
      },
    });
}

export async function getPost(postId: string): Promise<Post | null> {
  const [row] = await db.select().from(posts).where(eq(posts.id, postId)).limit(1);
  return row ?? null;
}

/**
 * One page of the wall, newest first by the author's own clock so two
 * devices that have caught up agree on the order.
 */
export async function getFeed(circleId: string, limit = 20, before?: number): Promise<Post[]> {
  const where = before
    ? and(eq(posts.circleId, circleId), isNull(posts.deletedAt), lt(posts.createdAt, before))
    : and(eq(posts.circleId, circleId), isNull(posts.deletedAt));

  return db.select().from(posts).where(where).orderBy(desc(posts.createdAt)).limit(limit);
}

/** The album is every post its author kept in it. */
export async function getAlbum(circleId: string): Promise<Post[]> {
  return db
    .select()
    .from(posts)
    .where(and(eq(posts.circleId, circleId), eq(posts.inAlbum, true), isNull(posts.deletedAt)))
    .orderBy(desc(posts.createdAt));
}

export async function getPosts(postIds: string[]): Promise<Post[]> {
  if (postIds.length === 0) return [];
  return db.select().from(posts).where(inArray(posts.id, postIds));
}

export async function markPostViewed(postId: string, at: number): Promise<void> {
  await db.update(posts).set({ lastViewedAt: at }).where(eq(posts.id, postId));
}

export async function markChildrenFetched(postId: string, at: number): Promise<void> {
  await db.update(posts).set({ childrenFetchedAt: at }).where(eq(posts.id, postId));
}

/**
 * Whether opening this post needs a call: never fetched, or the relay
 * has changed it since it last was.
 */
export function childrenAreStale(post: Post): boolean {
  return post.childrenFetchedAt === null || post.childrenFetchedAt < post.updatedAt;
}

export async function setInAlbum(postId: string, inAlbum: boolean): Promise<void> {
  await db.update(posts).set({ inAlbum }).where(eq(posts.id, postId));
}

/** Kept, not removed: a walk delivers the deletion and the row is what receives it. */
export async function markPostDeleted(postId: string, at: number): Promise<void> {
  await db.update(posts).set({ deletedAt: at, caption: '' }).where(eq(posts.id, postId));
}

/** Posts with comments this device has not seen, for the wall's marker. */
export async function getPostsWithUnseenComments(circleId: string): Promise<string[]> {
  const rows = await db
    .select({ id: posts.id })
    .from(posts)
    .where(
      and(
        eq(posts.circleId, circleId),
        isNull(posts.deletedAt),
        sql`${posts.commentCount} > 0`,
        sql`(${posts.lastViewedAt} is null or ${posts.updatedAt} > ${posts.lastViewedAt})`
      )
    );
  return rows.map((row) => row.id);
}
