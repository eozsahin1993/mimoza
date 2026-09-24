import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native';

import type { FeedRow, FeedRows } from '@/features/feed/components/rows';
import type { JoinRequest } from '@/features/invite/services/invite-relay';
import { approveJoinRequest, denyJoinRequest, discoverPendingRequests } from '@/features/invite/usecases/invite-to-circle';
import { PendingJoinRequestCard } from '@/features/invite/components/pending-join-request-card';
import { showError } from '@/core/services/messages';
import { JoinRequestGoneError } from '@/core/services/relay-errors';
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
 * Any admin can act on any pending request — approving pages every
 * admin, not just whoever shared the invite (see requests/service.go's
 * Create), so scoping this to the invite's own creator would leave the
 * others notified of something they can't see or answer.
 */
export function usePendingRequestRows({ circleId, onRosterChanged }: PendingRequestRowsInput): FeedRows {
  const { t } = useTranslation();
  const [requests, setRequests] = useState<PendingRequestRow[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!circleId) return;
    try {
      setRequests(await discoverPendingRequests(circleId));
    } catch (err) {
      console.error('Failed to load pending join requests', err);
    }
  }, [circleId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const drop = useCallback((requestId: string) => {
    setRequests((current) => current.filter((request) => request.requestId !== requestId));
  }, []);

  const actions = useMemo<RequestRowActions>(
    () => ({
      busy,
      onApprove: async (requestId) => {
        setBusy(true);
        try {
          await approveJoinRequest(circleId, requestId);
          drop(requestId);
          onRosterChanged();
        } catch (err) {
          // Another admin already answered it, or it aged out — the row
          // disappearing is the whole story; a "failed" toast would be
          // wrong, since nothing actually went wrong here.
          if (err instanceof JoinRequestGoneError) {
            drop(requestId);
          } else {
            console.error('Failed to approve a join request', err);
            showError(t('feed.approveRequestFailed'));
          }
        } finally {
          setBusy(false);
        }
      },
      onDeny: async (requestId) => {
        setBusy(true);
        try {
          await denyJoinRequest(circleId, requestId);
          drop(requestId);
        } catch (err) {
          if (err instanceof JoinRequestGoneError) {
            drop(requestId);
          } else {
            console.error('Failed to deny a join request', err);
            showError(t('feed.denyRequestFailed'));
          }
        } finally {
          setBusy(false);
        }
      },
    }),
    [busy, circleId, drop, onRosterChanged, t],
  );

  return useMemo(
    () => ({ rows: requests.map((request) => pendingRequestRow(request, actions)), reload: load }),
    [requests, actions, load],
  );
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
