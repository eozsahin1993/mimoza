jest.mock('@/core/services/log-relay');
jest.mock('@/features/account/usecases/account-manifest');

import { bytesToHex } from '@noble/curves/utils.js';

import {
  addReaction,
  AttachmentKinds,
  deletePostLocally,
  AttachmentStatuses,
  getAttachment,
  getPost,
  getPostComments,
  getPostReactionSummary,
  initDatabase,
  insertComment,
  insertPost,
  MemberRoles,
  recordMemberAddedLocally,
} from '@/data/db';
import { createCircle } from '@/features/circle/usecases/create-circle';
import type { LogEntryEnvelope } from '@/core/sync/log-entry';
import { generateIdentity, generateUUID } from '@/core/crypto/primitives';
import { getCircleIdentity } from '@/core/services/keystore/circle-keys';
import { saveMasterSeed } from '@/core/services/keystore/master-seed';
import { appendEntry, bootstrapCircle } from '@/core/services/log-relay';
import { postDeleteHandler } from '@/core/sync/entry-handlers/post-delete';

beforeAll(async () => {
  await initDatabase();
  await saveMasterSeed(new Uint8Array(16));
});
beforeEach(() => {
  jest.resetAllMocks();
  (bootstrapCircle as jest.Mock).mockResolvedValue(undefined);
  (appendEntry as jest.Mock).mockResolvedValue({ epoch: 1, receivedAt: Date.now() });
});

function envelope(authorPubkey: string, payload: unknown): LogEntryEnvelope {
  return { type: 'post_delete', payload, authorPubkey, signature: 'unchecked-by-this-layer' };
}

async function circleWithPost() {
  const { id: circleId } = await createCircle({ name: 'Family Circle' });
  const author = (await getCircleIdentity(circleId))!;
  const postId = generateUUID();
  await insertPost(
    {
      id: postId,
      circleId,
      caption: 'c',
      authorPublicKey: bytesToHex(author.publicKey),
      createdAt: 1000,
      lastViewedAt: null,
      inAlbum: true,
    },
    {
      circleId,
      entryId: postId,
      kind: AttachmentKinds.POST_PHOTO,
      bytes: null,
      hash: 'h',
      keyVersion: 1,
      status: AttachmentStatuses.PENDING,
      fetchAttempts: 0,
      nextAttemptAt: null,
      createdAt: 1000,
    }
  );
  return { circleId, postId, author };
}

/** Adds someone to the roster who did not write the post. */
async function otherMember(circleId: string, role = MemberRoles.member) {
  const key = bytesToHex(generateIdentity().publicKey);
  await recordMemberAddedLocally({
    circleId,
    subjectPublicKey: key,
    joinedAt: 1_000,
    profile: { encPublicKey: 'cc', memberId: generateUUID(), role, name: 'Marcus', picture: null },
  });
  return key;
}

describe('predicate', () => {
  test('accepts a deletion from the photo’s own author', async () => {
    const { circleId, postId, author } = await circleWithPost();

    await expect(
      postDeleteHandler.predicate(circleId, envelope(bytesToHex(author.publicKey), { postId, createdAt: 2000 }))
    ).resolves.toBe(true);
  });

  test('accepts a deletion from an admin who did not write the post', async () => {
    const { circleId, postId } = await circleWithPost();
    const admin = await otherMember(circleId, MemberRoles.admin);

    await expect(postDeleteHandler.predicate(circleId, envelope(admin, { postId, createdAt: 2000 }))).resolves.toBe(
      true
    );
  });

  /** The rule the whole feature rests on: nobody deletes someone else's photo without being an admin. */
  test('rejects a deletion from a plain member who did not write the post', async () => {
    const { circleId, postId } = await circleWithPost();
    const member = await otherMember(circleId);

    await expect(postDeleteHandler.predicate(circleId, envelope(member, { postId, createdAt: 2000 }))).resolves.toBe(
      false
    );
  });

  /**
   * The deleting device removes the post before its entry is ever
   * appended, so its own copy comes back to a post that isn't there.
   * Rejecting it there logged a warning on every delete.
   */
  test('accepts a deletion whose post is already gone, from a plain member', async () => {
    const { circleId, postId } = await circleWithPost();
    const member = await otherMember(circleId);
    await deletePostLocally(circleId, postId);

    await expect(
      postDeleteHandler.predicate(circleId, envelope(member, { postId, createdAt: 2000 }))
    ).resolves.toBe(true);
  });

  test('rejects a deletion from someone this device has never seen join', async () => {
    const { circleId, postId } = await circleWithPost();
    const stranger = generateIdentity();

    await expect(
      postDeleteHandler.predicate(circleId, envelope(bytesToHex(stranger.publicKey), { postId, createdAt: 2000 }))
    ).resolves.toBe(false);
  });

  test.each([
    ['a missing postId', { createdAt: 1 }],
    ['a non-string postId', { postId: 7, createdAt: 1 }],
    ['a non-numeric createdAt', { postId: 'p', createdAt: 'soon' }],
  ])('rejects %s even from a real member', async (_label, payload) => {
    const { circleId, author } = await circleWithPost();

    await expect(
      postDeleteHandler.predicate(circleId, envelope(bytesToHex(author.publicKey), payload))
    ).resolves.toBe(false);
  });
});

