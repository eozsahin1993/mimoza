import {
  addNotificationResponseReceivedListener,
  clearLastNotificationResponse,
  getLastNotificationResponse,
  type NotificationResponse,
} from 'expo-notifications';
import { router } from 'expo-router';

import { initDatabase } from '@/data/db';
import { resolvePushDestination } from '@/features/push-notifications/usecases/push-destination';
import type { PushData } from '@/features/push-notifications/usecases/handle-push';
import { syncCircle } from '@/core/sync/sync-circles';

/**
 * Routes a tapped notification to its content. Call once from the root
 * layout — a tap can also be what launched the app, which is what the
 * getLastNotificationResponse check below covers.
 */
let started = false;

export function startPushTapRouting(): void {
  // The root layout's effect can run again (a remount, Fast Refresh), and
  // a second listener would route every tap twice.
  if (started) return;
  started = true;

  addNotificationResponseReceivedListener((response) => {
    // Cleared on every handled tap, not just the launching one: the native
    // side keeps the last response, and a later JS reload would otherwise
    // read it back and navigate again.
    clearLastNotificationResponse();
    void openDestination(response);
  });

  const launching = getLastNotificationResponse();
  if (launching) {
    clearLastNotificationResponse();
    void openDestination(launching);
  }
}

async function openDestination(response: NotificationResponse): Promise<void> {
  try {
    // A cold start by tap may run before anything else opened the database.
    await initDatabase();

    const data = tapData(response);
    let destination = await resolvePushDestination(data);
    if (!destination) return;

    // No circle to sync yet: the pending screen fetches and completes the join itself.
    if (destination.screen === 'pending') {
      router.push({ pathname: '/join/pending', params: { requestId: destination.requestId } });
      return;
    }

    // The push can outrun the sync carrying its content, so sync first and
    // re-resolve — a feed destination may upgrade to the post once synced.
    // Capped: a dead network must delay the tap, not eat it.
    await Promise.race([
      syncCircle(destination.circleId).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 4000)),
    ]);
    const refined = await resolvePushDestination(data);
    if (refined && refined.screen !== 'pending') destination = refined;

    // The feed goes under the post so back walks post -> feed -> wherever
    // the tap happened, rather than skipping the circle entirely.
    router.push({ pathname: '/circle/feed', params: { circleId: destination.circleId } });
    if (destination.screen === 'post') {
      router.push({ pathname: '/post/[id]', params: { id: destination.postId, circleId: destination.circleId } });
    }
  } catch (err) {
    console.error('Failed to open a notification', err);
  }
}

/**
 * The push's custom fields, from where each platform puts them. Android:
 * content.data, attached by task.ts when it schedules the card. iOS: the
 * trigger's payload (the raw APNs userInfo) — content.data is only filled
 * from a `body` sub-key convention this payload deliberately doesn't
 * follow, since the extension reads the fields at the top level.
 */
function tapData(response: NotificationResponse): PushData {
  const content = response.notification.request.content;
  const trigger = response.notification.request.trigger as { payload?: Record<string, unknown> } | null;
  const data = (content.data ?? trigger?.payload ?? {}) as Record<string, unknown>;
  return {
    pushRoutingId: typeof data.pushRoutingId === 'string' ? data.pushRoutingId : undefined,
    kind: typeof data.kind === 'string' ? data.kind : undefined,
    keyVersion: typeof data.keyVersion === 'string' || typeof data.keyVersion === 'number' ? data.keyVersion : undefined,
    payload: typeof data.payload === 'string' ? data.payload : undefined,
  };
}
