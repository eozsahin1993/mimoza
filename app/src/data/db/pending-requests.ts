import { eq } from 'drizzle-orm';

import { db } from '@/data/db/connection';
import { pendingRequests } from '@/data/db/schema';

export type PendingRequest = typeof pendingRequests.$inferSelect;

/**
 * Asks to join, until the relay answers. The relay returns these on
 * every sync, so this is a local copy of what it said rather than a
 * source of truth.
 */
export async function upsertRequest(request: typeof pendingRequests.$inferInsert): Promise<void> {
  await db
    .insert(pendingRequests)
    .values(request)
    .onConflictDoUpdate({
      target: pendingRequests.circleId,
      set: { status: request.status, circleName: request.circleName },
    });
}

export async function listRequests(): Promise<PendingRequest[]> {
  return db.select().from(pendingRequests);
}

export async function getRequest(circleId: string): Promise<PendingRequest | null> {
  const [row] = await db.select().from(pendingRequests).where(eq(pendingRequests.circleId, circleId)).limit(1);
  return row ?? null;
}

export async function dropRequest(circleId: string): Promise<void> {
  await db.delete(pendingRequests).where(eq(pendingRequests.circleId, circleId));
}
