jest.mock('@/core/services/log-relay');
jest.mock('@/core/services/blob-relay');
jest.mock('@/features/account/usecases/account-manifest');
jest.mock('@/core/services/mailbox-relay');
jest.mock('@/features/invite/services/invite-preview-relay');

import { bytesToHex } from '@noble/curves/utils.js';

import {
  getAllCircles,
  getCircleFeed,
  getCircleMemberEvents,
  getCircleMembers,
  getPostComments,
  initDatabase,
  saveProfile,
} from '@/data/db';
import { createCircle } from '@/features/circle/usecases/create-circle';
import { setMemberRole } from '@/features/circle/usecases/change-member-role';
import { approveJoinRequest, getOrCreateInvite } from '@/features/invite/usecases/invite-to-circle';
import type { JoinRequestPayload } from '@/features/invite/usecases/invite-payloads';
import { buildAndEncryptLogEntry, verifyLogEntry } from '@/core/sync/log-entry';
import { addComment } from '@/features/post/usecases/comment-on-post';
import { createPost } from '@/features/post/usecases/create-post';
import { getReactionsForPost, toggleReaction } from '@/features/post/usecases/react-to-post';
import { encrypt, encryptJSON, generateEphemeralKeypair, generateIdentity, generateUUID, hashBytes, sign } from '@/core/crypto/primitives';
import { deriveAuthorityKeyProofMessage } from '@/core/crypto/signed-messages';
import { deriveJoinRequestKey } from '@/features/invite/crypto';
import { listJoinRequests, putJoinApproval } from '@/core/services/mailbox-relay';
import { createInvitePreview } from '@/features/invite/services/invite-preview-relay';
import { getCircleIdentity, getCurrentContentKey } from '@/core/services/keystore/circle-keys';
import { saveMasterSeed } from '@/core/services/keystore/master-seed';
import { saveAuthToken } from '@/core/services/keystore/auth-token';
import {
  appendEntry,
  bootstrapCircle,
  changeAuthority,
  fetchEntries,
  fetchEpochs,
  type Namespace,
} from '@/core/services/log-relay';
import { getBlob, getUploadTarget, uploadBlob } from '@/core/services/blob-relay';
import { memberAddedHandler } from '@/core/sync/entry-handlers/member-added';
import { drainPhotoQueue } from '@/core/photo/photo-queue';
import { drainOutbox } from '@/features/circle/usecases/sync-circle';
import { syncCircle, syncStaleCircles } from '@/core/sync/sync-circles';

beforeAll(async () => {
  await saveAuthToken('session-token');
  await initDatabase();
  await saveMasterSeed(new Uint8Array(16));
});

beforeEach(() => {
  jest.clearAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
  (changeAuthority as jest.Mock).mockResolvedValue({ epoch: 2, receivedAt: Date.now() });
  (getUploadTarget as jest.Mock).mockResolvedValue({ url: 'https://s3', fields: {} });
  (uploadBlob as jest.Mock).mockResolvedValue(undefined);
  (fetchEntries as jest.Mock).mockResolvedValue({ entries: [], currentEpoch: 0 });
  (fetchEpochs as jest.Mock).mockResolvedValue([]);
  (createInvitePreview as jest.Mock).mockResolvedValue(undefined);
});

/**
 * Stands in for the relay: serves `meta`/`content` entries per namespace,
 * so one process can play "the other device already wrote these".
 */
function relayServes(byNamespace: { meta?: unknown[]; content?: unknown[] }) {
  (fetchEntries as jest.Mock).mockImplementation(async (_syncId: string, namespace: Namespace) => {
    const entries = (byNamespace[namespace] ?? []) as { epoch: number }[];
    return { entries, currentEpoch: entries.length > 0 ? entries[entries.length - 1].epoch : 0 };
  });
}

