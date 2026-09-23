import {
  applyCircle,
  childrenAreStale,
  getPost,
  initDatabase,
  insertPendingComment,
  listComments,
  listReactors,
  queueReactionChange,
} from '@/data/db';
import { sealContent } from '@/core/crypto/content';
import { reactionTag, reactionTagKey, reactionTagTable } from '@/core/crypto/reaction-tags';
import { applyChildrenEntries } from '@/core/sync/entry-handlers/children';
import { applyPostEntry } from '@/core/sync/entry-handlers/post';
import type { EntryContext } from '@/core/sync/entry-handlers/types';

const NOW = 1_700_000_000_000;
const KEY_V1 = new Uint8Array(32).fill(1);
const KEY_V2 = new Uint8Array(32).fill(2);

let next = 0;
function ids() {
  next += 1;
  return { circleId: `circle-${next}`, postId: `post-${next}`, suffix: next };
}

function context(circleId: string, keys: Record<number, Uint8Array> = { 1: KEY_V1 }): EntryContext {
  const tagKey = reactionTagKey(circleId, keys);
  return { circleId, accountId: 'me', keys, tagKey, tags: reactionTagTable(tagKey) };
}

beforeAll(async () => {
  await initDatabase();
});

async function seedPost(circleId: string, postId: string) {
  await applyCircle(
    { circleId, name: 'Family', role: 'member', notifyLevel: 'all', keyVersion: 1, rosterVersion: 1 },
    NOW
  );
  await applyPostEntry(context(circleId), {
    entryId: postId,
    type: 'post',
    authorId: 'sarah',
    receivedAt: NOW,
    keyVersion: 1,
    ciphertext: sealContent({ caption: 'hi', createdAt: NOW, photoHash: 'abc' }, KEY_V1),
    updatedAt: NOW + 100,
  });
}

describe('applying a post’s children', () => {
  test('decrypts comments and names reaction tags', async () => {
    const { circleId, postId, suffix } = ids();
    await seedPost(circleId, postId);

    await applyChildrenEntries(
      context(circleId),
      postId,
      {
        comments: [
          {
            commentId: `c-${suffix}`,
            authorId: 'ali',
            keyVersion: 1,
            ciphertext: sealContent({ body: 'lovely', createdAt: NOW }, KEY_V1),
            receivedAt: NOW,
          },
        ],
        reactions: [
          {
            accountId: 'ali',
            tag: reactionTag('❤️', reactionTagKey(circleId, { 1: KEY_V1 })!),
            keyVersion: 1,
            ciphertext: sealContent({ emoji: '❤️' }, KEY_V1),
            receivedAt: NOW,
          },
        ],
      },
      NOW + 200
    );

    expect((await listComments(postId))[0].body).toBe('lovely');
    expect(await listReactors(postId)).toEqual([{ accountId: 'ali', name: '', emoji: '❤️' }]);
  });

  // The ciphertext is authoritative: the tag table only names the eight
  // in the palette, so an emoji from a newer build would be nameless
  // without it.
  test('an emoji outside the palette is named from its own ciphertext', async () => {
    const { circleId, postId } = ids();
    await seedPost(circleId, postId);

    await applyChildrenEntries(
      context(circleId),
      postId,
      {
        comments: [],
        reactions: [
          {
            accountId: 'ali',
            tag: 'a-tag-nothing-in-the-palette-hashes-to',
            keyVersion: 1,
            ciphertext: sealContent({ emoji: '🦄' }, KEY_V1),
            receivedAt: NOW,
          },
        ],
      },
      NOW + 200
    );

    expect((await listReactors(postId)).map((reactor) => reactor.emoji)).toEqual(['🦄']);
  });

  // The row survives so the post screen can name it after a reseal; the
  // card's own count never comes from here.
  test('a reaction under an unheld key version is stored unnamed', async () => {
    const { circleId, postId } = ids();
    await seedPost(circleId, postId);

    await applyChildrenEntries(
      context(circleId),
      postId,
      {
        comments: [],
        reactions: [
          {
            accountId: 'ali',
            tag: 'a-tag-this-device-cannot-name',
            keyVersion: 2,
            ciphertext: sealContent({ emoji: '❤️' }, KEY_V2),
            receivedAt: NOW,
          },
        ],
      },
      NOW + 200
    );

    expect(await listReactors(postId)).toEqual([{ accountId: 'ali', name: '', emoji: '' }]);
  });

  test('a fetch stops the post being stale', async () => {
    const { circleId, postId } = ids();
    await seedPost(circleId, postId);
    expect(childrenAreStale((await getPost(postId))!)).toBe(true);

    await applyChildrenEntries(context(circleId), postId, { comments: [], reactions: [] }, NOW + 200);

    expect(childrenAreStale((await getPost(postId))!)).toBe(false);
  });

  // A fetch can predate a write this device has queued, so it must not
  // take that write's optimistic row away.
  test('this device’s own pending rows survive a fetch', async () => {
    const { circleId, postId, suffix } = ids();
    await seedPost(circleId, postId);
    await insertPendingComment({
      id: `mine-${suffix}`,
      postId,
      circleId,
      authorId: 'me',
      body: 'just sent',
      createdAt: NOW,
    });
    queueReactionChange(
      {
        postId,
        circleId,
        accountId: 'me',
        tag: reactionTag('🥂', reactionTagKey(circleId, { 1: KEY_V1 })!),
        emoji: '🥂',
        keyVersion: 1,
        createdAt: NOW,
      },
      'add',
      { circleId, op: 'reaction', postId, entryId: 'queued', createdAt: NOW }
    );

    await applyChildrenEntries(context(circleId), postId, { comments: [], reactions: [] }, NOW + 200);

    expect((await listComments(postId)).map((comment) => comment.body)).toEqual(['just sent']);
    expect((await listReactors(postId)).map((reactor) => reactor.emoji)).toEqual(['🥂']);
  });

  test('a comment whose key is missing is skipped, and the rest still land', async () => {
    const { circleId, postId, suffix } = ids();
    await seedPost(circleId, postId);

    await applyChildrenEntries(
      context(circleId),
      postId,
      {
        comments: [
          {
            commentId: `bad-${suffix}`,
            authorId: 'ali',
            keyVersion: 2,
            ciphertext: sealContent({ body: 'unreadable', createdAt: NOW }, KEY_V2),
            receivedAt: NOW,
          },
          {
            commentId: `good-${suffix}`,
            authorId: 'ali',
            keyVersion: 1,
            ciphertext: sealContent({ body: 'readable', createdAt: NOW }, KEY_V1),
            receivedAt: NOW,
          },
        ],
        reactions: [],
      },
      NOW + 200
    );

    expect((await listComments(postId)).map((comment) => comment.body)).toEqual(['readable']);
  });
});
