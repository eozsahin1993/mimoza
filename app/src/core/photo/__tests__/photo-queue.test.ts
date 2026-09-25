jest.mock('@/core/services/blob-relay');
jest.mock('@/core/services/keystore/circle-keys', () => ({
  getCircleKeyMap: jest.fn(async () => ({ 1: new Uint8Array(32).fill(1) })),
}));

import {
  AttachmentKinds,
  AttachmentStatuses,
  applyCircle,
  applyPost,
  clearAttachmentBackoff,
  getAttachment,
  getFetchableAttachments,
  initDatabase,
  insertAttachment,
} from '@/data/db';
import { encrypt, generateUUID, hashBytes } from '@/core/crypto/primitives';
import { deleteAuthToken, saveAuthToken } from '@/core/services/keystore/auth-token';
import { getBlob } from '@/core/services/blob-relay';
import { drainPhotoQueue, retryAttachment } from '@/core/photo/photo-queue';

const NOW = 1_700_000_000_000;
const KEY = new Uint8Array(32).fill(1);

let next = 0;
async function makeCircle(): Promise<string> {
  next += 1;
  const circleId = `circle-${next}`;
  await applyCircle(
    { circleId, name: 'Family', role: 'member', notifyLevel: 'all', keyVersion: 1, rosterVersion: 1 },
    NOW
  );
  return circleId;
}

beforeAll(async () => {
  await saveAuthToken('session-token');
  await initDatabase();
});

beforeEach(() => {
  jest.clearAllMocks();
});

/** A pulled post: row present, photo not downloaded yet — what the post handler writes. */
async function makePendingPost(circleId: string, photo: Uint8Array, createdAt: number): Promise<string> {
  const postId = generateUUID();
  await applyPost({ id: postId, circleId, authorId: 'sarah', caption: 'c', createdAt, receivedAt: createdAt });
  await insertAttachment({
    circleId,
    entryId: postId,
    kind: AttachmentKinds.POST_PHOTO,
    bytes: null,
    hash: hashBytes(photo),
    keyVersion: 1,
    status: AttachmentStatuses.PENDING,
    fetchAttempts: 0,
    nextAttemptAt: null,
    createdAt,
  });
  return postId;
}

test('downloads, decrypts, and stores a pending photo', async () => {
  const circleId = await makeCircle();
  const photo = new Uint8Array([4, 5, 6]);
  const postId = await makePendingPost(circleId, photo, 1000);
  (getBlob as jest.Mock).mockResolvedValue(encrypt(photo, KEY));

  await drainPhotoQueue();

  const attachment = await getAttachment(circleId, postId);
  expect(attachment?.bytes).toEqual(photo);
  expect(attachment?.status).toBe('fetched');
  expect(attachment?.fetchAttempts).toBe(0);
  // Addressed as (circle, the rest of the key) — no syncId any more.
  expect(getBlob).toHaveBeenCalledWith(circleId, postId);
});

test('stops without a session, rather than backing every photo off', async () => {
  const circleId = await makeCircle();
  const postId = await makePendingPost(circleId, new Uint8Array([1]), 1000);
  await deleteAuthToken();

  try {
    await drainPhotoQueue();
  } finally {
    await saveAuthToken('session-token');
  }

  expect(getBlob).not.toHaveBeenCalled();
  expect((await getAttachment(circleId, postId))?.fetchAttempts).toBe(0);
});

test('fetches newest first, across circles rather than finishing one circle at a time', async () => {
  const olderCircle = await makeCircle();
  const newerCircle = await makeCircle();
  const photo = new Uint8Array([7]);
  await makePendingPost(olderCircle, photo, 1000);
  const newest = await makePendingPost(newerCircle, photo, 9000);
  await makePendingPost(olderCircle, photo, 2000);

  const [first] = await getFetchableAttachments(Date.now(), 1);

  // The newest photo wins even though its circle was created last and has
  // fewer pending items — an old backlog must never starve a fresh post.
  expect(first.entryId).toBe(newest);
});

test('records a failure with backoff and leaves the photo pending', async () => {
  const circleId = await makeCircle();
  const postId = await makePendingPost(circleId, new Uint8Array([1]), 1000);
  (getBlob as jest.Mock).mockRejectedValue(new Error('offline'));

  await drainPhotoQueue();

  const attachment = await getAttachment(circleId, postId);
  expect(attachment?.status).toBe('failed');
  expect(attachment?.bytes).toBeNull();
  expect(attachment?.fetchAttempts).toBe(1);
  expect(attachment?.nextAttemptAt).toBeGreaterThan(Date.now());
});

