import { initDatabase } from '@/data/db';
import { applyMembership } from '@/data/db/circles';
import {
  applyPost,
  childrenAreStale,
  getAlbum,
  getFeed,
  getPost,
  markChildrenFetched,
  markPostDeleted,
  setInAlbum,
} from '@/data/db/posts';

const NOW = 1_700_000_000_000;

// The database is shared across cases in a file, so ids are unique per
// case rather than each one cleaning up after itself.
let next = 0;
function circleId(): string {
  next += 1;
  return `circle-${next}`;
}

function postId(name: string): string {
  return `${name}-${next}`;
}

async function seedCircle(id: string) {
  await applyMembership(
    { circleId: id, name: 'Family', role: 'admin', notifyLevel: 'all', keyVersion: 1, rosterVersion: 1 },
    NOW
  );
}

function post(circle: string, id: string, overrides: Partial<Parameters<typeof applyPost>[0]> = {}) {
  return {
    id,
    circleId: circle,
    authorId: 'acc-1',
    caption: 'hello',
    createdAt: NOW,
    receivedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

beforeEach(async () => {
  await initDatabase();
});

// The relay owns the counts; this device owns when it last looked.
test('applying a post replaces the relay half and keeps the local half', async () => {
  const circle = circleId();
  await seedCircle(circle);
  const id = postId('kept');
  await applyPost(post(circle, id));
  await markChildrenFetched(id, NOW + 50);

  await applyPost(post(circle, id, { commentCount: 4, updatedAt: NOW + 100 }));

  const row = await getPost(id);
  expect(row?.commentCount).toBe(4);
  expect(row?.updatedAt).toBe(NOW + 100);
  expect(row?.childrenFetchedAt).toBe(NOW + 50);
});

// The wall sorts on the author's own clock, so two caught-up devices
// agree on the order.
test('the feed comes back newest first by the author clock', async () => {
  const circle = circleId();
  await seedCircle(circle);
  await applyPost(post(circle, 'old', { createdAt: NOW - 100, receivedAt: NOW + 500 }));
  await applyPost(post(circle, 'new', { createdAt: NOW, receivedAt: NOW }));

  expect((await getFeed(circle)).map((row) => row.id)).toEqual(['new', 'old']);
});

test('a deleted post leaves the feed but keeps its row', async () => {
  const circle = circleId();
  await seedCircle(circle);
  const id = postId('deleted');
  await applyPost(post(circle, id));
  await markPostDeleted(id, NOW + 10);

  expect(await getFeed(circle)).toHaveLength(0);
  const row = await getPost(id);
  expect(row?.deletedAt).toBe(NOW + 10);
  expect(row?.caption).toBe('');
});

test('the album is what its authors kept in it', async () => {
  const circle = circleId();
  await seedCircle(circle);
  await applyPost(post(circle, 'in'));
  await applyPost(post(circle, 'out'));
  await setInAlbum('out', false);

  expect((await getAlbum(circle)).map((row) => row.id)).toEqual(['in']);
});

// Opening a post should cost nothing when nothing has changed.
test('children are stale only when never fetched or older than the post', async () => {
  const circle = circleId();
  const id = postId('stale');
  await seedCircle(circle);
  await applyPost(post(circle, id, { updatedAt: NOW }));

  expect(childrenAreStale((await getPost(id))!)).toBe(true);

  await markChildrenFetched(id, NOW + 10);
  expect(childrenAreStale((await getPost(id))!)).toBe(false);

  await applyPost(post(circle, id, { updatedAt: NOW + 20 }));
  expect(childrenAreStale((await getPost(id))!)).toBe(true);
});
