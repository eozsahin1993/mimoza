jest.mock('@/features/circle/usecases/sync-circle');
jest.mock('@/features/account/usecases/account-manifest');
jest.mock('@/core/services/log-relay');
jest.mock('@/core/services/push-relay');
// Only the Android calls are stubbed; the channel id is a pure function
// and is exactly what this asserts.
jest.mock('@/features/push-notifications/services/channels', () => ({
  ensureCircleNotificationChannel: jest.fn().mockResolvedValue(undefined),
  removeCircleNotificationChannel: jest.fn().mockResolvedValue(undefined),
  circleNotificationChannelId: (circleId: string) => `circle-${circleId}`,
}));
jest.mock('@/core/photo/image');

import { Buffer } from 'buffer';
import { bytesToHex } from '@noble/curves/utils.js';

import { initDatabase, MemberRoles, recordMemberAddedLocally } from '@/data/db';
import { createCircle } from '@/features/circle/usecases/create-circle';
import { buildAndEncryptLogEntry, EntryTypes } from '@/core/sync/log-entry';
import { resetLocalDataForTesting } from '@/features/dev/dev-reset';
import { handlePush } from '@/features/push-notifications/usecases/handle-push';
import { generateIdentity, generateUUID, type Keypair } from '@/core/crypto/primitives';
import { derivePushRoutingId } from '@/core/crypto/identity';
import { addCircleKeyVersion, getCircleIdentity, getCurrentContentKey } from '@/core/services/keystore/circle-keys';
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

test('a post becomes the author name and the circle', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const identity = (await getCircleIdentity(circleId))!;
  const current = (await getCurrentContentKey(circleId))!;
  const entry = buildAndEncryptLogEntry(EntryTypes.POST, { postId: 'p1', createdAt: 1 }, identity, current.key);

  const notification = await handlePush({
    pushRoutingId: derivePushRoutingId((await getMasterSeed())!, circleId),
    keyVersion: String(current.version),
    payload: Buffer.from(entry).toString('base64'),
  });

  expect(notification).toMatchObject({ circleId, title: 'Family Circle', channelId: `circle-${circleId}` });
  expect(notification?.body).toContain('added a photo');
});

test('the author is named from the roster', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const marcus = generateIdentity();
  await recordMemberAddedLocally({
    circleId,
    subjectPublicKey: bytesToHex(marcus.publicKey),
    joinedAt: 1_000,
    profile: { encPublicKey: 'cc', memberId: generateUUID(), role: MemberRoles.member, name: 'Marcus', picture: null },
  });

  const notification = await handlePush(
    await pushFor(circleId, EntryTypes.COMMENT, marcus, { postId: 'p1', body: 'hi', createdAt: 1 }),
  );

  expect(notification?.body).toBe('Marcus commented: “hi”');
});

test('a comment on your own post says so', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const marcus = generateIdentity();
  await recordMemberAddedLocally({
    circleId,
    subjectPublicKey: bytesToHex(marcus.publicKey),
    joinedAt: 1_000,
    profile: { encPublicKey: 'cc', memberId: generateUUID(), role: MemberRoles.member, name: 'Marcus', picture: null },
  });
  const own = bytesToHex((await getCircleIdentity(circleId))!.publicKey);

  const notification = await handlePush(
    await pushFor(circleId, EntryTypes.COMMENT, marcus, { postId: 'p1', body: 'hi', createdAt: 1, postAuthorPubkey: own }),
  );

  expect(notification?.body).toBe('Marcus commented on your photo: “hi”');
});

/** A comment push only reaches the thread's participants, so "also" holds. */
test("a comment on someone else's post reads as joining in", async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const marcus = generateIdentity();
  await recordMemberAddedLocally({
    circleId,
    subjectPublicKey: bytesToHex(marcus.publicKey),
    joinedAt: 1_000,
    profile: { encPublicKey: 'cc', memberId: generateUUID(), role: MemberRoles.member, name: 'Marcus', picture: null },
  });

  const notification = await handlePush(
    await pushFor(circleId, EntryTypes.COMMENT, marcus, {
      postId: 'p1',
      body: 'hi',
      createdAt: 1,
      postAuthorPubkey: bytesToHex(generateIdentity().publicKey),
    }),
  );

  expect(notification?.body).toBe('Marcus also commented: “hi”');
});

/** Someone without the circle's key cannot make anything render. */
test('a payload this device cannot decrypt shows nothing', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });

  const notification = await handlePush({
    pushRoutingId: derivePushRoutingId((await getMasterSeed())!, circleId),
    keyVersion: '1',
    payload: Buffer.from('not our ciphertext').toString('base64'),
  });

  expect(notification).toBeNull();
});

