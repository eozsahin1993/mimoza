import { applyCircle, applyPost, initDatabase, queueReactionChange, queuedFor, saveProfile, summarise } from '@/data/db';
import { generateUUID } from '@/core/crypto/primitives';

const ACCOUNT_ID = 'account-1';
const TAG = 'tag-thumbsup';
const EMOJI = '👍';

beforeAll(async () => {
  await initDatabase();
  await saveProfile({ accountId: ACCOUNT_ID, name: 'Me', deviceId: 'device-1', createdAt: 1, updatedAt: 1 });
});

// summarise() reads a post's own reactionCounts/iReacted as the confirmed
// base and adjusts by whatever's pending — not the mere presence of a
// postReactions row, which is listReactors' concern, not this one's.
async function makePost(confirmed = false): Promise<{ circleId: string; postId: string }> {
  const circleId = generateUUID();
  const postId = generateUUID();
  const now = Date.now();
  await applyCircle({ circleId, name: 'Family', role: 'admin', notifyLevel: 'all', keyVersion: 1, rosterVersion: 1 }, now);
  await applyPost({
    id: postId,
    circleId,
    authorId: 'someone-else',
    caption: 'c',
    createdAt: now,
    receivedAt: now,
    ...(confirmed ? { reactionCounts: JSON.stringify({ [EMOJI]: 1 }), iReacted: true } : {}),
  });
  return { circleId, postId };
}

function tap(circleId: string, postId: string, op: 'add' | 'remove') {
  queueReactionChange(
    { postId, circleId, accountId: ACCOUNT_ID, tag: TAG, emoji: EMOJI, keyVersion: 1, createdAt: Date.now() },
    op,
    { circleId, op: op === 'add' ? 'reaction' : 'unreact', postId, entryId: TAG, plaintext: JSON.stringify({ emoji: EMOJI }), createdAt: Date.now() }
  );
}

test('a single add queues normally', async () => {
  const { circleId, postId } = await makePost();

  tap(circleId, postId, 'add');

  expect(await summarise(postId, ACCOUNT_ID)).toEqual({ counts: { [EMOJI]: 1 }, total: 1, iReacted: true });
  const queued = await queuedFor(postId);
  expect(queued).toHaveLength(1);
  expect(queued[0].op).toBe('reaction');
});

test('a single remove, against an already-confirmed reaction, queues normally', async () => {
  const { circleId, postId } = await makePost(true);

  tap(circleId, postId, 'remove');

  expect(await summarise(postId, ACCOUNT_ID)).toEqual({ counts: {}, total: 0, iReacted: false });
  const queued = await queuedFor(postId);
  expect(queued).toHaveLength(1);
  expect(queued[0].op).toBe('unreact');
});

// The bug: tapping add then remove before either had sent used to leave
// the second tap's outbox entry racing the first's — see queue.ts.
test('tapping add then remove before either sends cancels both, queuing nothing', async () => {
  const { circleId, postId } = await makePost();

  tap(circleId, postId, 'add');
  tap(circleId, postId, 'remove');

  expect(await summarise(postId, ACCOUNT_ID)).toEqual({ counts: {}, total: 0, iReacted: false });
  expect(await queuedFor(postId)).toHaveLength(0);
});

test('tapping remove then add again, on an already-confirmed reaction, restores it and queues nothing', async () => {
  const { circleId, postId } = await makePost(true);

  tap(circleId, postId, 'remove');
  tap(circleId, postId, 'add');

  expect(await summarise(postId, ACCOUNT_ID)).toEqual({ counts: { [EMOJI]: 1 }, total: 1, iReacted: true });
  expect(await queuedFor(postId)).toHaveLength(0);
});
