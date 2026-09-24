import {
  AttachmentKinds,
  AttachmentStatuses,
  applyCircle,
  due,
  failed,
  getPost,
  initDatabase,
  listComments,
  listReactors,
  queueComment,
  queuePost,
  queueReactionChange,
  saveProfile,
} from '@/data/db';
import { openContent, sealContent } from '@/core/crypto/content';
import { decrypt } from '@/core/crypto/primitives';
import { reactionTag } from '@/core/crypto/reaction-tags';
import { NetworkUnreachableError } from '@/core/services/relay-errors';
import { drainOutbox } from '@/core/sync/drain-outbox';
import type { Entry } from '@/features/post/services/post-relay';

jest.mock('@/core/services/keystore/circle-keys', () => ({
  getCircleKeyMap: jest.fn(async () => ({ 1: new Uint8Array(32).fill(1) })),
  getCurrentContentKey: jest.fn(async () => ({ version: 1, key: new Uint8Array(32).fill(1) })),
}));
jest.mock('@/core/services/blob-relay', () => ({
  BlobPaths: { photo: (postId: string) => postId },
  getUploadTarget: jest.fn(async () => ({ url: 'https://s3.test', fields: {} })),
  uploadBlob: jest.fn(async () => undefined),
}));
jest.mock('@/features/post/services/post-relay', () => ({
  ...jest.requireActual('@/features/post/services/post-relay'),
  putPost: jest.fn(),
  addComment: jest.fn(),
  react: jest.fn(),
  unreact: jest.fn(),
}));

const relay = jest.requireMock('@/features/post/services/post-relay') as {
  putPost: jest.Mock;
  addComment: jest.Mock;
  react: jest.Mock;
  unreact: jest.Mock;
};
const blobs = jest.requireMock('@/core/services/blob-relay') as { uploadBlob: jest.Mock };

const NOW = 1_700_000_000_000;
const KEY_V1 = new Uint8Array(32).fill(1);
const ACCOUNT = 'me';

let next = 0;
function ids() {
  next += 1;
  return { circleId: `circle-${next}`, postId: `post-${next}`, suffix: next };
}

function answer(postId: string, overrides: Partial<Entry> = {}): Entry {
  return {
    entryId: postId,
    type: 'post',
    authorId: ACCOUNT,
    receivedAt: NOW,
    keyVersion: 1,
    ciphertext: sealContent({ caption: 'hi', createdAt: NOW, photoHash: 'abc' }, KEY_V1),
    updatedAt: NOW + 5,
    ...overrides,
  };
}

beforeAll(async () => {
  await initDatabase();
  await saveProfile({ accountId: ACCOUNT, name: 'Me', deviceId: 'phone', createdAt: NOW, updatedAt: NOW });
});

beforeEach(() => {
  jest.clearAllMocks();
});

async function seed(circleId: string) {
  await applyCircle(
    { circleId, name: 'Family', role: 'member', notifyLevel: 'all', keyVersion: 1, rosterVersion: 1 },
    NOW
  );
}

function queueOnePost(circleId: string, postId: string) {
  queuePost(
    { id: postId, circleId, authorId: ACCOUNT, caption: 'at the lake', createdAt: NOW, receivedAt: NOW, updatedAt: NOW },
    {
      circleId,
      entryId: postId,
      kind: AttachmentKinds.POST_PHOTO,
      bytes: new Uint8Array([1, 2, 3]),
      hash: 'abc',
      keyVersion: 1,
      status: AttachmentStatuses.FETCHED,
      fetchAttempts: 0,
      nextAttemptAt: null,
      createdAt: NOW,
    },
    {
      circleId,
      op: 'post',
      postId,
      entryId: postId,
      plaintext: JSON.stringify({ caption: 'at the lake', createdAt: NOW, photoHash: 'abc', visibility: 'album' }),
      createdAt: NOW,
    }
  );
}

