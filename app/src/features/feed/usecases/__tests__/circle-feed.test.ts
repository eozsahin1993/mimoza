import { applyCircle, applyPost, applyRoster, initDatabase, insertActivity, saveProfile } from '@/data/db';
import { FEED_PAGE_SIZE, loadCircleFeedMeta, loadCircleFeedPage } from '@/features/feed/usecases/circle-feed';
import { generateUUID } from '@/core/crypto/primitives';

const ACCOUNT_ID = 'account-1';

beforeAll(async () => {
  await initDatabase();
  await saveProfile({ accountId: ACCOUNT_ID, name: 'Founder', deviceId: 'device-1', createdAt: 1, updatedAt: 1 });
});

async function makeCircle(): Promise<string> {
  const circleId = generateUUID();
  const now = Date.now();
  await applyCircle({ circleId, name: 'Family Circle', role: 'admin', notifyLevel: 'all', keyVersion: 1, rosterVersion: 1 }, now);
  await applyRoster(circleId, [{ circleId, accountId: ACCOUNT_ID, name: 'Founder', role: 'admin', joinedAt: now }], now);
  return circleId;
}

function post(circleId: string, createdAt: number) {
  return { id: generateUUID(), circleId, authorId: ACCOUNT_ID, caption: 'c', createdAt, receivedAt: createdAt };
}

async function addEvent(circleId: string, actorId: string, receivedAt: number, subjectName: string) {
  await insertActivity({
    id: generateUUID(),
    circleId,
    event: 'joined',
    actorId,
    subjectId: generateUUID(),
    subjectName,
    receivedAt,
  });
}

describe('loadCircleFeedMeta', () => {
  test("resolves the founder's own account as an admin", async () => {
    const circleId = await makeCircle();

    const meta = await loadCircleFeedMeta(circleId);

    expect(meta.circleName).toBe('Family Circle');
    expect(meta.ownPublicKey).toBe(ACCOUNT_ID);
    expect(meta.ownIsAdmin).toBe(true);
  });
});

describe('loadCircleFeedPage', () => {
  /** 15 posts, newest first: 1,000,000 down to 986,000 in steps of 1,000. */
  async function makeCircleWithPosts(): Promise<string> {
    const circleId = await makeCircle();
    for (let i = 0; i < 15; i++) {
      await applyPost(post(circleId, 1_000_000 - i * 1_000));
    }
    return circleId;
  }

  test('the first page is the newest `FEED_PAGE_SIZE` posts, newest first', async () => {
    const circleId = await makeCircleWithPosts();
    const meta = await loadCircleFeedMeta(circleId);

    const page = await loadCircleFeedPage(circleId, meta, null);

    expect(page.posts).toHaveLength(FEED_PAGE_SIZE);
    expect(page.posts[0].post.createdAt).toBe(1_000_000);
    expect(page.posts[FEED_PAGE_SIZE - 1].post.createdAt).toBe(1_000_000 - (FEED_PAGE_SIZE - 1) * 1_000);
    expect(page.nextCursor).not.toBeNull();
    expect(page.hasMore).toBe(true);
  });

  test('the next page continues from the cursor and eventually exhausts', async () => {
    const circleId = await makeCircleWithPosts();
    const meta = await loadCircleFeedMeta(circleId);

    const first = await loadCircleFeedPage(circleId, meta, null);
    const second = await loadCircleFeedPage(circleId, meta, first.nextCursor);

    expect(second.posts).toHaveLength(15 - FEED_PAGE_SIZE);
    expect(second.nextCursor).toBeNull();
    expect(second.hasMore).toBe(false);
    // No post appears on both pages.
    const seenIds = new Set([...first.posts, ...second.posts].map((view) => view.post.id));
    expect(seenIds.size).toBe(15);
  });

  test("an event older than the first page's oldest post is deferred — the first page's own floor excludes it", async () => {
    const circleId = await makeCircleWithPosts();
    const meta = await loadCircleFeedMeta(circleId);
    const first = await loadCircleFeedPage(circleId, meta, null);
    // First page's floor is its oldest post's createdAt.
    const floor = first.posts[first.posts.length - 1].post.createdAt;

    await addEvent(circleId, ACCOUNT_ID, floor + 500, 'NewEnough');
    await addEvent(circleId, ACCOUNT_ID, floor - 500, 'TooOld');

    const withEvents = await loadCircleFeedPage(circleId, meta, null);
    expect(withEvents.events.map((e) => e.subjectName)).toEqual(['NewEnough']);
  });

  test('the last page (no more posts) takes every remaining event, with no floor of its own', async () => {
    const circleId = await makeCircleWithPosts();
    const meta = await loadCircleFeedMeta(circleId);
    const first = await loadCircleFeedPage(circleId, meta, null);

    // Older than every post in the circle, including the last page's own oldest.
    await addEvent(circleId, ACCOUNT_ID, 1, 'AncientJoiner');

    const second = await loadCircleFeedPage(circleId, meta, first.nextCursor);
    expect(second.events.map((e) => e.subjectName)).toContain('AncientJoiner');
    expect(second.nextCursor).toBeNull();
  });

  test('scopes reactions, comments and photo state to just this page\'s posts', async () => {
    const circleId = await makeCircleWithPosts();
    const meta = await loadCircleFeedMeta(circleId);

    const page = await loadCircleFeedPage(circleId, meta, null);

    expect(page.posts).toHaveLength(FEED_PAGE_SIZE);
    for (const view of page.posts) {
      expect(view.reactions).toEqual({ counts: {}, total: 0, iReacted: false });
      expect(view.comments).toEqual({ latest: null, total: 0 });
    }
  });
});
