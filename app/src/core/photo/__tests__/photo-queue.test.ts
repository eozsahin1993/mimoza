// A factory, not the bare automock: BlobPaths is plain path-building data
// that fetchProfilePicture itself calls at runtime, not something this
// file stubs — automocking the whole module would turn every BlobPaths.*
// call inside photo-queue.ts into a function returning undefined too.
jest.mock('@/core/services/blob-relay', () => ({
  ...jest.requireActual('@/core/services/blob-relay'),
  getBlob: jest.fn(),
}));
jest.mock('@/core/services/keystore/circle-keys', () => ({
  getCircleKeyMap: jest.fn(async () => ({ 1: new Uint8Array(32).fill(1) })),
}));

import {
  AttachmentKinds,
  AttachmentStatuses,
  applyCircle,
  applyPost,
  applyRoster,
  clearAttachmentBackoff,
  coverEntryId,
  getAttachment,
  getFetchableAttachments,
  getProfilePicture,
  initDatabase,
  insertAttachment,
  upsertProfilePictureRef,
} from '@/data/db';
import { encrypt, generateUUID, hashBytes } from '@/core/crypto/primitives';
import { deleteAuthToken, saveAuthToken } from '@/core/services/keystore/auth-token';
import { BlobPaths, getBlob } from '@/core/services/blob-relay';
import { drainPhotoQueue, retryAttachment } from '@/core/photo/photo-queue';
import { onPhotoFetched, type PhotoFetched } from '@/core/photo/photo-events';

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

/** A pending circle cover, same shape as makePendingPost but for the cover tier. */
async function makePendingCover(circleId: string, photo: Uint8Array, createdAt: number, coverId = 'cover-1'): Promise<string> {
  const entryId = coverEntryId(coverId);
  await insertAttachment({
    circleId,
    entryId,
    kind: AttachmentKinds.CIRCLE_COVER,
    bytes: null,
    hash: hashBytes(photo),
    keyVersion: 1,
    status: AttachmentStatuses.PENDING,
    fetchAttempts: 0,
    nextAttemptAt: null,
    createdAt,
  });
  return entryId;
}

/**
 * A pending profile picture: a roster row so findCircleSharedWith has
 * somewhere to address the download through, plus the ref itself —
 * what queueProfilePictureRefs in sync-circles.ts does on a real sync.
 */
async function makePendingProfilePicture(
  circleId: string,
  accountId: string,
  pictureId: string,
  createdAt: number
): Promise<void> {
  await applyRoster(
    circleId,
    [{ circleId, accountId, name: accountId, publicKey: 'pk', role: 'member', joinedAt: createdAt }],
    createdAt
  );
  await upsertProfilePictureRef(accountId, pictureId, createdAt);
}

test('downloads, decrypts, and stores a pending photo', async () => {
  const circleId = await makeCircle();
  const photo = new Uint8Array([4, 5, 6]);
  const postId = await makePendingPost(circleId, photo, 1000);
  (getBlob as jest.Mock).mockResolvedValue(encrypt(photo, KEY));

  const events: PhotoFetched[] = [];
  const unsubscribe = onPhotoFetched((event) => events.push(event));
  await drainPhotoQueue();
  unsubscribe();

  const attachment = await getAttachment(circleId, postId);
  expect(attachment?.bytes).toEqual(photo);
  expect(attachment?.status).toBe('fetched');
  expect(attachment?.fetchAttempts).toBe(0);
  // Addressed as (circle, the rest of the key) — no syncId any more.
  expect(getBlob).toHaveBeenCalledWith(circleId, postId);
  expect(events).toEqual([{ kind: 'post', circleId, postId, uri: expect.any(String) }]);
});

test('notifies with kind "cover" when a circle cover finishes downloading', async () => {
  const circleId = await makeCircle();
  const photo = new Uint8Array([1, 2, 3]);
  await makePendingCover(circleId, photo, 1000);
  (getBlob as jest.Mock).mockResolvedValue(encrypt(photo, KEY));

  const events: PhotoFetched[] = [];
  const unsubscribe = onPhotoFetched((event) => events.push(event));
  await drainPhotoQueue();
  unsubscribe();

  expect(events).toEqual([{ kind: 'cover', circleId, uri: expect.any(String) }]);
});

// Not an attachment at all any more: no circle/entryId address, no
// decrypt, no hash — the relay already serves plain bytes.
//
// Account ids here are unique per test, not the shared 'sarah' the post
// and cover helpers above use — profile_pictures is keyed by accountId
// alone, with no circleId to scope it, so two tests reusing the same one
// would read back whatever the earlier test left, not a fresh row.
test('fetches a pending profile picture: plain bytes, no decrypt, notifies kind "profilePicture"', async () => {
  const circleId = await makeCircle();
  const accountId = `account-${circleId}`;
  const photo = new Uint8Array([1, 2, 3]);
  await makePendingProfilePicture(circleId, accountId, 'pic-1', 1000);
  (getBlob as jest.Mock).mockResolvedValue(photo);

  const events: PhotoFetched[] = [];
  const unsubscribe = onPhotoFetched((event) => events.push(event));
  await drainPhotoQueue();
  unsubscribe();

  expect(getBlob).toHaveBeenCalledWith(circleId, BlobPaths.picture(accountId, 'pic-1'));
  const picture = await getProfilePicture(accountId);
  expect(picture?.bytes).toEqual(photo);
  expect(picture?.status).toBe('fetched');
  expect(picture?.fetchAttempts).toBe(0);
  expect(events).toEqual([{ kind: 'profilePicture', accountId, uri: expect.any(String) }]);
});

