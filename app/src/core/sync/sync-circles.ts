import { getAllCircles, getCircle, getPendingOutboxEntries } from '@/data/db';
import { finishAccountDeletionIfPending } from '@/features/account/usecases/delete-account';
import { finishPendingDepartures } from '@/features/circle/usecases/leave-circle';
import { drainOutbox } from '@/features/circle/usecases/sync-circle';
import { isPushStale, resyncPushIfStale } from '@/features/push-notifications/usecases/push-preferences';
import { refreshPushSnapshot } from '@/features/push-notifications/usecases/push-snapshot';
import { fetchEpochs } from '@/core/services/log-relay';
import { timed } from '@/core/utils/timing';
import { pullContent, pullMeta } from '@/core/sync/pull-log';

/**
 * One circle's log pass: catch up on meta, push whatever is queued, then
 * catch up on content. Deliberately contains no photo work — photos are
 * bulk, and this is what a screen or a pull-to-refresh waits on.
 *
 * Meta is pulled *before* pushing because pushing depends on it: the
 * write token and key version come from the current content key, so a
 * device that hasn't seen a rotation would have its append bounced. That
 * turns the design's "sync, retry" case from the common path into a rare
 * one. Content is pulled after the push instead of before, so a large
 * backlog of someone else's posts doesn't delay your own going out.
 */
export async function syncCircle(circleId: string): Promise<void> {
  await timed('sync.meta', () => pullMeta(circleId));
  // The meta pass may have torn the circle down — a deletion tombstone, or
  // this device's own removal. Both leave nothing for the rest of the pass
  // to push to or pull from.
  if (!(await getCircle(circleId))) return;

  // Straight after meta, since that's where a rotation lands: until the
  // relay has the new key's hash, this circle's notifications don't reach
  // this account. A failure is retried next pass, not the pass's problem.
  await resyncPushIfStale(circleId).catch((err) => console.error(`Failed to re-sync notifications for circle ${circleId}`, err));

  await timed('sync.push', () => drainOutbox(circleId));
  await timed('sync.content', () => pullContent(circleId));

  // The meta pass may have changed names or the roster; the iOS
  // notification extension reads them from the snapshot. Never throws.
  void refreshPushSnapshot();
}

/**
 * Log pass for every circle this device is still in, one at a time — at
 * family-circle scale there are few enough that sequential is simpler
 * than any concurrency limit. A failure is contained to its own circle so
 * one broken circle can't stop the rest syncing.
 *
 * Returns how many circles failed rather than throwing, since throwing on
 * the first would defeat that containment. The scheduler ignores the
 * count; pull-to-refresh reports it, because someone is standing there
 * waiting to see whether it worked.
 */
export async function syncAllCircles(): Promise<number> {
  let failed = 0;

  for (const circle of await getAllCircles()) {
    try {
      await syncCircle(circle.id);
    } catch (err) {
      console.error(`Failed to sync circle ${circle.id}`, err);
      failed += 1;
    }
  }
  // Circles this device has left are excluded from getAllCircles, but one
  // with a departure still queued needs a pass of its own until that
  // entry has gone out — see finishDeparture.
  await finishPendingDepartures();
  // Same reasoning, one level up: an account deletion still finishing in
  // the background needs a pass regardless of what any circle needs.
  await finishAccountDeletionIfPending();
  return failed;
}

/**
 * The scheduler's own periodic pass: cheaply checks every circle's current
 * epoch first, and only runs a real syncCircle for one that actually needs
 * it — either the relay has something new (its epoch is ahead of this
 * device's own cursor), or this device still has something queued to push.
 *
 * The pending-push check matters and is easy to miss: gating only on the
 * relay's epoch would silently stop retrying a locally-queued post/comment
 * that failed to push, for any circle where nobody else's content ever
 * changes again — syncCircle is what actually retries drainOutbox, so a
 * circle with something still queued locally needs a real pass even when
 * the relay has nothing new to offer. getPendingOutboxEntries is a local
 * SQLite read, not a network call, so checking it costs nothing extra.
 *
 * Unlike syncAllCircles, this is meant only for the scheduler's own
 * automatic trigger — a manual pull-to-refresh should still mean "sync
 * everything for real," never a conditional check, and keeps calling
 * syncAllCircles directly.
 */
export async function syncStaleCircles(): Promise<void> {
  await finishPendingDepartures();
  await finishAccountDeletionIfPending();

  const circles = await getAllCircles();
  if (circles.length === 0) return;

  // A failed epoch check must not strand the push side: an outbox entry
  // that hasn't gone out yet needs its retry whether or not this
  // particular endpoint answered (it has its own rate-limit budget, and
  // could fail while appends would still succeed). Carry on with no
  // epochs — every circle then syncs only if it has something queued.
  const remote = await fetchEpochs(circles.map((circle) => circle.syncId)).catch((err) => {
    console.error('Failed to check circle epochs', err);
    return [];
  });
  const remoteBySyncId = new Map(remote.map((epochs) => [epochs.syncId, epochs]));

  await Promise.all(
    circles.map(async (circle) => {
      const epochs = remoteBySyncId.get(circle.syncId);
      const hasNewContent = epochs !== undefined && (epochs.metaEpoch > circle.metaCursor || epochs.contentEpoch > circle.contentCursor);
      const hasPendingPush = (await getPendingOutboxEntries(circle.id)).length > 0;
      // Same reasoning for the notification hash: a re-sync that failed
      // has no relay-side change to wake it up again.
      const notificationsStale = await isPushStale(circle.id);
      if (!hasNewContent && !hasPendingPush && !notificationsStale) return;

      try {
        await syncCircle(circle.id);
      } catch (err) {
        console.error(`Failed to sync circle ${circle.id}`, err);
      }
    }),
  );
}