/** The push names its version, so a rotation doesn't strand older entries. */
test('an entry encrypted under an older key still decrypts', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const identity = (await getCircleIdentity(circleId))!;
  const original = (await getCurrentContentKey(circleId))!;
  const entry = buildAndEncryptLogEntry(EntryTypes.POST, { postId: 'p1', createdAt: 1 }, identity, original.key);

  await addCircleKeyVersion(circleId, original.version + 1, new Uint8Array(32).fill(5));

  const notification = await handlePush({
    pushRoutingId: derivePushRoutingId((await getMasterSeed())!, circleId),
    keyVersion: String(original.version),
    payload: Buffer.from(entry).toString('base64'),
  });

  expect(notification?.body).toContain('added a photo');
});

/** A version this device doesn't hold is an entry it was never meant to read. */
test('a key version this device does not hold shows nothing', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const identity = (await getCircleIdentity(circleId))!;
  const current = (await getCurrentContentKey(circleId))!;
  const entry = buildAndEncryptLogEntry(EntryTypes.POST, { postId: 'p1', createdAt: 1 }, identity, current.key);

  const notification = await handlePush({
    pushRoutingId: derivePushRoutingId((await getMasterSeed())!, circleId),
    keyVersion: '99',
    payload: Buffer.from(entry).toString('base64'),
  });

  expect(notification).toBeNull();
});

test('a routing id for no circle here shows nothing', async () => {
  await createCircle({ name: 'Family Circle' });

  await expect(handlePush({ pushRoutingId: 'f'.repeat(64), keyVersion: '1', payload: 'AAAA' })).resolves.toBeNull();
});

test.each([
  ['no routing id', { payload: 'AAAA' }],
  ['no payload', { pushRoutingId: 'f'.repeat(64), keyVersion: '1' }],
  ['nothing at all', {}],
])('%s shows nothing', async (_label, data) => {
  await expect(handlePush(data)).resolves.toBeNull();
});

/**
 * `member_added` is signed by the admin who approved it, so naming the
 * author would announce the wrong person entirely.
 */
test('a join names the person who joined, not the admin who approved', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const approver = (await getCircleIdentity(circleId))!;

  const notification = await handlePush(
    await pushFor(circleId, EntryTypes.MEMBER_ADDED, approver, {
      identityPublicKey: bytesToHex(generateIdentity().publicKey),
      encPublicKey: 'cc',
      name: 'Marcus',
      role: MemberRoles.member,
      createdAt: 1,
    }),
  );

  expect(notification?.body).toBe('Marcus joined');
});

/** They arrive before the sync that would put them on the roster. */
test('a join with no name still says something', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const approver = (await getCircleIdentity(circleId))!;

  const notification = await handlePush(
    await pushFor(circleId, EntryTypes.MEMBER_ADDED, approver, { role: MemberRoles.member, createdAt: 1 }),
  );

  expect(notification?.body).toBe('Someone joined');
});

test('a reaction names the emoji, since it always went to the post\'s own owner', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const marcus = generateIdentity();
  await recordMemberAddedLocally({
    circleId,
    subjectPublicKey: bytesToHex(marcus.publicKey),
    joinedAt: 1_000,
    profile: { encPublicKey: 'cc', memberId: generateUUID(), role: MemberRoles.member, name: 'Marcus', picture: null },
  });

  const notification = await handlePush(
    await pushFor(circleId, EntryTypes.REACTION, marcus, { postId: 'p1', emoji: '❤️', reacted: true, createdAt: 1 }),
  );

  expect(notification?.body).toBe('Marcus reacted ❤️ to your photo');
});

/** A malformed or missing emoji still says something, rather than nothing. */
test('a reaction with no usable emoji falls back to generic text', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const marcus = generateIdentity();
  await recordMemberAddedLocally({
    circleId,
    subjectPublicKey: bytesToHex(marcus.publicKey),
    joinedAt: 1_000,
    profile: { encPublicKey: 'cc', memberId: generateUUID(), role: MemberRoles.member, name: 'Marcus', picture: null },
  });

  const notification = await handlePush(
    await pushFor(circleId, EntryTypes.REACTION, marcus, { postId: 'p1', reacted: true, createdAt: 1 }),
  );

  expect(notification?.body).toBe('Marcus reacted to your photo');
});

/** Reactions and posts interrupt; a rename or a key rotation must not. */
test('an entry type that should not interrupt shows nothing', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const identity = (await getCircleIdentity(circleId))!;

  const notification = await handlePush(
    await pushFor(circleId, EntryTypes.CIRCLE_RENAMED, identity, { name: 'Nana House', createdAt: 1 }),
  );

  expect(notification).toBeNull();
});
