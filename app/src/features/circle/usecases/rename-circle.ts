import { renameCircle as renameLocally } from '@/data/db';
import { renameCircle as renameOnRelay } from '@/features/circle/services/circle-relay';
import { ensureCircleNotificationChannel } from '@/features/push-notifications/services/channels';
import { requireLiveCircle } from '@/features/circle/usecases/require-live-circle';

/**
 * Admin-only, enforced by the relay; the wall gets a `renamed` entry.
 *
 * Trimmed and refused when blank: the relay reads an empty name as
 * "leave this field alone", so whitespace would sail past that guard and
 * become the circle's name for everyone.
 */
export async function renameCircle(circleId: string, name: string): Promise<void> {
  await requireLiveCircle(circleId);
  const trimmed = name.trim();
  if (!trimmed) throw new Error('A circle needs a name.');

  await renameOnRelay(circleId, trimmed);
  await renameLocally(circleId, trimmed);
  await ensureCircleNotificationChannel(circleId, trimmed).catch((err) =>
    console.error(`Failed to rename notification channel for ${circleId}`, err)
  );
}
