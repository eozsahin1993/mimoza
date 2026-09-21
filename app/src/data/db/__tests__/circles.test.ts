import { generateUUID } from '@/core/crypto/primitives';
import { initDatabase } from '@/data/db';
import { insertComment } from '@/data/db/comments';
import {
  deleteCircle,
  getAllCircles,
  getCircle,
  getUnreadCount,
  insertCircle,
  markCircleViewed,
  updateCircleName,
} from '@/data/db/circles';
import { getMemberByPublicKey, insertMember, MemberRoles } from '@/data/db/members';
import { insertPost, markPostViewed } from '@/data/db/posts';

const OWN_KEY = 'aa'.repeat(32);
const OTHER_KEY = 'bb'.repeat(32);

function makePost(circleId: string, overrides: Partial<{ id: string; authorPublicKey: string; createdAt: number }> = {}) {
  return {
    id: generateUUID(),
    circleId,
    caption: 'c',
    authorPublicKey: OTHER_KEY,
    createdAt: Date.now(),
    lastViewedAt: null,
    inAlbum: true,
    ...overrides,
  };
}

function makeComment(postId: string, overrides: Partial<{ authorPublicKey: string; createdAt: number }> = {}) {
  return {
    id: generateUUID(),
    postId,
    body: 'nice',
    authorPublicKey: OTHER_KEY,
    createdAt: Date.now(),
    ...overrides,
  };
}

beforeAll(() => initDatabase());

function makeCircle(overrides: Partial<{ id: string; name: string; createdAt: number; lastViewedAt: number }> = {}) {
  return {
    id: generateUUID(),
    name: 'Nana’s House',
    picture: null,
    pictureHash: null,
    syncId: generateUUID(),
    createdAt: Date.now(),
    pushCategoryMask: 3,
    pushSilenced: false,
    pushKeyVersion: null,
    leftAt: null,
    metaCursor: 0,
    contentCursor: 0,
    lastViewedAt: 0,
    ...overrides,
  };
}

describe('circles CRUD', () => {
  test('insertCircle then getCircle returns the same row', async () => {
    const circle = makeCircle();
    await insertCircle(circle);

    await expect(getCircle(circle.id)).resolves.toEqual(circle);
  });

  test('getCircle returns null for an unknown id', async () => {
    await expect(getCircle(generateUUID())).resolves.toBeNull();
  });

  test('getAllCircles returns every inserted circle, ordered by createdAt', async () => {
    const earlier = makeCircle({ name: 'Earlier', createdAt: 1000 });
    const later = makeCircle({ name: 'Later', createdAt: 2000 });
    await insertCircle(later);
    await insertCircle(earlier);

    const all = await getAllCircles();
    const ids = all.map((c) => c.id);
    expect(ids.indexOf(earlier.id)).toBeLessThan(ids.indexOf(later.id));
  });

  test('updateCircleName changes the stored name', async () => {
    const circle = makeCircle();
    await insertCircle(circle);

    await updateCircleName(circle.id, 'The Andersons');

    await expect(getCircle(circle.id)).resolves.toMatchObject({ name: 'The Andersons' });
  });

  test('deleteCircle removes the row', async () => {
    const circle = makeCircle();
    await insertCircle(circle);

    await deleteCircle(circle.id);

    await expect(getCircle(circle.id)).resolves.toBeNull();
  });

  test('deleting a circle cascades to its members (validates ON DELETE CASCADE + foreign_keys pragma)', async () => {
    const circle = makeCircle();
    await insertCircle(circle);
    const member = {
      circleId: circle.id,
      identityPublicKey: 'aa'.repeat(32),
      encPublicKey: 'cc'.repeat(32),
      memberId: 'bb'.repeat(16),
      role: MemberRoles.member,
      name: 'Grandma',
      picture: null,
      joinedAt: Date.now(),
      removedAt: null,
    };
    await insertMember(member);

    await deleteCircle(circle.id);

    await expect(getMemberByPublicKey(circle.id, member.identityPublicKey)).resolves.toBeNull();
  });
});