test('syncCircle picks up another member and their post, photo and all', async () => {
  // This device founds the circle; a second member and their post arrive
  // over the log — the gap createCircle/completeJoin both document as
  // "existing members only learn of this once pullCircle exists".
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const founder = (await getCircleIdentity(circleId))!;
  const contentKey = (await getCurrentContentKey(circleId))!.key;

  const other = generateIdentity();
  const postId = generateUUID();
  const photo = new Uint8Array([9, 9, 9]);

  relayServes({
    meta: [
      {
        epoch: 2,
        keyVersion: 1,
        receivedAt: Date.now(),
        // Signed by the founder — the approver, as the design intends.
        encryptedMeta: buildAndEncryptLogEntry(
          'member_added',
          { identityPublicKey: bytesToHex(other.publicKey), encPublicKey: 'cc', name: 'Marcus', role: 'member' },
          founder,
          contentKey
        ),
      },
    ],
    content: [
      {
        epoch: 1,
        keyVersion: 1,
        receivedAt: Date.now(),
        encryptedMeta: buildAndEncryptLogEntry(
          'post',
          { postId, caption: 'From the other device', photoHash: hashBytes(photo), createdAt: 8000, keyVersion: 1 },
          other,
          contentKey
        ),
      },
    ],
  });

  await syncCircle(circleId);

  const members = await getCircleMembers(circleId);
  expect(members.map((member) => member.name)).toContain('Marcus');

  const [post] = await getCircleFeed(circleId);
  expect(post).toMatchObject({ caption: 'From the other device', authorName: 'Marcus' });
  // The log pass deliberately does not download photos.
  expect(post.hasPhoto).toBe(false);
  expect(post.photoStatus).toBe('pending');

  (getBlob as jest.Mock).mockResolvedValue(encrypt(photo, contentKey));
  await drainPhotoQueue();

  const [withPhoto] = await getCircleFeed(circleId);
  expect(withPhoto.hasPhoto).toBe(true);
});

test('syncCircle pushes the queued posts this device made while pulling', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  await createPost({ circleId, caption: 'Mine', photo: new Uint8Array([1, 2, 3]), inAlbum: true });
  (appendEntry as jest.Mock).mockClear();

  await syncCircle(circleId);

  // Nothing outstanding to push after a pass that drained the outbox.
  const appendedTypes = (appendEntry as jest.Mock).mock.calls.map((call) => call[1]);
  expect(appendedTypes).toEqual(expect.arrayContaining(['content']));
});

test('meta is fully caught up before any content entry is read', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const order: Namespace[] = [];
  (fetchEntries as jest.Mock).mockImplementation(async (_syncId: string, namespace: Namespace) => {
    order.push(namespace);
    return { entries: [], currentEpoch: 0 };
  });

  await syncCircle(circleId);

  // A content entry needs its key version and its author, both of which
  // only meta can supply — so the order here is load-bearing, not stylistic.
  expect(order).toEqual(['meta', 'content']);
});

test('a post this device just pushed comes straight back on the same pass without duplicating', async () => {
  // pullContent runs after drainOutbox, so our own freshly-appended entry
  // is in the very next page the relay serves. It must be absorbed as a
  // no-op, not re-materialized or reset to pending.
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const founder = (await getCircleIdentity(circleId))!;
  const contentKey = (await getCurrentContentKey(circleId))!.key;
  const photo = new Uint8Array([1, 2, 3]);
  await createPost({ circleId, caption: 'Mine', photo, inAlbum: true });

  const [{ id: postId }] = await getCircleFeed(circleId);
  relayServes({
    content: [
      {
        epoch: 1,
        keyVersion: 1,
        receivedAt: Date.now(),
        encryptedMeta: buildAndEncryptLogEntry(
          'post',
          { postId, caption: 'Mine', photoHash: hashBytes(photo), createdAt: 1, keyVersion: 1 },
          founder,
          contentKey
        ),
      },
    ],
  });

  await syncCircle(circleId);

  const feed = await getCircleFeed(circleId);
  expect(feed).toHaveLength(1);
  // Still holds its local bytes — the echo must not blank them back to
  // 'pending' and send the download queue chasing a photo we authored.
  expect(feed[0].hasPhoto).toBe(true);
  expect(feed[0].photoStatus).toBe('fetched');
});

/**
 * The half of `member_events` that no local writer can do. A roster
 * change made on this device updates `circle_members` immediately but
 * writes no history: the entry is still in the outbox with no epoch, and
 * epoch is what an event row is keyed on (see data/db/member-events.ts).
 * The row only exists once the entry has been appended, given an epoch,
 * and pulled back — including when this device is the author, which works
 * only because pull-log has no "skip what I wrote" filter.
 */