describe('apply', () => {
  test('removes the post', async () => {
    const { circleId, postId, author } = await circleWithPost();

    await postDeleteHandler.apply(circleId, envelope(bytesToHex(author.publicKey), { postId, createdAt: 2000 }), 1);

    expect(await getPost(postId)).toBeNull();
  });

  /** No foreign key ties an attachment to its post, so nothing cascades it — the download queue would keep chasing bytes for a post that is gone. */
  test('removes the attachment with it', async () => {
    const { circleId, postId, author } = await circleWithPost();

    await postDeleteHandler.apply(circleId, envelope(bytesToHex(author.publicKey), { postId, createdAt: 2000 }), 1);

    expect(await getAttachment(circleId, postId)).toBeNull();
  });

  test('takes the post’s comments with it', async () => {
    const { circleId, postId, author } = await circleWithPost();
    await insertComment({
      id: generateUUID(),
      postId,
      authorPublicKey: bytesToHex(author.publicKey),
      body: 'lovely',
      createdAt: 1500,
    });

    await postDeleteHandler.apply(circleId, envelope(bytesToHex(author.publicKey), { postId, createdAt: 2000 }), 1);

    expect(await getPostComments(circleId, postId)).toEqual([]);
  });

  test('takes the post’s reactions with it', async () => {
    const { circleId, postId, author } = await circleWithPost();
    await addReaction({
      postId,
      authorPublicKey: bytesToHex(author.publicKey),
      emoji: '\u2764\ufe0f',
      createdAt: 1500,
    });

    await postDeleteHandler.apply(circleId, envelope(bytesToHex(author.publicKey), { postId, createdAt: 2000 }), 1);

    expect(await getPostReactionSummary(postId, bytesToHex(author.publicKey))).toEqual([]);
  });

  /** Invariant 8: replaying a log re-applies entries, and the second pass must not be an error. */
  test('applying the same deletion twice is a no-op', async () => {
    const { circleId, postId, author } = await circleWithPost();
    const key = bytesToHex(author.publicKey);

    await postDeleteHandler.apply(circleId, envelope(key, { postId, createdAt: 2000 }), 1);

    await expect(
      postDeleteHandler.apply(circleId, envelope(key, { postId, createdAt: 2000 }), 2)
    ).resolves.toBeUndefined();
  });

  test('a deletion naming a post this device skipped is a no-op, not a crash', async () => {
    const { circleId, author } = await circleWithPost();

    await expect(
      postDeleteHandler.apply(
        circleId,
        envelope(bytesToHex(author.publicKey), { postId: generateUUID(), createdAt: 2000 }),
        1
      )
    ).resolves.toBeUndefined();
  });

  test('a malformed payload is a no-op rather than a crash', async () => {
    const { circleId, postId, author } = await circleWithPost();

    await expect(
      postDeleteHandler.apply(circleId, envelope(bytesToHex(author.publicKey), { nonsense: true }), 1)
    ).resolves.toBeUndefined();

    expect(await getPost(postId)).not.toBeNull();
  });
});
