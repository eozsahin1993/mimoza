import { initDatabase } from '@/data/db';
import { discard, done, due, enqueue, failed, queuedFor, retryLater } from '@/data/db/outbox';

const NOW = 1_700_000_000_000;

let next = 0;
function circleId(): string {
  next += 1;
  return `circle-${next}`;
}

beforeEach(async () => {
  await initDatabase();
});

// Writes drain in the order they were made: a comment must never
// overtake the post it belongs to.
test('queued writes come back in order', async () => {
  const circle = circleId();
  const first = await enqueue({ circleId: circle, op: 'post', postId: 'post-1', createdAt: NOW });
  const second = await enqueue({ circleId: circle, op: 'comment', postId: 'post-1', createdAt: NOW });

  const queue = (await due(circle, NOW)).filter((row) => row.circleId === circle);
  expect(queue.map((row) => row.seq)).toEqual([first, second]);
});

// A row waiting on backoff is not due yet, and becomes due when its time
// comes.
test('backoff keeps a row out of the queue until it is time', async () => {
  const circle = circleId();
  const seq = await enqueue({ circleId: circle, op: 'post', createdAt: NOW });
  await retryLater(seq, 1, NOW + 1000, 'network');

  expect((await due(circle, NOW)).some((row) => row.seq === seq)).toBe(false);
  expect((await due(circle, NOW + 1000)).some((row) => row.seq === seq)).toBe(true);
});

// Past the budget a write stops retrying and becomes something the
// person is told about.
test('a write that keeps failing is marked failed rather than retried forever', async () => {
  const circle = circleId();
  const seq = await enqueue({ circleId: circle, op: 'post', createdAt: NOW });
  await retryLater(seq, 5, NOW + 1000, 'gone');

  expect((await due(circle, NOW + 5000)).some((row) => row.seq === seq)).toBe(false);
  const stuck = await failed(circle);
  expect(stuck).toHaveLength(1);
  expect(stuck[0].lastError).toBe('gone');
});

test('a completed write leaves the queue', async () => {
  const circle = circleId();
  const seq = await enqueue({ circleId: circle, op: 'post', createdAt: NOW });
  await done(seq);
  expect((await due(circle, NOW)).some((row) => row.seq === seq)).toBe(false);
});

// The card adjusts by what is queued for that post, so it has to be
// readable on its own.
test('a post has its own queued writes', async () => {
  const circle = circleId();
  await enqueue({ circleId: circle, op: 'reaction', postId: 'post-a', createdAt: NOW });
  await enqueue({ circleId: circle, op: 'comment', postId: 'post-b', createdAt: NOW });

  expect((await queuedFor('post-a')).map((row) => row.op)).toEqual(['reaction']);
});

test('a failed write can be discarded', async () => {
  const circle = circleId();
  const seq = await enqueue({ circleId: circle, op: 'post', createdAt: NOW });
  await retryLater(seq, 5, NOW, 'gone');
  await discard(seq);
  expect(await failed(circle)).toHaveLength(0);
});
