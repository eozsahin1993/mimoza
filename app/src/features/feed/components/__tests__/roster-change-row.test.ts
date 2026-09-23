import { rosterChangeRows } from '@/features/feed/components/roster-change-row';
import type { MembershipEventGroupItem } from '@/features/feed/components/membership-event-row';
import type { MemberEvent } from '@/features/feed/usecases/group-member-events';

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

/** Renders a row and pulls the `group` prop back out, for asserting on what actually got built. */
function renderedGroup(row: { render: () => React.ReactElement }): MembershipEventGroupItem {
  return (row.render() as { props: { group: MembershipEventGroupItem } }).props.group;
}

describe('rosterChangeRows', () => {
  test('one event is a day header, its one row, then a spacer closing the block', () => {
    const rows = rosterChangeRows([event()], [], null, 'en');

    expect(rows).toHaveLength(3);
    expect(rows[0].at).toBeGreaterThan(rows[1].at!);
    expect(rows[1].at).toBe(NOON);
    expect(rows[2].at).toBeLessThan(rows[1].at!);
  });

  test('two blocks (split by a post) each get their own day header and closing spacer', () => {
    const events = [event({ id: '1', occurredAt: NOON }), event({ id: '2', occurredAt: NOON - 2000 })];
    const postTimestamps = [NOON - 1000];

    const rows = rosterChangeRows(events, postTimestamps, null, 'en');

    // header, row, spacer, header, row, spacer
    expect(rows).toHaveLength(6);
    expect(rows[0].key).not.toBe(rows[3].key);
  });

  /**
   * The spacer exists so a block's last row can ask for the full gap
   * below it without also loosening the (still tight) gap above it — see
   * roster-change-row.tsx. A block of exactly one row is the case that
   * would otherwise break, since that row is both first and last.
   */
  test('the spacer sits between the last row and whatever comes next, not between the header and the row', () => {
    const rows = rosterChangeRows([event()], [], null, 'en');

    expect(rows[1].spacing).toBeLessThan(rows[2].spacing);
  });

  test('resolves ownPublicKey into actorIsYou/subjectIsYou on the built group', () => {
    const rows = rosterChangeRows([event({ actorPublicKey: 'me', subjectPublicKey: 'marcus' })], [], 'me', 'en');

    const group = renderedGroup(rows[1]);
    expect(group.actorIsYou).toBe(true);
    expect(group.subjects[0].subjectIsYou).toBe(false);
  });

  test('a blank subject name (event landed before the roster write behind it) falls back to "Someone"', () => {
    const rows = rosterChangeRows([event({ subjectName: '' })], [], null, 'en');

    expect(renderedGroup(rows[1]).subjects[0].subjectName).toBe('Someone');
  });

  test('every row key is unique, even across two same-day blocks', () => {
    const events = [event({ id: '1', occurredAt: NOON }), event({ id: '2', occurredAt: NOON - 2000 })];
    const rows = rosterChangeRows(events, [NOON - 1000], null, 'en');

    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });
});
