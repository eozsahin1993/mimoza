import {
  registerTaskAsync,
  scheduleNotificationAsync,
  setNotificationHandler,
  type NotificationTaskPayload,
} from 'expo-notifications';
import { defineTask } from 'expo-task-manager';
import { Platform } from 'react-native';

import { handlePush } from '@/features/push-notifications/usecases/handle-push';
import { ensureLocalizedChannels, followLanguageInChannelNames } from '@/features/push-notifications/services/channels';
import { initDatabase } from '@/data/db';
import { getAuthToken } from '@/core/services/keystore/auth-token';
import { loadLanguage } from '@/core/i18n/i18n';

/**
 * The background handler that turns a delivered push into a notification.
 *
 * Must be defined at module scope in a module loaded early: the task
 * manager loads the JS bundle on its own to run this, with no screen
 * mounted and no app state, so anything it needs has to be reachable from
 * here.
 */

const PUSH_TASK = 'circle-push';

defineTask<NotificationTaskPayload>(PUSH_TASK, async ({ data, error }) => {
  if (error) {
    console.error('Push task failed', error);
    return;
  }

  try {
    // Signing out unregisters this device, but not if the relay was
    // unreachable then — pushes can still arrive.
    if (!(await getAuthToken())) return;

    // The bundle may have been started by this task alone, so nothing has
    // opened the database yet. Idempotent, and memoized (see run.ts).
    await initDatabase();
    await loadLanguage();

    const pushData = pushDataFrom(data);
    const notification = await handlePush(pushData);
    // Null means nothing worth interrupting for — a push we couldn't
    // decrypt, or an entry type that shouldn't raise a card. Showing
    // nothing is the right answer, and on Android we can.
    if (!notification) return;

    await scheduleNotificationAsync({
      // The push's fields ride along so a tap can route to the content —
      // see services/push/tap.ts (iOS taps read them off the APNs payload
      // instead; the extension can't attach anything for JS).
      content: { title: notification.title, body: notification.body, data: pushData },
      trigger: { channelId: notification.channelId },
    });
  } catch (err) {
    console.error('Failed to handle a push', err);
  }
});

/**
 * FCM data values arrive as strings, but the shape differs between a
 * delivered notification and a response to one being tapped.
 */
function pushDataFrom(data: unknown): { pushRoutingId?: string; kind?: string; keyVersion?: string; payload?: string } {
  const record = (data ?? {}) as Record<string, unknown>;
  const body = (record.data ?? record) as Record<string, unknown>;
  return {
    pushRoutingId: typeof body.pushRoutingId === 'string' ? body.pushRoutingId : undefined,
    kind: typeof body.kind === 'string' ? body.kind : undefined,
    keyVersion: typeof body.keyVersion === 'string' ? body.keyVersion : undefined,
    payload: typeof body.payload === 'string' ? body.payload : undefined,
  };
}

/**
 * Registers the task and how a notification behaves while the app is open.
 *
 * Separate from the `defineTask` above because that has to run at import
 * and this is async — the module's import is what the task manager needs
 * to find, not this call.
 */
export async function startPushHandling(): Promise<void> {
  setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });

  // Android only, permanently: iOS composes in the notification service
  // extension (targets/notification-service), which runs natively before
  // display — a JS background task would be too late to rewrite the card.
  if (Platform.OS !== 'android') return;

  followLanguageInChannelNames();
  await ensureLocalizedChannels();
  await registerTaskAsync(PUSH_TASK);
}
