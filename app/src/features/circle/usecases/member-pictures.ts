import { getProfilePictures } from '@/data/db';
import { cachedProfilePictureUri, writeProfilePictureFile } from '@/core/photo/photo-cache';

/**
 * Resolves each account's current picture to a `file://` URI, keyed by
 * account id. An account with no row yet, or whose bytes have not
 * arrived, is simply absent from the result — every caller falls back
 * to initials for those, the same way a post's own photo falls back to
 * a placeholder.
 *
 * Not circle-scoped, unlike the old per-circle avatar resolver this
 * replaces: a profile picture is the same object wherever the account
 * is seen, so one cached file serves a member list, a feed, a comment
 * thread and the pending-requests card alike.
 */
export async function resolveMemberPictures(accountIds: string[]): Promise<Map<string, string>> {
  const pictures = await getProfilePictures(accountIds);
  const resolved = new Map<string, string>();

  for (const [accountId, picture] of pictures) {
    const uri =
      cachedProfilePictureUri(accountId, picture.pictureId) ??
      (picture.bytes ? writeProfilePictureFile(accountId, picture.bytes, picture.pictureId) : null);
    if (uri) resolved.set(accountId, uri);
  }

  return resolved;
}