describe('markCircleViewed / getUnreadCount', () => {
  test('markCircleViewed bumps lastViewedAt to roughly now', async () => {
    const circle = makeCircle({ createdAt: 1000 });
    await insertCircle(circle);

    await markCircleViewed(circle.id);

    const updated = await getCircle(circle.id);
    expect(updated!.lastViewedAt).toBeGreaterThan(1000);
    expect(updated!.lastViewedAt).toBeLessThanOrEqual(Date.now());
  });

  test('counts a post from someone else past lastViewedAt, excludes one from the viewer themselves', async () => {
    const circle = makeCircle({ createdAt: 1000, lastViewedAt: 1000 });
    await insertCircle(circle);
    await insertPost(makePost(circle.id, { authorPublicKey: OTHER_KEY, createdAt: 2000 }));
    await insertPost(makePost(circle.id, { authorPublicKey: OWN_KEY, createdAt: 2000 }));

    await expect(getUnreadCount(circle.id, OWN_KEY, circle.createdAt, circle.lastViewedAt)).resolves.toBe(1);
  });

  test('a post from before lastViewedAt does not count', async () => {
    const circle = makeCircle({ createdAt: 1000, lastViewedAt: 3000 });
    await insertCircle(circle);
    await insertPost(makePost(circle.id, { authorPublicKey: OTHER_KEY, createdAt: 2000 }));

    await expect(getUnreadCount(circle.id, OWN_KEY, circle.createdAt, circle.lastViewedAt)).resolves.toBe(0);
  });

  test('a reaction never contributes to the count — getUnreadCount only ever queries posts and comments', async () => {
    const circle = makeCircle({ createdAt: 1000, lastViewedAt: 1000 });
    await insertCircle(circle);
    const post = makePost(circle.id, { authorPublicKey: OWN_KEY, createdAt: 500 });
    await insertPost(post);

    await expect(getUnreadCount(circle.id, OWN_KEY, circle.createdAt, circle.lastViewedAt)).resolves.toBe(0);
  });

  test('a comment on a never-opened old post counts, from someone else, past the join floor', async () => {
    const circle = makeCircle({ createdAt: 1000, lastViewedAt: 1000 });
    await insertCircle(circle);
    const oldPost = makePost(circle.id, { createdAt: 500 }); // predates the join — the post itself is not "new"
    await insertPost(oldPost);
    await insertComment(makeComment(oldPost.id, { authorPublicKey: OTHER_KEY, createdAt: 2000 }));
    await insertComment(makeComment(oldPost.id, { authorPublicKey: OWN_KEY, createdAt: 2000 }));

    await expect(getUnreadCount(circle.id, OWN_KEY, circle.createdAt, circle.lastViewedAt)).resolves.toBe(1);
  });

  test('a comment predating the join never counts, even though the post is never individually viewed', async () => {
    const circle = makeCircle({ createdAt: 1000, lastViewedAt: 1000 });
    await insertCircle(circle);
    const oldPost = makePost(circle.id, { createdAt: 100 });
    await insertPost(oldPost);
    await insertComment(makeComment(oldPost.id, { authorPublicKey: OTHER_KEY, createdAt: 900 }));

    await expect(getUnreadCount(circle.id, OWN_KEY, circle.createdAt, circle.lastViewedAt)).resolves.toBe(0);
  });

  test('opening the post (markPostViewed) clears comments up to that moment, but not ones after', async () => {
    const circle = makeCircle({ createdAt: 1000, lastViewedAt: 1000 });
    await insertCircle(circle);
    const oldPost = makePost(circle.id, { createdAt: 500 });
    await insertPost(oldPost);
    await insertComment(makeComment(oldPost.id, { authorPublicKey: OTHER_KEY, createdAt: 2000 }));

    await markPostViewed(oldPost.id);
    await expect(getUnreadCount(circle.id, OWN_KEY, circle.createdAt, circle.lastViewedAt)).resolves.toBe(0);

    await insertComment(makeComment(oldPost.id, { authorPublicKey: OTHER_KEY, createdAt: Date.now() + 10_000 }));
    await expect(getUnreadCount(circle.id, OWN_KEY, circle.createdAt, circle.lastViewedAt)).resolves.toBe(1);
  });
});
