import { initDatabase } from '@/data/db';
import { applyMembership } from '@/data/db/circles';
import { applyPost } from '@/data/db/posts';
import { applyReactions, listReactors, queueReaction, settleReaction, summarise } from '@/data/db/reactions';

const NOW = 1_700_000_000_000;
const ME = 'acc-me';

let next = 0;
function postId(): string {
  next += 1;
  return `post-${next}`;
}

async function seedPost(id: string, relay: { counts?: Record<string, number>; unnamed?: number; iReacted?: boolean } = {}) {
  await applyPost({
    id,
    circleId: 'circle-1',
    authorId: 'acc-author',
    caption: 'x',
    createdAt: NOW,
    receivedAt: NOW,
    updatedAt: NOW,
    reactionCounts: JSON.stringify(relay.counts ?? {}),
    unnamedReactions: relay.unnamed ?? 0,
    iReacted: relay.iReacted ?? false,
  });
}

beforeEach(async () => {
  await initDatabase();
  // A post belongs to a circle, and the row is a foreign key.
  await applyMembership(
    {
      circleId: 'circle-1',
      name: 'Family',
      role: 'admin',
      notifyLevel: 'all',
      keyVersion: 1,
      rosterVersion: 1,
    },
    NOW
  );
});

// The card renders from the relay's counts, not from rows: a sync
// carries how many reacted, never who.
test('a summary comes from the post, with the unnamed ones in the total', async () => {
  const post = postId();
  await seedPost(post, { counts: { '❤️': 3, '😂': 1 }, unnamed: 2 });

  const summary = await summarise(post, ME);
  expect(summary.counts).toEqual({ '❤️': 3, '😂': 1 });
  expect(summary.total).toBe(6);
  expect(summary.iReacted).toBe(false);
});

// A tap shows immediately, before the relay has answered.
test('a queued reaction is counted at read time', async () => {
  const post = postId();
  await seedPost(post, { counts: { '❤️': 1 } });
  await queueReaction(
    { postId: post, circleId: 'circle-1', accountId: ME, tag: 'tag-heart', emoji: '❤️', createdAt: NOW },
    'add'
  );

  const summary = await summarise(post, ME);
  expect(summary.counts['❤️']).toBe(2);
  expect(summary.total).toBe(2);
  expect(summary.iReacted).toBe(true);
});

// Taking one back does the same in reverse, and an emoji nobody is left
// holding disappears rather than sitting at zero.
test('a queued removal is subtracted, and an empty emoji drops out', async () => {
  const post = postId();
  await seedPost(post, { counts: { '❤️': 1 }, iReacted: true });
  await queueReaction(
    { postId: post, circleId: 'circle-1', accountId: ME, tag: 'tag-heart', emoji: '❤️', createdAt: NOW },
    'remove'
  );

  const summary = await summarise(post, ME);
  expect(summary.counts['❤️']).toBeUndefined();
  expect(summary.total).toBe(0);
  expect(summary.iReacted).toBe(false);
});

// The relay's answer replaces the optimistic state rather than adding to
// it, so a confirmed reaction is counted exactly once.
test('settling a reaction leaves the relay count standing alone', async () => {
  const post = postId();
  await seedPost(post, { counts: { '❤️': 1 } });
  await queueReaction(
    { postId: post, circleId: 'circle-1', accountId: ME, tag: 'tag-heart', emoji: '❤️', createdAt: NOW },
    'add'
  );

  // What the relay answers with, applied the way a sync would.
  await seedPost(post, { counts: { '❤️': 2 }, iReacted: true });
  await settleReaction(post, ME, 'tag-heart');

  const summary = await summarise(post, ME);
  expect(summary.counts['❤️']).toBe(2);
  expect(summary.iReacted).toBe(true);
});

test('settling a removal takes the row with it', async () => {
  const post = postId();
  await seedPost(post, { counts: { '❤️': 1 }, iReacted: true });
  await queueReaction(
    { postId: post, circleId: 'circle-1', accountId: ME, tag: 'tag-heart', emoji: '❤️', createdAt: NOW },
    'remove'
  );
  await settleReaction(post, ME, 'tag-heart');

  await seedPost(post, { counts: {}, iReacted: false });
  const summary = await summarise(post, ME);
  expect(summary.total).toBe(0);
  expect(summary.iReacted).toBe(false);
});

// Who reacted only arrives with the children fetch, and that answer
// replaces the set rather than merging into it.
test('the children fetch replaces confirmed rows but keeps pending ones', async () => {
  const post = postId();
  await seedPost(post, { counts: { '❤️': 1 } });
  await applyReactions(post, [
    { postId: post, circleId: 'circle-1', accountId: 'acc-ali', tag: 'tag-heart', emoji: '❤️', createdAt: NOW },
  ]);
  await queueReaction(
    { postId: post, circleId: 'circle-1', accountId: ME, tag: 'tag-laugh', emoji: '😂', createdAt: NOW },
    'add'
  );

  await applyReactions(post, [
    { postId: post, circleId: 'circle-1', accountId: 'acc-jo', tag: 'tag-heart', emoji: '❤️', createdAt: NOW },
  ]);

  const reactors = await listReactors(post);
  expect(reactors.map((row) => row.accountId).sort()).toEqual(['acc-jo', ME].sort());
});

// A member may hold several at once, so rows are keyed by emoji too.
test('one member can hold several reactions', async () => {
  const post = postId();
  await seedPost(post);
  await applyReactions(post, [
    { postId: post, circleId: 'circle-1', accountId: 'acc-ali', tag: 'tag-heart', emoji: '❤️', createdAt: NOW },
    { postId: post, circleId: 'circle-1', accountId: 'acc-ali', tag: 'tag-laugh', emoji: '😂', createdAt: NOW },
  ]);

  const reactors = await listReactors(post);
  expect(reactors).toHaveLength(2);
  expect(reactors.map((row) => row.emoji).sort()).toEqual(['❤️', '😂']);
});
