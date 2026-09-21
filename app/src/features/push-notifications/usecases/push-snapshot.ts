import { File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

import { getAllCircles, getAllPendingJoinRequests, getCircleMembers, getInvitesWithPushRouting } from '@/data/db';
import { getAuthToken } from '@/core/services/keystore/auth-token';
import { getAppSettings } from '@/core/services/settings';
import { APP_GROUP } from '@/features/push-notifications/app-group';

export const PUSH_SNAPSHOT_FILE = 'push-snapshot.json';

/** Bumped by every clear, so a refresh that was already reading can tell it lost the race. */
let generation = 0;

/**
 * Mirrors the circle and member names the iOS notification extension
 * needs into the App Group container — it can't open the app's SQLite.
 * Stale is benign (a card says "Someone"); never throws, since the sync
 * and launch paths calling it must not fail on it.
 *
 * Live invites and pending join requests ride along so the two join
 * handshake pushes can be matched and read there (docs/INVITE_PUSH.md).
 *
 * Also carries the language picked in the app, which the extension can't
 * read from AsyncStorage either. Left out when following the device, so
 * the extension resolves that itself and a change of device language
 * applies without waiting for the app to rewrite this.
 */
export async function refreshPushSnapshot(): Promise<void> {
  if (Platform.OS !== 'ios') return;
  const startedAt = generation;

  try {
    if (!(await getAuthToken())) return;

    const container = Paths.appleSharedContainers?.[APP_GROUP];
    if (!container) return;

    const { language } = await getAppSettings();
    const circles = [];
    for (const circle of await getAllCircles()) {
      const members = await getCircleMembers(circle.id);
      circles.push({
        id: circle.id,
        name: circle.name,
        members: members.map((member) => ({ identityPublicKey: member.identityPublicKey, name: member.name })),
      });
    }

    const now = Date.now();
    const invites = (await getInvitesWithPushRouting())
      .filter((invite) => invite.revokedAt === null && invite.expiresAt > now)
      .map((invite) => ({ pushRoutingId: invite.pushRoutingId, circleId: invite.circleId }));
    const pendingRequests = (await getAllPendingJoinRequests())
      .filter((request) => request.pushRoutingId)
      .map((request) => ({
        requestId: request.id,
        pushRoutingId: request.pushRoutingId,
        circleId: request.circleId,
        circleName: request.circleName,
        createdByName: request.createdByName,
        createdByPublicKey: request.createdByPublicKey,
      }));

    // Synchronous from this check to the write, so no clear can land between them.
    if (generation !== startedAt) return;
    new File(container, PUSH_SNAPSHOT_FILE).write(
      JSON.stringify({ circles, invites, pendingRequests, language: language === 'system' ? undefined : language }),
    );
  } catch (err) {
    console.error('Failed to write the push snapshot', err);
  }
}

/**
 * Removes the snapshot, for signing out. Without it the extension can only
 * show the placeholder, which matters when the relay couldn't be reached to
 * unregister and pushes still arrive. Never throws.
 *
 * Call after the session token is deleted. A refresh starting later then
 * finds no token, and one already running sees the bumped generation.
 */
export async function clearPushSnapshot(): Promise<void> {
  if (Platform.OS !== 'ios') return;
  generation += 1;

  try {
    const container = Paths.appleSharedContainers?.[APP_GROUP];
    if (!container) return;

    const file = new File(container, PUSH_SNAPSHOT_FILE);
    if (file.exists) file.delete();
  } catch (err) {
    console.error('Failed to clear the push snapshot', err);
  }
}
