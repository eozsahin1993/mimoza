jest.mock('@/features/circle/usecases/sync-circle');
jest.mock('@/features/account/usecases/account-manifest');
jest.mock('@/core/services/log-relay');
jest.mock('@/core/services/push-relay');
jest.mock('@/core/photo/image');

import { Buffer } from 'buffer';

import { initDatabase, insertPost } from '@/data/db';
import { createCircle } from '@/features/circle/usecases/create-circle';
import { buildAndEncryptLogEntry, EntryTypes } from '@/core/sync/log-entry';
import { resetLocalDataForTesting } from '@/features/dev/dev-reset';
import { resolvePushDestination } from '@/features/push-notifications/usecases/push-destination';
import { generateUUID, type Keypair } from '@/core/crypto/primitives';
import { derivePushRoutingId } from '@/core/crypto/identity';
import { getCircleIdentity, getCurrentContentKey } from '@/core/services/keystore/circle-keys';
import { getMasterSeed, saveMasterSeed } from '@/core/services/keystore/master-seed';
import { appendEntry, bootstrapCircle } from '@/core/services/log-relay';

beforeAll(async () => {
  await initDatabase();
});

beforeEach(async () => {
  jest.clearAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
  await resetLocalDataForTesting();
  await saveMasterSeed(new Uint8Array(16).fill(9));
});

/** A push as it arrives: the routing id, and the entry's own ciphertext. */
async function pushFor(circleId: string, type: string, author: Keypair, payload: object) {
  const current = (await getCurrentContentKey(circleId))!;
  const entry = buildAndEncryptLogEntry(type, payload, author, current.key);
  return {
    pushRoutingId: derivePushRoutingId((await getMasterSeed())!, circleId),
    keyVersion: String(current.version),
    payload: Buffer.from(entry).toString('base64'),
  };
}

async function insertLocalPost(circleId: string, authorPublicKey: string): Promise<string> {
  const postId = generateUUID();
  await insertPost({
    id: postId,
    circleId,
    caption: '',
    authorPublicKey,
    createdAt: 1_000,
    lastViewedAt: null,
    inAlbum: false,
  });
  return postId;
}

test('a comment on a post this device holds opens the post', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const identity = (await getCircleIdentity(circleId))!;
  const postId = await insertLocalPost(circleId, 'aa');

  const destination = await resolvePushDestination(
    await pushFor(circleId, EntryTypes.COMMENT, identity, { commentId: 'c1', postId, body: 'hi', createdAt: 2 }),
  );

  expect(destination).toEqual({ screen: 'post', circleId, postId });
});

/** The push can outrun the sync that carries its post; the feed syncs on focus and surfaces it. */
test('a comment on a post not yet synced opens the feed', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const identity = (await getCircleIdentity(circleId))!;

  const destination = await resolvePushDestination(
    await pushFor(circleId, EntryTypes.COMMENT, identity, { commentId: 'c1', postId: generateUUID(), body: 'hi', createdAt: 2 }),
  );

  expect(destination).toEqual({ screen: 'feed', circleId });
});

test('a member joining opens the feed', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const identity = (await getCircleIdentity(circleId))!;

  const destination = await resolvePushDestination(
    await pushFor(circleId, EntryTypes.MEMBER_ADDED, identity, { name: 'Nadia', createdAt: 2 }),
  );

  expect(destination).toEqual({ screen: 'feed', circleId });
});

/** iOS hands keyVersion over as a number; the lookup must not care. */
test('a numeric keyVersion resolves the same as a string one', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const identity = (await getCircleIdentity(circleId))!;
  const postId = await insertLocalPost(circleId, 'aa');
  const push = await pushFor(circleId, EntryTypes.COMMENT, identity, { commentId: 'c1', postId, body: 'hi', createdAt: 2 });

  const destination = await resolvePushDestination({ ...push, keyVersion: Number(push.keyVersion) });

  expect(destination).toEqual({ screen: 'post', circleId, postId });
});

/** Garbage still identifies its circle — the tap opens something rather than dying. */
test('an undecryptable payload opens the feed', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });

  const destination = await resolvePushDestination({
    pushRoutingId: derivePushRoutingId((await getMasterSeed())!, circleId),
    keyVersion: '1',
    payload: Buffer.from('garbage').toString('base64'),
  });

  expect(destination).toEqual({ screen: 'feed', circleId });
});

test('an unknown routing id resolves nowhere', async () => {
  await createCircle({ name: 'Family Circle' });

  const destination = await resolvePushDestination({
    pushRoutingId: 'not-a-routing-id-this-device-derives',
    keyVersion: '1',
    payload: Buffer.from('x').toString('base64'),
  });

  expect(destination).toBeNull();
});
