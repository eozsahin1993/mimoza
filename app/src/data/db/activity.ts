import { and, desc, eq, gt } from 'drizzle-orm';

import { db } from '@/data/db/connection';
import { activity } from '@/data/db/schema';

export type Activity = typeof activity.$inferSelect;
export type NewActivity = typeof activity.$inferInsert;

/** Relay-written and immutable, so a repeat is the same row. */
export async function insertActivity(entry: NewActivity): Promise<void> {
  await db.insert(activity).values(entry).onConflictDoNothing();
}

export async function listActivity(circleId: string, limit = 100): Promise<Activity[]> {
  return db
    .select()
    .from(activity)
    .where(eq(activity.circleId, circleId))
    .orderBy(desc(activity.receivedAt))
    .limit(limit);
}

/** What the wall interleaves with posts since it was last opened. */
export async function listActivitySince(circleId: string, since: number): Promise<Activity[]> {
  return db
    .select()
    .from(activity)
    .where(and(eq(activity.circleId, circleId), gt(activity.receivedAt, since)))
    .orderBy(desc(activity.receivedAt));
}
