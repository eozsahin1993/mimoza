import { queueVisibility } from '@/data/db';
import { drainOutbox } from '@/core/sync/drain-outbox';
import { Visibility } from '@/features/post/services/post-relay';

/**
 * Moves a photo in or out of the circle's album. The album is where a
 * post sits unless its author took it out, so this is a change like any
 * other and goes through the outbox.
 */
export async function setAlbumVisibility(circleId: string, postId: string, inAlbum: boolean): Promise<void> {
  const at = Date.now();
  queueVisibility(postId, inAlbum, {
    circleId,
    op: 'set_visibility',
    postId,
    plaintext: JSON.stringify({ visibility: inAlbum ? Visibility.ALBUM : Visibility.FEED }),
    createdAt: at,
  });

  drainOutbox(circleId).catch((err) => console.error('Failed to drain outbox', err));
}
