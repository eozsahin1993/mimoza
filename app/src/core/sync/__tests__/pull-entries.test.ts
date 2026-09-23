import { applyCircle, getCircle, getPost, initDatabase, listActivity } from '@/data/db';
import { sealContent } from '@/core/crypto/content';
import { reactionTagKey, reactionTagTable } from '@/core/crypto/reaction-tags';
import { pullNewEntries, pullOlderPosts } from '@/core/sync/pull-entries';
import type { EntryContext } from '@/core/sync/entry-handlers/types';
import type { Entry, Page } from '@/features/post/services/post-relay';

// Only the walk is faked: the module also carries the visibility
// vocabulary the post handler reads.
jest.mock('@/features/post/services/post-relay', () => ({
  ...jest.requireActual('@/features/post/services/post-relay'),
  walkEntries: jest.fn(),
}));
const { walkEntries } = jest.requireMock('@/features/post/services/post-relay') as {
  walkEntries: jest.Mock<Promise<Page>, [string, string, string?, number?]>;
};

const NOW = 1_700_000_000_000;
const KEY_V1 = new Uint8Array(32).fill(1);

let next = 0;
function ids() {
  next += 1;
  return { circleId: `circle-${next}`, postId: `post-${next}`, suffix: next };
}

function context(circleId: string): EntryContext {
  const tagKey = reactionTagKey(circleId, { 1: KEY_V1 });
  return { circleId, accountId: 'me', keys: { 1: KEY_V1 }, tagKey, tags: reactionTagTable(tagKey) };
}

function post(postId: string, overrides: Partial<Entry> = {}): Entry {
  return {
    entryId: postId,
    type: 'post',
    authorId: 'sarah',
    receivedAt: NOW,
    keyVersion: 1,
    ciphertext: sealContent({ caption: 'hi', createdAt: NOW, photoHash: 'abc' }, KEY_V1),
    updatedAt: NOW,
    ...overrides,
  };
}

function page(entries: Entry[], overrides: Partial<Page> = {}): Page {
  return { entries, next: 'cursor-next', prev: 'cursor-prev', more: false, ...overrides };
}

beforeAll(async () => {
  await initDatabase();
});

beforeEach(() => {
  walkEntries.mockReset();
});

async function seed(circleId: string) {
  await applyCircle(
    { circleId, name: 'Family', role: 'member', notifyLevel: 'all', keyVersion: 1, rosterVersion: 1 },
    NOW
  );
}

