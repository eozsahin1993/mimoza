import { deleteCircle, getCircleMembers, MemberRoles } from '@/data/db';
import { removeCircleNotificationChannel } from '@/features/push-notifications/services/channels';
import { deleteCirclePhotoFiles } from '@/core/photo/photo-cache';
import { deleteCircleKeys } from '@/core/services/keystore/circle-keys';
import { unregisterPushForCircleInvites } from '@/features/invite/usecases/invite-push';
import { asRecord, numberField, type EntryHandler } from '@/core/sync/entry-handlers/types';

/**
 * What `deleteCircleForEveryone` puts in a `circle_deleted` entry — the
 * tombstone that ends a circle. Which circle is implied by the log it
 * arrived on, so there is nothing to carry but the author's clock.
 */
type CircleDeletedPayload = { createdAt?: number };

function parse(payload: unknown): CircleDeletedPayload | null {
  const record = asRecord(payload);
  if (!record) return null;
  return { createdAt: numberField(record, 'createdAt') ?? undefined };
}

export const circleDeletedHandler: EntryHandler = {
  /**
   * Admin-authored, same rule as `member_removed`. The relay enforces the
   * matching half — no deletion unsigned by a key in its authority set —
   * because neither side can make the other's check: the relay can't read
   * roles, a client can't see the authority set.
   */
  async predicate(circleId, envelope) {
    if (!parse(envelope.payload)) return false;

    const admins = (await getCircleMembers(circleId)).filter((member) => member.role === MemberRoles.admin);
    return admins.some((member) => member.identityPublicKey === envelope.authorPubkey);
  },

  /**
   * Rows first (cascade takes the roster, posts, attachments and anything
   * queued), then the photo files, then the keys. Keys last because a
   * crash after destroying those would leave a circle that still renders
   * and can never sync again; photo files orphaned by a crash sit in the
   * cache directory, which the OS reclaims.
   */
  async apply(circleId) {
    // Before the rows: the invite rows are what name its push routings.
    await unregisterPushForCircleInvites(circleId);
    await deleteCircle(circleId);
    deleteCirclePhotoFiles(circleId);
    await deleteCircleKeys(circleId);
    await removeCircleNotificationChannel(circleId);
  },
};
