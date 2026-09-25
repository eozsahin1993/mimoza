import { and, desc, eq, inArray, isNull, lte, or } from 'drizzle-orm';

import { normalizeBlob } from '@/data/db/blob';
import { db } from '@/data/db/connection';
import { attachments, circles } from '@/data/db/schema';

export type Attachment = typeof attachments.$inferSelect;
export type NewAttachment = typeof attachments.$inferInsert;

export const AttachmentStatuses = {
  PENDING: 'pending',
  FETCHED: 'fetched',
  FAILED: 'failed',
} as const;

export const AttachmentKinds = {
  POST_PHOTO: 'post_photo',
  CIRCLE_COVER: 'circle_cover',
  MEMBER_AVATAR: 'member_avatar',
} as const;

/**
 * Where a blob lives, as the rest of the relay's key after the circle.
 * Every one is written once and never overwritten, so a changed cover or
 * picture is a new key rather than a replacement.
 */
export function coverEntryId(coverId: string): string {
  return `cover/${coverId}`;
}

export function avatarEntryId(accountId: string, avatarId: string): string {
  return `avatar/${accountId}/${avatarId}`;
}

export function normalizeAttachment(attachment: Attachment): Attachment {
  return { ...attachment, bytes: normalizeBlob(attachment.bytes) };
}

/**
 * Records an attachment this device now knows about. `onConflictDoNothing`
 * makes re-applying an already-seen log entry a no-op rather than a
 * primary-key error — sync can redeliver the same entry more than once,
 * and replay has to stay harmless when it does.
 */
export async function insertAttachment(attachment: NewAttachment): Promise<void> {
  await db.insert(attachments).values(attachment).onConflictDoNothing();
}

/**
 * Records an attachment that can legitimately be replaced. Only the
 * circle cover, which always lives at the same fixed `COVER_ENTRY_ID`:
 * setting a new one must overwrite the old row's hash and send it back
 * to the queue, where `insertAttachment`'s no-op would leave the
 * previous image in place forever.
 *
 * Replaying the same entry is still harmless — it writes the same hash
 * and version, and the status reset just re-fetches bytes this device
 * already has.
 */
export async function upsertAttachment(attachment: NewAttachment): Promise<void> {
  await db
    .insert(attachments)
    .values(attachment)
    .onConflictDoUpdate({
      target: [attachments.circleId, attachments.entryId],
      set: {
        hash: attachment.hash,
        keyVersion: attachment.keyVersion,
        bytes: attachment.bytes,
        status: attachment.status,
        fetchAttempts: attachment.fetchAttempts,
        nextAttemptAt: attachment.nextAttemptAt,
      },
    });
}

export async function getAttachment(circleId: string, entryId: string): Promise<Attachment | null> {
  const rows = await db
    .select()
    .from(attachments)
    .where(and(eq(attachments.circleId, circleId), eq(attachments.entryId, entryId)));
  return rows[0] ? normalizeAttachment(rows[0]) : null;
}

/** An attachment awaiting download, plus the syncId its blob lives under. */
export type FetchableAttachment = Attachment;

/**
 * The download queue's only read: attachments that still need bytes and
 * are past any backoff, **newest first across every circle** — global
 * rather than per-circle so a brand-new photo in one circle always beats
 * an old backlog in another (see photo-queue.ts, which re-runs this with
 * `limit: 1` on every iteration rather than snapshotting a batch).
 *
 * Resolves each row's `syncId` (the blob's relay address needs it) and
 * skips circles this device has left.
 */
export async function getFetchableAttachments(now: number, limit: number): Promise<FetchableAttachment[]> {
  // Subquery rather than a join, for the same reason as getCirclePosts:
  // this driver maps result columns by name, and `circles`/`attachments`
  // collide on `circle_id`. The syncIds are then resolved in one extra
  // read — at most `limit` circles, and `limit` is 1 in the drain loop.
  const liveCircles = db.select({ id: circles.id }).from(circles).where(isNull(circles.leftAt));
  const rows = await db
    .select()
    .from(attachments)
    .where(
      and(
        isNull(attachments.bytes),
        inArray(attachments.circleId, liveCircles),
        or(isNull(attachments.nextAttemptAt), lte(attachments.nextAttemptAt, now))
      )
    )
    .orderBy(desc(attachments.createdAt))
    .limit(limit);
  // The circle id is the address now: a blob's key is the circle and
  // the rest, so nothing has to be looked up to fetch one.
  return rows.map((row) => normalizeAttachment(row));
}

/** Records a successful download: bytes land, backoff state resets. */
export async function markAttachmentFetched(circleId: string, entryId: string, bytes: Uint8Array): Promise<void> {
  await db
    .update(attachments)
    .set({ bytes, status: AttachmentStatuses.FETCHED, fetchAttempts: 0, nextAttemptAt: null })
    .where(and(eq(attachments.circleId, circleId), eq(attachments.entryId, entryId)));
}

/**
 * Clears a failed attachment's scheduled backoff, so the queue's next
 * drain treats it as due right away instead of waiting out the delay —
 * the post screen's manual retry.
 */
export async function clearAttachmentBackoff(circleId: string, entryId: string): Promise<void> {
  await db
    .update(attachments)
    .set({ nextAttemptAt: null })
    .where(and(eq(attachments.circleId, circleId), eq(attachments.entryId, entryId)));
}

/** Records a failed download attempt and when it may next be retried. */
export async function markAttachmentFailed(
  circleId: string,
  entryId: string,
  fetchAttempts: number,
  nextAttemptAt: number
): Promise<void> {
  await db
    .update(attachments)
    .set({ status: AttachmentStatuses.FAILED, fetchAttempts, nextAttemptAt })
    .where(and(eq(attachments.circleId, circleId), eq(attachments.entryId, entryId)));
}
