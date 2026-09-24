import {
  addNotificationResponseReceivedListener,
  clearLastNotificationResponse,
  getLastNotificationResponse,
  type NotificationResponse,
} from 'expo-notifications';
import { router } from 'expo-router';
import { Alert } from 'react-native';

import { initDatabase, getPost } from '@/data/db';
import { i18n } from '@/core/i18n/i18n';
import { discoverPendingRequests } from '@/features/invite/usecases/invite-to-circle';

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

/** The push's data fields, from wherever each platform puts them for a delivered, OS-rendered alert. */
function tapData(
  response: NotificationResponse
): { circleId?: string; entryId?: string; parentEntryId?: string; requestId?: string } {
  const content = response.notification.request.content;
  const trigger = response.notification.request.trigger as { payload?: Record<string, unknown> } | null;
  const data = (content.data ?? trigger?.payload ?? {}) as Record<string, unknown>;
  return {
    circleId: typeof data.circleId === 'string' ? data.circleId : undefined,
    entryId: typeof data.entryId === 'string' ? data.entryId : undefined,
    parentEntryId: typeof data.parentEntryId === 'string' ? data.parentEntryId : undefined,
    requestId: typeof data.requestId === 'string' ? data.requestId : undefined,
  };
}

async function openDestination(response: NotificationResponse): Promise<void> {
  try {
    // A cold start by tap may run before anything else opened the database.
    await initDatabase();

    const { circleId, entryId, parentEntryId, requestId } = tapData(response);
    if (!circleId) return;

    // The feed goes under the post so back walks post -> feed -> wherever
    // the tap happened, rather than skipping the circle entirely.
    router.push({ pathname: '/circle/feed', params: { circleId } });

    // A comment or reaction's own id is never what opens: parentEntryId is
    // the post underneath it. A bare post notification has no parent, so
    // its own entryId is the post. Either way, only open it if this device
    // already has it — the push can outrun the sync carrying its content,
    // and there is nothing to show yet.
    const postId = parentEntryId ?? entryId;
    if (postId && (await getPost(postId))) {
      router.push({ pathname: '/post/[id]', params: { id: postId, circleId } });
    }

    // A join-request notification can outlive the request it's about —
    // another admin may have already approved or denied it by the time
    // this one is tapped. The feed simply won't show that row any more;
    // say so, rather than leaving whoever tapped it looking for it.
    if (requestId) {
      const stillPending = (await discoverPendingRequests(circleId)).some((request) => request.requestId === requestId);
      if (!stillPending) {
        Alert.alert(i18n.t('feed.requestGoneTitle'), i18n.t('feed.requestGoneMessage'));
      }
    }
  } catch (err) {
    console.error('Failed to open a notification', err);
  }
}
