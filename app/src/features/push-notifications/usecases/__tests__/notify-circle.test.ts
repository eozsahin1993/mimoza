jest.mock('@/features/circle/usecases/sync-circle');
jest.mock('@/features/account/usecases/account-manifest');
jest.mock('@/core/services/log-relay');
jest.mock('@/core/services/push-relay');
jest.mock('@/core/photo/image');

import { bytesToHex } from '@noble/curves/utils.js';

import { addReaction, initDatabase, insertComment, insertPost, MemberRoles, recordMemberAddedLocally, setMemberPushRoutingId } from '@/data/db';
import { createCircle } from '@/features/circle/usecases/create-circle';
import { buildAndEncryptLogEntry, EntryTypes } from '@/core/sync/log-entry';
import { resetLocalDataForTesting } from '@/features/dev/dev-reset';
import { notifyCircle } from '@/features/push-notifications/usecases/notify-circle';
import { PushCategories } from '@/features/push-notifications/usecases/push-categories';
import { generateIdentity, generateUUID } from '@/core/crypto/primitives';
import { derivePushRoutingId } from '@/core/crypto/identity';
import { derivePushFanoutToken } from '@/core/crypto/push';
import { getCircleIdentity, getCurrentContentKey } from '@/core/services/keystore/circle-keys';
import { getMasterSeed, saveMasterSeed } from '@/core/services/keystore/master-seed';
import { sendPush } from '@/core/services/push-relay';
import { appendEntry, bootstrapCircle } from '@/core/services/log-relay';

const payload = new Uint8Array([7, 7, 7]);

beforeAll(async () => {
  await initDatabase();
});

beforeEach(async () => {
  jest.clearAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
  (sendPush as jest.Mock).mockResolvedValue({ delivered: 1, skipped: 0 });
  await resetLocalDataForTesting();
  await saveMasterSeed(new Uint8Array(16).fill(9));
});

/** Adds a member with a published routing id, and returns it. */
async function addMemberWithRouting(circleId: string, name: string): Promise<string> {
  const key = bytesToHex(generateIdentity().publicKey);
  await recordMemberAddedLocally({
    circleId,
    subjectPublicKey: key,
    joinedAt: 1_000,
    profile: { encPublicKey: 'cc', memberId: generateUUID(), role: MemberRoles.member, name, picture: null },
  });
  const pushRoutingId = `routing-${name}`;
  await setMemberPushRoutingId(circleId, key, pushRoutingId);
  return pushRoutingId;
}

test('targets every member who published a routing id', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const marcus = await addMemberWithRouting(circleId, 'marcus');
  const nadia = await addMemberWithRouting(circleId, 'nadia');

  await notifyCircle(circleId, PushCategories.newPost, 1, payload);

  const [routingIds, fanoutToken, category, keyVersion, sentPayload] = (sendPush as jest.Mock).mock.calls[0];
  expect([...routingIds].sort()).toEqual([marcus, nadia].sort());
  expect(fanoutToken).toEqual(derivePushFanoutToken((await getCurrentContentKey(circleId))!.key));
  expect(category).toBe(PushCategories.newPost);
  expect(keyVersion).toBe(1);
  expect(sentPayload).toBe(payload);
});

/** Your devices share one routing id, so excluding it silences all of them. */
test('never targets the sender', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const identity = (await getCircleIdentity(circleId))!;
  await setMemberPushRoutingId(circleId, bytesToHex(identity.publicKey), derivePushRoutingId((await getMasterSeed())!, circleId));
  const marcus = await addMemberWithRouting(circleId, 'marcus');

  await notifyCircle(circleId, PushCategories.newPost, 1, payload);

  expect((sendPush as jest.Mock).mock.calls[0][0]).toEqual([marcus]);
});

/** A member who never opted into notifications simply isn't targetable. */
test('skips members with no routing id', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  await recordMemberAddedLocally({
    circleId,
    subjectPublicKey: bytesToHex(generateIdentity().publicKey),
    joinedAt: 1_000,
    profile: { encPublicKey: 'cc', memberId: generateUUID(), role: MemberRoles.member, name: 'Quiet', picture: null },
  });

  await notifyCircle(circleId, PushCategories.newPost, 1, payload);

  expect(sendPush).not.toHaveBeenCalled();
});

test('a circle with nobody to notify sends nothing', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });

  await notifyCircle(circleId, PushCategories.comment, 1, payload);

  expect(sendPush).not.toHaveBeenCalled();
});

