import { avatarEntryId, getAttachment } from '@/data/db';
import { bytesToDataUri } from '@/core/photo/image';

export type AvatarRef = { accountId: string; avatarId: string | null };

/**
 * Resolves each ref's current picture to a data URI, keyed by account
 * id. A ref with no avatarId, or one whose bytes haven't arrived yet, is
 * simply absent from the result — every caller falls back to initials
 * for those, the same way a post's own photo falls back to a placeholder.
 *
 * Bytes only, never a file cache — same as photo-queue.ts's own choice
 * for a MEMBER_AVATAR attachment ("a picture is small and its screens
 * read it straight out of SQLite"). `bytesToDataUri` is memoized by the
 * bytes' own identity, so this only pays the encode once per picture,
 * not once per screen that shows it.
 *
 * A member's picture is content-addressed (see coverEntryId/avatarEntryId
 * in data/db/attachments.ts) — a changed avatar is a new avatarId, so
 * this needs no invalidation of its own: the old bytes simply stop being
 * referenced once the roster carries the new id.
 */
export async function resolveMemberAvatars(circleId: string, refs: AvatarRef[]): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();

  for (const ref of refs) {
    if (!ref.avatarId) continue;

    const attachment = await getAttachment(circleId, avatarEntryId(ref.accountId, ref.avatarId));
    if (attachment?.bytes) {
      resolved.set(ref.accountId, bytesToDataUri(attachment.bytes));
    }
  }

  return resolved;
}
