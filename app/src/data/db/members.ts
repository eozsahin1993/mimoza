import { and, eq, isNull } from 'drizzle-orm';

import { db } from '@/data/db/connection';
import { circleMembers } from '@/data/db/schema';

export type Member = typeof circleMembers.$inferSelect;
export type NewMember = typeof circleMembers.$inferInsert;

/**
 * Replaces a circle's roster with what the relay just sent. Members no
 * longer on it are marked as having left rather than deleted: a post or
 * a reaction by someone who has gone still has to resolve to a name.
 */
export async function applyRoster(circleId: string, roster: NewMember[], now: number): Promise<void> {
  const present = new Set(roster.map((member) => member.accountId));

  for (const member of roster) {
    await db
      .insert(circleMembers)
      .values({ ...member, circleId, leftAt: null })
      .onConflictDoUpdate({
        target: [circleMembers.circleId, circleMembers.accountId],
        set: {
          name: member.name,
          avatarId: member.avatarId ?? null,
          avatarKeyVersion: member.avatarKeyVersion ?? null,
          publicKey: member.publicKey,
          role: member.role,
          needsRewrap: member.needsRewrap ?? false,
          leftAt: null,
        },
      });
  }

  const known = await db.select().from(circleMembers).where(eq(circleMembers.circleId, circleId));
  for (const member of known) {
    if (present.has(member.accountId) || member.leftAt !== null) continue;
    await db
      .update(circleMembers)
      .set({ leftAt: now })
      .where(and(eq(circleMembers.circleId, circleId), eq(circleMembers.accountId, member.accountId)));
  }
}

export async function getMember(circleId: string, accountId: string): Promise<Member | null> {
  const [row] = await db
    .select()
    .from(circleMembers)
    .where(and(eq(circleMembers.circleId, circleId), eq(circleMembers.accountId, accountId)))
    .limit(1);
  return row ?? null;
}

/** Everyone currently in the circle. */
export async function listMembers(circleId: string): Promise<Member[]> {
  return db
    .select()
    .from(circleMembers)
    .where(and(eq(circleMembers.circleId, circleId), isNull(circleMembers.leftAt)));
}

/** Including those who have left, for resolving an old post's author. */
export async function listEveryMemberSeen(circleId: string): Promise<Member[]> {
  return db.select().from(circleMembers).where(eq(circleMembers.circleId, circleId));
}

export async function countMembers(circleId: string): Promise<number> {
  return (await listMembers(circleId)).length;
}

/** Someone who left, or whose account is gone, kept by name alone. */
export async function rememberDepartedMember(
  circleId: string,
  accountId: string,
  name: string,
  at: number
): Promise<void> {
  await db
    .insert(circleMembers)
    .values({ circleId, accountId, name, role: 'member', joinedAt: at, leftAt: at })
    .onConflictDoUpdate({
      target: [circleMembers.circleId, circleMembers.accountId],
      set: { leftAt: at, ...(name ? { name } : {}) },
    });
}

/** This device's own picture for one circle, after it has been uploaded. */
export async function setMemberAvatar(
  circleId: string,
  accountId: string,
  avatarId: string,
  keyVersion: number
): Promise<void> {
  await db
    .update(circleMembers)
    .set({ avatarId, avatarKeyVersion: keyVersion })
    .where(and(eq(circleMembers.circleId, circleId), eq(circleMembers.accountId, accountId)));
}
