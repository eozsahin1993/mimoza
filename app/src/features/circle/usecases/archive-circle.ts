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
 */
export async function archiveCircleLocally(circleId: string, at: number): Promise<void> {
  await markCircleLeft(circleId, at);
  await dropOutbox(circleId);
  await removeCircleNotificationChannel(circleId).catch((err) =>
    console.error(`Failed to remove notification channel for ${circleId}`, err)
  );
}