/** A published authority key plus the proof its owner holds it. */
function authorityClaim(identityPublicKey: string) {
  const authority = generateIdentity();
  return {
    authorityPublicKey: bytesToHex(authority.publicKey),
    authorityKeyProof: bytesToHex(sign(deriveAuthorityKeyProofMessage(identityPublicKey), authority.secretKey)),
  };
}

test('a role change made here writes no history until its own entry echoes back', async () => {
  await saveProfile({ name: 'Nadia', picture: null, createdAt: 1, updatedAt: 1 });
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const founder = (await getCircleIdentity(circleId))!;
  const contentKey = (await getCurrentContentKey(circleId))!.key;

  const other = generateIdentity();
  const otherKey = bytesToHex(other.publicKey);
  const memberAdded = {
    epoch: 1,
    keyVersion: 1,
    receivedAt: Date.now(),
    encryptedMeta: buildAndEncryptLogEntry(
      'member_added',
      {
        identityPublicKey: otherKey,
        encPublicKey: 'cc',
        name: 'Marcus',
        role: 'member',
        createdAt: 1_000,
        // Without a published authority key — proof and all — there is
        // nothing to put in the relay's set, so a promotion has nothing
        // to name. See `provenAuthorityKey`.
        ...authorityClaim(otherKey),
      },
      founder,
      contentKey
    ),
  };
  relayServes({ meta: [memberAdded] });
  await syncCircle(circleId);

  await setMemberRole(circleId, otherKey, 'admin');
  // setMemberRole drains fire-and-forget; settle it so the append below
  // is in hand before anything is asserted about it.
  await drainOutbox(circleId).catch(() => {});

  // Nothing has changed yet, roster included: an authority change is one
  // the relay can genuinely refuse, so the entry replaying back is the
  // only thing that writes it.
  expect((await getCircleMembers(circleId)).find((member) => member.identityPublicKey === otherKey)?.role).toBe(
    'member'
  );
  expect((await getCircleMemberEvents(circleId)).map((event) => event.kind)).toEqual(['added']);

  // Serve back the very bytes this device pushed, rather than a
  // reconstruction — that's the whole point of the round trip. A
  // promotion leaves by `changeAuthority`, not the generic append: the
  // relay has to move its authority set in the same transaction.
  const pushed = (changeAuthority as jest.Mock).mock.calls[0][0].encryptedMeta;
  relayServes({ meta: [memberAdded, { epoch: 2, keyVersion: 1, receivedAt: Date.now(), encryptedMeta: pushed }] });

  await syncCircle(circleId);

  // The role lands on the replay, never before it.
  expect((await getCircleMembers(circleId)).find((member) => member.identityPublicKey === otherKey)?.role).toBe('admin');

  const [newest] = await getCircleMemberEvents(circleId);
  expect(newest).toMatchObject({
    kind: 'role_changed',
    role: 'admin',
    subjectName: 'Marcus',
    actorName: 'Nadia',
    selfInflicted: false,
  });
  // Replaying the same entry can't double it — the (circle, epoch) key holds.
  await syncCircle(circleId);
  expect((await getCircleMemberEvents(circleId)).filter((event) => event.kind === 'role_changed')).toHaveLength(1);
});

test('approving a join makes the new member visible to everyone, not just to the approver', async () => {
  // The gap this closes: previously the joiner announced itself, and every
  // other device discarded that entry because nobody had vouched for the
  // signer. Now the approver — an admin — writes it.
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const founder = (await getCircleIdentity(circleId))!;
  const contentKey = (await getCurrentContentKey(circleId))!.key;
  const joiner = generateIdentity();
  const joinerKey = bytesToHex(joiner.publicKey);

  const invite = await getOrCreateInvite(circleId);
  const requestPayload: JoinRequestPayload = {
    ephemeralPublicKey: bytesToHex(generateEphemeralKeypair().publicKey),
    identityPublicKey: joinerKey,
    encPublicKey: 'cc'.repeat(32),
    selfReportedName: 'Marcus',
  };
  (listJoinRequests as jest.Mock).mockResolvedValue([
    {
      requesterId: 'req-1',
      encryptedRequest: encryptJSON(requestPayload, deriveJoinRequestKey(invite.code)),
      encryptedApproval: null,
      createdAt: Date.now(),
    },
  ]);
  (putJoinApproval as jest.Mock).mockResolvedValue(undefined);

  await approveJoinRequest(circleId, 'req-1');
  // approveJoinRequest kicks the push off fire-and-forget so approval
  // never blocks on the network; await it here to assert on what lands.
  await drainOutbox(circleId);

  // Visible locally straight away, rather than only after a sync pass.
  const members = await getCircleMembers(circleId);
  expect(members.map((member) => member.identityPublicKey)).toContain(joinerKey);

  // And the entry that tells everyone else was appended, signed by the
  // approver so their predicate accepts it.
  const metaAppends = (appendEntry as jest.Mock).mock.calls.filter((call) => call[1] === 'meta');
  expect(metaAppends.length).toBeGreaterThan(0);
  const appended = verifyLogEntry(metaAppends[metaAppends.length - 1][3], contentKey);
  expect(appended).toMatchObject({
    type: 'member_added',
    authorPubkey: bytesToHex(founder.publicKey),
    payload: { identityPublicKey: joinerKey, name: 'Marcus', role: 'member' },
  });
});

