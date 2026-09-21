import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';

import { db } from '@/data/db/connection';
import { circleInvites } from '@/data/db/schema';

export type Invite = typeof circleInvites.$inferSelect;

export async function insertInvite(invite: Invite): Promise<void> {
  await db.insert(circleInvites).values(invite);
}

/**
 * Returns the circle's current invite, if it has one — the most recent
 * one that hasn't been revoked. May be past its `expiresAt`; callers
 * decide how to present an expired-but-not-revoked invite (e.g. offer to
 * replace it), rather than this query silently hiding it.
 */
export async function getCurrentInvite(circleId: string): Promise<Invite | null> {
  const rows = await db
    .select()
    .from(circleInvites)
    .where(and(eq(circleInvites.circleId, circleId), isNull(circleInvites.revokedAt)))
    .orderBy(desc(circleInvites.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** Revokes an invite — any redemption attempt against it should be rejected from this point on. */
export async function revokeInvite(code: string): Promise<void> {
  await db.update(circleInvites).set({ revokedAt: Date.now() }).where(eq(circleInvites.code, code));
}

/** The invite registered under this push routing id, if it's one of this device's. */
export async function getInviteByPushRoutingId(pushRoutingId: string): Promise<Invite | null> {
  const rows = await db.select().from(circleInvites).where(eq(circleInvites.pushRoutingId, pushRoutingId)).limit(1);
  return rows[0] ?? null;
}

/** Every invite still registered for push on the relay, live or not. */
export async function getInvitesWithPushRouting(): Promise<Invite[]> {
  return db.select().from(circleInvites).where(isNotNull(circleInvites.pushRoutingId));
}

/** Null once the relay has deleted the routing. */
export async function setInvitePushRoutingId(code: string, pushRoutingId: string | null): Promise<void> {
  await db.update(circleInvites).set({ pushRoutingId }).where(eq(circleInvites.code, code));
}