describe('walking a circle forward', () => {
  // A circle with no cursor reads the newest page, which comes back
  // walking backward: its `more` is about history, not catching up, so
  // that read takes one page and seeds both cursors.
  test('a fresh circle takes one page and seeds both cursors', async () => {
    const { circleId, postId } = ids();
    await seed(circleId);
    walkEntries.mockResolvedValue(page([post(postId)], { more: true }));

    await pullNewEntries(context(circleId), 'post');

    expect(walkEntries).toHaveBeenCalledTimes(1);
    expect(walkEntries).toHaveBeenCalledWith(circleId, 'post', undefined);
    const circle = await getCircle(circleId);
    expect(circle?.postsForwardCursor).toBe('cursor-next');
    expect(circle?.postsBackwardCursor).toBe('cursor-prev');
    expect(await getPost(postId)).not.toBeNull();
  });

  test('a caught-up circle keeps paging while the relay says there is more', async () => {
    const { circleId, suffix } = ids();
    await seed(circleId);
    walkEntries.mockResolvedValueOnce(page([post(`first-${suffix}`)], { more: true, next: 'cursor-a' }));
    await pullNewEntries(context(circleId), 'post');
    walkEntries.mockReset();

    walkEntries
      .mockResolvedValueOnce(page([post(`second-${suffix}`)], { more: true, next: 'cursor-b' }))
      .mockResolvedValueOnce(page([post(`third-${suffix}`)], { more: false, next: 'cursor-c' }));
    await pullNewEntries(context(circleId), 'post');

    expect(walkEntries.mock.calls.map((call) => call[2])).toEqual(['cursor-a', 'cursor-b']);
    expect((await getCircle(circleId))?.postsForwardCursor).toBe('cursor-c');
  });

  // An empty page carries no cursors at all. Saving those would rewind
  // the stream to "newest page" on the next pass.
  test('an empty page leaves the cursor where it was', async () => {
    const { circleId, suffix } = ids();
    await seed(circleId);
    walkEntries.mockResolvedValueOnce(page([post(`only-${suffix}`)], { next: 'cursor-a' }));
    await pullNewEntries(context(circleId), 'post');

    walkEntries.mockResolvedValueOnce(page([], { next: undefined, prev: undefined }));
    await pullNewEntries(context(circleId), 'post');

    expect((await getCircle(circleId))?.postsForwardCursor).toBe('cursor-a');
  });

  test('activity keeps its own cursor and never touches the post cursors', async () => {
    const { circleId, suffix } = ids();
    await seed(circleId);

    walkEntries.mockResolvedValue(
      page([{ entryId: `act-${suffix}`, type: 'activity', authorId: 'sarah', receivedAt: NOW, event: 'joined' }])
    );
    await pullNewEntries(context(circleId), 'activity');

    const circle = await getCircle(circleId);
    expect(circle?.activityCursor).toBe('cursor-next');
    expect(circle?.postsForwardCursor).toBeNull();
    expect(await listActivity(circleId)).toHaveLength(1);
  });

  test('an unknown entry type is skipped and the walk carries on', async () => {
    const { circleId, postId, suffix } = ids();
    await seed(circleId);
    walkEntries.mockResolvedValue(
      page([
        { entryId: `weird-${suffix}`, type: 'something_new' as Entry['type'], authorId: 'sarah', receivedAt: NOW },
        post(postId),
      ])
    );

    await pullNewEntries(context(circleId), 'post');

    expect(await getPost(postId)).not.toBeNull();
    expect((await getCircle(circleId))?.postsForwardCursor).toBe('cursor-next');
  });

  // Cursors never rewind, so a failure that could succeed later has to
  // leave the position alone rather than walking past the entry.
  test('a failed fetch leaves the cursor alone', async () => {
    const { circleId } = ids();
    await seed(circleId);
    walkEntries.mockRejectedValue(new Error('offline'));

    await expect(pullNewEntries(context(circleId), 'post')).rejects.toThrow('offline');
    expect((await getCircle(circleId))?.postsForwardCursor).toBeNull();
  });
});

describe('walking a circle back', () => {
  test('nothing to do until a forward pass has seeded the cursor', async () => {
    const { circleId } = ids();
    await seed(circleId);

    expect(await pullOlderPosts(context(circleId))).toBe(false);
    expect(walkEntries).not.toHaveBeenCalled();
  });

  test('one page at a time, saying whether more remain', async () => {
    const { circleId, suffix } = ids();
    await seed(circleId);
    walkEntries.mockResolvedValueOnce(page([post(`newest-${suffix}`)], { prev: 'back-a' }));
    await pullNewEntries(context(circleId), 'post');
    walkEntries.mockReset();

    walkEntries.mockResolvedValueOnce(page([post(`older-${suffix}`)], { more: true, prev: 'back-b' }));

    expect(await pullOlderPosts(context(circleId))).toBe(true);
    expect(walkEntries).toHaveBeenCalledWith(circleId, 'post', 'back-a');
    expect((await getCircle(circleId))?.postsBackwardCursor).toBe('back-b');
    expect(await getPost(`older-${suffix}`)).not.toBeNull();
  });

  test('the end of history says so', async () => {
    const { circleId, suffix } = ids();
    await seed(circleId);
    walkEntries.mockResolvedValueOnce(page([post(`newest-${suffix}`)], { prev: 'back-a' }));
    await pullNewEntries(context(circleId), 'post');

    walkEntries.mockResolvedValueOnce(page([], { more: false, prev: undefined }));

    expect(await pullOlderPosts(context(circleId))).toBe(false);
    expect((await getCircle(circleId))?.postsBackwardCursor).toBe('back-a');
  });
});
