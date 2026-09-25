import {
  applyCircle,
  applyPost,
  due,
  getAttachment,
  getPost,
  initDatabase,
  listComments,
  listReactors,
  saveProfile,
} from '@/data/db';
import { reactionTag, reactionTagKey } from '@/core/crypto/reaction-tags';
import { commentOnPost, deleteComment } from '@/features/post/usecases/comment-on-post';
import { createPost } from '@/features/post/usecases/create-post';
import { deletePost } from '@/features/post/usecases/delete-post';
import { getReactions, toggleReaction } from '@/features/post/usecases/react-to-post';
import { setAlbumVisibility } from '@/features/post/usecases/set-album-visibility';

jest.mock('@/core/sync/drain-outbox', () => ({ drainOutbox: jest.fn(async () => undefined) }));
jest.mock('@/core/services/keystore/circle-keys', () => ({
  getCircleKeyMap: jest.fn(async () => ({ 1: new Uint8Array(32).fill(1) })),
  getCurrentContentKey: jest.fn(async () => ({ version: 1, key: new Uint8Array(32).fill(1) })),
}));
jest.mock('@/core/photo/photo-cache', () => ({
  writePhotoFile: jest.fn(() => 'file://photo'),
  deletePhotoFile: jest.fn(),
}));

const drain = jest.requireMock('@/core/sync/drain-outbox') as { drainOutbox: jest.Mock };

const NOW = 1_700_000_000_000;
const KEY_V1 = new Uint8Array(32).fill(1);
const ACCOUNT = 'me';

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

async function makePost(circleId: string): Promise<string> {
  next += 1;
  const postId = `post-${next}`;
  await applyPost({ id: postId, circleId, authorId: 'sarah', caption: 'hi', createdAt: NOW, receivedAt: NOW });
  return postId;
}

beforeAll(async () => {
  await initDatabase();
  await saveProfile({ accountId: ACCOUNT, name: 'Me', deviceId: 'phone', createdAt: NOW, updatedAt: NOW });
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('posting a photo', () => {
  test('shows immediately, with the bytes already here and the write queued', async () => {
    const circleId = await makeCircle();

    const postId = await createPost({ circleId, caption: 'at the lake', photo: new Uint8Array([1, 2, 3]), inAlbum: true });

    const post = await getPost(postId);
    expect(post?.caption).toBe('at the lake');
    expect(post?.authorId).toBe(ACCOUNT);
    expect((await getAttachment(circleId, postId))?.status).toBe('fetched');
    expect((await due(circleId, Date.now())).map((row) => row.op)).toEqual(['post']);
  });

  // The relay routes on visibility, so it rides on the write rather than
  // costing a second one.
  test('a photo kept out of the album says so on its own write', async () => {
    const circleId = await makeCircle();

    const postId = await createPost({ circleId, caption: 'c', photo: new Uint8Array([1]), inAlbum: false });

    expect((await getPost(postId))?.inAlbum).toBe(false);
    const [queued] = await due(circleId, Date.now());
    expect(queued.op).toBe('post');
    expect(JSON.parse(queued.plaintext).visibility).toBe('feed');
  });

  // A stuck push must never make posting itself feel broken.
  test('the drain is fire and forget', async () => {
    const circleId = await makeCircle();
    drain.drainOutbox.mockRejectedValueOnce(new Error('offline'));

    await expect(
      createPost({ circleId, caption: 'c', photo: new Uint8Array([1]), inAlbum: true })
    ).resolves.toBeDefined();
  });
});

describe('commenting', () => {
  test('a new comment shows pending and is queued', async () => {
    const circleId = await makeCircle();
    const postId = await makePost(circleId);

    await commentOnPost(circleId, postId, 'lovely');

    const [comment] = await listComments(postId);
    expect(comment.body).toBe('lovely');
    expect(comment.pending).toBe(true);
    expect((await due(circleId, Date.now())).map((row) => row.op)).toEqual(['comment']);
  });

  test('deleting one hides it here and queues the removal', async () => {
    const circleId = await makeCircle();
    const postId = await makePost(circleId);
    const commentId = await commentOnPost(circleId, postId, 'oops');

    await deleteComment(circleId, postId, commentId);

    expect(await listComments(postId)).toEqual([]);
    expect((await due(circleId, Date.now())).map((row) => row.op)).toEqual(['comment', 'delete_comment']);
  });
});

describe('reacting', () => {
  test('a tap adds the emoji and queues it under the circle’s own tag', async () => {
    const circleId = await makeCircle();
    const postId = await makePost(circleId);

    await toggleReaction(circleId, postId, '❤️');

    expect((await listReactors(postId)).map((reactor) => reactor.emoji)).toEqual(['❤️']);
    const [queued] = await due(circleId, Date.now());
    expect(queued.op).toBe('reaction');
    expect(queued.entryId).toBe(reactionTag('❤️', reactionTagKey(circleId, { 1: KEY_V1 })!));
  });

  // A member may hold several at once, so a second emoji is added rather
  // than replacing the first.
  test('a second emoji joins the first', async () => {
    const circleId = await makeCircle();
    const postId = await makePost(circleId);
    await toggleReaction(circleId, postId, '❤️');

    await toggleReaction(circleId, postId, '🥂');

    expect((await listReactors(postId)).map((reactor) => reactor.emoji).sort()).toEqual(['❤️', '🥂']);
  });

  // Cancels the queued add outright rather than sending it and an
  // unreact back to back — the first tap never reached the relay, so
  // there is nothing there yet to undo. See queue.ts's queueReactionChange.
  test('tapping the same emoji again before the first tap sends cancels it, queuing nothing', async () => {
    const circleId = await makeCircle();
    const postId = await makePost(circleId);
    await toggleReaction(circleId, postId, '❤️');

    await toggleReaction(circleId, postId, '❤️');

    expect(await listReactors(postId)).toEqual([]);
    expect(await due(circleId, Date.now())).toEqual([]);
  });

  // The card sums the relay's counts plus what is queued, so a tap shows
  // before anything has been sent.
  test('the card counts a queued tap on top of the relay’s own count', async () => {
    const circleId = await makeCircle();
    const postId = await makePost(circleId);
    await applyPost({
      id: postId,
      circleId,
      authorId: 'sarah',
      caption: 'hi',
      createdAt: NOW,
      receivedAt: NOW,
      reactionCounts: JSON.stringify({ '❤️': 2 }),
    });

    await toggleReaction(circleId, postId, '❤️');

    expect(await getReactions(postId)).toEqual({ counts: { '❤️': 3 }, total: 3, iReacted: true });
  });
});

describe('the rest of a post', () => {
  test('deleting hides it here and queues the removal', async () => {
    const circleId = await makeCircle();
    const postId = await makePost(circleId);

    await deletePost(circleId, postId);

    expect((await getPost(postId))?.deletedAt).not.toBeNull();
    expect((await getPost(postId))?.caption).toBe('');
    expect((await due(circleId, Date.now())).map((row) => row.op)).toEqual(['delete_post']);
  });

  test('moving one out of the album queues a visibility change', async () => {
    const circleId = await makeCircle();
    const postId = await makePost(circleId);

    await setAlbumVisibility(circleId, postId, false);

    expect((await getPost(postId))?.inAlbum).toBe(false);
    const [queued] = await due(circleId, Date.now());
    expect(queued.op).toBe('set_visibility');
    expect(JSON.parse(queued.plaintext).visibility).toBe('feed');
  });
});
