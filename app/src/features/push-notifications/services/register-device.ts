import { getProfile } from '@/data/db';
import { getAppSettings } from '@/core/services/settings';
import { getDevicePushToken } from '@/features/push-notifications/services/tokens';
import { registerDevice as putDevice, unregisterDevice as deleteDevice } from '@/features/push-notifications/services/device-relay';

/**
 * Registers this phone for push, account-wide — one row covers every
 * circle, since the relay already knows which circles this account is in.
 * Call on every launch and right after permission is granted: a push
 * token rotates on its own schedule, so re-sending isn't a cost to avoid.
 *
 * No-ops rather than throws when a prerequisite isn't there yet (no
 * session, no device id minted, permission refused) — nothing here should
 * ever surface as an error to whoever just opened the app.
 */
export async function registerThisDevice(): Promise<void> {
  const profile = await getProfile();
  if (!profile?.deviceId) return;

  const device = await getDevicePushToken();
  if (!device) return;

  const { language } = await getAppSettings();
  try {
    await putDevice(profile.deviceId, { ...device, locale: language === 'system' ? undefined : language });
  } catch (err) {
    console.error('Failed to register this device for push', err);
  }
}

/** Signing out: push stops reaching this phone. Other devices on the account keep theirs. */
export async function unregisterThisDevice(): Promise<void> {
  const profile = await getProfile();
  if (!profile?.deviceId) return;

  try {
    await deleteDevice(profile.deviceId);
  } catch (err) {
    console.error('Failed to unregister this device from push', err);
  }
}