test('a failed photo is skipped until its backoff expires, so the queue never spins on it', async () => {
  const circleId = await makeCircle();
  await makePendingPost(circleId, new Uint8Array([1]), 1000);
  (getBlob as jest.Mock).mockRejectedValue(new Error('offline'));

  await drainPhotoQueue();
  const attemptsAfterFirstDrain = (getBlob as jest.Mock).mock.calls.length;
  // A second drain right away must not retry it — otherwise a permanently
  // broken newest photo would block every other photo forever.
  await drainPhotoQueue();

  expect((getBlob as jest.Mock).mock.calls.length).toBe(attemptsAfterFirstDrain);
  expect(await getFetchableAttachments(Date.now(), 1)).toHaveLength(0);
});

test('rejects bytes that do not match the hash inside the entry', async () => {
  const circleId = await makeCircle();
  const postId = await makePendingPost(circleId, new Uint8Array([1, 1, 1]), 1000);
  // Correctly encrypted, so it decrypts — but they aren't the bytes the
  // entry committed to, which is the swap this check exists for.
  (getBlob as jest.Mock).mockResolvedValue(encrypt(new Uint8Array([2, 2, 2]), KEY));

  await drainPhotoQueue();

  const attachment = await getAttachment(circleId, postId);
  expect(attachment?.bytes).toBeNull();
  expect(attachment?.status).toBe('failed');
});

test('one failing photo does not stop the rest of the queue', async () => {
  const circleId = await makeCircle();
  const good = new Uint8Array([3, 3, 3]);
  const newestId = await makePendingPost(circleId, new Uint8Array([1]), 9000);
  const olderId = await makePendingPost(circleId, good, 1000);
  (getBlob as jest.Mock).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(encrypt(good, KEY));

  await drainPhotoQueue();

  expect((await getAttachment(circleId, newestId))?.status).toBe('failed');
  expect((await getAttachment(circleId, olderId))?.bytes).toEqual(good);
});

test('stops at the budget, for a background window that cannot run long', async () => {
  const circleId = await makeCircle();
  const photo = new Uint8Array([8]);
  await makePendingPost(circleId, photo, 3000);
  await makePendingPost(circleId, photo, 2000);
  await makePendingPost(circleId, photo, 1000);
  (getBlob as jest.Mock).mockResolvedValue(encrypt(photo, KEY));

  await drainPhotoQueue({ maxPhotos: 2 });

  expect((getBlob as jest.Mock).mock.calls.length).toBe(2);
  expect(await getFetchableAttachments(Date.now(), 5)).toHaveLength(1);
});

// The post screen's manual retry: a photo that failed enough to be
// backed off for up to a day should not have to wait that out.
test('clearAttachmentBackoff makes a failed photo fetchable again immediately', async () => {
  const circleId = await makeCircle();
  const postId = await makePendingPost(circleId, new Uint8Array([1]), 1000);
  (getBlob as jest.Mock).mockRejectedValue(new Error('offline'));
  await drainPhotoQueue();
  expect(await getFetchableAttachments(Date.now(), 1)).toHaveLength(0);

  await clearAttachmentBackoff(circleId, postId);

  expect(await getFetchableAttachments(Date.now(), 1)).toHaveLength(1);
});

test('retryAttachment gets a failed photo without waiting for its backoff', async () => {
  const circleId = await makeCircle();
  const photo = new Uint8Array([9]);
  const postId = await makePendingPost(circleId, photo, 1000);
  (getBlob as jest.Mock).mockRejectedValueOnce(new Error('offline'));
  await drainPhotoQueue();
  expect((await getAttachment(circleId, postId))?.status).toBe('failed');

  // Whatever the earlier failure backed it off to is beside the point —
  // retryAttachment is the one path that doesn't wait it out.
  (getBlob as jest.Mock).mockResolvedValueOnce(encrypt(photo, KEY));
  await retryAttachment(circleId, postId);
  await drainPhotoQueue(); // joins retryAttachment's own nudge if it's still running

  const attachment = await getAttachment(circleId, postId);
  expect(attachment?.bytes).toEqual(photo);
  expect(attachment?.status).toBe('fetched');
});
