import {
  AndroidImportance,
  deleteNotificationChannelAsync,
  setNotificationChannelAsync,
  setNotificationChannelGroupAsync,
} from 'expo-notifications';
import { Platform } from 'react-native';

import { i18n } from '@/core/i18n/i18n';

/**
 * Android notification channels, one per circle.
 *
 * A channel per circle is what gives Android its own per-circle sound,
 * vibration and mute in system settings, which is where people look for
 * them. They all sit under one group, so that screen reads as a "Circles"
 * heading with a row per circle. A group each would be a heading per circle
 * with a single meaningless channel beneath it; that only earns its place
 * once a circle has several channels to organise.
 *
 * No-ops everywhere but Android. iOS has no channel concept.
 */

const PUSH_CHANNEL_GROUP_ID = 'circles';

/**
 * Stable per circle, so a rename updates the row rather than leaving a
 * second one behind. Offering a tone picker *in the app* would force this
 * to carry the sound too, since a channel's sound is frozen once created
 * and only a new channel can change it — Android's own settings already
 * offer that per channel, so this stays simple until we don't.
 */
export function circleNotificationChannelId(circleId: string): string {
  return `circle-${circleId}`;
}

/**
 * Creates or updates a circle's channel. Safe to call repeatedly: the name
 * updates in place, which is how a renamed circle keeps a correct row.
 */
export async function ensureCircleNotificationChannel(circleId: string, circleName: string): Promise<void> {
  if (Platform.OS !== 'android') return;

  await setNotificationChannelGroupAsync(PUSH_CHANNEL_GROUP_ID, { name: i18n.t('push.channelGroup') });
  await setNotificationChannelAsync(circleNotificationChannelId(circleId), {
    name: circleName,
    groupId: PUSH_CHANNEL_GROUP_ID,
    importance: AndroidImportance.DEFAULT,
  });
}

/**
 * Join requests, and news on your own, in one shared channel outside the
 * Circles group: muting a circle shouldn't mute requests to join it, and a
 * requester has no circle channel until they're in. Created up front,
 * since Android 8+ silently drops a notification posted to a channel that
 * doesn't exist.
 */
export const INVITES_CHANNEL_ID = 'invites';

/**
 * Creates, or renames, the channels and group whose names are the app's
 * own words rather than a circle's: in the language the app is showing
 * now. Re-creating with the same id only updates the name; the sound and
 * importance a channel was created with stay.
 */
export async function ensureLocalizedChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;

  await setNotificationChannelGroupAsync(PUSH_CHANNEL_GROUP_ID, { name: i18n.t('push.channelGroup') });
  await setNotificationChannelAsync(INVITES_CHANNEL_ID, {
    name: i18n.t('push.invitesChannel'),
    importance: AndroidImportance.DEFAULT,
  });
}

/**
 * Keeps those names in the app's language. At launch the channels can be
 * created before the stored language has loaded, and the language can
 * change from settings at any time; both end in `languageChanged`.
 */
export function followLanguageInChannelNames(): void {
  if (Platform.OS !== 'android') return;
  i18n.on('languageChanged', () => {
    ensureLocalizedChannels().catch((err) => console.error('Failed to rename notification channels', err));
  });
}

/**
 * Removes a circle's channel — leaving or deleting a circle. The group
 * stays: it is shared, and deleting it would take every other circle's
 * channel with it.
 */
export async function removeCircleNotificationChannel(circleId: string): Promise<void> {
  if (Platform.OS !== 'android') return;

  await deleteNotificationChannelAsync(circleNotificationChannelId(circleId));
}
