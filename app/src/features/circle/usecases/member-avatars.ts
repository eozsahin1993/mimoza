import { avatarEntryId, getAttachment } from '@/data/db';
import { cachedAvatarUri, writeAvatarFile } from '@/core/photo/photo-cache';

export type AvatarRef = { accountId: string; avatarId: string | null };

/**
 * Resolves each ref's current picture to a cached `file://` path, keyed
 * by account id. A ref with no avatarId, or one whose bytes haven't
 * arrived yet, is simply absent from the result — every caller falls
 * back to initials for those, the same way a post's own photo falls
 * back to a placeholder.
 *
 * A member's picture is content-addressed (see coverEntryId/avatarEntryId
 * in data/db/attachments.ts) — a changed avatar is a new avatarId, so
 * this needs no invalidation of its own: the old file simply stops being
 * referenced once the roster carries the new id.
 */
export async function resolveMemberAvatars(circleId: string, refs: AvatarRef[]): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();

  for (const ref of refs) {
    if (!ref.avatarId) continue;

    const cached = cachedAvatarUri(circleId, ref.accountId, ref.avatarId);
    if (cached) {
      resolved.set(ref.accountId, cached);
      continue;
    }

    const attachment = await getAttachment(circleId, avatarEntryId(ref.accountId, ref.avatarId));
    if (attachment?.bytes) {
      resolved.set(ref.accountId, writeAvatarFile(circleId, ref.accountId, ref.avatarId, attachment.bytes));
    }
  }

  return resolved;
}
