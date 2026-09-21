import { eq } from 'drizzle-orm';

import { db } from '@/data/db/connection';
import { pendingJoinRequests } from '@/data/db/schema';

export type PendingJoinRequest = typeof pendingJoinRequests.$inferSelect;

export const PendingJoinRequestStatuses = {
  pending: 'pending',
  approved: 'approved',
} as const;

export async function insertPendingJoinRequest(request: PendingJoinRequest): Promise<void> {
  await db.insert(pendingJoinRequests).values(request);
}

export async function getPendingJoinRequest(id: string): Promise<PendingJoinRequest | null> {
  const rows = await db.select().from(pendingJoinRequests).where(eq(pendingJoinRequests.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function getAllPendingJoinRequests(): Promise<PendingJoinRequest[]> {
  return db.select().from(pendingJoinRequests);
}

/** Marks a request as approved but not yet completed locally — a brief transient state; see the schema's doc comment. */
export async function markPendingJoinRequestApproved(id: string): Promise<void> {
  await db.update(pendingJoinRequests).set({ status: PendingJoinRequestStatuses.approved }).where(eq(pendingJoinRequests.id, id));
}

/** Removes a pending request row — called once `completeJoin` has finished, or if the requester abandons it. */
export async function deletePendingJoinRequest(id: string): Promise<void> {
  await db.delete(pendingJoinRequests).where(eq(pendingJoinRequests.id, id));
}

/** The request registered under this push routing id, if this device made one. */
export async function getPendingJoinRequestByPushRoutingId(pushRoutingId: string): Promise<PendingJoinRequest | null> {
  const rows = await db.select().from(pendingJoinRequests).where(eq(pendingJoinRequests.pushRoutingId, pushRoutingId)).limit(1);
  return rows[0] ?? null;
}
