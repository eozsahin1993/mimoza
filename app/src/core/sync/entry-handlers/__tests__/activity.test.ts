import { applyMembership, applyRoster, initDatabase, listActivity, listEveryMemberSeen, listMembers } from '@/data/db';
import { ActivityEvents, applyActivityEntry } from '@/core/sync/entry-handlers/activity';
import type { EntryContext } from '@/core/sync/entry-handlers/types';
import type { Entry } from '@/features/post/services/post-relay';

const NOW = 1_700_000_000_000;

let next = 0;
function circleId(): string {
  next += 1;
  return `circle-${next}`;
}

function context(id: string): EntryContext {
  return { circleId: id, accountId: 'me', keys: {}, tagKey: null, tags: {} };
}

function entry(overrides: Partial<Entry> = {}): Entry {
  return { entryId: `activity-${next}`, type: 'activity', authorId: 'sarah', receivedAt: NOW, ...overrides };
}

beforeAll(async () => {
  await initDatabase();
});

async function seed(id: string) {
  await applyMembership(
    { circleId: id, name: 'Family', role: 'member', notifyLevel: 'all', keyVersion: 1, rosterVersion: 1 },
    NOW
  );
}

describe('applying an activity entry', () => {
  test('records what happened, with the actor and the subject', async () => {
    const id = circleId();
    await seed(id);

    await applyActivityEntry(
      context(id),
      entry({ event: ActivityEvents.PROMOTED, subjectId: 'ali', subjectName: 'Ali' })
    );

    const [row] = await listActivity(id);
    expect(row.event).toBe('promoted');
    expect(row.actorId).toBe('sarah');
    expect(row.subjectId).toBe('ali');
    expect(row.subjectName).toBe('Ali');
  });

  // The relay writes each one once and never changes it, so a rewind
  // that redelivers the same entry has to be harmless.
  test('the same entry twice is one row', async () => {
    const id = circleId();
    await seed(id);
    const twice = entry({ event: ActivityEvents.RENAMED });

    await applyActivityEntry(context(id), twice);
    await applyActivityEntry(context(id), twice);

    expect(await listActivity(id)).toHaveLength(1);
  });

  // Someone who left is gone from the next roster, and a post or
  // reaction of theirs still has to resolve to a name.
  test.each([ActivityEvents.LEFT, ActivityEvents.REMOVED, ActivityEvents.ACCOUNT_DELETED])(
    'a %s event keeps the departed member by name',
    async (event) => {
      const id = circleId();
      await seed(id);

      await applyActivityEntry(context(id), entry({ event, subjectId: 'ali', subjectName: 'Ali' }));

      const everyone = await listEveryMemberSeen(id);
      expect(everyone.map((member) => member.name)).toEqual(['Ali']);
      expect(everyone[0].leftAt).toBe(NOW);
      expect(await listMembers(id)).toEqual([]);
    }
  );

  test('a departure does not resurrect someone the roster still has', async () => {
    const id = circleId();
    await seed(id);
    await applyRoster(
      id,
      [{ circleId: id, accountId: 'ali', name: 'Ali', publicKey: 'aa', role: 'member', joinedAt: NOW }],
      NOW
    );

    await applyActivityEntry(context(id), entry({ event: ActivityEvents.JOINED, subjectId: 'ali', subjectName: 'Ali' }));

    expect(await listMembers(id)).toHaveLength(1);
  });
});
