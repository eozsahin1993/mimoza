import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';

import { db } from '@/data/db/connection';
import { activity, circles, posts } from '@/data/db/schema';

export type Circle = typeof circles.$inferSelect;
export type NewCircle = typeof circles.$inferInsert;

/** What a sync hands back for one circle, before anything else is fetched. */
export type Membership = {
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

export async function upsertCircle(circle: NewCircle): Promise<void> {
  await db
    .insert(circles)
    .values(circle)
    .onConflictDoUpdate({ target: circles.id, set: { name: circle.name } });
}

/**
 * Applies what a sync said about a circle. Only the relay's own fields
 * are written: cursors and local state belong to this device and are
 * left alone.
 */
export async function applyMembership(membership: Membership, now: number): Promise<void> {
  await db
    .insert(circles)
    .values({
      id: membership.circleId,
      name: membership.name,
      coverId: membership.coverId ?? null,
      role: membership.role,
      notifyLevel: membership.notifyLevel,
      keyVersion: membership.keyVersion,
      rosterVersion: membership.rosterVersion,
      lastEntryAt: membership.lastEntryAt ?? 0,
      needsRewrap: membership.needsRewrap ?? false,
      createdAt: now,
      lastViewedAt: now,
    })
    .onConflictDoUpdate({
      target: circles.id,
      set: {
        name: membership.name,
        coverId: membership.coverId ?? null,
        role: membership.role,
        notifyLevel: membership.notifyLevel,
        keyVersion: membership.keyVersion,
        rosterVersion: membership.rosterVersion,
        lastEntryAt: membership.lastEntryAt ?? 0,
        needsRewrap: membership.needsRewrap ?? false,
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

/** Posts and activity newer than the last time this circle was opened. */
export async function getUnreadCount(circleId: string): Promise<number> {
  const circle = await getCircle(circleId);
  if (!circle) return 0;

  const [newPosts] = await db
    .select({ n: sql<number>`count(*)` })
    .from(posts)
    .where(and(eq(posts.circleId, circleId), gt(posts.createdAt, circle.lastViewedAt), isNull(posts.deletedAt)));
  const [newActivity] = await db
    .select({ n: sql<number>`count(*)` })
    .from(activity)
    .where(and(eq(activity.circleId, circleId), gt(activity.receivedAt, circle.lastViewedAt)));

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