test('a comment written here is pushed, and one from another device arrives', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const founder = (await getCircleIdentity(circleId))!;
  const contentKey = (await getCurrentContentKey(circleId))!.key;
  await createPost({ circleId, caption: 'Mine', photo: new Uint8Array([1, 2, 3]), inAlbum: true });
  const [{ id: postId }] = await getCircleFeed(circleId);

  // Written here: lands locally and goes out to the relay as content.
  await addComment(circleId, postId, 'Nice one');
  (appendEntry as jest.Mock).mockClear();
  await drainOutbox(circleId);

  // The post's own entry may still have been queued, so look for the
  // comment among what went out rather than assuming it was alone.
  const pushed = (appendEntry as jest.Mock).mock.calls
    .filter((call) => call[1] === 'content')
    .map((call) => verifyLogEntry(call[3], contentKey));
  expect(pushed.filter((entry) => entry?.type === 'comment')).toEqual([
    expect.objectContaining({
      authorPubkey: bytesToHex(founder.publicKey),
      payload: expect.objectContaining({ postId, body: 'Nice one' }),
    }),
  ]);

  // Arriving from elsewhere: applied on the next content pass.
  const other = generateIdentity();
  await memberAddedHandler.apply(
    circleId,
    {
      type: 'member_added',
      payload: { identityPublicKey: bytesToHex(other.publicKey), encPublicKey: 'cc', name: 'Marcus', role: 'member' },
      authorPubkey: bytesToHex(founder.publicKey),
      signature: 'unused',
    },
    1
  );
  relayServes({
    content: [
      {
        epoch: 9,
        keyVersion: 1,
        receivedAt: Date.now(),
        encryptedMeta: buildAndEncryptLogEntry(
          'comment',
          { commentId: generateUUID(), postId, body: 'From Marcus', createdAt: 8000 },
          other,
          contentKey
        ),
      },
    ],
  });

  await syncCircle(circleId);

  const comments = await getPostComments(circleId, postId);
  expect(comments.map((c) => c.body)).toEqual(expect.arrayContaining(['Nice one', 'From Marcus']));
  // Names resolve from the roster, not from anything stored on the comment.
  expect(comments.find((c) => c.body === 'From Marcus')?.authorName).toBe('Marcus');
});

test('a reaction toggled here is pushed, and one from another device arrives', async () => {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const founder = (await getCircleIdentity(circleId))!;
  const contentKey = (await getCurrentContentKey(circleId))!.key;
  await createPost({ circleId, caption: 'Mine', photo: new Uint8Array([1, 2, 3]), inAlbum: true });
  const [{ id: postId }] = await getCircleFeed(circleId);

  await toggleReaction(circleId, postId, '❤️');
  (appendEntry as jest.Mock).mockClear();
  await drainOutbox(circleId);

  const pushed = (appendEntry as jest.Mock).mock.calls
    .filter((call) => call[1] === 'content')
    .map((call) => verifyLogEntry(call[3], contentKey));
  expect(pushed.filter((entry) => entry?.type === 'reaction')).toEqual([
    expect.objectContaining({ payload: expect.objectContaining({ postId, emoji: '❤️', reacted: true }) }),
  ]);

  const other = generateIdentity();
  await memberAddedHandler.apply(circleId, {
    type: 'member_added',
    payload: { identityPublicKey: bytesToHex(other.publicKey), encPublicKey: 'cc', name: 'Marcus', role: 'member' },
    authorPubkey: bytesToHex(founder.publicKey),
    signature: 'unused',
  }, 1);
  relayServes({
    content: [
      {
        epoch: 9,
        keyVersion: 1,
        receivedAt: Date.now(),
        encryptedMeta: buildAndEncryptLogEntry(
          'reaction',
          { postId, emoji: '❤️', reacted: true, createdAt: 9000 },
          other,
          contentKey
        ),
      },
    ],
  });

  await syncCircle(circleId);

  const [summary] = await getReactionsForPost(circleId, postId);
  expect(summary).toMatchObject({ emoji: '❤️', count: 2, reactedByMe: true });
});

