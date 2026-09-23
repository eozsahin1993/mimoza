import { coverEntryId, getAttachment, getCircle, getFeed } from '@/data/db';
import { cachedCoverUri, ensurePhotoUri, writeCoverFile } from '@/core/photo/photo-cache';

/**
 * The circle's image as a cached `file://` path. A circle's cover always
 * caches to the same fixed path family (see photo-cache.ts) suffixed
 * with its own id, so a changed cover gets a genuinely different path —
 * otherwise this cache's own "does it exist" check, and `expo-image`'s
 * native cache on top of it, would both keep showing whatever was
 * cached under the old cover's path forever.
 *
 * Only a circle whose file is missing under its current id costs a read
 * of its bytes; everything else is an existence check — which is what
 * keeps re-entering a screen cheap.
 *
 * Shared so the circle list and the details screen can't show a circle two
 * different faces.
 */
export async function resolveCircleCoverUri(circleId: string): Promise<string | undefined> {
  const circle = await getCircle(circleId);
  if (circle?.coverId) {
    const cached = cachedCoverUri(circleId, circle.coverId);
    if (cached) return cached;

    const attachment = await getAttachment(circleId, coverEntryId(circle.coverId));
    // Known but not yet downloaded — nothing to show until the photo
    // queue lands it; the fallback below is for having no cover at all,
    // not for one that's still arriving.
    return attachment?.bytes ? writeCoverFile(circleId, attachment.bytes, circle.coverId) : undefined;
  }

  // No cover of its own: fall back to the newest post's photo, reusing the
  // file the photo queue already wrote rather than reading those bytes
  // back out of SQLite. Deliberately not cached under the cover's own id —
  // the fallback should follow the newest post, not freeze on today's.
  const [newestPost] = await getFeed(circleId, 1);
  return newestPost ? (ensurePhotoUri(circleId, newestPost.id, () => null) ?? undefined) : undefined;
}