describe('draining the outbox', () => {
  test('uploads the photo, then seals the caption at send time', async () => {
    const { circleId, postId } = ids();
    await seed(circleId);
    queueOnePost(circleId, postId);
    relay.putPost.mockResolvedValue(answer(postId));

    await drainOutbox(circleId);

    expect(blobs.uploadBlob).toHaveBeenCalledTimes(1);
    const [, sent] = relay.putPost.mock.calls[0];
    expect(openContent(sent.ciphertext, KEY_V1)).toEqual({ caption: 'at the lake', createdAt: NOW, photoHash: 'abc' });
    // Visibility is plaintext: the relay routes on it and never reads
    // what is sealed beside it.
    expect(sent.visibility).toBe('album');
    expect(await due(circleId, Date.now())).toEqual([]);
  });

  // The relay only ever holds the sealed copy — a plaintext blob there
  // would fail every other device's decrypt on download, and worse,
  // would actually be readable by whoever runs the relay.
  test('the uploaded photo is encrypted, not the plaintext bytes', async () => {
    const { circleId, postId } = ids();
    await seed(circleId);
    queueOnePost(circleId, postId);
    relay.putPost.mockResolvedValue(answer(postId));

    await drainOutbox(circleId);

    const [, uploadedBytes] = blobs.uploadBlob.mock.calls[0];
    const plaintext = new Uint8Array([1, 2, 3]);
    expect(uploadedBytes).not.toEqual(plaintext);
    expect(decrypt(uploadedBytes, KEY_V1)).toEqual(plaintext);
  });

  test('the relay’s answer replaces the local copy without waiting for a walk', async () => {
    const { circleId, postId } = ids();
    await seed(circleId);
    queueOnePost(circleId, postId);
    relay.putPost.mockResolvedValue(answer(postId, { commentCount: 2, updatedAt: NOW + 50 }));

    await drainOutbox(circleId);

    const post = await getPost(postId);
    expect(post?.commentCount).toBe(2);
    expect(post?.updatedAt).toBe(NOW + 50);
  });

  test('a sent comment stops being pending', async () => {
    const { circleId, postId, suffix } = ids();
    await seed(circleId);
    queueOnePost(circleId, postId);
    relay.putPost.mockResolvedValue(answer(postId));
    await drainOutbox(circleId);

    queueComment(
      { id: `c-${suffix}`, postId, circleId, authorId: ACCOUNT, body: 'lovely', createdAt: NOW },
      { circleId, op: 'comment', postId, entryId: `c-${suffix}`, plaintext: JSON.stringify({ body: 'lovely', createdAt: NOW }), createdAt: NOW }
    );
    relay.addComment.mockResolvedValue(answer(postId, { commentCount: 1 }));
    await drainOutbox(circleId);

    const comments = await listComments(postId);
    expect(comments).toHaveLength(1);
    expect(comments[0].pending).toBe(false);
  });

  test('a removed reaction takes its row with it', async () => {
    const { circleId, postId } = ids();
    await seed(circleId);
    queueOnePost(circleId, postId);
    relay.putPost.mockResolvedValue(answer(postId));
    await drainOutbox(circleId);

    const tag = reactionTag('❤️', KEY_V1);
    queueReactionChange(
      { postId, circleId, accountId: ACCOUNT, tag, emoji: '❤️', keyVersion: 1, createdAt: NOW },
      'remove',
      { circleId, op: 'unreact', postId, entryId: tag, plaintext: JSON.stringify({ emoji: '❤️' }), createdAt: NOW }
    );
    relay.unreact.mockResolvedValue(answer(postId));
    await drainOutbox(circleId);

    expect(relay.unreact).toHaveBeenCalledWith(circleId, postId, tag);
    expect(await listReactors(postId)).toEqual([]);
  });

  // Order is load-bearing: a comment must never overtake the post it is on.
  test('a failure stops the queue rather than reordering around it', async () => {
    const { circleId, postId, suffix } = ids();
    await seed(circleId);
    queueOnePost(circleId, postId);
    queueComment(
      { id: `c-${suffix}`, postId, circleId, authorId: ACCOUNT, body: 'lovely', createdAt: NOW },
      { circleId, op: 'comment', postId, entryId: `c-${suffix}`, plaintext: JSON.stringify({ body: 'lovely', createdAt: NOW }), createdAt: NOW }
    );
    relay.putPost.mockRejectedValue(new Error('offline'));

    await drainOutbox(circleId);

    expect(relay.addComment).not.toHaveBeenCalled();
    // The comment carries no backoff of its own, but it is behind the
    // post, so nothing goes out until the post does.
    expect(await due(circleId, Date.now())).toEqual([]);
    expect((await due(circleId, Date.now() + 60_000)).map((row) => row.op)).toEqual(['post', 'comment']);
  });

  test('a write that keeps failing gives up and surfaces', async () => {
    const { circleId, postId } = ids();
    await seed(circleId);
    queueOnePost(circleId, postId);
    relay.putPost.mockRejectedValue(new Error('refused'));

    for (let attempt = 0; attempt < 6; attempt += 1) {
      jest.spyOn(Date, 'now').mockReturnValue(NOW + attempt * 120_000);
      await drainOutbox(circleId);
    }
    jest.spyOn(Date, 'now').mockRestore();

    const stuck = await failed(circleId);
    expect(stuck).toHaveLength(1);
    expect(stuck[0].lastError).toContain('refused');
  });

  // Being offline says nothing about the write. Counting it would put a
  // post made on a plane in the failed banner in half a minute.
  test('an unreachable relay waits without spending an attempt', async () => {
    const { circleId, postId } = ids();
    await seed(circleId);
    queueOnePost(circleId, postId);
    relay.putPost.mockRejectedValue(new NetworkUnreachableError());

    for (let attempt = 0; attempt < 8; attempt += 1) {
      jest.spyOn(Date, 'now').mockReturnValue(NOW + attempt * 120_000);
      await drainOutbox(circleId);
    }
    jest.spyOn(Date, 'now').mockRestore();

    expect(await failed(circleId)).toEqual([]);
    const [waiting] = await due(circleId, Date.now() + 120_000);
    expect(waiting.op).toBe('post');
    expect(waiting.attempts).toBe(0);
  });

  test('coming back online sends what was waiting', async () => {
    const { circleId, postId } = ids();
    await seed(circleId);
    queueOnePost(circleId, postId);
    relay.putPost.mockRejectedValueOnce(new NetworkUnreachableError());
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    await drainOutbox(circleId);

    relay.putPost.mockResolvedValue(answer(postId));
    // Past the flat offline wait, which is the scheduler's own cadence.
    jest.spyOn(Date, 'now').mockReturnValue(NOW + 60_000);
    await drainOutbox(circleId);
    jest.spyOn(Date, 'now').mockRestore();

    expect(await due(circleId, Date.now())).toEqual([]);
  });

  test('two drains of one circle are one drain', async () => {
    const { circleId, postId } = ids();
    await seed(circleId);
    queueOnePost(circleId, postId);
    relay.putPost.mockResolvedValue(answer(postId));

    await Promise.all([drainOutbox(circleId), drainOutbox(circleId)]);

    expect(relay.putPost).toHaveBeenCalledTimes(1);
  });
});
