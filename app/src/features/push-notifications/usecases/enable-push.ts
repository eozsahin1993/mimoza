import { getPermissionsAsync } from 'expo-notifications';

import { getAppSettings, updateAppSettings } from '@/core/services/settings';
import { getDevicePushToken } from '@/features/push-notifications/services/tokens';
import { registerThisDevice, unregisterThisDevice } from '@/features/push-notifications/services/register-device';

export { registerThisDevice as enablePushEverywhere, unregisterThisDevice as unregisterPushEverywhere };

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
 * registers this device straight away rather than at the next launch.
 */
export async function answerNotificationPrompt(turnOn: boolean): Promise<void> {
  await updateAppSettings({ notificationPromptAnswered: true });
  if (!turnOn) return;

  const device = await getDevicePushToken({ ask: true });
  if (device) await registerThisDevice();
}
