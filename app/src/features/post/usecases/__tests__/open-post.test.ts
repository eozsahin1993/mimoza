jest.mock('@/features/post/services/post-relay', () => ({ getChildren: jest.fn(async () => ({ comments: [], reactions: [] })) }));
// Opening a post reads the keychain through the entry context; none of
// that is under test, only whether the relay is asked.
jest.mock('@/core/sync/entry-handlers', () => ({
  applyChildrenEntries: jest.fn(async () => undefined),
  entryContext: jest.fn(async () => ({})),
}));

import { applyPost, initDatabase, markCircleLeft } from '@/data/db';
import { applyCircle } from '@/data/db/circles';
import { getChildren } from '@/features/post/services/post-relay';
import { openPost } from '@/features/post/usecases/open-post';

const NOW = 1_700_000_000_000;
const children = getChildren as unknown as jest.Mock;

let next = 0;
async function seed(circleId: string, postId: string) {
  await applyCircle(
    { circleId, name: 'Family', role: 'admin', notifyLevel: 'all', keyVersion: 1, rosterVersion: 1 },
    NOW
  );
  await applyPost({
    id: postId,
    circleId,
    authorId: 'acc-1',
    caption: 'hello',
    createdAt: NOW,
    receivedAt: NOW,
    updatedAt: NOW,
  });
}

beforeEach(async () => {
  await initDatabase();
  children.mockClear();
  next += 1;
});

describe('opening a post', () => {
  test('asks the relay for a post whose comments were never fetched', async () => {
    await seed(`circle-${next}`, `post-${next}`);

    await openPost(`circle-${next}`, `post-${next}`);

    expect(children).toHaveBeenCalledTimes(1);
  });

  // A removed member's request would be refused as not-a-member, and the
  // screen would log an error for a read it never needed: an archive is
  // shown as it was stored.
  test('does not ask the relay once the circle has been left', async () => {
    await seed(`circle-${next}`, `post-${next}`);
    await markCircleLeft(`circle-${next}`, NOW + 1);

    await openPost(`circle-${next}`, `post-${next}`);

    expect(children).not.toHaveBeenCalled();
  });
});
