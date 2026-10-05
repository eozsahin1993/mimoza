import { dropOutbox, markCircleLeft } from '@/data/db';
import { removeCircleNotificationChannel } from '@/features/push-notifications/services/channels';

/**
 * What being out of a circle looks like on this device, however it came
 * about: the rows stay as a read-only archive, and the notification
 * channel and anything still queued for the circle go.
 *
 * Sync calls it when the relay stops listing a circle and leaving calls
 * it directly, so a leave, a removal and a leave made on another phone
 * all end in one state, and whichever runs first leaves the other
 * nothing to do.
 *
 * Outbox first: the drain does not check `leftAt`, so a crash after the
 * mark but before the drop would leave rows that fail five times into
 * the banner. The other way round, the next sync pass simply archives
 * again.
 */
export async function archiveCircleLocally(circleId: string, at: number): Promise<void> {
  await dropOutbox(circleId);
  await markCircleLeft(circleId, at);
  await removeCircleNotificationChannel(circleId).catch((err) =>
    console.error(`Failed to remove notification channel for ${circleId}`, err)
  );
}
