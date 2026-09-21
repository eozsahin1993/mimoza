import { getPermissionsAsync } from 'expo-notifications';

import { getAllCircles, getCircle } from '@/data/db';
import { getAuthToken } from '@/core/services/keystore/auth-token';
import { getAppSettings, updateAppSettings } from '@/core/services/settings';
import { circlePushPreferences } from '@/features/push-notifications/usecases/push-preferences';
import { registerPushForCircle, unregisterDeviceForCircle } from '@/features/push-notifications/usecases/push-registration';
import { refreshPushSnapshot } from '@/features/push-notifications/usecases/push-snapshot';
import { getDevicePushToken } from '@/features/push-notifications/services/tokens';

/**
 * Registers this device for every circle it can be reached in — call on
 * launch, and after joining or creating one.
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
 * Whether the home screen should ask about notifications: not answered
 * there yet, and the OS would still show its prompt. Local reads only.
 */
export async function shouldOfferNotifications(): Promise<boolean> {
  if ((await getAppSettings()).notificationPromptAnswered) return false;
  // Not keyed on `status`: iOS reports `undetermined` before the first ask,
  // Android reports denied-with-canAskAgain. These two cover both.
  const existing = await getPermissionsAsync();
  return !existing.granted && existing.canAskAgain;
}

/**
 * The home screen's answer. Only a yes spends the OS prompt, and a grant
 * registers every circle straight away rather than at the next launch.
 */
export async function answerNotificationPrompt(turnOn: boolean): Promise<void> {
  await updateAppSettings({ notificationPromptAnswered: true });
  if (!turnOn) return;

  const device = await getDevicePushToken({ ask: true });
  if (device) await enablePushEverywhere();
}

/**
 * Registers a circle this phone never has, when a feed opens. Launch
 * registers every circle, but not one created or joined since; without
 * this it stays unreachable until the next cold start. `pushKeyVersion`
 * is null until the first registration, so this runs once per circle.
 * Never prompts: the ask lives on the home screen.
 */
export async function ensurePushForCircle(circleId: string): Promise<void> {
  const circle = await getCircle(circleId);
  if (!circle || circle.pushSilenced || circle.pushKeyVersion !== null) return;

  const device = await getDevicePushToken();
  if (!device) return;

  const { categories } = await circlePushPreferences(circleId);
  await registerPushForCircle(circleId, { ...device, categories });
}
