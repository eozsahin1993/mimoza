import { and, eq, inArray, isNull, lte, ne, or } from 'drizzle-orm';

import { normalizeBlob } from '@/data/db/blob';
import { db } from '@/data/db/connection';
import { circleMembers, circles, profilePictures } from '@/data/db/schema';

export type ProfilePicture = typeof profilePictures.$inferSelect;

export const ProfilePictureStatuses = {
  PENDING: 'pending',
  FETCHED: 'fetched',
  FAILED: 'failed',
} as const;

function normalizeProfilePicture(row: ProfilePicture): ProfilePicture {
  return { ...row, bytes: normalizeBlob(row.bytes) };
}

/**
 * Records that this device needs to know about an account's current
 * picture — called with whatever id a roster, a request or an invite
 * preview just reported. `setWhere` makes the update itself conditional
 * on the id actually having changed: without it, a roster refresh that
 * reports the same id this device already fetched would reset bytes
 * back to pending and re-download a picture nothing about has moved.
 */
export async function upsertProfilePictureRef(accountId: string, pictureId: string, now: number): Promise<void> {
  await db
    .insert(profilePictures)
    .values({ accountId, pictureId, status: ProfilePictureStatuses.PENDING, createdAt: now })
    .onConflictDoUpdate({
      target: profilePictures.accountId,
      set: {
        pictureId,
        bytes: null,
        status: ProfilePictureStatuses.PENDING,
        fetchAttempts: 0,
        nextAttemptAt: null,
        createdAt: now,
      },
      setWhere: ne(profilePictures.pictureId, pictureId),
    });
}

export async function storeProfilePicture(accountId: string, pictureId: string, bytes: Uint8Array): Promise<void> {
  await db
    .insert(profilePictures)
    .values({ accountId, pictureId, bytes, status: ProfilePictureStatuses.FETCHED, createdAt: Date.now() })
    .onConflictDoUpdate({
      target: profilePictures.accountId,
      set: { pictureId, bytes, status: ProfilePictureStatuses.FETCHED, fetchAttempts: 0, nextAttemptAt: null },
    });
}

export async function getProfilePicture(accountId: string): Promise<ProfilePicture | null> {
  const rows = await db.select().from(profilePictures).where(eq(profilePictures.accountId, accountId));
  return rows[0] ? normalizeProfilePicture(rows[0]) : null;
}

export async function getProfilePictures(accountIds: string[]): Promise<Map<string, ProfilePicture>> {
  if (accountIds.length === 0) return new Map();
  const rows = await db.select().from(profilePictures).where(inArray(profilePictures.accountId, accountIds));
  return new Map(rows.map((row) => [row.accountId, normalizeProfilePicture(row)]));
}

/**
 * The picture queue's own read, parallel to getFetchableAttachments:
 * accounts with no bytes yet, past any backoff, and still relevant —
 * narrowed to accounts this device shares a live circle with, same
 * reasoning as that function's own liveCircles subquery, so an account
 * left long ago is not fetched for nothing.
 *
 * No self-exclusion: the signed-in account's own row is fetched the
 * same way anyone else's is. That's safe because markProfilePictureFetched
 * and markProfilePictureFailed below only ever complete the exact fetch
 * that was started — see those for why a self-fetch can't race a publish
 * on this same device.
 */
export async function getFetchableProfilePictures(now: number, limit: number): Promise<ProfilePicture[]> {
  const sharedAccounts = db
    .selectDistinct({ accountId: circleMembers.accountId })
    .from(circleMembers)
    .innerJoin(circles, eq(circles.id, circleMembers.circleId))
    .where(isNull(circles.leftAt));
  const rows = await db
    .select()
    .from(profilePictures)
    .where(
      and(
        isNull(profilePictures.bytes),
        inArray(profilePictures.accountId, sharedAccounts),
        or(isNull(profilePictures.nextAttemptAt), lte(profilePictures.nextAttemptAt, now))
      )
    )
    .limit(limit);
  return rows.map(normalizeProfilePicture);
}

/**
 * Completes the fetch for exactly the id that was fetched — a
 * compare-and-set, not a blind write. Without the pictureId check, a
 * slow fetch for an id this row has since moved past (a newer
 * upsertProfilePictureRef, or this account's own publishProfilePicture)
 * would land late and overwrite the current id's bytes with the old
 * id's. With it, that late write matches zero rows and is a no-op —
 * which is also what makes it safe to fetch "my own" row at all: a
 * self-publish updates pictureId first, so a self-fetch still in
 * flight for the old id can never clobber it.
 */
export async function markProfilePictureFetched(accountId: string, pictureId: string, bytes: Uint8Array): Promise<void> {
  await db
    .update(profilePictures)
    .set({ bytes, status: ProfilePictureStatuses.FETCHED, fetchAttempts: 0, nextAttemptAt: null })
    .where(and(eq(profilePictures.accountId, accountId), eq(profilePictures.pictureId, pictureId)));
}

/** Drops this account's local row outright — removing a picture, not replacing it with a new one (see upsertProfilePictureRef for that). */
export async function deleteProfilePicture(accountId: string): Promise<void> {
  await db.delete(profilePictures).where(eq(profilePictures.accountId, accountId));
}

/** Same compare-and-set reasoning as markProfilePictureFetched: a failure for an id this row has since moved past must not stamp its backoff onto whatever id is current now. */
export async function markProfilePictureFailed(
  accountId: string,
  pictureId: string,
  fetchAttempts: number,
  nextAttemptAt: number
): Promise<void> {
  await db
    .update(profilePictures)
    .set({ status: ProfilePictureStatuses.FAILED, fetchAttempts, nextAttemptAt })
    .where(and(eq(profilePictures.accountId, accountId), eq(profilePictures.pictureId, pictureId)));
}