describe('reaction scoping', () => {
  /** A circle with a post owned by someone other than this device's own identity. */
  async function circleWithPost() {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const ownerKey = bytesToHex(generateIdentity().publicKey);
    await recordMemberAddedLocally({
      circleId,
      subjectPublicKey: ownerKey,
      joinedAt: 1_000,
      profile: { encPublicKey: 'cc', memberId: generateUUID(), role: MemberRoles.member, name: 'Owner', picture: null },
    });
    const ownerRoutingId = 'routing-owner';
    await setMemberPushRoutingId(circleId, ownerKey, ownerRoutingId);
    await addMemberWithRouting(circleId, 'bystander');

    const postId = generateUUID();
    await insertPost({ id: postId, circleId, caption: 'c', authorPublicKey: ownerKey, createdAt: 1_000, lastViewedAt: null, inAlbum: true });

    return { circleId, postId, ownerKey, ownerRoutingId };
  }

  async function reactionEntry(circleId: string, postId: string, emoji: string, reacted: boolean) {
    const identity = (await getCircleIdentity(circleId))!;
    const current = (await getCurrentContentKey(circleId))!;
    return buildAndEncryptLogEntry(EntryTypes.REACTION, { postId, emoji, reacted, createdAt: Date.now() }, identity, current.key);
  }

  test('targets only the post owner, not the rest of the circle', async () => {
    const { circleId, postId, ownerRoutingId } = await circleWithPost();

    await notifyCircle(circleId, PushCategories.reaction, 1, await reactionEntry(circleId, postId, '❤️', true));

    expect((sendPush as jest.Mock).mock.calls[0][0]).toEqual([ownerRoutingId]);
  });

  test('a toggle-off notifies nobody', async () => {
    const { circleId, postId } = await circleWithPost();

    await notifyCircle(circleId, PushCategories.reaction, 1, await reactionEntry(circleId, postId, '❤️', false));

    expect(sendPush).not.toHaveBeenCalled();
  });

  /** Only the first emoji on a post is news; the rest are the same reactor piling on. */
  test('a second emoji from someone who already reacted to this post notifies nobody', async () => {
    const { circleId, postId } = await circleWithPost();
    const ownKey = bytesToHex((await getCircleIdentity(circleId))!.publicKey);
    await addReaction({ postId, authorPublicKey: ownKey, emoji: '❤️', createdAt: 1_000 });

    await notifyCircle(circleId, PushCategories.reaction, 1, await reactionEntry(circleId, postId, '🙏', true));

    expect(sendPush).not.toHaveBeenCalled();
  });

  /** Reacting to your own post is never news to yourself — and `recipients` excludes the sender regardless. */
  test('reacting to your own post notifies nobody', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const ownKey = bytesToHex((await getCircleIdentity(circleId))!.publicKey);
    const postId = generateUUID();
    await insertPost({ id: postId, circleId, caption: 'c', authorPublicKey: ownKey, createdAt: 1_000, lastViewedAt: null, inAlbum: true });

    await notifyCircle(circleId, PushCategories.reaction, 1, await reactionEntry(circleId, postId, '❤️', true));

    expect(sendPush).not.toHaveBeenCalled();
  });

  /** No identifiable post — falls back to nobody, never to the whole circle. */
  test('a reaction on an unknown post notifies nobody', async () => {
    const { circleId } = await circleWithPost();

    await notifyCircle(circleId, PushCategories.reaction, 1, await reactionEntry(circleId, 'no-such-post', '❤️', true));

    expect(sendPush).not.toHaveBeenCalled();
  });
});

