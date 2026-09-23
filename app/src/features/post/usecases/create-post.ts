import { AttachmentKinds, AttachmentStatuses, getProfile, queuePost } from '@/data/db';
import { generateUUID, hashBytes } from '@/core/crypto/primitives';
import { writePhotoFile } from '@/core/photo/photo-cache';
import { getCurrentContentKey } from '@/core/services/keystore/circle-keys';
import { drainOutbox } from '@/core/sync/drain-outbox';
import { Visibility } from '@/features/post/services/post-relay';
import { timedSync } from '@/core/utils/timing';

export type CreatePostInput = {
  circleId: string;
  caption: string;
  photo: Uint8Array;
  /** Whether this photo joins the circle's album — see the album screen. */
  inAlbum: boolean;
};

/**
 * Posts a photo. Local and offline-safe: the row, the bytes and the
 * queued write all land here, and the drain that follows is fire and
 * forget — a stuck push must never make posting feel broken.
 *
 * The caption is sealed at drain time, not here, so a key rotation in
 * between is not a problem. `photoHash` travels inside the ciphertext so
 * a reader can check the bytes it downloads are the ones that were
 * posted; the blob and its post are uploaded separately and nothing else
 * ties them together.
 */
export async function createPost(input: CreatePostInput): Promise<string> {
  const profile = await getProfile();
  if (!profile) throw new Error('No profile on this device.');
  const current = await getCurrentContentKey(input.circleId);
  if (!current) throw new Error('No content key on this device.');

  const postId = generateUUID();
  const createdAt = Date.now();
  const photoHash = timedSync(`post.hash(${Math.round(input.photo.length / 1024)}KB)`, () => hashBytes(input.photo));

  queuePost(
    {
      id: postId,
      circleId: input.circleId,
      authorId: profile.accountId,
      caption: input.caption,
      createdAt,
      receivedAt: createdAt,
      inAlbum: input.inAlbum,
      updatedAt: createdAt,
    },
    {
      circleId: input.circleId,
      entryId: postId,
      kind: AttachmentKinds.POST_PHOTO,
      bytes: input.photo,
      hash: photoHash,
      keyVersion: current.version,
      // Made here, so there is nothing to download.
      status: AttachmentStatuses.FETCHED,
      fetchAttempts: 0,
      nextAttemptAt: null,
      createdAt,
    },
    {
      circleId: input.circleId,
      op: 'post',
      postId,
      entryId: postId,
      plaintext: JSON.stringify({
        caption: input.caption,
        createdAt,
        photoHash,
        visibility: input.inAlbum ? Visibility.ALBUM : Visibility.FEED,
      }),
      createdAt,
    }
  );
  writePhotoFile(input.circleId, postId, input.photo);

  drainOutbox(input.circleId).catch((err) => console.error('Failed to drain outbox', err));
  return postId;
}
