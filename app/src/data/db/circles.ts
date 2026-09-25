import { and, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';

import { db } from '@/data/db/connection';
import { activity, circles, posts } from '@/data/db/schema';

export type Circle = typeof circles.$inferSelect;
export type NewCircle = typeof circles.$inferInsert;

/**
 * A circle as the relay describes it. Spelled out here rather than
 * imported from the relay client, because this layer does not depend on
 * features/ — and not exported, because `applyCircle` is the only thing
 * that ever holds one.
 */
type RelayCircle = {
  circleId: string;
  name: string;
  coverId?: string | null;
  role: string;
  notifyLevel: string;
  keyVersion: number;
  rosterVersion: number;
  lastEntryAt?: number;
  needsRewrap?: boolean;
};

/**
 * Writes what the relay said about a circle — from the circle list, or
 * from the response to creating one.
 *
 * Only the relay's own fields are touched. The cursors, the last-viewed
 * mark and `leftAt` belong to this device and are left exactly as they
 * were, which is what makes this safe to call on every sync pass.
 */
export async function applyCircle(circle: RelayCircle, now: number): Promise<void> {
  await db
    .insert(circles)
    .values({
      id: circle.circleId,
      name: circle.name,
      coverId: circle.coverId ?? null,
      role: circle.role,
      notifyLevel: circle.notifyLevel,
      keyVersion: circle.keyVersion,
      rosterVersion: circle.rosterVersion,
      lastEntryAt: circle.lastEntryAt ?? 0,
      needsRewrap: circle.needsRewrap ?? false,
      createdAt: now,
      lastViewedAt: now,
    })
    .onConflictDoUpdate({
      target: circles.id,
      set: {
        name: circle.name,
        coverId: circle.coverId ?? null,
        role: circle.role,
        notifyLevel: circle.notifyLevel,
        keyVersion: circle.keyVersion,
        rosterVersion: circle.rosterVersion,
        lastEntryAt: circle.lastEntryAt ?? 0,
        needsRewrap: circle.needsRewrap ?? false,
        leftAt: null,
      },
    });
}

export async function getCircle(circleId: string): Promise<Circle | null> {
  const [row] = await db.select().from(circles).where(eq(circles.id, circleId)).limit(1);
  return row ?? null;
}

/** Circles this device is still in, newest activity first. */
export async function listCircles(): Promise<Circle[]> {
  return db.select().from(circles).where(isNull(circles.leftAt)).orderBy(desc(circles.lastEntryAt));
}

/** Circles left behind, kept as a local archive rather than deleted. */
export async function listLeftCircles(): Promise<Circle[]> {
  return db.select().from(circles).where(sql`${circles.leftAt} is not null`).orderBy(desc(circles.leftAt));
}

export async function listAllCircles(): Promise<Circle[]> {
  return db.select().from(circles);
}

/** Cursors are opaque: this device stores what the relay handed it. */
export async function saveCursors(
  circleId: string,
  cursors: { postsForward?: string | null; postsBackward?: string | null; activity?: string | null }
): Promise<void> {
  const set: Partial<typeof circles.$inferInsert> = {};
  if (cursors.postsForward !== undefined) set.postsForwardCursor = cursors.postsForward;
  if (cursors.postsBackward !== undefined) set.postsBackwardCursor = cursors.postsBackward;
  if (cursors.activity !== undefined) set.activityCursor = cursors.activity;
  if (Object.keys(set).length === 0) return;
  await db.update(circles).set(set).where(eq(circles.id, circleId));
}

export async function markCircleViewed(circleId: string, at: number): Promise<void> {
  await db.update(circles).set({ lastViewedAt: at }).where(eq(circles.id, circleId));
}

/**
 * Posts and activity newer than the last time this circle was opened,
 * excluding this account's own — posting or renaming a circle yourself is
 * not news to you, and would otherwise badge a circle you just touched.
 */
export async function getUnreadCount(circleId: string, myAccountId: string): Promise<number> {
  const circle = await getCircle(circleId);
  if (!circle) return 0;

  const [newPosts] = await db
    .select({ n: sql<number>`count(*)` })
    .from(posts)
    .where(
      and(
        eq(posts.circleId, circleId),
        gt(posts.createdAt, circle.lastViewedAt),
        isNull(posts.deletedAt),
        ne(posts.authorId, myAccountId)
      )
    );
  const [newActivity] = await db
    .select({ n: sql<number>`count(*)` })
    .from(activity)
    .where(
      and(eq(activity.circleId, circleId), gt(activity.receivedAt, circle.lastViewedAt), ne(activity.actorId, myAccountId))
    );

  return (newPosts?.n ?? 0) + (newActivity?.n ?? 0);
}

export async function setNotifyLevel(circleId: string, level: string): Promise<void> {
  await db.update(circles).set({ notifyLevel: level }).where(eq(circles.id, circleId));
}

export async function setCover(circleId: string, coverId: string | null): Promise<void> {
  await db.update(circles).set({ coverId }).where(eq(circles.id, circleId));
}

export async function renameCircle(circleId: string, name: string): Promise<void> {
  await db.update(circles).set({ name }).where(eq(circles.id, circleId));
}

/** Left, not gone: the posts already synced stay readable offline. */
export async function markCircleLeft(circleId: string, at: number): Promise<void> {
  await db.update(circles).set({ leftAt: at }).where(eq(circles.id, circleId));
}

export async function deleteCircle(circleId: string): Promise<void> {
  await db.delete(circles).where(eq(circles.id, circleId));
}