describe('comment scoping', () => {
  async function commentEntry(circleId: string, postId: string) {
    const identity = (await getCircleIdentity(circleId))!;
    const current = (await getCurrentContentKey(circleId))!;
    return buildAndEncryptLogEntry(
      EntryTypes.COMMENT,
      { commentId: generateUUID(), postId, body: 'hi', createdAt: Date.now() },
      identity,
      current.key,
    );
  }

  test("a post's first comment reaches only its owner", async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const ownerKey = bytesToHex(generateIdentity().publicKey);
    await recordMemberAddedLocally({
      circleId, subjectPublicKey: ownerKey, joinedAt: 1_000,
      profile: { encPublicKey: 'cc', memberId: generateUUID(), role: MemberRoles.member, name: 'Owner', picture: null },
    });
    await setMemberPushRoutingId(circleId, ownerKey, 'routing-owner');
    await addMemberWithRouting(circleId, 'bystander');
    const postId = generateUUID();
    await insertPost({ id: postId, circleId, caption: 'c', authorPublicKey: ownerKey, createdAt: 1_000, lastViewedAt: null, inAlbum: true });

    await notifyCircle(circleId, PushCategories.comment, 1, await commentEntry(circleId, postId));

    expect((sendPush as jest.Mock).mock.calls[0][0]).toEqual(['routing-owner']);
  });

  test('a later comment also reaches everyone who already commented, not the rest of the circle', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const ownerKey = bytesToHex(generateIdentity().publicKey);
    await recordMemberAddedLocally({
      circleId, subjectPublicKey: ownerKey, joinedAt: 1_000,
      profile: { encPublicKey: 'cc', memberId: generateUUID(), role: MemberRoles.member, name: 'Owner', picture: null },
    });
    await setMemberPushRoutingId(circleId, ownerKey, 'routing-owner');
    const priorCommenterKey = bytesToHex(generateIdentity().publicKey);
    await recordMemberAddedLocally({
      circleId, subjectPublicKey: priorCommenterKey, joinedAt: 1_000,
      profile: { encPublicKey: 'cc', memberId: generateUUID(), role: MemberRoles.member, name: 'Prior Commenter', picture: null },
    });
    await setMemberPushRoutingId(circleId, priorCommenterKey, 'routing-prior');
    await addMemberWithRouting(circleId, 'bystander');
    const postId = generateUUID();
    await insertPost({ id: postId, circleId, caption: 'c', authorPublicKey: ownerKey, createdAt: 1_000, lastViewedAt: null, inAlbum: true });
    await insertComment({ id: generateUUID(), postId, authorPublicKey: priorCommenterKey, body: 'first!', createdAt: 2_000 });

    await notifyCircle(circleId, PushCategories.comment, 1, await commentEntry(circleId, postId));

    expect([...(sendPush as jest.Mock).mock.calls[0][0]].sort()).toEqual(['routing-owner', 'routing-prior'].sort());
  });

  test('commenting on your own post still reaches a prior commenter', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const ownKey = bytesToHex((await getCircleIdentity(circleId))!.publicKey);
    const priorCommenterKey = bytesToHex(generateIdentity().publicKey);
    await recordMemberAddedLocally({
      circleId, subjectPublicKey: priorCommenterKey, joinedAt: 1_000,
      profile: { encPublicKey: 'cc', memberId: generateUUID(), role: MemberRoles.member, name: 'Prior Commenter', picture: null },
    });
    await setMemberPushRoutingId(circleId, priorCommenterKey, 'routing-prior');
    const postId = generateUUID();
    await insertPost({ id: postId, circleId, caption: 'c', authorPublicKey: ownKey, createdAt: 1_000, lastViewedAt: null, inAlbum: true });
    await insertComment({ id: generateUUID(), postId, authorPublicKey: priorCommenterKey, body: 'first!', createdAt: 2_000 });

    await notifyCircle(circleId, PushCategories.comment, 1, await commentEntry(circleId, postId));

    expect((sendPush as jest.Mock).mock.calls[0][0]).toEqual(['routing-prior']);
  });

  /** `recipients` never includes the sender — a prior comment from yourself doesn't change that. */
  test('never notifies the commenter about their own comment', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const ownerKey = bytesToHex(generateIdentity().publicKey);
    await recordMemberAddedLocally({
      circleId, subjectPublicKey: ownerKey, joinedAt: 1_000,
      profile: { encPublicKey: 'cc', memberId: generateUUID(), role: MemberRoles.member, name: 'Owner', picture: null },
    });
    await setMemberPushRoutingId(circleId, ownerKey, 'routing-owner');
    const ownKey = bytesToHex((await getCircleIdentity(circleId))!.publicKey);
    const postId = generateUUID();
    await insertPost({ id: postId, circleId, caption: 'c', authorPublicKey: ownerKey, createdAt: 1_000, lastViewedAt: null, inAlbum: true });
    await insertComment({ id: generateUUID(), postId, authorPublicKey: ownKey, body: 'earlier', createdAt: 1_500 });

    await notifyCircle(circleId, PushCategories.comment, 1, await commentEntry(circleId, postId));

    expect((sendPush as jest.Mock).mock.calls[0][0]).toEqual(['routing-owner']);
  });

  /** No identifiable post and nobody prior — falls back to nobody, never to the whole circle. */
  test('a comment on an unknown post notifies nobody', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    await addMemberWithRouting(circleId, 'bystander');

    await notifyCircle(circleId, PushCategories.comment, 1, await commentEntry(circleId, 'no-such-post'));

    expect(sendPush).not.toHaveBeenCalled();
  });
});
