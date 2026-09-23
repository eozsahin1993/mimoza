import { justJoinedRow } from '@/features/feed/components/just-joined-row';
import { pendingRequestRow } from '@/features/feed/components/pending-request-row';
import { rosterChangeRows } from '@/features/feed/components/roster-change-row';
import { buildFeedRows, gapBetween, stickyIndices, type FeedRow } from '@/features/feed/components/rows';
import { Space, Spacing } from '@/ui/theme/tokens';
import type { MemberEvent } from '@/features/feed/usecases/group-member-events';

function event(id: string, occurredAt: number): MemberEvent {
  return {
    id,
    kind: 'added',
    subjectName: 'Marcus',
    actorName: 'Nadia',
    selfInflicted: false,
    subjectPublicKey: 'pk-subject',
    actorPublicKey: 'pk-actor',
    role: 'member',
    occurredAt,
  };
}

/** One event's group row — everything `rosterChangeRows` builds for it besides the day header above it. */
function eventRow(occurredAt: number): FeedRow {
  return rosterChangeRows([event('e', occurredAt)], [], null, 'en')[1];
}

const noRequestActions = { busy: false, onApprove: () => {}, onDeny: () => {} };

/** The same mapping `useCircleFeed` performs, with the row kinds it has today. */
function build(events: MemberEvent[] = [], justJoined = false): FeedRow[] {
  return buildFeedRows([
    pendingRequestRow({ requestId: 'a', circleId: 'c1', accountId: 'acc-a', name: 'Marcus', status: 'pending', createdAt: 1 }, noRequestActions),
    ...(justJoined ? [justJoinedRow()] : []),
    ...rosterChangeRows(events, [], null, 'en'),
  ]);
}

describe('buildFeedRows', () => {
  test('pins in adapter order, above the timeline', () => {
    // A day header, its one group row, then the spacer closing the block — see roster-change-row.tsx.
    expect(build([event('e1', 1_000)]).map((row) => row.key)).toEqual([
      'request:a',
      'member-event-day-0-1000',
      'member-event-0-0',
      'member-event-block-end-0',
    ]);
  });

  /** Pinned rows are about the circle now, not about a moment, so they never sort. */
  test('sorts only the timeline, newest first', () => {
    // Three separate days (all at local noon, so no timezone can push one
    // into another's calendar day), so each is its own block.
    const day1 = new Date(2026, 0, 1, 12, 0, 0).getTime();
    const day2 = new Date(2026, 0, 2, 12, 0, 0).getTime();
    const day3 = new Date(2026, 0, 3, 12, 0, 0).getTime();
    const rows = build([event('old', day1), event('new', day3), event('mid', day2)]);

    expect(rows.slice(0, 1).map((row) => row.key)).toEqual(['request:a']);
    expect(rows.slice(1).map((row) => row.at)).toEqual([
      day3 + 1, day3, day3 - 1,
      day2 + 1, day2, day2 - 1,
      day1 + 1, day1, day1 - 1,
    ]);
  });

  /** Ordering only — it renders exactly the rows it is handed. */
  test('renders exactly the rows it is given', () => {
    expect(buildFeedRows(rosterChangeRows([event('e1', 1_000)], [], null, 'en')).map((row) => row.key)).toEqual([
      'member-event-day-0-1000',
      'member-event-0-0',
      'member-event-block-end-0',
    ]);
  });
});

describe('each row decides for itself', () => {
  /**
   * Nothing is sticky today: the join request was the only row that ever
   * was, and under Fabric on Android it reserved its height and drew
   * nothing. It stays at the top through `orderRows` instead.
   */
  test('no row asks to stick', () => {
    expect(pendingRequestRow({ requestId: 'a', circleId: 'c1', accountId: 'acc-a', name: 'M', status: 'pending', createdAt: 1 }, noRequestActions).sticky).toBeUndefined();
    expect(eventRow(1).sticky).toBeUndefined();
  });

  /** Pinned without being sticky — no `at` keeps it above the timeline. */
  test('a join request stays above dated rows', () => {
    const rows = buildFeedRows([
      ...rosterChangeRows([event('e1', 9_000)], [], null, 'en'),
      pendingRequestRow({ requestId: 'a', circleId: 'c1', accountId: 'acc-a', name: 'M', status: 'pending', createdAt: 1 }, noRequestActions),
    ]);
    expect(rows[0].key).toBe('request:a');
  });

  test('only a timeline row carries a time', () => {
    expect(eventRow(5_000).at).toBe(5_000);
    expect(pendingRequestRow({ requestId: 'a', circleId: 'c1', accountId: 'acc-a', name: 'M', status: 'pending', createdAt: 1 }, noRequestActions).at).toBeUndefined();
  });

  /** A roster change means nothing by being scrolled past; a post marks its comments seen. */
  test('a roster change has nothing to mark seen', () => {
    expect(eventRow(1).onSeen).toBeUndefined();
  });

  test('a roster change asks for a tighter gap than a card', () => {
    expect(eventRow(1).spacing).toBe(Space.s300);
  });
});

describe('gapBetween', () => {
  const post: FeedRow = { key: 'p', spacing: Spacing.gapBetweenPosts, render: () => null! };
  const rosterChange: FeedRow = { key: 'e', spacing: Space.s300, render: () => null! };

  test('two cards take the full gap', () => {
    expect(gapBetween(post, post)).toBe(Spacing.gapBetweenPosts);
  });

  /** The quieter row wins, so it tightens both its sides without either neighbour knowing about it. */
  test.each([
    ['before', post, rosterChange],
    ['after', rosterChange, post],
  ])('a roster change tightens the gap %s it', (_label, leading, trailing) => {
    expect(gapBetween(leading, trailing)).toBe(Space.s300);
  });

  test('the last row falls back to its own spacing', () => {
    expect(gapBetween(rosterChange, undefined)).toBe(Space.s300);
  });
});

describe('stickyIndices', () => {
  const pinned: FeedRow = { key: 'p', spacing: 0, sticky: true, render: () => null! };
  const ordinary: FeedRow = { key: 'o', spacing: 0, render: () => null! };

  test('is the position of each pinned row', () => {
    expect(stickyIndices([pinned, pinned, ordinary])).toEqual([0, 1]);
  });

  test('is empty when nothing sticks', () => {
    expect(stickyIndices([ordinary])).toEqual([]);
  });
});
