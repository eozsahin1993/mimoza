import { getPermissionsAsync } from 'expo-notifications';

import { getAllCircles } from '@/data/db';
import { getAuthToken } from '@/core/services/keystore/auth-token';
import { circlePushPreferences } from '@/features/push-notifications/usecases/push-preferences';
import { registerPushForCircle, unregisterDeviceForCircle } from '@/features/push-notifications/usecases/push-registration';
import { refreshPushSnapshot } from '@/features/push-notifications/usecases/push-snapshot';
import { getDevicePushToken } from '@/features/push-notifications/services/tokens';

/**
 * Registers this device for every circle it can be reached in — call on
 * launch. A circle joined or created since then registers when its feed
 * is first opened (`askForPushOnCircle`), or on the next launch.
 *
 * Re-running is the point rather than a cost: push tokens rotate, and the
 * fanout hash follows the circle's content key, so a rotation leaves a
 * stale registration that silently stops verifying. This is what heals it.
 *
 * Best-effort throughout. A refused permission, an offline relay or one
 * circle missing its key must not stop the others, and none of it should
 * ever surface as an error to whoever just opened the app.
 */
export async function enablePushEverywhere(): Promise<void> {
  // Every registration route is session-gated.
  if (!(await getAuthToken())) return;

  // Even without permission (or a token), the iOS extension's snapshot
  // should reflect this launch's circles.
  await refreshPushSnapshot();

  // Never prompts: this runs on every launch, and the OS spends its one
  // prompt on whatever asks first.
  const device = await getDevicePushToken();
  if (!device) return;

  for (const circle of await getAllCircles()) {
    if (circle.pushSilenced) continue;

    try {
      const { categories } = await circlePushPreferences(circle.id);
      await registerPushForCircle(circle.id, { ...device, categories });
    } catch (err) {
      console.error(`Failed to enable notifications for circle ${circle.id}`, err);
    }
  }
}

/**
 * Stops this device receiving notifications for any circle — for signing
 * out, and must run while the session is still valid, since the relay's
 * push routes require one. Other devices on the account keep theirs.
 */
export async function unregisterPushEverywhere(): Promise<void> {
  for (const circle of await getAllCircles()) {
    try {
      await unregisterDeviceForCircle(circle.id);
    } catch (err) {
      console.error(`Failed to disable notifications for circle ${circle.id}`, err);
    }
  }
}

/**
 * Asks for notification permission and registers one circle. Called from
 * the feed, which is the only place with that circle on screen to explain
 * what is being asked for — a usecase should not be popping OS dialogs.
 *
 * Returns immediately once permission has been answered either way, so
 * opening a feed costs nothing after the first time.
 */
export async function askForPushOnCircle(circleId: string): Promise<void> {
  // Not keyed on `status`: iOS reports `undetermined` before the first ask,
  // Android reports denied-with-canAskAgain, so testing for `undetermined`
  // meant Android was never asked at all. These two cover both.
  const existing = await getPermissionsAsync();
  if (existing.granted) return; // launch already registered this circle
  if (!existing.canAskAgain) return; // the OS will not ask again

  const device = await getDevicePushToken({ ask: true });
  if (!device) return;

  const { categories } = await circlePushPreferences(circleId);
  await registerPushForCircle(circleId, { ...device, categories });
}
