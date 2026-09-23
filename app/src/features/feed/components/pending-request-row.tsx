import { useMemo } from 'react';
import { StyleSheet } from 'react-native';

import type { FeedRow, FeedRows } from '@/features/feed/components/rows';
import type { JoinRequest } from '@/features/invite/services/invite-relay';
import { PendingJoinRequestCard } from '@/features/invite/components/pending-join-request-card';
import { ThemedView } from '@/ui/theme/themed-view';
import { Spacing } from '@/ui/theme/tokens';

/** One ask waiting on an admin, as the relay returns it. */
export type PendingRequestRow = JoinRequest;

type RequestRowActions = {
  /** Any approve/deny in flight — disables all of them, not just the one tapped. */
  busy: boolean;
  onApprove: (requestId: string) => void;
  onDeny: (requestId: string) => void;
};

export type PendingRequestRowsInput = {
  circleId: string;
  /** Approving admits a member, which changes the roster — see the feed controller. */
  onRosterChanged: () => void;
};

/**
 * Stub: the real read (the invite mailbox) and the approve/deny writes
 * are the invite column's, mid-rewrite alongside this. Always empty
 * until that lands — see pendingRequestRow below, which is what still
 * has a real shape and is exercised directly by rows.test.ts.
 */
export function usePendingRequestRows(_input: PendingRequestRowsInput): FeedRows {
  return useMemo(() => ({ rows: [] }), []);
}

export function pendingRequestRow(request: PendingRequestRow, actions: RequestRowActions): FeedRow {
  return {
    key: `request:${request.requestId}`,
    spacing: Spacing.gapBetweenPosts,
    // Not sticky, despite wanting to be. This was the only sticky row in
    // the feed, and under Fabric on Android it reserved its height and
    // drew nothing — so the request was invisible rather than merely
    // scrollable. `orderRows` already pins it to the top (no `at`), so it
    // is still the first thing on screen when the feed opens.
    render: () => (
      <ThemedView style={styles.row}>
        <PendingJoinRequestCard
          request={request}
          busy={actions.busy}
          onApprove={() => actions.onApprove(request.requestId)}
          onDeny={() => actions.onDeny(request.requestId)}
        />
      </ThemedView>
    ),
  };
}

const styles = StyleSheet.create({
  row: {
    marginHorizontal: Spacing.feedTextPadding,
  },
});