describe('syncStaleCircles', () => {
  test('runs a real sync for a circle whose remote epoch is ahead of its local cursor', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const founder = (await getCircleIdentity(circleId))!;
    const contentKey = (await getCurrentContentKey(circleId))!.key;
    // getAllCircles returns every circle from every earlier test too, ordered
    // by createdAt — must find this test's own circle, not assume it's first.
    const { syncId } = (await getAllCircles()).find((circle) => circle.id === circleId)!;
    const other = generateIdentity();
    const postId = generateUUID();
    const photo = new Uint8Array([1, 2, 3]);

    // contentCursor starts at 0 for a fresh circle — 1 is ahead of it.
    (fetchEpochs as jest.Mock).mockResolvedValue([{ syncId, metaEpoch: 1, contentEpoch: 1 }]);
    relayServes({
      content: [
        {
          epoch: 1,
          keyVersion: 1,
          receivedAt: Date.now(),
          encryptedMeta: buildAndEncryptLogEntry(
            'post',
            { postId, caption: 'From elsewhere', photoHash: hashBytes(photo), createdAt: 1, keyVersion: 1 },
            other,
            contentKey
          ),
        },
      ],
    });
    // The author must be a known member for the content entry's predicate to accept it.
    await memberAddedHandler.apply(circleId, {
      type: 'member_added',
      payload: { identityPublicKey: bytesToHex(other.publicKey), encPublicKey: 'cc', name: 'Marcus', role: 'member' },
      authorPubkey: bytesToHex(founder.publicKey),
      signature: 'unused',
    }, 1);

    await syncStaleCircles();

    const [post] = await getCircleFeed(circleId);
    expect(post).toMatchObject({ caption: 'From elsewhere' });
  });

  test('skips a circle whose remote epoch matches its local cursor and has nothing queued', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    const { syncId, metaCursor, contentCursor } = (await getAllCircles()).find((circle) => circle.id === circleId)!;

    // Reports exactly what this device already has — nothing new, nothing queued.
    (fetchEpochs as jest.Mock).mockResolvedValue([{ syncId, metaEpoch: metaCursor, contentEpoch: contentCursor }]);

    await syncStaleCircles();

    // A real sync pass would have called fetchEntries at least once (meta,
    // then content) — it must never have run at all.
    expect(fetchEntries).not.toHaveBeenCalled();
    await expect(getCircleFeed(circleId)).resolves.toEqual([]);
  });

  test('still syncs a circle with nothing new remotely but something queued locally', async () => {
    const { id: circleId } = await createCircle({ name: 'Family Circle' });
    // createPost kicks off its own drain fire-and-forget. Let that one
    // fail and settle, so the entry is still pending and every append
    // seen below belongs to syncStaleCircles rather than to that drain.
    (appendEntry as jest.Mock).mockRejectedValue(new Error('offline'));
    await createPost({ circleId, caption: 'Mine', photo: new Uint8Array([1, 2, 3]), inAlbum: true });
    await drainOutbox(circleId).catch(() => {});
    const { syncId, metaCursor, contentCursor } = (await getAllCircles()).find((circle) => circle.id === circleId)!;
    (appendEntry as jest.Mock).mockReset();
    (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });

    // Reports no new content at all — the only reason to sync is the
    // locally-queued post drainOutbox hasn't pushed yet.
    (fetchEpochs as jest.Mock).mockResolvedValue([{ syncId, metaEpoch: metaCursor, contentEpoch: contentCursor }]);

    await syncStaleCircles();

    const pushedTypes = (appendEntry as jest.Mock).mock.calls.map((call) => call[1]);
    expect(pushedTypes).toContain('content');
  });
});
