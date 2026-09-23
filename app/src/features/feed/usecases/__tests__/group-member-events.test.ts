import { groupMemberEvents } from '@/features/feed/usecases/group-member-events';
import type { MemberEvent } from '@/features/feed/usecases/group-member-events';

const DAY = 24 * 60 * 60 * 1000;
// A fixed instant, comfortably inside a single local calendar day, so
// tests aren't at the mercy of the runner's timezone landing near midnight.
const NOON = new Date(2026, 0, 10, 12, 0, 0).getTime();

function event(overrides: Partial<MemberEvent> = {}): MemberEvent {
  return {
    id: '1',
    kind: 'added',
    subjectName: 'Marcus',
    actorName: 'Nadia',
    selfInflicted: false,
    subjectPublicKey: 'marcus',
    actorPublicKey: 'nadia',
    role: null,
    occurredAt: NOON,
    ...overrides,
  };
}

describe('groupMemberEvents', () => {
  test('an empty list makes no blocks', () => {
    expect(groupMemberEvents([], [], 'en')).toEqual([]);
  });

  test('one event is one block with one group of one subject', () => {
    const blocks = groupMemberEvents([event()], [], 'en');

    expect(blocks).toHaveLength(1);
    expect(blocks[0].groups).toHaveLength(1);
    expect(blocks[0].groups[0].subjects).toEqual([{ subjectPublicKey: 'marcus', subjectName: 'Marcus' }]);
  });

  test('the same actor adding several people the same day, no posts, is one group', () => {
    const events = [
      event({ id: '1', subjectPublicKey: 'a', subjectName: 'A', occurredAt: NOON }),
      event({ id: '2', subjectPublicKey: 'b', subjectName: 'B', occurredAt: NOON - 1000 }),
      event({ id: '3', subjectPublicKey: 'c', subjectName: 'C', occurredAt: NOON - 2000 }),
    ];

    const blocks = groupMemberEvents(events, [], 'en');

    expect(blocks).toHaveLength(1);
    expect(blocks[0].groups).toHaveLength(1);
    // Oldest first: the group reads in the order people were actually added.
    expect(blocks[0].groups[0].subjects.map((s) => s.subjectName)).toEqual(['C', 'B', 'A']);
  });

  test('a different actor, or a different action, is a separate group within the same block', () => {
    const events = [
      event({ id: '1', actorPublicKey: 'nadia', occurredAt: NOON }),
      event({ id: '2', actorPublicKey: 'lin', occurredAt: NOON - 1000 }),
      event({ id: '3', kind: 'removed', selfInflicted: true, actorPublicKey: 'c', subjectPublicKey: 'c', occurredAt: NOON - 2000 }),
    ];

    const blocks = groupMemberEvents(events, [], 'en');

    expect(blocks).toHaveLength(1);
    expect(blocks[0].groups).toHaveLength(3);
  });

  test('a role change only merges with the same direction, not its opposite', () => {
    const events = [
      event({ id: '1', kind: 'role_changed', role: 'admin', actorPublicKey: 'nadia', subjectPublicKey: 'a', occurredAt: NOON }),
      event({ id: '2', kind: 'role_changed', role: 'member', actorPublicKey: 'nadia', subjectPublicKey: 'b', occurredAt: NOON - 1000 }),
    ];

    const blocks = groupMemberEvents(events, [], 'en');

    expect(blocks[0].groups).toHaveLength(2);
  });

  /** The actor is the subject for a departure, so keying on it would give every departure its own, never-merging group. */
  test('several different people leaving the same day merge into one group', () => {
    const events = [
      event({ id: '1', kind: 'removed', selfInflicted: true, actorPublicKey: 'a', subjectPublicKey: 'a', subjectName: 'A', occurredAt: NOON }),
      event({ id: '2', kind: 'removed', selfInflicted: true, actorPublicKey: 'b', subjectPublicKey: 'b', subjectName: 'B', occurredAt: NOON - 1000 }),
    ];

    const blocks = groupMemberEvents(events, [], 'en');

    expect(blocks[0].groups).toHaveLength(1);
    expect(blocks[0].groups[0].subjects.map((s) => s.subjectName)).toEqual(['B', 'A']);
  });

  test('a departure never merges with an admin removing someone, even from the same actor', () => {
    const events = [
      // Nadia removes Marcus.
      event({ id: '1', kind: 'removed', selfInflicted: false, actorPublicKey: 'nadia', subjectPublicKey: 'marcus', occurredAt: NOON }),
      // Nadia herself leaves later that day.
      event({ id: '2', kind: 'removed', selfInflicted: true, actorPublicKey: 'nadia', subjectPublicKey: 'nadia', occurredAt: NOON - 1000 }),
    ];

    const blocks = groupMemberEvents(events, [], 'en');

    expect(blocks[0].groups).toHaveLength(2);
  });

  test('a different calendar day starts a new block', () => {
    const events = [event({ occurredAt: NOON }), event({ id: '2', occurredAt: NOON - DAY })];

    const blocks = groupMemberEvents(events, [], 'en');

    expect(blocks).toHaveLength(2);
    expect(blocks[0].day).not.toBe(blocks[1].day);
  });

  test('a post between two same-day events splits them into two blocks', () => {
    const events = [event({ id: '1', occurredAt: NOON }), event({ id: '2', occurredAt: NOON - 2000 })];
    const postTimestamps = [NOON - 1000];

    const blocks = groupMemberEvents(events, postTimestamps, 'en');

    expect(blocks).toHaveLength(2);
    // Both blocks are still the same calendar day — the split is real, not a day boundary in disguise.
    expect(blocks[0].day).toBe(blocks[1].day);
  });

  test('a post outside the gap between two events does not split them', () => {
    const events = [event({ id: '1', occurredAt: NOON }), event({ id: '2', occurredAt: NOON - 2000 })];
    const postTimestamps = [NOON + 5000, NOON - 5000];

    const blocks = groupMemberEvents(events, postTimestamps, 'en');

    expect(blocks).toHaveLength(1);
  });

  test("a block's day and occurredAt come from its newest event", () => {
    const events = [event({ id: '1', occurredAt: NOON }), event({ id: '2', occurredAt: NOON - 1000 })];

    const blocks = groupMemberEvents(events, [], 'en');

    expect(blocks[0].occurredAt).toBe(NOON);
  });

  test('a group carries the kind, role, actor and self-inflicted flag it was keyed on', () => {
    const blocks = groupMemberEvents([event({ kind: 'role_changed', role: 'admin', actorName: 'Nadia', actorPublicKey: 'nadia' })], [], 'en');

    expect(blocks[0].groups[0]).toMatchObject({
      kind: 'role_changed',
      role: 'admin',
      selfInflicted: false,
      actorPublicKey: 'nadia',
      actorName: 'Nadia',
    });
  });
});