// Faces before posts: every pending picture is drained to exhaustion
// before the attachment loop ever runs, regardless of recency — not
// counted against maxPhotos at all, so this has to be observed by call
// order rather than by catching the drain mid-way with a small budget.
test('a profile picture is drained before a post, regardless of recency', async () => {
  const circleId = await makeCircle();
  const accountId = `account-${circleId}`;
  const photo = new Uint8Array([1]);
  const postId = await makePendingPost(circleId, photo, 9000); // newer than the picture below
  await makePendingProfilePicture(circleId, accountId, 'pic-1', 1000);
  (getBlob as jest.Mock).mockImplementation(async (_circleId: string, path: string) =>
    path === BlobPaths.picture(accountId, 'pic-1') ? photo : encrypt(photo, KEY)
  );

  await drainPhotoQueue();

  const calledPaths = (getBlob as jest.Mock).mock.calls.map((call) => call[1]);
  expect(calledPaths.indexOf(BlobPaths.picture(accountId, 'pic-1'))).toBeLessThan(calledPaths.indexOf(postId));
});

// Compact and independent of one another, unlike a post or cover — so
// they go out together rather than one at a time. Proven by a gate that
// only opens once both fetches have actually started: a sequential
// implementation would await the first call forever, since nothing
// would ever start the second one to open the gate.
test('fetches multiple pending profile pictures in parallel, not one at a time', async () => {
  // Two circles, not one: applyRoster replaces a circle's whole roster,
  // so calling makePendingProfilePicture twice against the *same*
  // circleId would mark the first account as having left when the
  // second roster (of just the second account) landed.
  const circleA = await makeCircle();
  const circleB = await makeCircle();
  const accountA = `account-a-${circleA}`;
  const accountB = `account-b-${circleB}`;
  await makePendingProfilePicture(circleA, accountA, 'pic-a', 1000);
  await makePendingProfilePicture(circleB, accountB, 'pic-b', 1000);

  let started = 0;
  let releaseBoth: () => void = () => {};
  const bothStarted = new Promise<void>((resolve) => {
    releaseBoth = resolve;
  });
  (getBlob as jest.Mock).mockImplementation(async () => {
    started += 1;
    if (started === 2) releaseBoth();
    await bothStarted;
    return new Uint8Array([1]);
  });

  await drainPhotoQueue();

  expect(started).toBe(2);
  expect((await getProfilePicture(accountA))?.status).toBe('fetched');
  expect((await getProfilePicture(accountB))?.status).toBe('fetched');
});

// deadlineMs has no real caller yet (see DrainBudget's own doc comment),
// but it's being kept for an eventual background-fetch task, so the
// picture-draining loop has to actually honor it now, not just the
// attachment loop — a backlog spread across many stale circles
// shouldn't be able to run past a real deadline uncounted.
test('stops draining profile pictures once the deadline has passed', async () => {
  const circleId = await makeCircle();
  const accountId = `account-${circleId}`;
  await makePendingProfilePicture(circleId, accountId, 'pic-1', 1000);
  (getBlob as jest.Mock).mockResolvedValue(new Uint8Array([1]));

  await drainPhotoQueue({ deadlineMs: -1 });

  expect(getBlob).not.toHaveBeenCalled();
  expect((await getProfilePicture(accountId))?.status).toBe('pending');
});

// A blob that was never uploaded (or was already retired) is an ordinary
// miss, not corruption — same as a post or a cover.
test('a missing profile picture backs off rather than retrying forever', async () => {
  const circleId = await makeCircle();
  const accountId = `account-${circleId}`;
  await makePendingProfilePicture(circleId, accountId, 'pic-1', 1000);
  (getBlob as jest.Mock).mockResolvedValue(null);

  await drainPhotoQueue();

  const picture = await getProfilePicture(accountId);
  expect(picture?.status).toBe('failed');
  expect(picture?.bytes).toBeNull();
  expect(picture?.fetchAttempts).toBe(1);
  expect(picture?.nextAttemptAt).toBeGreaterThan(Date.now());
});

// getFetchableProfilePictures' own gate only checks that the account has
// some row in a circle this device hasn't left; it says nothing about
// whether that one account has since left that particular circle, so
// findCircleSharedWith's own, stricter check is what actually catches
// this case — backing it off rather than throwing out of the drain loop.
test('a profile picture backs off once the account has left every circle this device shares', async () => {
  const circleId = await makeCircle();
  const accountId = `account-${circleId}`;
  await applyRoster(circleId, [{ circleId, accountId, name: 'Sarah', publicKey: 'pk', role: 'member', joinedAt: 1000 }], 1000);
  await applyRoster(circleId, [], 1100); // this account leaves; the circle itself stays
  await upsertProfilePictureRef(accountId, 'pic-1', 1100);

  await drainPhotoQueue();

  expect(getBlob).not.toHaveBeenCalled();
  expect((await getProfilePicture(accountId))?.status).toBe('failed');
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

test('drains every cover before any post, regardless of recency', async () => {
  const circleId = await makeCircle();
  const photo = new Uint8Array([1]);
  await makePendingPost(circleId, photo, 9000); // newer than the cover below
  const coverEntry = await makePendingCover(circleId, photo, 1000); // older, but must still win the tier

  const [first] = await getFetchableAttachments(Date.now(), 1);

  expect(first.kind).toBe(AttachmentKinds.CIRCLE_COVER);
  expect(first.entryId).toBe(coverEntry);
});

test('within the cover tier, newest still wins', async () => {
  const circleId = await makeCircle();
  const photo = new Uint8Array([1]);
  await makePendingPost(circleId, photo, 9000); // must still lose to both, despite being newest overall
  await makePendingCover(circleId, photo, 1000, 'cover-1');
  const newerCover = await makePendingCover(circleId, photo, 2000, 'cover-2');

  const [first] = await getFetchableAttachments(Date.now(), 1);

  expect(first.entryId).toBe(newerCover);
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
