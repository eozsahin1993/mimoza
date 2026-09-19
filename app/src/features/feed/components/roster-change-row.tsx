import { useMemo } from 'react';

import type { FeedRow, FeedRows } from '@/features/feed/components/rows';
import { DayDivider, MembershipEventGroupRow, type MembershipEventGroupItem } from '@/features/feed/components/membership-event-row';
import { Space } from '@/ui/theme/tokens';
import type { MemberEvent } from '@/data/db';
import { groupMemberEvents, type MembershipEventGroup } from '@/features/feed/usecases/group-member-events';
import { i18n } from '@/core/i18n/i18n';
import type { LanguageCode } from '@/core/i18n/languages';

/**
 * Someone joined, left, or changed role — grouped into blocks by day (a
 * post interrupting the run starts a new block even within the same day)
 * and, within a block, consolidated by actor and action. Takes no actions
 * at all — there is nothing to do to it — which is why row modules take
 * their own dependencies rather than one shared bag of every handler in
 * the feed.
 */
export type RosterChangeRowsInput = {
  events: MemberEvent[];
  /**
   * When each post in the circle happened — the only other thing in the
   * feed that shares a timeline with roster changes, and the only thing
   * that can split an otherwise-continuous day of them. Nothing else
   * about a post is needed here.
   */
  postTimestamps: number[];
  /** This device's identity, so a line about the reader reads in the second person. */
  ownPublicKey: string | null;
  language: LanguageCode;
};

/** Takes no actions — there is nothing to do to a roster change. */
export function useRosterChangeRows({ events, postTimestamps, ownPublicKey, language }: RosterChangeRowsInput): FeedRows {
  // Keyed on content, not `postTimestamps`'s own array identity: patching a
  // post (a reaction, a comment, a photo landing) rebuilds `posts` wholesale,
  // giving this a new reference on every bit of activity even when nothing
  // about the grouping actually changed.
  const postTimestampsKey = postTimestamps.join(',');
  return useMemo(
    () => ({ rows: rosterChangeRows(events, postTimestamps, ownPublicKey, language) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- postTimestampsKey stands in for postTimestamps deliberately.
    [events, postTimestampsKey, ownPublicKey, language],
  );
}

export function rosterChangeRows(
  events: MemberEvent[],
  postTimestamps: number[],
  ownPublicKey: string | null,
  language: LanguageCode,
): FeedRow[] {
  const blocks = groupMemberEvents(events, postTimestamps, language);

  return blocks.flatMap((block, blockIndex) => [
    {
      key: `member-event-day-${blockIndex}-${block.occurredAt}`,
      spacing: Space.s500,
      // A hair after the block's newest row, so the header always sorts
      // immediately above it rather than tying with it.
      at: block.occurredAt + 1,
      render: () => <DayDivider day={block.day} />,
    },
    ...block.groups.map((group, groupIndex) => groupRow(group, blockIndex, groupIndex, ownPublicKey, language)),
    // `gapBetween` takes the smaller of two neighbours' spacing, so
    // widening the last group row's own spacing would also widen the gap
    // above it — wrong for a one-row block, where that row is both first
    // and last. An invisible row instead, tight against the last row and
    // full-width on its other side.
    {
      key: `member-event-block-end-${blockIndex}`,
      spacing: Space.s500,
      at: block.groups[block.groups.length - 1].occurredAt - 1,
      render: () => <></>,
    },
  ]);
}

function groupRow(
  group: MembershipEventGroup,
  blockIndex: number,
  groupIndex: number,
  ownPublicKey: string | null,
  language: LanguageCode,
): FeedRow {
  const item: MembershipEventGroupItem = {
    kind: group.kind,
    role: group.role,
    selfInflicted: group.selfInflicted,
    actorName: group.actorName,
    actorIsYou: group.actorPublicKey === ownPublicKey,
    subjects: group.subjects.map((s) => ({
      // Blank only in the window between an event row landing and the
      // roster write behind it (see member-events.ts) — the next replay
      // fills it in.
      subjectName: s.subjectName || i18n.getFixedT(language)('feed.membership.someone'),
      subjectIsYou: s.subjectPublicKey === ownPublicKey,
    })),
  };

  return {
    key: `member-event-${blockIndex}-${groupIndex}`,
    // Tighter than the gap around the day divider above: these rows carry
    // no rule of their own, so the gap is the only thing saying they
    // belong to it rather than floating on their own.
    spacing: Space.s300,
    at: group.occurredAt,
    render: () => <MembershipEventGroupRow group={item} />,
  };
}
