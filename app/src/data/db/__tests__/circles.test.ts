import { initDatabase } from '@/data/db';
import { insertActivity, listActivitySince } from '@/data/db/activity';
import {
  applyCircle,
  deleteCircle,
  getCircle,
  getUnreadCount,
  listCircles,
  listLeftCircles,
  markCircleLeft,
  markCircleViewed,
  saveCursors,
} from '@/data/db/circles';
import { applyPost } from '@/data/db/posts';

const NOW = 1_700_000_000_000;

// The database is shared across cases in a file, so each one works in a
// circle of its own rather than cleaning up after itself.
let next = 0;
function circleId(): string {
  next += 1;
  return `circle-${next}`;
}

function membership(circleId: string, overrides: Partial<Parameters<typeof applyCircle>[0]> = {}) {
  return {
    circleId,
    name: 'Family',
    role: 'admin',
    notifyLevel: 'all',
    keyVersion: 1,
    rosterVersion: 2,
    lastEntryAt: NOW,
    ...overrides,
  };
}

beforeEach(async () => {
  await initDatabase();
});

// A sync writes the relay's fields and nothing else: cursors and the
// unread floor belong to this device.
test('applying a membership leaves local state alone', async () => {
  const circle = circleId();
  await applyCircle(membership(circle), NOW);
  await saveCursors(circle, { postsForward: 'cursor-1', activity: 'cursor-a' });
  await markCircleViewed(circle, NOW + 500);

  await applyCircle(membership(circle, { name: 'Renamed', rosterVersion: 3 }), NOW + 1000);

  const row = await getCircle(circle);
  expect(row?.name).toBe('Renamed');
  expect(row?.rosterVersion).toBe(3);
  expect(row?.postsForwardCursor).toBe('cursor-1');
  expect(row?.activityCursor).toBe('cursor-a');
  expect(row?.lastViewedAt).toBe(NOW + 500);
});

// Rejoining a circle you left clears the mark rather than leaving it
// filed under departures.
test('a membership that comes back is no longer left', async () => {
  const circle = circleId();
  await applyCircle(membership(circle), NOW);
  await markCircleLeft(circle, NOW + 10);
  const inList = async (list: () => Promise<{ id: string }[]>) =>
    (await list()).some((row) => row.id === circle);

  expect(await inList(listCircles)).toBe(false);
  expect(await inList(listLeftCircles)).toBe(true);

  await applyCircle(membership(circle), NOW + 20);
  expect(await inList(listCircles)).toBe(true);
  expect(await inList(listLeftCircles)).toBe(false);
});

// The badge counts posts and what happened to the circle alike, since
// both appear on the wall.
test('unread counts posts and activity since the last look', async () => {
  const circle = circleId();
  await applyCircle(membership(circle), NOW);
  await markCircleViewed(circle, NOW);

  await applyPost({
    id: 'post-old',
    circleId: circle,
    authorId: 'acc-1',
    caption: 'old',
    createdAt: NOW - 100,
    receivedAt: NOW - 100,
  });
  await applyPost({
    id: 'post-new',
    circleId: circle,
    authorId: 'acc-1',
    caption: 'new',
    createdAt: NOW + 100,
    receivedAt: NOW + 100,
  });
  await insertActivity({
    id: 'activity-1',
    circleId: circle,
    event: 'joined',
    actorId: 'acc-2',
    receivedAt: NOW + 200,
  });

  expect(await getUnreadCount(circle)).toBe(2);

  await markCircleViewed(circle, NOW + 300);
  expect(await getUnreadCount(circle)).toBe(0);
});

// A deleted post is still a row, so it must not be counted as news.
test('a deleted post does not count as unread', async () => {
  const circle = circleId();
  await applyCircle(membership(circle), NOW);
  await markCircleViewed(circle, NOW);
  await applyPost({
    id: 'post-1',
    circleId: circle,
    authorId: 'acc-1',
    caption: '',
    createdAt: NOW + 100,
    receivedAt: NOW + 100,
    deletedAt: NOW + 150,
  });

  expect(await getUnreadCount(circle)).toBe(0);
});

test('deleting a circle takes its rows with it', async () => {
  const circle = circleId();
  await applyCircle(membership(circle), NOW);
  await applyPost({
    id: 'post-1',
    circleId: circle,
    authorId: 'acc-1',
    caption: 'x',
    createdAt: NOW,
    receivedAt: NOW,
  });

  await deleteCircle(circle);
  expect(await getCircle(circle)).toBeNull();
});

// The feed's activity floor is its oldest post's time, so an event
// landing in exactly that millisecond belongs to the page that floor
// bounds — not the next one, where it would show up only after scrolling.
test('an event exactly at the floor belongs to the page it bounds', async () => {
  const circle = circleId();
  await applyCircle(membership(circle), NOW);
  const floor = NOW + 500;
  await insertActivity({ id: `at-${circle}`, circleId: circle, event: 'joined', actorId: 'a', receivedAt: floor });
  await insertActivity({ id: `below-${circle}`, circleId: circle, event: 'joined', actorId: 'b', receivedAt: floor - 1 });

  const page = await listActivitySince(circle, floor);

  expect(page.map((row) => row.id)).toEqual([`at-${circle}`]);
});
