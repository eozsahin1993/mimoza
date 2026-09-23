import { applyCircle, getAttachment, getPost, initDatabase, listComments } from '@/data/db';
import { sealContent } from '@/core/crypto/content';
import { reactionTag, reactionTagKey, reactionTagTable } from '@/core/crypto/reaction-tags';
import { applyPostEntry } from '@/core/sync/entry-handlers/post';
import type { EntryContext } from '@/core/sync/entry-handlers/types';
import type { Entry } from '@/features/post/services/post-relay';

const NOW = 1_700_000_000_000;
const KEY_V1 = new Uint8Array(32).fill(1);
const KEY_V2 = new Uint8Array(32).fill(2);

let next = 0;
function ids() {
  next += 1;
  return { circleId: `circle-${next}`, postId: `post-${next}`, commentId: `comment-${next}` };
}

function context(circleId: string, keys: Record<number, Uint8Array> = { 1: KEY_V1 }): EntryContext {
  const tagKey = reactionTagKey(circleId, keys);
  return { circleId, accountId: 'me', keys, tagKey, tags: reactionTagTable(tagKey) };
}

function entry(postId: string, overrides: Partial<Entry> = {}): Entry {
  return {
    entryId: postId,
    type: 'post',
    authorId: 'sarah',
    receivedAt: NOW,
    keyVersion: 1,
    ciphertext: sealContent({ caption: 'at the lake', createdAt: NOW - 500, photoHash: 'abc' }, KEY_V1),
    hasBlob: true,
    commentCount: 0,
    updatedAt: NOW,
    ...overrides,
  };
}

beforeAll(async () => {
  await initDatabase();
});

async function seed(circleId: string) {
  await applyCircle(
    { circleId, name: 'Family', role: 'member', notifyLevel: 'all', keyVersion: 1, rosterVersion: 1 },
    NOW
  );
}

describe('applying a post from a walk', () => {
  test('decrypts the caption and keeps the author’s own clock', async () => {
    const { circleId, postId } = ids();
    await seed(circleId);

    await applyPostEntry(context(circleId), entry(postId));

    const post = await getPost(postId);
    expect(post?.caption).toBe('at the lake');
    expect(post?.createdAt).toBe(NOW - 500);
    expect(post?.receivedAt).toBe(NOW);
    expect(post?.inAlbum).toBe(true);
  });

  test('records the photo so the download queue can go find it', async () => {
    const { circleId, postId } = ids();
    await seed(circleId);

    await applyPostEntry(context(circleId), entry(postId));

    const attachment = await getAttachment(circleId, postId);
    expect(attachment?.hash).toBe('abc');
    expect(attachment?.keyVersion).toBe(1);
    expect(attachment?.bytes).toBeNull();
  });

  test('names the tags it can and counts the rest as unnamed', async () => {
    const { circleId, postId } = ids();
    await seed(circleId);
    const tagKey = reactionTagKey(circleId, { 1: KEY_V1 })!;

    await applyPostEntry(
      context(circleId),
      entry(postId, {
        reactionCounts: {
          [reactionTag('❤️', tagKey)]: 3,
          // An emoji outside this build's palette, from a newer peer.
          'a-tag-this-build-cannot-name': 2,
          // Dropped to zero by an unreact; the relay leaves the key.
          [reactionTag('🥂', tagKey)]: 0,
        },
      })
    );

    const post = await getPost(postId);
    expect(JSON.parse(post!.reactionCounts)).toEqual({ '❤️': 3 });
    expect(post?.unnamedReactions).toBe(2);
  });

  // The tag key comes from version 1 and never rotates, so a count made
  // before a rotation is still named after one.
  test('a rotation does not make old counts unnameable', async () => {
    const { circleId, postId } = ids();
    await seed(circleId);
    const beforeRotation = reactionTagKey(circleId, { 1: KEY_V1 })!;

    await applyPostEntry(
      context(circleId, { 1: KEY_V1, 2: KEY_V2 }),
      entry(postId, { reactionCounts: { [reactionTag('❤️', beforeRotation)]: 2 } })
    );

    expect(JSON.parse((await getPost(postId))!.reactionCounts)).toEqual({ '❤️': 2 });
    expect((await getPost(postId))?.unnamedReactions).toBe(0);
  });

  // Two circles must never share a tag for the same emoji, or the relay
  // could carry a guess from one circle into another.
  test('the same emoji tags differently in a different circle', async () => {
    const one = reactionTagKey('circle-a', { 1: KEY_V1 })!;
    const other = reactionTagKey('circle-b', { 1: KEY_V1 })!;

    expect(reactionTag('❤️', one)).not.toBe(reactionTag('❤️', other));
  });

  test('stores the preview comments and names them on the post', async () => {
    const { circleId, postId, commentId } = ids();
    await seed(circleId);

    await applyPostEntry(
      context(circleId),
      entry(postId, {
        commentCount: 1,
        recentComments: [
          {
            commentId,
            authorId: 'ali',
            keyVersion: 1,
            ciphertext: sealContent({ body: 'lovely', createdAt: NOW - 100 }, KEY_V1),
            receivedAt: NOW,
          },
        ],
      })
    );

    expect(JSON.parse((await getPost(postId))!.recentCommentIds)).toEqual([commentId]);
    const comments = await listComments(postId);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toBe('lovely');
    expect(comments[0].pending).toBe(false);
  });

  test('a post whose key this device lacks is skipped, not half-written', async () => {
    const { circleId, postId } = ids();
    await seed(circleId);

    await applyPostEntry(context(circleId, { 2: KEY_V2 }), entry(postId));

    expect(await getPost(postId)).toBeNull();
  });

  // The row that stood in the feed is the one that has to receive the
  // deletion, so a deleted post is still written even though it carries
  // no ciphertext at all.
  test('a deletion lands on a post this device never saw', async () => {
    const { circleId, postId } = ids();
    await seed(circleId);

    await applyPostEntry(
      context(circleId),
      entry(postId, { ciphertext: undefined, hasBlob: false, deletedAt: NOW + 10 })
    );

    const post = await getPost(postId);
    expect(post?.deletedAt).toBe(NOW + 10);
    expect(post?.caption).toBe('');
  });

  test('a second walk replaces the relay’s half and leaves the local half alone', async () => {
    const { circleId, postId } = ids();
    await seed(circleId);
    await applyPostEntry(context(circleId), entry(postId));

    await applyPostEntry(context(circleId), entry(postId, { commentCount: 4, iCommented: true, updatedAt: NOW + 99 }));

    const post = await getPost(postId);
    expect(post?.commentCount).toBe(4);
    expect(post?.iCommented).toBe(true);
    expect(post?.updatedAt).toBe(NOW + 99);
    expect(post?.childrenFetchedAt).toBeNull();
  });

  test('a post taken out of the album is not in it', async () => {
    const { circleId, postId } = ids();
    await seed(circleId);

    await applyPostEntry(context(circleId), entry(postId, { visibility: 'feed' }));

    expect((await getPost(postId))?.inAlbum).toBe(false);
  });
});
